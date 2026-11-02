# Computer Network I — Socket Chat

Part 2 implements R3–R11: unique usernames, an online list including yourself, separate private/group conversations, and groups that users explicitly join. The browser and server exchange messages through Socket.IO with WebSocket transport only.

## Run locally

Use Node.js 22 or newer (also required by the automated tests).

```powershell
npm ci
npm start
```

Open `http://localhost:3000` in three tabs and register as Alice, Bob, and Carol. Click an online name for a private conversation. Create a group, then use **Join group** from another tab. **Conversations** switches between rooms and indicates unread messages. Each room keeps its own messages and draft.

If an older server is running, stop it with Ctrl+C before restarting. Refresh all browser tabs after updating the code. An alternative port can be set with `$env:PORT = '3001'` before `npm start`.

## Demo on two physical computers (R1)

1. Connect both computers to the same LAN/Wi-Fi.
2. Run the server on computer 1 and find its IPv4 address using `ipconfig`.
3. Allow inbound TCP 3000 through the server's firewall for the demo network.
4. On both computers, open `http://<server-LAN-IP>:3000` and register different names.
5. Send messages in both directions. A third browser tab/profile can act as the non-member for privacy checks.

Two tabs are useful for development but do not replace the two physical computers required by R1. Prepare the Implementation Explanation slides described in the assignment.

## Part 2 verification

```powershell
npm test
```

Tests start an isolated server on a temporary localhost port and exercise real Socket.IO connections. They cover registration, duplicate names, online lists, private routing including self-chat, forged sender data, group creation, voluntary membership, late-client group lists, non-member rejection, history, and disconnect/reconnect. They do not require internet, an AI key, or a running demo server.

Manual UI checklist:

| Requirement     | Check                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R3–R4           | Reject a duplicate name (including different capitalization); all clients see the online list including themselves.                        |
| R5–R6           | Open several private/group rooms. Each has its own messages, draft, text box, and chat window. Incoming messages stay in the correct room. |
| R7              | Alice sends to Bob. Only Alice/Bob receive the message; Carol sees nothing. Reply and try a self-message.                                  |
| R8–R9           | Create two groups. Each starts with only its creator. Everyone, including a late client, sees both groups and their members.               |
| R10             | Bob must click Join group; the creator cannot add Bob.                                                                                     |
| R11             | Alice/Bob exchange group messages while Carol is outside. Carol receives nothing. After joining, Carol can participate.                    |
| Session cleanup | Disconnect Bob. Online/group lists update. After reconnecting, Bob must register and join groups again.                                    |

## State and scope

- State is in memory and resets when the server restarts; no database or persistent accounts.
- `socket.id` identifies a session. Disconnect clears that client's UI and removes its memberships. Other clients retain their conversation with the offline session but cannot send to it.
- Current group members can read the most recent 100 stored group messages, including messages from before they joined. Non-members receive only group/member metadata.
- Private messages go only to the sender and recipient. Group messages go only to members. Server-side checks enforce these rules.
- Acknowledgements report success/errors. Only message events append new messages; there is no automatic resend on timeout.
- AI is a Part 3 plan in `ARCHITECTURE.md`; it is not implemented or needed to run Part 2.
