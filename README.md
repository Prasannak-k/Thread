Thread — a real-time chat app

A two-person / group chat app with accounts, threaded replies, moderated deletion,
and admin-controlled groups — built as a small full-stack project (no client-only
tricks: messages live in a real database behind a real API).

## Stack

- **Backend:** Node.js, Express, SQLite (via `better-sqlite3`)
- **Auth:** bcrypt password hashing + JWT sessions
- **Real-time:** native WebSockets (`ws`) — REST for actions, WS for push updates
- **Frontend:** vanilla HTML/CSS/JS (no framework, no build step)

## Features

- Sign up / log in (passwords hashed with bcrypt, sessions via JWT)
- Direct messages between any two users
- Reply to a specific message — quoted inline, click to jump to the original
- Delete your own messages — replaced with a "This message was deleted" tombstone,
  not removed from the thread
- Group chats:
  - Creator becomes the group's admin
  - Admins can add or remove members
  - Any member can leave a group themselves; if the last admin leaves, the
    longest-standing remaining member is automatically promoted
  - Admins can restrict the group so **only admins can send messages**
  - Admins can restrict the group so **only admins can delete messages**
    (this overrides a member's ability to delete even their own messages)
- Live updates across devices/tabs over WebSockets — no polling, no localStorage
  message storage

## Running it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Create two accounts (e.g. in two browser
windows, or one normal + one incognito) to chat between them.

The SQLite database file (`thread.db`) is created automatically on first run in
the project folder — that's your persistent storage; data survives server restarts.

## Project structure

```
thread-app/
├── server.js        # Express routes, auth, permissions, WebSocket broadcast
├── db.js             # SQLite schema + connection
├── package.json
└── public/            # static frontend
    ├── index.html      # login/register screen + chat UI
    ├── style.css
    └── app.js           # fetch() calls to the API + WebSocket client
```

## API overview

| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Create an account |
| POST | `/api/auth/login` | Log in, get a JWT |
| GET | `/api/me` | Current user (auth required) |
| GET | `/api/users` | All registered users |
| GET | `/api/chats` | Chats you belong to |
| POST | `/api/chats/dm` | Get/create a DM with another user |
| POST | `/api/chats/group` | Create a group |
| GET | `/api/chats/:id/messages` | Message history for a chat |
| POST | `/api/chats/:id/messages` | Send a message |
| DELETE | `/api/messages/:id` | Delete a message (permission-checked) |
| POST | `/api/chats/:id/members` | Add a member (admin only) |
| DELETE | `/api/chats/:id/members/:userId` | Remove a member (admin), or leave (self) |
| PATCH | `/api/chats/:id/settings` | Toggle admin-only messaging/deletion (admin only) |

All permission rules (who can message, who can delete, who can manage members)
are enforced **server-side**, not just hidden in the UI.

## Notes for a resume write-up

Things worth calling out if you're describing this project:
- Server-authoritative permission checks (client UI just reflects what the API allows)
- Password hashing with bcrypt, stateless auth via signed JWTs
- Parameterized SQL everywhere (no string-built queries — SQL-injection safe)
- Real-time fan-out over WebSockets keyed by chat membership, not a broadcast-to-everyone model
- Soft-delete pattern for messages (tombstone rows, not `DELETE FROM`) so reply
  chains and audit trails stay intact

