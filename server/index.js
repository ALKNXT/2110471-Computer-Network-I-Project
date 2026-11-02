const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  transports: ["websocket"],
});

const PORT = 3000;
const users = new Map();

app.use(express.static(path.join(__dirname, "..", "client")));

function sendUsersList() {
  const userList = [...users.entries()].map(([socketId, name]) => ({
    socketId,
    name,
  }));

  for (const socketId of users.keys()) {
    io.to(socketId).emit("users:updated", { users: userList });
  }
}

function replyError(ack, code, message) {
  if (typeof ack === "function") {
    ack({ ok: false, error: { code, message } });
  }
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("user:register", (payload, ack) => {
    const name =
      typeof payload?.name === "string" ? payload.name.trim() : "";

    if (users.has(socket.id)) {
      return replyError(
        ack,
        "ALREADY_REGISTERED",
        "This connection has already registered a name.",
      );
    }

    if (name.length < 1 || name.length > 32) {
      return replyError(
        ack,
        "INVALID_NAME",
        "Name must be between 1 and 32 characters.",
      );
    }

    const nameAlreadyUsed = [...users.values()].some(
      (existingName) => existingName.toLowerCase() === name.toLowerCase(),
    );

    if (nameAlreadyUsed) {
      return replyError(ack, "NAME_TAKEN", "This name is already in use.");
    }

    users.set(socket.id, name);

    const userList = [...users.entries()].map(([socketId, userName]) => ({
      socketId,
      name: userName,
    }));

    if (typeof ack === "function") {
      ack({
        ok: true,
        data: {
          self: { socketId: socket.id, name },
          users: userList,
        },
      });
    }

    sendUsersList();
    console.log(`${name} registered (${socket.id})`);
  });

  socket.on("chat:send", (payload, ack) => {
    const senderName = users.get(socket.id);

    if (!senderName) {
      return replyError(
        ack,
        "NOT_REGISTERED",
        "Register a name before sending a message.",
      );
    }

    const text =
      typeof payload?.text === "string" ? payload.text.trim() : "";

    if (text.length < 1 || text.length > 2000) {
      return replyError(
        ack,
        "INVALID_MESSAGE",
        "Message must be between 1 and 2,000 characters.",
      );
    }

    const message = {
      from: {
        socketId: socket.id,
        name: senderName,
      },
      text,
      sentAt: new Date().toISOString(),
    };

    for (const socketId of users.keys()) {
      io.to(socketId).emit("chat:message", message);
    }

    if (typeof ack === "function") {
      ack({ ok: true, data: {} });
    }
  });

  socket.on("disconnect", () => {
    const oldName = users.get(socket.id);
    users.delete(socket.id);

    console.log(`Disconnected: ${oldName ?? socket.id}`);

    if (oldName) {
      sendUsersList();
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat server listening on http://0.0.0.0:${PORT}`);
});