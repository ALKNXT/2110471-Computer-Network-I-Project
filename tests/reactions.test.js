const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { io: connect } = require(
  path.resolve(
    path.dirname(require.resolve("socket.io")),
    "../client-dist/socket.io.js",
  ),
);
const { createChatServer } = require("../server");
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
function request(socket, event, payload) {
  return new Promise((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(event, payload, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
  );
}
function next(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out: ${event}`));
    }, 3000);
    function listener(data) {
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    }
    socket.on(event, listener);
  });
}

test("Message reactions respect private/group permissions and history", async (t) => {
  const server = createChatServer();
  const clients = [];
  t.after(async () => {
    clients.forEach((socket) => socket.disconnect());
    await new Promise((resolve) => server.io.close(resolve));
  });
  await new Promise((resolve) =>
    server.httpServer.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function client(name) {
    const socket = connect(url, {
      transports: ["websocket"],
      forceNew: true,
      autoConnect: false,
      reconnection: false,
    });
    clients.push(socket);
    const connected = next(socket, "connect");
    socket.connect();
    await connected;
    if (name)
      assert.equal((await request(socket, "user:register", { name })).ok, true);
    return socket;
  }
  const a = await client("Alice"),
    b = await client("Bob"),
    c = await client("Carol"),
    guest = await client();
  const updates = [[], [], [], []];
  clients.forEach((socket, i) =>
    socket.on("message:reactions", (data) => updates[i].push(data)),
  );
  const incoming = next(b, "private:message");
  await request(a, "private:send", { to: b.id, text: "private" });
  const pm = await incoming;
  const privateReaction = {
    type: "private",
    to: a.id,
    messageId: pm.messageId,
    emoji: "👍",
  };

  await t.test(
    "private reactions synchronize only to sender/receiver, toggle and switch",
    async () => {
      assert.ok(pm.messageId);
      assert.deepEqual(pm.reactions, []);
      assert.equal(
        (
          await request(b, "message:react", {
            ...privateReaction,
            socketId: c.id,
            name: "Spoofed",
          })
        ).ok,
        true,
      );
      await settle();
      assert.deepEqual(
        updates.map((list) => list.length),
        [1, 1, 0, 0],
      );
      assert.deepEqual(updates[0][0].reactions, [
        { socketId: b.id, name: "Bob", emoji: "👍" },
      ]);
      await request(b, "message:react", privateReaction);
      await settle();
      assert.deepEqual(updates[0].at(-1).reactions, []);
      await request(b, "message:react", privateReaction);
      await request(b, "message:react", { ...privateReaction, emoji: "❤️" });
      await request(a, "message:react", {
        ...privateReaction,
        to: b.id,
        emoji: "❤️",
      });
      await settle();
      assert.equal(updates[0].at(-1).reactions.length, 2);
      assert.ok(
        updates[0].at(-1).reactions.every((vote) => vote.emoji === "❤️"),
      );
    },
  );

  await t.test(
    "reject nonparticipants, unregistered actors, unsupported emoji and unknown IDs",
    async () => {
      assert.equal(
        (await request(c, "message:react", privateReaction)).error.code,
        "MESSAGE_NOT_FOUND",
      );
      assert.equal(
        (await request(guest, "message:react", privateReaction)).error.code,
        "NOT_REGISTERED",
      );
      assert.equal(
        (await request(b, "message:react", { ...privateReaction, emoji: "🔥" }))
          .error.code,
        "INVALID_REACTION",
      );
      assert.equal(
        (
          await request(b, "message:react", {
            ...privateReaction,
            type: "other",
          })
        ).error.code,
        "INVALID_REACTION",
      );
      assert.equal(
        (
          await request(b, "message:react", {
            ...privateReaction,
            messageId: "missing",
          })
        ).error.code,
        "MESSAGE_NOT_FOUND",
      );
      assert.equal(
        (
          await request(b, "message:react", {
            ...privateReaction,
            to: guest.id,
          })
        ).error.code,
        "USER_OFFLINE",
      );
      await settle();
      assert.equal(updates[2].length, 0);
      assert.equal(updates[3].length, 0);
    },
  );

  const group = (await request(a, "group:create", { name: "Team" })).data.group;
  await request(b, "group:join", { groupId: group.groupId });
  const received = next(b, "group:message");
  await request(a, "group:send", { groupId: group.groupId, text: "group" });
  const gm = await received;
  const groupReaction = {
    type: "group",
    groupId: group.groupId,
    messageId: gm.messageId,
    emoji: "😂",
  };

  await t.test(
    "group updates only reach members, and reactions survive joining/history",
    async () => {
      const baseline = updates.map((list) => list.length);
      assert.equal(
        (await request(c, "message:react", groupReaction)).error.code,
        "FORBIDDEN",
      );
      assert.equal((await request(b, "message:react", groupReaction)).ok, true);
      await settle();
      assert.deepEqual(
        updates.map((list, i) => list.length - baseline[i]),
        [1, 1, 0, 0],
      );
      assert.equal(updates[0].at(-1).groupId, group.groupId);
      const history = (
        await request(c, "group:join", { groupId: group.groupId })
      ).data.messages;
      assert.equal(history[0].messageId, gm.messageId);
      assert.deepEqual(history[0].reactions, [
        { socketId: b.id, name: "Bob", emoji: "😂" },
      ]);
      await request(c, "message:react", groupReaction);
      await settle();
      assert.equal(updates[0].at(-1).reactions.length, 2);
      assert.equal(updates[2].length, 1);
    },
  );

  await t.test(
    "a known message ID cannot be used in another conversation",
    async () => {
      const other = (await request(a, "group:create", { name: "Other" })).data
        .group;
      assert.equal(
        (
          await request(a, "message:react", {
            ...groupReaction,
            groupId: other.groupId,
          })
        ).error.code,
        "MESSAGE_NOT_FOUND",
      );
      assert.equal(
        (
          await request(a, "message:react", {
            ...groupReaction,
            messageId: pm.messageId,
          })
        ).error.code,
        "MESSAGE_NOT_FOUND",
      );
      assert.equal(
        (
          await request(a, "message:react", {
            ...groupReaction,
            groupId: "missing",
          })
        ).error.code,
        "GROUP_NOT_FOUND",
      );
    },
  );

  await t.test(
    "self-chat reaction is delivered once; expired history rejects reactions",
    async () => {
      const ownIncoming = next(a, "private:message");
      await request(a, "private:send", { to: a.id, text: "self" });
      const own = await ownIncoming;
      const baseline = updates[0].length;
      await request(a, "message:react", {
        type: "private",
        to: a.id,
        messageId: own.messageId,
        emoji: "👍",
      });
      await settle();
      assert.equal(updates[0].length, baseline + 1);
      for (let i = 0; i < 100; i++)
        await request(a, "group:send", {
          groupId: group.groupId,
          text: `new-${i}`,
        });
      assert.equal(
        (await request(b, "message:react", groupReaction)).error.code,
        "MESSAGE_NOT_FOUND",
      );
      for (let i = 0; i < 100; i++)
        await request(a, "private:send", { to: b.id, text: `new-${i}` });
      assert.equal(
        (await request(b, "message:react", privateReaction)).error.code,
        "MESSAGE_NOT_FOUND",
      );
    },
  );
});
