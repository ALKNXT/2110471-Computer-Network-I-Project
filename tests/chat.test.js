const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
// Use the same Socket.IO client bundle served to browsers; no extra dependency.
const { io: connect } = require(
  path.resolve(
    path.dirname(require.resolve("socket.io")),
    "../client-dist/socket.io.js",
  ),
);
const { createChatServer } = require("../server");

function request(socket, event, data = {}) {
  return new Promise((resolve, reject) =>
    socket
      .timeout(2000)
      .emit(event, data, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
  );
}
function next(socket, event, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out: ${event}`));
    }, 2000);
    function listener(data) {
      if (!matches(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    }
    socket.on(event, listener);
  });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("Part 2: registration, private routing, explicit group membership and disconnects", async (t) => {
  const server = createChatServer();
  await new Promise((resolve) =>
    server.httpServer.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((socket) => socket.disconnect());
    await new Promise((resolve) => server.io.close(resolve));
  });
  async function client() {
    const socket = connect(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
    });
    clients.push(socket);
    const ready = next(socket, "connect");
    socket.connect();
    await ready;
    return socket;
  }
  const a = await client(),
    b = await client(),
    c = await client(),
    guest = await client();
  const privateEvents = [[], [], [], []],
    groupEvents = [[], [], [], []];
  [a, b, c, guest].forEach((socket, i) => {
    socket.on("private:message", (data) => privateEvents[i].push(data));
    socket.on("group:message", (data) => groupEvents[i].push(data));
  });

  await t.test(
    "R3/R4: unique names, full online list including self, unregistered requests denied",
    async () => {
      assert.equal(
        (await request(a, "user:register", { name: "  Alice  " })).data.self
          .name,
        "Alice",
      );
      assert.equal(
        (await request(b, "user:register", { name: " alice " })).error.code,
        "NAME_TAKEN",
      );
      assert.equal(
        (await request(b, "user:register", { name: " " })).error.code,
        "INVALID_NAME",
      );
      assert.equal(
        (await request(b, "user:register", { name: "x".repeat(33) })).error
          .code,
        "INVALID_NAME",
      );
      await request(b, "user:register", { name: "Bob" });
      const update = next(
        a,
        "users:updated",
        (data) => data.users.length === 3,
      );
      const registered = await request(c, "user:register", { name: "Carol" });
      assert.deepEqual(registered.data.users.map((u) => u.name).sort(), [
        "Alice",
        "Bob",
        "Carol",
      ]);
      assert.ok(registered.data.users.some((u) => u.socketId === c.id));
      await update;
      assert.equal(
        (await request(a, "user:register", { name: "Changed" })).error.code,
        "ALREADY_REGISTERED",
      );
      for (const event of [
        "private:send",
        "group:create",
        "group:join",
        "group:send",
      ]) {
        assert.equal(
          (await request(guest, event)).error.code,
          "NOT_REGISTERED",
        );
      }
    },
  );

  await t.test(
    "R7: private messages only reach sender/receiver, forged sender ignored, self-chat emits once",
    async () => {
      assert.equal(
        (
          await request(a, "private:send", {
            to: b.id,
            text: "<b>private</b>",
            from: { socketId: c.id },
          })
        ).ok,
        true,
      );
      await settle();
      assert.deepEqual(
        privateEvents.map((list) => list.length),
        [1, 1, 0, 0],
      );
      assert.equal(privateEvents[1][0].from.socketId, a.id);
      assert.equal(privateEvents[1][0].text, "<b>private</b>");
      await request(b, "private:send", { to: a.id, text: "reply" });
      await request(a, "private:send", { to: a.id, text: "note to myself" });
      await settle();
      assert.deepEqual(
        privateEvents.map((list) => list.length),
        [3, 2, 0, 0],
      );
      assert.equal(
        (await request(a, "private:send", { to: guest.id, text: "no" })).error
          .code,
        "USER_OFFLINE",
      );
      assert.equal(
        (await request(a, "private:send", { to: b.id, text: "" })).error.code,
        "INVALID_MESSAGE",
      );
      assert.equal(
        (await request(a, "private:send", { to: b.id, text: "x".repeat(2001) }))
          .error.code,
        "INVALID_MESSAGE",
      );
    },
  );

  let first, second;
  await t.test(
    "R8/R9/R10: creator only, multiple groups, full directory, explicit self-join",
    async () => {
      let directory;
      c.on("groups:updated", (data) => {
        directory = data.groups;
      });
      first = (
        await request(a, "group:create", {
          name: "Team",
          members: [b.id, c.id],
        })
      ).data.group;
      second = (await request(a, "group:create", { name: "Team" })).data.group;
      await settle();
      assert.notEqual(first.groupId, second.groupId);
      assert.deepEqual(
        first.members.map((m) => m.socketId),
        [a.id],
      );
      assert.equal(directory.length, 2);
      assert.ok(
        directory.every(
          (group) => group.members.length === 1 && !("messages" in group),
        ),
      );
      const joined = await request(b, "group:join", {
        groupId: first.groupId,
        socketId: c.id,
      });
      assert.deepEqual(
        joined.data.group.members.map((m) => m.socketId).sort(),
        [a.id, b.id].sort(),
      );
      const repeated = await request(b, "group:join", {
        groupId: first.groupId,
      });
      assert.equal(repeated.data.group.members.length, 2);
      assert.equal(
        (await request(c, "group:join", { groupId: "missing" })).error.code,
        "GROUP_NOT_FOUND",
      );
      const late = await request(guest, "user:register", { name: "Late" });
      assert.equal(late.data.groups.length, 2);
      assert.equal(
        late.data.groups.find((group) => group.groupId === first.groupId)
          .members.length,
        2,
      );
    },
  );

  await t.test(
    "R11: non-members cannot send/receive; separate groups and bounded history",
    async () => {
      assert.equal(
        (
          await request(c, "group:send", {
            groupId: first.groupId,
            text: "forged",
          })
        ).error.code,
        "FORBIDDEN",
      );
      assert.equal(
        (await request(a, "group:send", { groupId: "missing", text: "no" }))
          .error.code,
        "GROUP_NOT_FOUND",
      );
      assert.equal(
        (await request(a, "group:send", { groupId: first.groupId, text: " " }))
          .error.code,
        "INVALID_MESSAGE",
      );
      await request(a, "group:send", {
        groupId: first.groupId,
        text: "first group",
      });
      await request(a, "group:send", {
        groupId: second.groupId,
        text: "second group",
      });
      await settle();
      assert.deepEqual(
        groupEvents.map((list) => list.length),
        [2, 1, 0, 0],
      );
      assert.equal(groupEvents[1][0].groupId, first.groupId);
      const joined = await request(c, "group:join", { groupId: first.groupId });
      assert.deepEqual(
        joined.data.messages.map((m) => m.text),
        ["first group"],
      );
      for (let i = 0; i < 102; i++)
        await request(b, "group:send", {
          groupId: first.groupId,
          text: `history-${i}`,
        });
      const history = (
        await request(c, "group:join", { groupId: first.groupId })
      ).data.messages;
      assert.equal(history.length, 100);
      assert.equal(history[0].text, "history-2");
      assert.ok(history.every((m) => m.groupId === first.groupId));
    },
  );

  await t.test(
    "disconnect removes online membership; reconnect does not restore permissions",
    async () => {
      const oldId = b.id;
      const removed = next(a, "groups:updated", (data) =>
        data.groups.every((g) => g.members.every((m) => m.socketId !== oldId)),
      );
      b.disconnect();
      await removed;
      assert.equal(
        (await request(a, "private:send", { to: oldId, text: "offline" })).error
          .code,
        "USER_OFFLINE",
      );
      const connected = next(b, "connect");
      b.connect();
      await connected;
      assert.notEqual(b.id, oldId);
      const registered = await request(b, "user:register", { name: "Bob" });
      assert.ok(
        registered.data.groups.every((group) =>
          group.members.every((m) => m.socketId !== b.id),
        ),
      );
      assert.equal(
        (
          await request(b, "group:send", {
            groupId: first.groupId,
            text: "not joined",
          })
        ).error.code,
        "FORBIDDEN",
      );
      const empty = next(
        c,
        "groups:updated",
        (data) =>
          data.groups.find((g) => g.groupId === second.groupId).members
            .length === 0,
      );
      a.disconnect();
      await empty;
      assert.equal(
        (await request(b, "group:join", { groupId: second.groupId })).ok,
        true,
      );
    },
  );
});
