const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "thread.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id                        TEXT PRIMARY KEY,
  type                      TEXT NOT NULL CHECK(type IN ('dm','group')),
  name                      TEXT,
  only_admins_can_message   INTEGER NOT NULL DEFAULT 0,
  only_admins_can_delete    INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin  INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL DEFAULT 'message' CHECK(type IN ('message','system')),
  text       TEXT,
  reply_to   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
`);

module.exports = db;
