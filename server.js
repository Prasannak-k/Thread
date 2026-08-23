const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const uid = () => crypto.randomBytes(9).toString("base64url");
const now = () => Date.now();

/* ---------------- auth helpers ---------------- */

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function publicUser(row) {
  return { id: row.id, username: row.username };
}

/* ---------------- auth routes ---------------- */

app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.trim().length < 2 || password.length < 4) {
    return res.status(400).json({ error: "Username (2+ chars) and password (4+ chars) are required." });
  }
  const clean = username.trim();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(clean);
  if (existing) return res.status(409).json({ error: "That username is taken." });

  const user = { id: uid(), username: clean, password_hash: bcrypt.hashSync(password, 10), created_at: now() };
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(user.id, user.username, user.password_hash, user.created_at);

  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get((username || "").trim());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(publicUser(user));
});

app.get("/api/users", authMiddleware, (req, res) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY username").all();
  res.json(rows.map(publicUser));
});

/* ---------------- chat helpers ---------------- */

function memberIdsOf(chatId) {
  return db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?").all(chatId).map(r => r.user_id);
}
function adminIdsOf(chatId) {
  return db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND is_admin = 1").all(chatId).map(r => r.user_id);
}
function isMember(chatId, userId) {
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, userId);
}
function isChatAdmin(chatId, userId) {
  return !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? AND is_admin = 1").get(chatId, userId);
}
function chatRow(chatId) { return db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId); }

function serializeChat(chat, viewerId) {
  const members = memberIdsOf(chat.id);
  const admins = adminIdsOf(chat.id);
  const lastRow = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").get(chat.id);
  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    memberIds: members,
    admins: chat.type === "group" ? admins : undefined,
    settings: chat.type === "group"
      ? { onlyAdminsCanMessage: !!chat.only_admins_can_message, onlyAdminsCanDelete: !!chat.only_admins_can_delete }
      : undefined,
    createdAt: chat.created_at,
    lastMessage: lastRow ? serializeMessage(lastRow) : null,
  };
}

function serializeMessage(row) {
  return {
    id: row.id, chatId: row.chat_id, senderId: row.sender_id, type: row.type,
    text: row.deleted ? "" : row.text, replyTo: row.reply_to, deleted: !!row.deleted, ts: row.created_at,
  };
}

function insertSystemMessage(chatId, text) {
  const msg = { id: uid(), chat_id: chatId, sender_id: null, type: "system", text, reply_to: null, deleted: 0, created_at: now() };
  db.prepare("INSERT INTO messages (id, chat_id, sender_id, type, text, reply_to, deleted, created_at) VALUES (@id,@chat_id,@sender_id,@type,@text,@reply_to,@deleted,@created_at)").run(msg);
  return msg;
}

function requireMembership(req, res, chatId) {
  const chat = chatRow(chatId);
  if (!chat) { res.status(404).json({ error: "Chat not found" }); return null; }
  if (!isMember(chatId, req.userId)) { res.status(403).json({ error: "You're not in this chat." }); return null; }
  return chat;
}

/* ---------------- chat routes ---------------- */

app.get("/api/chats", authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
  `).all(req.userId);
  res.json(rows.map(c => serializeChat(c, req.userId)));
});

app.get("/api/chats/:id", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  res.json(serializeChat(chat, req.userId));
});

app.get("/api/chats/:id/messages", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  const rows = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC").all(chat.id);
  res.json(rows.map(serializeMessage));
});

app.post("/api/chats/dm", authMiddleware, (req, res) => {
  const { otherUserId } = req.body || {};
  const other = db.prepare("SELECT * FROM users WHERE id = ?").get(otherUserId);
  if (!other) return res.status(404).json({ error: "User not found" });

  const existing = db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
    JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
    WHERE c.type = 'dm'
  `).get(req.userId, other.id);

  if (existing) return res.json(serializeChat(existing, req.userId));

  const chat = { id: uid(), type: "dm", name: null, only_admins_can_message: 0, only_admins_can_delete: 0, created_at: now() };
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO chats (id, type, name, only_admins_can_message, only_admins_can_delete, created_at) VALUES (@id,@type,@name,@only_admins_can_message,@only_admins_can_delete,@created_at)").run(chat);
    db.prepare("INSERT INTO chat_members (chat_id, user_id, is_admin, joined_at) VALUES (?,?,0,?)").run(chat.id, req.userId, now());
    db.prepare("INSERT INTO chat_members (chat_id, user_id, is_admin, joined_at) VALUES (?,?,0,?)").run(chat.id, other.id, now());
  });
  tx();
  const fresh = chatRow(chat.id);
  broadcastToChat(chat.id, { type: "chat:new", chat: serializeChat(fresh, req.userId) });
  res.json(serializeChat(fresh, req.userId));
});

