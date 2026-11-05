/* global io */
const socket = io({ transports: ["websocket"] });
const el = (id) => document.getElementById(id);
const messagesList = el("messages");
let self = null;
let users = [];
let groups = [];
let activeRoom = null;
const rooms = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function request(event, payload, timeoutMs = 5000) {
  const session = socket.id;
  return new Promise((resolve, reject) => {
    if (!socket.connected)
      return reject(
        new Error("Disconnected. Register again after reconnecting."),
      );
    socket.timeout(timeoutMs).emit(event, payload, (err, result) => {
      if (!socket.connected || socket.id !== session)
        return reject(new Error("Your session ended. Register again."));
      if (err)
        return reject(
          new Error(
            "No confirmation received. Check the conversation before trying again.",
          ),
        );
      if (!result?.ok)
        return reject(new Error(result?.error?.message || "Request failed."));
      resolve(result.data);
    });
  });
}

function ensureRoom(type, id, name) {
  const key = `${type}:${id}`;
  if (!rooms.has(key))
    rooms.set(key, {
      key,
      type,
      id,
      name,
      messages: [],
      unread: 0,
      draft: "",
      pending: false,
      status: "",
      summary: "",
      summaryStatus: "",
      summaryPending: false,
    });
  return rooms.get(key);
}

function canSend(room) {
  if (!self || !socket.connected || !room) return false;
  return room.type === "private"
    ? users.some((user) => user.socketId === room.id)
    : groups.some(
        (group) =>
          group.groupId === room.id &&
          group.members.some((member) => member.socketId === self.socketId),
      );
}

function renderSummaryControls() {
  const room = rooms.get(activeRoom);
  const isGroup = room?.type === "group";

  el("summary-tools").hidden = !isGroup;
  el("summary-button").disabled =
    !isGroup || !canSend(room) || room.summaryPending;
  el("summary-status").textContent = room?.summaryStatus || "";

  el("summary-panel").hidden = !isGroup || !room.summary;
  el("summary-text").textContent = room?.summary || "";
}

function renderComposer() {
  const room = rooms.get(activeRoom);
  el("message-input").disabled = !canSend(room) || room.pending;
  el("send-button").disabled = !canSend(room) || room.pending;
  el("chat-status").textContent = !self
    ? "Register to start chatting."
    : !room
      ? "Choose a person or join a group."
      : !canSend(room)
        ? "This user is offline."
        : room.status ||
          "Only people in this conversation receive your messages.";
  renderSummaryControls();
}

function renderRoomList() {
  el("rooms-list").replaceChildren();
  for (const room of rooms.values()) {
    const item = element("li", "");
    const button = element(
      "button",
      `room-button${activeRoom === room.key ? " is-active" : ""}`,
      `${room.type === "group" ? "# " : ""}${room.name}${room.unread ? ` (${room.unread} new)` : ""}`,
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(activeRoom === room.key));
    button.onclick = () => openRoom(room);
    item.append(button);
    el("rooms-list").append(item);
  }
}

function renderActiveRoom() {
  const room = rooms.get(activeRoom);
  messagesList.replaceChildren();
  el("room-title").textContent = room?.name || "Choose a conversation";
  el("room-type").textContent = room
    ? room.type === "private"
      ? "PRIVATE CHAT"
      : "GROUP CHAT"
    : "YOUR MESSAGES";
  el("room-members").textContent =
    room?.type === "group"
      ? groups
          .find((group) => group.groupId === room.id)
          ?.members.map((member) => member.name)
          .join(", ") || ""
      : "";
  el("message-input").value = room?.draft || "";
  if (room?.messages.length) room.messages.forEach(addMessage);
  else
    messagesList.append(
      element(
        "li",
        "empty-messages",
        room
          ? "No messages yet. Say hello."
          : "Select a person or join a group to start chatting.",
      ),
    );
  renderComposer();
}

function openRoom(room) {
  activeRoom = room.key;
  room.unread = 0;
  renderRoomList();
  renderActiveRoom();
  if (canSend(room)) el("message-input").focus();
}

function receive(room, message) {
  room.messages.push(message);
  if (activeRoom === room.key) renderActiveRoom();
  else room.unread++;
  renderRoomList();
}

function renderUsers() {
  el("users-list").replaceChildren();
  el("user-count").textContent = String(users.length);
  for (const user of users) {
    const item = element("li", "");
    const button = element(
      "button",
      "room-button",
      user.name + (user.socketId === self?.socketId ? " (You)" : ""),
    );
    button.type = "button";
    button.onclick = () =>
      openRoom(ensureRoom("private", user.socketId, user.name));
    item.append(button);
    el("users-list").append(item);
  }
  renderComposer();
}

