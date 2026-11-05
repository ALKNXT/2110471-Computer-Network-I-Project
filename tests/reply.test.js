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

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
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

test("Replies reference messages from the same conversation", async (t) => {
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
    await request(socket, "user:register", { name });
    return socket;
  }

  const alice = await client("Alice");
  const bob = await client("Bob");

  await t.test(
    "private replies include a trusted message preview",
    async () => {
      const originalEvent = next(bob, "private:message");
      assert.equal(
        (
          await request(alice, "private:send", {
            to: bob.id,
            text: "Private original",
          })
        ).ok,
        true,
      );
      const original = await originalEvent;
      assert.equal(original.replyTo, null);

      const replyEvent = next(alice, "private:message");
      assert.equal(
        (
          await request(bob, "private:send", {
            to: alice.id,
            text: "Private answer",
            replyToMessageId: original.messageId,
            replyTo: { fromName: "Forged", text: "Forged preview" },
          })
        ).ok,
        true,
      );
      const reply = await replyEvent;

      assert.equal(reply.text, "Private answer");
      assert.deepEqual(reply.replyTo, {
        messageId: original.messageId,
        fromName: "Alice",
        text: "Private original",
      });
    },
  );

  const groupA = (await request(alice, "group:create", { name: "Team A" })).data
    .group;
  await request(bob, "group:join", { groupId: groupA.groupId });
  const groupB = (await request(alice, "group:create", { name: "Team B" })).data
    .group;
  await request(bob, "group:join", { groupId: groupB.groupId });

  await t.test(
    "group members can reply to their own or another member's message",
    async () => {
      const originalEvent = next(bob, "group:message");
      assert.equal(
        (
          await request(alice, "group:send", {
            groupId: groupA.groupId,
            text: "Group original",
          })
        ).ok,
        true,
      );
      const original = await originalEvent;

      const ownReplyEvent = next(bob, "group:message");
      assert.equal(
        (
          await request(alice, "group:send", {
            groupId: groupA.groupId,
            text: "Alice replies to herself",
            replyToMessageId: original.messageId,
          })
        ).ok,
        true,
      );
      const ownReply = await ownReplyEvent;
      assert.deepEqual(ownReply.replyTo, {
        messageId: original.messageId,
        fromName: "Alice",
        text: "Group original",
      });

      const bobReplyEvent = next(alice, "group:message");
      assert.equal(
        (
          await request(bob, "group:send", {
            groupId: groupA.groupId,
            text: "Bob replies to Alice",
            replyToMessageId: original.messageId,
          })
        ).ok,
        true,
      );
      const bobReply = await bobReplyEvent;
      assert.deepEqual(bobReply.replyTo, {
        messageId: original.messageId,
        fromName: "Alice",
        text: "Group original",
      });
    },
  );

  await t.test(
    "unknown and cross-conversation message IDs are rejected",
    async () => {
      const originalEvent = next(bob, "group:message");
      await request(alice, "group:send", {
        groupId: groupA.groupId,
        text: "Only in Team A",
      });
      const original = await originalEvent;

      const invalidGroupReply = await request(bob, "group:send", {
        groupId: groupB.groupId,
        text: "Wrong group",
        replyToMessageId: original.messageId,
      });
      assert.equal(invalidGroupReply.error.code, "MESSAGE_NOT_FOUND");

      const invalidPrivateReply = await request(bob, "private:send", {
        to: alice.id,
        text: "Wrong conversation",
        replyToMessageId: original.messageId,
      });
      assert.equal(invalidPrivateReply.error.code, "MESSAGE_NOT_FOUND");

      const invalidId = await request(alice, "group:send", {
        groupId: groupA.groupId,
        text: "Unknown source",
        replyToMessageId: "missing-message-id",
      });
      assert.equal(invalidId.error.code, "MESSAGE_NOT_FOUND");

      const invalidType = await request(alice, "group:send", {
        groupId: groupA.groupId,
        text: "Malformed source ID",
        replyToMessageId: { id: original.messageId },
      });
      assert.equal(invalidType.error.code, "INVALID_REPLY");
    },
  );
});
