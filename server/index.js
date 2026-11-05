const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { Server } = require("socket.io");
const { createState } = require("./state");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { summarizeMessages: summarizeMessagesWithGemini } = require("./ai");

function createChatServer({
  summarizeMessages = summarizeMessagesWithGemini,
} = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { transports: ["websocket"] });
  const state = createState();
  const pendingSummaries = new Set();
  const groupMessageVersions = new Map();
  const privateMessageVersions = new Map();
  const { users, groups, groupMessages, privateMessages } = state;
  const reactionEmojis = ["👍", "❤️", "😂"];
  const privateKey = (a, b) => JSON.stringify([a, b].sort());
  app.use(express.static(path.join(__dirname, "..", "client")));

  function broadcast(event, data) {
    for (const id of users.keys()) io.to(id).emit(event, data);
  }

  io.on("connection", (socket) => {
    // Requests acknowledge once; message events update the chat history.
    function handle(event, action, requireRegistration = true) {
      socket.on(event, (payload, ack) => {
        if (typeof ack !== "function") return;
        const fail = (code, message) =>
          ack({ ok: false, error: { code, message } });
        if (requireRegistration && !users.has(socket.id)) {
          return fail("NOT_REGISTERED", "Register a name first.");
        }
        action(payload ?? {}, (data = {}) => ack({ ok: true, data }), fail);
      });
    }
    const clean = (value) => (typeof value === "string" ? value.trim() : "");
    const validText = (value) => value.length >= 1 && value.length <= 2000;
    const resolveReply = (history, replyToMessageId, fail) => {
      if (replyToMessageId == null) return null;

      if (
        typeof replyToMessageId !== "string" ||
        replyToMessageId.length === 0
      ) {
        fail("INVALID_REPLY", "The message to reply to is invalid.");
        return undefined;
      }

      const original = history.find(
        (item) => item.messageId === replyToMessageId,
      );

      if (!original) {
        fail("MESSAGE_NOT_FOUND", "The message to reply to is unavailable.");
        return undefined;
      }

      return {
        messageId: original.messageId,
        fromName: original.from.name,
        text: original.text,
      };
    };
    const message = (text) => ({
      messageId: randomUUID(),
      from: { socketId: socket.id, name: users.get(socket.id) },
      text,
      sentAt: new Date().toISOString(),
      reactions: [],
    });

    handle(
      "user:register",
      (payload, ok, fail) => {
        const name = clean(payload.name);
        if (users.has(socket.id))
          return fail("ALREADY_REGISTERED", "Already registered.");
        if (!name || name.length > 32)
          return fail("INVALID_NAME", "Name must be 1–32 characters.");
        if (
          [...users.values()].some(
            (other) => other.toLowerCase() === name.toLowerCase(),
          )
        ) {
          return fail("NAME_TAKEN", "This name is already in use.");
        }
        users.set(socket.id, name);
        ok({
          self: { socketId: socket.id, name },
          users: state.userList(),
          groups: state.groupList(),
        });
        broadcast("users:updated", { users: state.userList() });
      },
      false,
    );

    handle("private:send", (payload, ok, fail) => {
      const text = clean(payload.text);
      if (!validText(text))
        return fail("INVALID_MESSAGE", "Message must be 1–2,000 characters.");
      if (!users.has(payload.to))
        return fail("USER_OFFLINE", "This user is no longer online.");
      // Union routing emits once even when sending to yourself.
      const key = privateKey(socket.id, payload.to);
      if (!privateMessages.has(key)) privateMessages.set(key, []);
      const history = privateMessages.get(key);
      const replyTo = resolveReply(history, payload.replyToMessageId, fail);
      if (replyTo === undefined) return;

      const data = {
        ...message(text),
        to: payload.to,
        replyTo,
      };
      history.push(data);
      if (history.length > 100) history.shift();
      privateMessageVersions.set(
        key,
        (privateMessageVersions.get(key) || 0) + 1,
      );
      io.to(socket.id).to(payload.to).emit("private:message", data);
      ok();
    });

    handle("group:create", (payload, ok, fail) => {
      const name = clean(payload.name);
      if (!name || name.length > 32)
        return fail("INVALID_NAME", "Group name must be 1–32 characters.");
      const groupId = randomUUID();
      groups.set(groupId, { name, members: new Set([socket.id]) });
      groupMessages.set(groupId, []);
      groupMessageVersions.set(groupId, 0);
      socket.join(`group:${groupId}`);
      ok({ group: state.groupData(groupId), messages: [] });
      broadcast("groups:updated", { groups: state.groupList() });
    });

    handle("group:join", (payload, ok, fail) => {
      const group = groups.get(payload.groupId);
      if (!group) return fail("GROUP_NOT_FOUND", "This group does not exist.");
      // Only the requesting socket can join; supplied member IDs are ignored.
      group.members.add(socket.id);
      socket.join(`group:${payload.groupId}`);
      ok({
        group: state.groupData(payload.groupId),
        messages: groupMessages.get(payload.groupId),
      });
      broadcast("groups:updated", { groups: state.groupList() });
    });

    handle("group:send", (payload, ok, fail) => {
      const group = groups.get(payload.groupId);
      if (!group) return fail("GROUP_NOT_FOUND", "This group does not exist.");
      if (!group.members.has(socket.id))
        return fail("FORBIDDEN", "Join this group before sending messages.");
      const text = clean(payload.text);
      if (!validText(text))
        return fail("INVALID_MESSAGE", "Message must be 1–2,000 characters.");
      const history = groupMessages.get(payload.groupId);
      const replyTo = resolveReply(history, payload.replyToMessageId, fail);
      if (replyTo === undefined) return;

      const data = {
        ...message(text),
        groupId: payload.groupId,
        replyTo,
      };
      history.push(data);
      if (history.length > 100) history.shift();

      groupMessageVersions.set(
        payload.groupId,
        (groupMessageVersions.get(payload.groupId) || 0) + 1,
      );
      io.to(`group:${payload.groupId}`).emit("group:message", data);
      ok();
    });

    handle("message:unsend", (payload, ok, fail) => {
      let history;
      let groupRoom;

      if (payload.type === "group") {
        const group = groups.get(payload.groupId);

        if (!group)
          return fail("GROUP_NOT_FOUND", "This group does not exist.");

        if (!group.members.has(socket.id))
          return fail(
            "FORBIDDEN",
            "Join this group before unsending messages.",
          );

        history = groupMessages.get(payload.groupId);
        groupRoom = `group:${payload.groupId}`;
      } else if (payload.type === "private") {
        if (!users.has(payload.to))
          return fail("USER_OFFLINE", "This user is no longer online.");

        history = privateMessages.get(privateKey(socket.id, payload.to));
      } else {
        return fail("INVALID_CONVERSATION", "Unknown conversation type.");
      }

      const messageIndex = history?.findIndex(
        (item) => item.messageId === payload.messageId,
      );

      if (messageIndex == null || messageIndex < 0) {
        return fail(
          "MESSAGE_NOT_FOUND",
          "This message is no longer available.",
        );
      }

      const target = history[messageIndex];

      // ตรวจผู้ส่งจากข้อมูลที่ server เก็บไว้ ห้ามเชื่อข้อมูลจาก client
      if (target.from.socketId !== socket.id) {
        return fail("FORBIDDEN", "You can only unsend your own messages.");
      }

      // ลบข้อความต้นฉบับออกจาก history จริง
      history.splice(messageIndex, 1);

      // ล้าง quote ในข้อความตอบกลับ แต่ไม่ลบข้อความตอบกลับนั้น
      for (const item of history) {
        if (item.replyTo?.messageId === target.messageId) {
          item.replyTo = null;
        }
      }

      const update = {
        type: payload.type,
        messageId: target.messageId,
        ...(payload.type === "group"
          ? { groupId: payload.groupId }
          : { participantIds: [target.from.socketId, target.to] }),
      };

      if (payload.type === "group") {
        groupMessageVersions.set(
          payload.groupId,
          (groupMessageVersions.get(payload.groupId) || 0) + 1,
        );

        io.to(groupRoom).emit("message:unsent", update);
      } else {
        const key = privateKey(socket.id, payload.to);
        privateMessageVersions.set(
          key,
          (privateMessageVersions.get(key) || 0) + 1,
        );

        // Socket.IO จะส่งให้แต่ละ socket ใน union เพียงครั้งเดียว
        io.to(target.from.socketId)
          .to(target.to)
          .emit("message:unsent", update);
      }

      ok();
    });

    handle("message:react", (payload, ok, fail) => {
      if (!reactionEmojis.includes(payload.emoji)) {
        return fail("INVALID_REACTION", "Choose 👍, ❤️ or 😂.");
      }
      let history;
      let groupRoom;
      if (payload.type === "group") {
        const group = groups.get(payload.groupId);
        if (!group)
          return fail("GROUP_NOT_FOUND", "This group does not exist.");
        if (!group.members.has(socket.id))
          return fail("FORBIDDEN", "Join this group before reacting.");
        history = groupMessages.get(payload.groupId);
        groupRoom = `group:${payload.groupId}`;
      } else if (payload.type === "private") {
        if (!users.has(payload.to))
          return fail("USER_OFFLINE", "This user is no longer online.");
        history = privateMessages.get(privateKey(socket.id, payload.to));
      } else {
        return fail("INVALID_REACTION", "Unknown conversation type.");
      }
      const target = history?.find(
        (item) => item.messageId === payload.messageId,
      );
      if (!target)
        return fail(
          "MESSAGE_NOT_FOUND",
          "This message is no longer available for reactions.",
        );
      const currentName = users.get(socket.id);

      const previous = target.reactions.findIndex(
        (item) => item.name === currentName,
      );

      const oldEmoji = previous < 0 ? null : target.reactions[previous].emoji;
      if (previous >= 0) target.reactions.splice(previous, 1);
      if (oldEmoji !== payload.emoji) {
        target.reactions.push({
          name: currentName,
          emoji: payload.emoji,
        });
      }
      const update = {
        messageId: target.messageId,
        reactions: target.reactions,
      };
      if (groupRoom) {
        io.to(groupRoom).emit("message:reactions", {
          ...update,
          groupId: payload.groupId,
        });
      } else {
        io.to(target.from.socketId)
          .to(target.to)
          .emit("message:reactions", update);
      }
      ok();
    });

    socket.on("disconnect", () => {
      if (!users.delete(socket.id)) return;
      for (const key of privateMessages.keys()) {
        if (JSON.parse(key).includes(socket.id)) {
          privateMessages.delete(key);
          privateMessageVersions.delete(key);
        }
      }
      for (const group of groups.values()) group.members.delete(socket.id);
      broadcast("users:updated", { users: state.userList() });
      broadcast("groups:updated", { groups: state.groupList() });
      pendingSummaries.delete(socket.id);
    });

    socket.on("ai:summarize", async (payload = {}, ack) => {
      if (typeof ack !== "function") return;

      const fail = (code, message) =>
        ack({ ok: false, error: { code, message } });

      if (!users.has(socket.id)) {
        return fail("NOT_REGISTERED", "Register a name first.");
      }

      const type = payload?.type || (payload?.groupId ? "group" : undefined);
      let groupId;
      let privateTo;
      let versionKey;
      let messages;

      if (type === "group") {
        groupId = payload.groupId;
        const group = groups.get(groupId);

        if (!group) {
          return fail("GROUP_NOT_FOUND", "This group does not exist.");
        }

        if (!group.members.has(socket.id)) {
          return fail(
            "FORBIDDEN",
            "Join this group before requesting a summary.",
          );
        }

        versionKey = groupId;
        messages = (groupMessages.get(groupId) || []).slice(-100);
      } else if (type === "private") {
        privateTo = payload?.to;

        if (!users.has(privateTo)) {
          return fail("USER_OFFLINE", "This user is no longer online.");
        }

        versionKey = privateKey(socket.id, privateTo);
        messages = (privateMessages.get(versionKey) || []).slice(-100);
      } else {
        return fail(
          "INVALID_CONVERSATION",
          "Choose a private chat or group to summarize.",
        );
      }

      if (pendingSummaries.has(socket.id)) {
        return fail("AI_BUSY", "A summary request is already in progress.");
      }

      if (messages.length === 0) {
        return fail(
          "NO_MESSAGES",
          "There are no messages in this conversation to summarize.",
        );
      }

      pendingSummaries.add(socket.id);

      try {
        const getMessageVersion = () =>
          type === "group"
            ? groupMessageVersions.get(versionKey) || 0
            : privateMessageVersions.get(versionKey) || 0;
        const messageVersion = getMessageVersion();
        const summary = await summarizeMessages(messages);

        // Recheck access after waiting for the AI provider.
        if (!socket.connected || !users.has(socket.id)) return;

        if (type === "group") {
          if (!groups.get(groupId)?.members.has(socket.id)) return;
        } else if (!users.has(privateTo)) {
          return fail("USER_OFFLINE", "This user is no longer online.");
        }

        if (getMessageVersion() !== messageVersion) {
          return fail(
            "SUMMARY_STALE",
            "Conversation messages changed while summarizing. Please try again.",
          );
        }

        ack({
          ok: true,
          data: {
            type,
            groupId,
            to: privateTo,
            messageCount: messages.length,
            summary,
          },
        });
      } catch (error) {
        const apiKey = process.env.GEMINI_API_KEY;
        const errorMessage = String(error?.message || "Unknown error").replace(
          apiKey || /$^/,
          "[redacted]",
        );
        console.error("AI summary request failed:", {
          name: error?.name || "Error",
          status: error?.status,
          code: error?.code,
          message: errorMessage,
          requestId: error?.request_id,
        });
        fail("AI_UNAVAILABLE", "AI summary is unavailable. Try again later.");
      } finally {
        pendingSummaries.delete(socket.id);
      }
    });
  });
  return { httpServer, io };
}

if (require.main === module) {
  const { httpServer } = createChatServer();
  const port = Number(process.env.PORT || 3000);
  httpServer.listen(port, "0.0.0.0", () =>
    console.log(`Chat server listening on port ${port}`),
  );
}

module.exports = { createChatServer };