function acceptGroup(data) {
  const index = groups.findIndex(
    (group) => group.groupId === data.group.groupId,
  );
  if (index < 0) groups.push(data.group);
  else groups[index] = data.group;
  const room = ensureRoom("group", data.group.groupId, data.group.name);
  room.messages = data.messages;
  renderGroups();
  openRoom(room);
}

function renderGroups() {
  el("groups-list").replaceChildren();
  for (const group of groups) {
    const item = element("li", "group-item");
    const title = element("strong", "", group.name);
    const members = element(
      "p",
      "group-members",
      `Members: ${group.members.map((member) => member.name).join(", ") || "None online"}`,
    );
    const joined = group.members.some(
      (member) => member.socketId === self?.socketId,
    );
    const button = element(
      "button",
      "room-button",
      joined ? "Open group" : "Join group",
    );
    button.type = "button";
    button.disabled = !self;
    button.onclick = async () => {
      if (joined)
        return openRoom(ensureRoom("group", group.groupId, group.name));
      button.disabled = true;
      const session = socket.id;
      try {
        acceptGroup(await request("group:join", { groupId: group.groupId }));
      } catch (error) {
        if (socket.id === session)
          el("group-status").textContent = error.message;
      } finally {
        if (socket.id === session) renderGroups();
      }
    };
    item.append(title, members, button);
    el("groups-list").append(item);
  }
  if (!groups.length)
    el("groups-list").append(element("li", "empty-users", "No groups yet."));
  const room = rooms.get(activeRoom);
  el("room-members").textContent =
    room?.type === "group"
      ? groups
          .find((g) => g.groupId === room.id)
          ?.members.map((m) => m.name)
          .join(", ") || ""
      : "";
  renderComposer();
}
const reactionEmojis = ["👍", "❤️", "😂"];

function renderMessageReactions(message, container, room) {
  container.replaceChildren();
  const counts = element("div", "reaction-counts");
  const picker = element("div", "reaction-picker");
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Choose a reaction");
  for (const emoji of reactionEmojis) {
    const votes = (message.reactions || []).filter(
      (vote) => vote.emoji === emoji,
    );
    const selected = votes.some((vote) => vote.name === self?.name);
    function button(text, label) {
      const node = element(
        "button",
        `reaction-button${selected ? " is-selected" : ""}`,
        text,
      );
      node.type = "button";
      node.disabled = !canSend(room) || message.reactionPending;
      node.setAttribute("aria-label", label);
      node.setAttribute("aria-pressed", String(selected));
      node.onclick = async () => {
        if (!canSend(room) || message.reactionPending) return;
        message.reactionPending = true;
        renderMessageReactions(message, container, room);
        try {
          await request("message:react", {
            type: room.type,
            ...(room.type === "group" ? { groupId: room.id } : { to: room.id }),
            messageId: message.messageId,
            emoji,
          });
        } catch (error) {
          room.status = error.message;
          if (rooms.get(activeRoom) === room) renderComposer();
        } finally {
          message.reactionPending = false;
          renderMessageReactions(message, container, room);
        }
      };
      return node;
    }
    if (votes.length) {
      const badge = button(
        `${emoji} ${votes.length}`,
        `${emoji}: ${votes.length} reactions`,
      );
      badge.title = votes.map((vote) => vote.name).join(", ");
      counts.append(badge);
    }
    picker.append(button(emoji, `React with ${emoji}`));
  }
  container.append(counts, picker);
}

socket.on("message:reactions", ({ messageId, reactions }) => {
  for (const room of rooms.values()) {
    const message = room.messages.find((item) => item.messageId === messageId);
    if (!message) continue;
    message.reactions = reactions;
    if (room.key === activeRoom) {
      const container = messagesList.querySelector(
        `[data-message-id="${CSS.escape(messageId)}"] .message-reactions`,
      );
      if (container) renderMessageReactions(message, container, room);
    }
  }
});

