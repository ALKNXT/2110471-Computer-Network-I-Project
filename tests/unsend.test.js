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

function doesNotReceive(socket, event, timeoutMs = 150) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve(true);
    }, timeoutMs);

    function listener() {
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(false);
    }

    socket.on(event, listener);
  });
}

test("Unsend deletes only the sender's message and clears its reply quotes", async (t) => {
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
  const carol = await client("Carol");

  await t.test("group unsend removes the message for all members, preserving replies", async () => {
    const group = (
      await request(alice, "group:create", { name: "Team" })
    ).data.group;
    await request(bob, "group:join", { groupId: group.groupId });
    await request(carol, "group:join", { groupId: group.groupId });

    const originalAtBob = next(bob, "group:message");
    await request(alice, "group:send", {
      groupId: group.groupId,
      text: "Message to unsend",
    });
    const original = await originalAtBob;

    const replyAtAlice = next(alice, "group:message");
    await request(bob, "group:send", {
      groupId: group.groupId,
      text: "Reply should remain",
      replyToMessageId: original.messageId,
    });
    const reply = await replyAtAlice;
    assert.equal(reply.replyTo.messageId, original.messageId);

    const unauthorized = await request(bob, "message:unsend", {
      type: "group",
      groupId: group.groupId,
      messageId: original.messageId,
    });
    assert.equal(unauthorized.error.code, "FORBIDDEN");

    const unsentEvents = [
      next(alice, "message:unsent"),
      next(bob, "message:unsent"),
      next(carol, "message:unsent"),
    ];
    const result = await request(alice, "message:unsend", {
      type: "group",
      groupId: group.groupId,
      messageId: original.messageId,
    });
    assert.equal(result.ok, true);

    const updates = await Promise.all(unsentEvents);
    assert.ok(updates.every((update) => update.messageId === original.messageId));
    assert.ok(updates.every((update) => update.groupId === group.groupId));

    const history = (
      await request(bob, "group:join", { groupId: group.groupId })
    ).data.messages;
    assert.equal(
      history.some((message) => message.messageId === original.messageId),
      false,
    );
    const retainedReply = history.find((message) => message.messageId === reply.messageId);
    assert.ok(retainedReply);
    assert.equal(retainedReply.text, "Reply should remain");
    assert.equal(retainedReply.replyTo, null);
  });

  await t.test("private unsend reaches only its participants", async () => {
    const originalAtBob = next(bob, "private:message");
    await request(alice, "private:send", {
      to: bob.id,
      text: "Private message to unsend",
    });
    const original = await originalAtBob;

    const replyAtAlice = next(alice, "private:message");
    await request(bob, "private:send", {
      to: alice.id,
      text: "Private reply remains",
      replyToMessageId: original.messageId,
    });
    const reply = await replyAtAlice;

    const carolDidNotReceive = doesNotReceive(carol, "message:unsent");
    const aliceUnsent = next(alice, "message:unsent");
    const bobUnsent = next(bob, "message:unsent");

    const result = await request(alice, "message:unsend", {
      type: "private",
      to: bob.id,
      messageId: original.messageId,
    });
    assert.equal(result.ok, true);

    const [aliceUpdate, bobUpdate, carolWasExcluded] = await Promise.all([
      aliceUnsent,
      bobUnsent,
      carolDidNotReceive,
    ]);
    assert.equal(aliceUpdate.messageId, original.messageId);
    assert.equal(bobUpdate.messageId, original.messageId);
    assert.equal(carolWasExcluded, true);

    const replyToDeleted = await request(bob, "private:send", {
      to: alice.id,
      text: "Cannot reply to removed message",
      replyToMessageId: original.messageId,
    });
    assert.equal(replyToDeleted.error.code, "MESSAGE_NOT_FOUND");

    // Another participant cannot unsend a reply they did not author.
    const nextUnsend = await request(alice, "message:unsend", {
      type: "private",
      to: bob.id,
      messageId: reply.messageId,
    });
    assert.equal(nextUnsend.error.code, "FORBIDDEN");
  });

  await t.test("unknown messages and unsupported conversation types are rejected", async () => {
    const unknown = await request(alice, "message:unsend", {
      type: "group",
      groupId: "missing-group",
      messageId: "missing-message",
    });
    assert.equal(unknown.error.code, "GROUP_NOT_FOUND");

    const invalidType = await request(alice, "message:unsend", {
      type: "other",
      messageId: "missing-message",
    });
    assert.equal(invalidType.error.code, "INVALID_CONVERSATION");
  });
});

test("An in-flight summary is rejected if a group message is unsent", async (t) => {
  let markSummaryStarted;
  let finishSummary;
  let summarizedMessages = [];
  const summaryStarted = new Promise((resolve) => {
    markSummaryStarted = resolve;
  });
  const summaryResult = new Promise((resolve) => {
    finishSummary = resolve;
  });
  const server = createChatServer({
    summarizeMessages: async (messages) => {
      summarizedMessages = messages;
      markSummaryStarted();
      return summaryResult;
    },
  });
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
  const group = (await request(alice, "group:create", { name: "Summary" }))
    .data.group;
  const messageEvent = next(alice, "group:message");
  await request(alice, "group:send", {
    groupId: group.groupId,
    text: "This should be unsent",
  });
  const message = await messageEvent;

  const summaryRequest = request(alice, "ai:summarize", {
    groupId: group.groupId,
  });
  await summaryStarted;
  assert.ok(summarizedMessages.some((item) => item.messageId === message.messageId));

  const unsent = await request(alice, "message:unsend", {
    type: "group",
    groupId: group.groupId,
    messageId: message.messageId,
  });
  assert.equal(unsent.ok, true);

  finishSummary("Stale summary containing the removed message");
  const result = await summaryRequest;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SUMMARY_STALE");
});
