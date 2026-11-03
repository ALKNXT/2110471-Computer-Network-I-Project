const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { Server } = require("socket.io");
const { createState } = require("./state");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { summarizeMessages } = require("./ai");

function createChatServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { transports: ["websocket"] });
  const state = createState();
  const pendingSummaries = new Set();
  const { users, groups, groupMessages } = state;
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
    const message = (text) => ({
      from: { socketId: socket.id, name: users.get(socket.id) },
      text,
      sentAt: new Date().toISOString(),
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
      io.to(socket.id)
        .to(payload.to)
        .emit("private:message", { ...message(text), to: payload.to });
      ok();
    });

    handle("group:create", (payload, ok, fail) => {
      const name = clean(payload.name);
      if (!name || name.length > 32)
        return fail("INVALID_NAME", "Group name must be 1–32 characters.");
      const groupId = randomUUID();
      groups.set(groupId, { name, members: new Set([socket.id]) });
      groupMessages.set(groupId, []);
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
      const data = { ...message(text), groupId: payload.groupId };
      const history = groupMessages.get(payload.groupId);
      history.push(data);
      if (history.length > 100) history.shift();
      io.to(`group:${payload.groupId}`).emit("group:message", data);
      ok();
    });

    socket.on("disconnect", () => {
      if (!users.delete(socket.id)) return;
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

      const groupId = payload?.groupId;
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

      if (pendingSummaries.has(socket.id)) {
        return fail("AI_BUSY", "A summary request is already in progress.");
      }

      const messages = (groupMessages.get(groupId) || []).slice(-100);
      if (messages.length === 0) {
        return fail("NO_MESSAGES", "There are no group messages to summarize.");
      }

      pendingSummaries.add(socket.id);

      try {
        const summary = await summarizeMessages(messages);

        // ตรวจสิทธิ์อีกครั้งหลังรอ AI ป้องกันกรณีสมาชิกหลุดระหว่างประมวลผล
        if (
          !socket.connected ||
          !users.has(socket.id) ||
          !groups.get(groupId)?.members.has(socket.id)
        ) {
          return;
        }

        ack({
          ok: true,
          data: {
            groupId,
            messageCount: messages.length,
            summary,
          },
        });
      } catch (error) {
        const apiKey = process.env.OPENAI_API_KEY;
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