app.post("/api/chats/group", authMiddleware, (req, res) => {
  const { name, memberIds } = req.body || {};
  if (!name || !name.trim() || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: "Group name and at least one member are required." });
  }
  const allIds = Array.from(new Set([req.userId, ...memberIds]));
  const chat = { id: uid(), type: "group", name: name.trim(), only_admins_can_message: 0, only_admins_can_delete: 0, created_at: now() };

  const tx = db.transaction(() => {
    db.prepare("INSERT INTO chats (id, type, name, only_admins_can_message, only_admins_can_delete, created_at) VALUES (@id,@type,@name,@only_admins_can_message,@only_admins_can_delete,@created_at)").run(chat);
    allIds.forEach(id => {
      db.prepare("INSERT INTO chat_members (chat_id, user_id, is_admin, joined_at) VALUES (?,?,?,?)").run(chat.id, id, id === req.userId ? 1 : 0, now());
    });
    const me = db.prepare("SELECT username FROM users WHERE id = ?").get(req.userId);
    insertSystemMessage(chat.id, `${me.username} created the group "${chat.name}"`);
  });
  tx();

  const fresh = chatRow(chat.id);
  const payload = { type: "chat:new", chat: serializeChat(fresh, req.userId) };
  allIds.forEach(id => sendToUser(id, payload));
  res.json(serializeChat(fresh, req.userId));
});

app.post("/api/chats/:id/messages", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  const { text, replyTo } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message text is required." });

  if (chat.type === "group" && chat.only_admins_can_message && !isChatAdmin(chat.id, req.userId)) {
    return res.status(403).json({ error: "Only admins can send messages in this group." });
  }

  const msg = { id: uid(), chat_id: chat.id, sender_id: req.userId, type: "message", text: text.trim(), reply_to: replyTo || null, deleted: 0, created_at: now() };
  db.prepare("INSERT INTO messages (id, chat_id, sender_id, type, text, reply_to, deleted, created_at) VALUES (@id,@chat_id,@sender_id,@type,@text,@reply_to,@deleted,@created_at)").run(msg);

  broadcastToChat(chat.id, { type: "message:new", message: serializeMessage(msg) });
  res.json(serializeMessage(msg));
});

app.delete("/api/messages/:id", authMiddleware, (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!msg || msg.type !== "message") return res.status(404).json({ error: "Message not found" });
  const chat = chatRow(msg.chat_id);
  if (!isMember(chat.id, req.userId)) return res.status(403).json({ error: "You're not in this chat." });

  const isMine = msg.sender_id === req.userId;
  const admin = chat.type === "group" && isChatAdmin(chat.id, req.userId);
  const allowed = chat.type === "dm" ? isMine : (chat.only_admins_can_delete ? admin : (isMine || admin));
  if (!allowed) return res.status(403).json({ error: "You don't have permission to delete this message." });

  db.prepare("UPDATE messages SET deleted = 1, text = '' WHERE id = ?").run(msg.id);
  broadcastToChat(chat.id, { type: "message:deleted", messageId: msg.id, chatId: chat.id });
  res.json({ ok: true });
});

/* ---------------- membership routes ---------------- */

app.post("/api/chats/:id/members", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  if (chat.type !== "group") return res.status(400).json({ error: "Not a group chat." });
  if (!isChatAdmin(chat.id, req.userId)) return res.status(403).json({ error: "Only admins can add members." });

  const { userId } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (isMember(chat.id, userId)) return res.status(409).json({ error: "Already a member." });

  db.prepare("INSERT INTO chat_members (chat_id, user_id, is_admin, joined_at) VALUES (?,?,0,?)").run(chat.id, userId, now());
  const me = db.prepare("SELECT username FROM users WHERE id = ?").get(req.userId);
  const sys = insertSystemMessage(chat.id, `${me.username} added ${user.username}`);

  broadcastToChat(chat.id, { type: "member:added", chatId: chat.id, chat: serializeChat(chatRow(chat.id), req.userId), message: serializeMessage(sys) });
  sendToUser(userId, { type: "chat:new", chat: serializeChat(chatRow(chat.id), userId) });
  res.json({ ok: true });
});