function addMessage(message) {
  const item = document.createElement("li");
  const isOwnMessage =
    message.from.socketId === socket.id || message.from.name === self?.name;
  item.className = isOwnMessage ? "message-item own-message" : "message-item";
  item.dataset.messageId = message.messageId;
  item.tabIndex = 0;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = (message.from.name.trim()[0] || "?").toUpperCase();

  const content = document.createElement("div");
  content.className = "message-content";

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const sender = document.createElement("strong");
  sender.className = "message-sender";
  sender.textContent = isOwnMessage ? "You" : message.from.name;

  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.sentAt;
  time.textContent = new Date(message.sentAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  const body = document.createElement("p");
  body.className = "message-text";
  // Display user-entered content as plain text.
  body.textContent = message.text;

  meta.append(sender, time);
  content.append(meta, body);
  const reactions = element("div", "message-reactions");
  renderMessageReactions(message, reactions, rooms.get(activeRoom));
  content.append(reactions);
  item.append(avatar, content);
  messagesList.append(item);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function resetSession(text) {
  self = null;
  users = [];
  groups = [];
  rooms.clear();
  activeRoom = null;
  el("name-input").disabled = false;
  el("register-button").disabled = !socket.connected;
  el("create-group-button").disabled = true;
  el("group-name").disabled = true;
  el("group-status").textContent = "";
  el("register-status").textContent = text;
  renderUsers();
  renderGroups();
  renderRoomList();
  renderActiveRoom();
}

function connection(connected, text) {
  el("connection-status").textContent = text;
  el("connection-indicator").classList.toggle("is-connected", connected);
  el("connection-indicator").classList.toggle("is-error", !connected);
}
socket.on("connect", () => {
  connection(true, "Connected · WebSocket");
  resetSession("Choose a display name to join.");
});
socket.on("disconnect", () => {
  connection(false, "Disconnected");
  resetSession(
    "Connection lost. Register and join groups again after reconnecting.",
  );
});
socket.on("connect_error", () => {
  connection(false, "Connection failed");
  resetSession("Could not connect. Check the server address and network.");
});

el("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (self || !socket.connected) return;
  const session = socket.id;
  el("register-button").disabled = true;
  try {
    const data = await request("user:register", {
      name: el("name-input").value,
    });
    self = data.self;
    users = data.users;
    groups = data.groups;
    el("name-input").disabled = true;
    el("group-name").disabled = false;
    el("create-group-button").disabled = false;
    el("register-status").textContent = `Joined as ${self.name}.`;
    renderUsers();
    renderGroups();
  } catch (error) {
    if (socket.id === session)
      el("register-status").textContent = error.message;
  } finally {
    el("register-button").disabled = !!self || !socket.connected;
  }
});

el("create-group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!self || !socket.connected) return;
  const session = socket.id;
  el("create-group-button").disabled = true;
  try {
    acceptGroup(
      await request("group:create", { name: el("group-name").value }),
    );
    el("group-name").value = "";
    el("group-status").textContent =
      "Group created. Others can choose to join.";
  } catch (error) {
    if (socket.id === session) el("group-status").textContent = error.message;
  } finally {
    el("create-group-button").disabled = !self || !socket.connected;
  }
});

el("summary-button").addEventListener("click", async () => {
  const room = rooms.get(activeRoom);
  if (!room || room.type !== "group" || !canSend(room)) return;
  if (room.summaryPending) return;

  room.summaryPending = true;
  room.summaryStatus = "Summarizing recent messages...";
  renderSummaryControls();

  try {
    const data = await request("ai:summarize", { groupId: room.id }, 25_000);

    room.summary = data.summary;
    room.summaryStatus = `Summary of ${data.messageCount} recent messages.`;
  } catch (error) {
    room.summaryStatus = error.message;
  } finally {
    room.summaryPending = false;
    if (rooms.get(activeRoom) === room) renderActiveRoom();
    else renderSummaryControls();
  }
});

socket.on("users:updated", (data) => {
  if (self) {
    users = data.users;
    renderUsers();
  }
});
socket.on("groups:updated", (data) => {
  if (self) {
    groups = data.groups;
    renderGroups();
  }
});
socket.on("private:message", (message) => {
  if (!self) return;
  const peerId =
    message.from.socketId === self.socketId
      ? message.to
      : message.from.socketId;
  const peerName =
    users.find((user) => user.socketId === peerId)?.name || message.from.name;
  receive(ensureRoom("private", peerId, peerName), message);
});
socket.on("group:message", (message) => {
  if (!self) return;
  const group = groups.find((item) => item.groupId === message.groupId);
  if (group) receive(ensureRoom("group", group.groupId, group.name), message);
});

el("message-input").addEventListener("input", () => {
  const room = rooms.get(activeRoom);
  if (room) room.draft = el("message-input").value;
});
el("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const room = rooms.get(activeRoom);
  if (!canSend(room) || room.pending || !room.draft.trim()) return;
  const draft = room.draft;
  room.pending = true;
  room.status = "Sending...";
  renderComposer();
  try {
    await request(room.type === "private" ? "private:send" : "group:send", {
      ...(room.type === "private" ? { to: room.id } : { groupId: room.id }),
      text: draft,
    });
    room.draft = "";
    room.status = "Message accepted by the server.";
  } catch (error) {
    room.status = error.message;
  } finally {
    room.pending = false;
    if (rooms.get(activeRoom) === room) renderActiveRoom();
  }
});
