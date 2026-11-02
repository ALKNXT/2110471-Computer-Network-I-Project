const socket = io({
  transports: ["websocket"],
});

const connectionStatus = document.querySelector("#connection-status");
const connectionIndicator = document.querySelector("#connection-indicator");
const registerForm = document.querySelector("#register-form");
const nameInput = document.querySelector("#name-input");
const registerButton = document.querySelector("#register-button");
const registerStatus = document.querySelector("#register-status");
const usersList = document.querySelector("#users-list");
const userCount = document.querySelector("#user-count");
const messagesList = document.querySelector("#messages");
const emptyMessages = document.querySelector("#empty-messages");
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const chatStatus = document.querySelector("#chat-status");

let registered = false;

function setChatEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function setConnectionState(state, text) {
  connectionStatus.textContent = text;
  connectionIndicator.classList.toggle("is-connected", state === "connected");
  connectionIndicator.classList.toggle("is-error", state === "error");
}

function renderUsers(users) {
  usersList.replaceChildren();
  userCount.textContent = String(users.length);

  if (users.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "empty-users";
    emptyItem.textContent = "No one is here yet.";
    usersList.append(emptyItem);
    return;
  }

  for (const user of users) {
    const item = document.createElement("li");
    item.className = "user-item";

    const avatar = document.createElement("span");
    avatar.className = "user-avatar";
    avatar.textContent = (user.name.trim()[0] || "?").toUpperCase();

    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = user.name;

    item.append(avatar, name);

    if (registered && user.socketId === socket.id) {
      const youBadge = document.createElement("span");
      youBadge.className = "you-badge";
      youBadge.textContent = "YOU";
      item.append(youBadge);
    }

    usersList.append(item);
  }
}

function addMessage(message) {
  if (emptyMessages?.isConnected) {
    emptyMessages.remove();
  }

  const item = document.createElement("li");
  const isOwnMessage = message.from.socketId === socket.id;
  item.className = isOwnMessage ? "message-item own-message" : "message-item";

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
  item.append(avatar, content);
  messagesList.append(item);
  messagesList.scrollTop = messagesList.scrollHeight;
}

socket.on("connect", () => {
  setConnectionState("connected", "Connected · WebSocket");
  registerButton.disabled = false;
  registered = false;
  setChatEnabled(false);
  chatStatus.textContent = "Register to start chatting.";
  registerStatus.textContent = "Connected. Choose a display name to join.";
});

socket.on("disconnect", () => {
  setConnectionState("error", "Disconnected");
  registerButton.disabled = true;
  registered = false;
  usersList.replaceChildren();
  userCount.textContent = "0";
  setChatEnabled(false);
  chatStatus.textContent = "Connection lost. Reconnect and register again.";
  registerStatus.textContent = "You have been disconnected from the server.";
});

socket.on("connect_error", () => {
  setConnectionState("error", "Connection failed");
  registerButton.disabled = true;
  registered = false;
  setChatEnabled(false);
  registerStatus.textContent =
    "Could not connect. Check the server address and network.";
});

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();

  if (!name) {
    registerStatus.textContent = "Please enter a display name.";
    return;
  }

  registerButton.disabled = true;
  registerStatus.textContent = "Joining the chat...";

  socket.emit("user:register", { name }, (result) => {
    registerButton.disabled = false;

    if (!result?.ok) {
      registerStatus.textContent =
        result?.error?.message ?? "Could not join the chat.";
      return;
    }

    registered = true;
    registerStatus.textContent = `You joined as ${result.data.self.name}.`;
    chatStatus.textContent = "You are connected. Send a message to the room.";
    setChatEnabled(true);
    renderUsers(result.data.users);
    messageInput.focus();
  });
});

socket.on("users:updated", ({ users }) => {
  renderUsers(users);
});

socket.on("chat:message", (message) => {
  // Add new messages from the socket event only to avoid duplicates.
  addMessage(message);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!registered || !socket.connected) {
    chatStatus.textContent = "Connect and register before sending a message.";
    return;
  }

  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  sendButton.disabled = true;
  chatStatus.textContent = "Sending...";

  socket.emit("chat:send", { text }, (result) => {
    sendButton.disabled = !registered;

    if (!result?.ok) {
      chatStatus.textContent =
        result?.error?.message ?? "Message could not be sent.";
      return;
    }

    chatStatus.textContent = "Message delivered to the server.";
  });

  messageInput.value = "";
  messageInput.focus();
});