function removeMemberInternal(chat, userId, actorName, systemVerb) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(chat.id, userId);
    // if the group has no admins left but still has members, promote the earliest remaining member
    const remaining = memberIdsOf(chat.id);
    const admins = adminIdsOf(chat.id);
    if (remaining.length > 0 && admins.length === 0) {
      const earliest = db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC LIMIT 1").get(chat.id);
      db.prepare("UPDATE chat_members SET is_admin = 1 WHERE chat_id = ? AND user_id = ?").run(chat.id, earliest.user_id);
      const promoted = db.prepare("SELECT username FROM users WHERE id = ?").get(earliest.user_id);
      insertSystemMessage(chat.id, `${promoted.username} is now an admin`);
    }
  });
  tx();
  insertSystemMessage(chat.id, systemVerb);
}

app.delete("/api/chats/:id/members/:userId", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  if (chat.type !== "group") return res.status(400).json({ error: "Not a group chat." });

  const targetId = req.params.userId;
  const isSelf = targetId === req.userId;
  if (!isSelf && !isChatAdmin(chat.id, req.userId)) {
    return res.status(403).json({ error: "Only admins can remove other members." });
  }
  if (!isMember(chat.id, targetId)) return res.status(404).json({ error: "Not a member." });

  const actor = db.prepare("SELECT username FROM users WHERE id = ?").get(req.userId);
  const target = db.prepare("SELECT username FROM users WHERE id = ?").get(targetId);
  const verb = isSelf ? `${target.username} left the group` : `${actor.username} removed ${target.username}`;

  removeMemberInternal(chat, targetId, actor.username, verb);

  const fresh = chatRow(chat.id);
  const stillMembers = memberIdsOf(chat.id);
  const latestSystemMsg = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").get(chat.id);

  stillMembers.forEach(id => sendToUser(id, {
    type: "member:removed", chatId: chat.id, chat: serializeChat(fresh, id), message: serializeMessage(latestSystemMsg),
  }));
  sendToUser(targetId, { type: "chat:left", chatId: chat.id });

  res.json({ ok: true });
});

app.patch("/api/chats/:id/settings", authMiddleware, (req, res) => {
  const chat = requireMembership(req, res, req.params.id);
  if (!chat) return;
  if (chat.type !== "group") return res.status(400).json({ error: "Not a group chat." });
  if (!isChatAdmin(chat.id, req.userId)) return res.status(403).json({ error: "Only admins can change group settings." });

  const { onlyAdminsCanMessage, onlyAdminsCanDelete } = req.body || {};
  const updates = [];
  if (typeof onlyAdminsCanMessage === "boolean") {
    db.prepare("UPDATE chats SET only_admins_can_message = ? WHERE id = ?").run(onlyAdminsCanMessage ? 1 : 0, chat.id);
    updates.push(`messaging: ${onlyAdminsCanMessage ? "on" : "off"}`);
  }
  if (typeof onlyAdminsCanDelete === "boolean") {
    db.prepare("UPDATE chats SET only_admins_can_delete = ? WHERE id = ?").run(onlyAdminsCanDelete ? 1 : 0, chat.id);
    updates.push(`deletion: ${onlyAdminsCanDelete ? "on" : "off"}`);
  }
  const me = db.prepare("SELECT username FROM users WHERE id = ?").get(req.userId);
  const sys = insertSystemMessage(chat.id, `${me.username} updated "only admins" settings (${updates.join(", ")})`);

  const fresh = chatRow(chat.id);
  broadcastToChat(chat.id, { type: "settings:updated", chatId: chat.id, chat: serializeChat(fresh, req.userId), message: serializeMessage(sys) });
  res.json(serializeChat(fresh, req.userId));
});

/* ---------------- websocket real-time layer ---------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const connections = new Map(); // userId -> Set<ws>

function sendToUser(userId, payload) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(payload);
  sockets.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(data); });
}

function broadcastToChat(chatId, payload) {
  memberIdsOf(chatId).forEach(userId => sendToUser(userId, payload));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  let userId;
  try { userId = jwt.verify(token, JWT_SECRET).sub; } catch { ws.close(); return; }

  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);

  ws.on("close", () => {
    connections.get(userId)?.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Thread server running at http://localhost:${PORT}`);
});
