/* ============================================================
   THREAD — client
   Talks to the Express/SQLite backend over REST for actions and
   a WebSocket for live updates. The only thing kept client-side
   is the auth token (localStorage), same as any normal web app.
   ============================================================ */

const TOKEN_KEY = "thread_token";
const USER_COLORS = ["var(--user-1)","var(--user-2)","var(--user-3)","var(--user-4)","var(--user-5)","var(--user-6)"];

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let users = [];               // cache of all registered users
let chats = [];                // chats current user belongs to
let messagesCache = {};        // chatId -> array of messages (populated lazily)
let activeChatId = null;
let replyingToId = null;
let ws = null;

/* ---------------- API helper ---------------- */

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

/* ---------------- helpers ---------------- */

function getUser(id) { return users.find(u => u.id === id); }
function userColor(id) {
  const idx = users.findIndex(u => u.id === id);
  return USER_COLORS[Math.max(idx, 0) % USER_COLORS.length];
}
function initials(name) { return (name || "?").trim().slice(0, 1).toUpperCase(); }
function getChat(id) { return chats.find(c => c.id === id); }
function isAdmin(chat, userId) { return chat.type === "group" && chat.admins.includes(userId); }
function chatMessages(chatId) { return messagesCache[chatId] || []; }

function chatDisplayName(chat) {
  if (chat.type === "group") return chat.name;
  const otherId = chat.memberIds.find(id => id !== currentUser.id) || chat.memberIds[0];
  return getUser(otherId)?.username || "Unknown";
}

function canMessage(chat) {
  if (chat.type === "dm") return true;
  if (!chat.settings.onlyAdminsCanMessage) return true;
  return isAdmin(chat, currentUser.id);
}

function canDelete(chat, message) {
  if (message.deleted) return false;
  const isMine = message.senderId === currentUser.id;
  if (chat.type === "dm") return isMine;
  const admin = isAdmin(chat, currentUser.id);
  if (chat.settings.onlyAdminsCanDelete) return admin;
  return isMine || admin;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

/* ================= AUTH ================= */

let authMode = "login";

function wireAuthScreen() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      authMode = tab.dataset.mode;
      document.getElementById("authSubmit").textContent = authMode === "login" ? "Log in" : "Create account";
      document.getElementById("authError").hidden = true;
      document.getElementById("authPassword").autocomplete = authMode === "login" ? "current-password" : "new-password";
    });
  });

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("authUsername").value.trim();
    const password = document.getElementById("authPassword").value;
    const errBox = document.getElementById("authError");
    errBox.hidden = true;
    try {
      const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const data = await api(path, { method: "POST", body: { username, password } });
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      currentUser = data.user;
      await enterApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  chats = []; messagesCache = {}; activeChatId = null;
  document.getElementById("appRoot").hidden = true;
  document.getElementById("authScreen").hidden = false;
}

/* ================= BOOT / ENTER APP ================= */

async function tryResumeSession() {
  if (!token) return false;
  try {
    currentUser = await api("/api/me");
    return true;
  } catch {
    return false;
  }
}

async function enterApp() {
  document.getElementById("authScreen").hidden = true;
  document.getElementById("appRoot").hidden = false;
  users = await api("/api/users");
  chats = await api("/api/chats");
  connectSocket();
  render();
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); };
  ws.onerror = () => setConn(false);
  ws.onmessage = (e) => handleSocketEvent(JSON.parse(e.data));
}

function setConn(live) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  if (!dot) return;
  dot.classList.toggle("is-live", live);
  label.textContent = live ? "live" : "reconnecting…";
  if (!live) setTimeout(() => { if (token) connectSocket(); }, 1500);
}

function handleSocketEvent(evt) {
  switch (evt.type) {
    case "chat:new": {
      if (!chats.find(c => c.id === evt.chat.id)) chats.push(evt.chat);
      else chats = chats.map(c => c.id === evt.chat.id ? evt.chat : c);
      render();
      break;
    }
    case "message:new": {
      (messagesCache[evt.message.chatId] ||= []).push(evt.message);
      const c = getChat(evt.message.chatId);
      if (c) { /* trigger sidebar preview refresh */ }
      refreshChatMeta(evt.message.chatId);
      render();
      break;
    }
    case "message:deleted": {
      const list = messagesCache[evt.chatId];
      if (list) {
        const m = list.find(x => x.id === evt.messageId);
        if (m) { m.deleted = true; m.text = ""; }
      }
      render();
      break;
    }
    case "member:added":
    case "settings:updated": {
      chats = chats.map(c => c.id === evt.chat.id ? evt.chat : c);
      if (evt.message) (messagesCache[evt.chatId] ||= []).push(evt.message);
      render();
      break;
    }
    case "member:removed": {
      chats = chats.map(c => c.id === evt.chat.id ? evt.chat : c);
      if (evt.message) (messagesCache[evt.chatId] ||= []).push(evt.message);
      render();
      break;
    }
    case "chat:left": {
      chats = chats.filter(c => c.id !== evt.chatId);
      delete messagesCache[evt.chatId];
      if (activeChatId === evt.chatId) activeChatId = null;
      toast("You left the group.");
      render();
      break;
    }
  }
}

async function refreshChatMeta(chatId) {
  // keep sidebar preview ordering in sync even if this chat isn't open
  try {
    const fresh = await api(`/api/chats/${chatId}`);
    chats = chats.map(c => c.id === chatId ? { ...fresh, lastMessage: getChat(chatId)?.lastMessage } : c);
  } catch { /* ignore */ }
}

/* ================= ACTIONS ================= */

async function openOrCreateDM(otherUserId) {
  try {
    const chat = await api("/api/chats/dm", { method: "POST", body: { otherUserId } });
    if (!chats.find(c => c.id === chat.id)) chats.push(chat);
    await selectChat(chat.id);
  } catch (err) { toast(err.message); }
}

async function createGroup(name, memberIds) {
  try {
    const chat = await api("/api/chats/group", { method: "POST", body: { name, memberIds } });
    if (!chats.find(c => c.id === chat.id)) chats.push(chat);
    await selectChat(chat.id);
  } catch (err) { toast(err.message); }
}

async function selectChat(chatId) {
  activeChatId = chatId;
  replyingToId = null;
  render();
  if (!messagesCache[chatId]) {
    try {
      messagesCache[chatId] = await api(`/api/chats/${chatId}/messages`);
      render();
    } catch (err) { toast(err.message); }
  }
}

async function sendMessage(text) {
  const chat = getChat(activeChatId);
  if (!chat || !text.trim()) return;
  try {
    await api(`/api/chats/${chat.id}/messages`, { method: "POST", body: { text: text.trim(), replyTo: replyingToId } });
    replyingToId = null;
    // the server echoes this back over the websocket (message:new), which appends it to the cache
  } catch (err) { toast(err.message); }
}

async function deleteMessage(messageId) {
  try {
    await api(`/api/messages/${messageId}`, { method: "DELETE" });
  } catch (err) { toast(err.message); }
}

async function addMember(chatId, userId) {
  try {
    await api(`/api/chats/${chatId}/members`, { method: "POST", body: { userId } });
    renderGroupSettingsModal();
  } catch (err) { toast(err.message); }
}

async function removeMember(chatId, userId) {
  try {
    await api(`/api/chats/${chatId}/members/${userId}`, { method: "DELETE" });
    if (getChat(chatId)) renderGroupSettingsModal();
  } catch (err) { toast(err.message); }
}

async function leaveGroup(chatId) {
  try {
    await api(`/api/chats/${chatId}/members/${currentUser.id}`, { method: "DELETE" });
    chats = chats.filter(c => c.id !== chatId);
    delete messagesCache[chatId];
    if (activeChatId === chatId) activeChatId = null;
    closeModal("groupSettingsOverlay");
    render();
  } catch (err) { toast(err.message); }
}

async function toggleSetting(chatId, key, value) {
  try {
    const chat = await api(`/api/chats/${chatId}/settings`, { method: "PATCH", body: { [key]: value } });
    chats = chats.map(c => c.id === chat.id ? chat : c);
    render();
  } catch (err) {
    toast(err.message);
    renderGroupSettingsModal();
  }
}

/* ================= RENDERING ================= */

function render() {
  renderIdentity();
  renderChatList();
  renderChatView();
}

function renderIdentity() {
  document.getElementById("identityAvatar").textContent = initials(currentUser.username);
  document.getElementById("identityAvatar").style.background = userColor(currentUser.id);
  document.getElementById("identityName").textContent = currentUser.username;
}

function renderChatList() {
  const list = document.getElementById("chatList");
  list.innerHTML = "";

  const sorted = [...chats].sort((a, b) => {
    const la = a.lastMessage?.ts || a.createdAt;
    const lb = b.lastMessage?.ts || b.createdAt;
    return lb - la;
  });

  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--text-on-ink-dim);font-size:12.5px;padding:10px 8px;";
    empty.textContent = "No conversations yet.";
    list.appendChild(empty);
  }

  sorted.forEach(chat => {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === activeChatId ? " is-active" : "");
    const cached = chatMessages(chat.id);
    const last = cached.length ? cached[cached.length - 1] : chat.lastMessage;

    let preview = "No messages yet";
    if (last) {
      if (last.type === "system") preview = last.text;
      else if (last.deleted) preview = "This message was deleted";
      else preview = `${last.senderId === currentUser.id ? "You: " : ""}${last.text}`;
    }

    let iconHtml;
    if (chat.type === "group") {
      iconHtml = `<div class="chat-item__group-icon">👥</div>`;
    } else {
      const otherId = chat.memberIds.find(id => id !== currentUser.id) || chat.memberIds[0];
      const other = getUser(otherId);
      iconHtml = `<span class="avatar" style="background:${userColor(otherId)}">${initials(other?.username)}</span>`;
    }

    item.innerHTML = `
      ${iconHtml}
      <div class="chat-item__meta">
        <div class="chat-item__name">${escapeHtml(chatDisplayName(chat))}</div>
        <div class="chat-item__preview">${escapeHtml(preview)}</div>
      </div>`;
    item.addEventListener("click", () => selectChat(chat.id));
    list.appendChild(item);
  });
}

function renderChatView() {
  const chat = getChat(activeChatId);
  const emptyState = document.getElementById("emptyState");
  const chatView = document.getElementById("chatView");

  if (!chat) {
    emptyState.hidden = false;
    chatView.hidden = true;
    return;
  }
  emptyState.hidden = true;
  chatView.hidden = false;

  document.getElementById("chatTitle").textContent = chatDisplayName(chat);
  document.getElementById("chatSubtitle").textContent = chat.type === "group"
    ? `${chat.memberIds.length} members${isAdmin(chat, currentUser.id) ? " · you're an admin" : ""}`
    : "Direct message";

  document.getElementById("groupSettingsBtn").hidden = chat.type !== "group";

  renderMessages(chat);

  const locked = !canMessage(chat);
  document.getElementById("composer").hidden = locked;
  document.getElementById("composerLock").hidden = !locked;

  renderReplyBar();
}

function renderMessages(chat) {
  const box = document.getElementById("messages");
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = "";

  chatMessages(chat.id).forEach(msg => {
    if (msg.type === "system") {
      const el = document.createElement("div");
      el.className = "system-msg";
      el.textContent = msg.text;
      box.appendChild(el);
      return;
    }

    const sender = getUser(msg.senderId) || { username: "Unknown", id: msg.senderId };
    const isMine = msg.senderId === currentUser.id;
    const row = document.createElement("div");
    row.className = "msg-row" + (isMine ? " is-mine" : "");
    row.id = "msg-" + msg.id;

    let quoteHtml = "";
    if (!msg.deleted && msg.replyTo) {
      const original = chatMessages(chat.id).find(m => m.id === msg.replyTo);
      if (original && !original.deleted && original.type !== "system") {
        const originalSender = getUser(original.senderId) || { username: "Unknown" };
        quoteHtml = `<div class="bubble__quote" data-jump="${original.id}">
          <span class="bubble__quote-name">${escapeHtml(originalSender.username)}</span>
          <span class="bubble__quote-text">${escapeHtml(original.text)}</span>
        </div>`;
      } else {
        quoteHtml = `<div class="bubble__quote"><span class="bubble__quote-text" style="font-style:italic">Original message deleted</span></div>`;
      }
    }

    const bubbleClass = msg.deleted ? "bubble bubble--deleted" : "bubble";
    const bodyHtml = msg.deleted ? `This message was deleted` : `${quoteHtml}${escapeHtml(msg.text)}`;

    let actionsHtml = `<button class="reply-btn" title="Reply">↩ Reply</button>`;
    if (canDelete(chat, msg)) actionsHtml += `<button class="delete-btn danger" title="Delete">🗑 Delete</button>`;

    row.innerHTML = `
      <span class="avatar avatar--sm" style="background:${userColor(sender.id)}">${initials(sender.username)}</span>
      <div class="msg-row__col">
        ${chat.type === "group" && !isMine ? `<span class="msg-sender" style="color:${userColor(sender.id)}">${escapeHtml(sender.username)}</span>` : ""}
        <div class="${bubbleClass}">
          ${bodyHtml}
          ${!msg.deleted ? `<div class="msg-actions">${actionsHtml}</div>` : ""}
        </div>
        <span class="msg-time">${formatTime(msg.ts)}</span>
      </div>`;

    if (!msg.deleted) {
      row.querySelector(".reply-btn").addEventListener("click", () => {
        replyingToId = msg.id;
        renderReplyBar();
      });
      const delBtn = row.querySelector(".delete-btn");
      if (delBtn) delBtn.addEventListener("click", () => deleteMessage(msg.id));
    }
    const quoteEl = row.querySelector(".bubble__quote[data-jump]");
    if (quoteEl) {
      quoteEl.addEventListener("click", () => {
        const target = document.getElementById("msg-" + quoteEl.dataset.jump);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.animate([{ background: "rgba(76,95,213,0.18)" }, { background: "transparent" }], { duration: 900 });
        }
      });
    }
    box.appendChild(row);
  });

  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

function renderReplyBar() {
  const bar = document.getElementById("replyBar");
  if (!replyingToId) { bar.hidden = true; return; }
  const original = chatMessages(activeChatId).find(m => m.id === replyingToId);
  if (!original || original.deleted) { replyingToId = null; bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById("replyBarName").textContent = getUser(original.senderId)?.username || "Unknown";
  document.getElementById("replyBarText").textContent = original.text;
}

/* ---------------- new chat modal ---------------- */

async function renderNewChatModal() {
  users = await api("/api/users"); // refresh in case someone new registered

  const dmList = document.getElementById("dmPickList");
  dmList.innerHTML = "";
  users.filter(u => u.id !== currentUser.id).forEach(u => {
    const item = document.createElement("div");
    item.className = "pick-item";
    item.innerHTML = `<span class="avatar avatar--sm" style="background:${userColor(u.id)}">${initials(u.username)}</span><span class="pick-item__name">${escapeHtml(u.username)}</span>`;
    item.addEventListener("click", () => { closeModal("newChatOverlay"); openOrCreateDM(u.id); });
    dmList.appendChild(item);
  });

  const groupList = document.getElementById("groupPickList");
  groupList.innerHTML = "";
  users.filter(u => u.id !== currentUser.id).forEach(u => {
    const item = document.createElement("label");
    item.className = "pick-item";
    item.innerHTML = `<span class="avatar avatar--sm" style="background:${userColor(u.id)}">${initials(u.username)}</span><span class="pick-item__name">${escapeHtml(u.username)}</span><input type="checkbox" value="${u.id}" />`;
    groupList.appendChild(item);
  });
  document.getElementById("groupNameInput").value = "";
  validateGroupForm();

  if (users.filter(u => u.id !== currentUser.id).length === 0) {
    dmList.innerHTML = `<p class="modal__hint">No other users yet — ask a friend to create an account.</p>`;
  }
}

function validateGroupForm() {
  const name = document.getElementById("groupNameInput").value.trim();
  const checked = document.querySelectorAll("#groupPickList input:checked").length;
  document.getElementById("createGroupBtn").disabled = !(name && checked >= 1);
}

/* ---------------- group settings modal ---------------- */

function renderGroupSettingsModal() {
  const chat = getChat(activeChatId);
  if (!chat) return;
  const amAdmin = isAdmin(chat, currentUser.id);

  const memberList = document.getElementById("memberList");
  memberList.innerHTML = "";
  chat.memberIds.forEach(id => {
    const u = getUser(id) || { username: "Unknown", id };
    const admin = chat.admins.includes(id);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <span class="avatar avatar--sm" style="background:${userColor(id)}">${initials(u.username)}</span>
      <span class="member-row__name">${escapeHtml(u.username)}${id === currentUser.id ? " (you)" : ""}</span>
      ${admin ? `<span class="badge">Admin</span>` : ""}
      ${amAdmin && id !== currentUser.id ? `<button class="member-row__remove" title="Remove from group">Remove</button>` : ""}
    `;
    const removeBtn = row.querySelector(".member-row__remove");
    if (removeBtn) removeBtn.addEventListener("click", () => removeMember(chat.id, id));
    memberList.appendChild(row);
  });

  document.getElementById("adminOnlySection").hidden = !amAdmin;

  if (amAdmin) {
    const select = document.getElementById("addMemberSelect");
    select.innerHTML = "";
    const addable = users.filter(u => !chat.memberIds.includes(u.id));
    if (addable.length === 0) {
      select.innerHTML = `<option value="">No one left to add</option>`;
      document.getElementById("addMemberBtn").disabled = true;
    } else {
      addable.forEach(u => {
        const opt = document.createElement("option");
        opt.value = u.id; opt.textContent = u.username;
        select.appendChild(opt);
      });
      document.getElementById("addMemberBtn").disabled = false;
    }
    document.getElementById("toggleOnlyAdminsMessage").checked = chat.settings.onlyAdminsCanMessage;
    document.getElementById("toggleOnlyAdminsDelete").checked = chat.settings.onlyAdminsCanDelete;
  }
}

/* ================= EVENT WIRING ================= */

function wireAppEvents() {
  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.getElementById("newChatBtn").addEventListener("click", async () => {
    await renderNewChatModal();
    openModal("newChatOverlay");
  });
  document.getElementById("newChatClose").addEventListener("click", () => closeModal("newChatOverlay"));
  document.getElementById("newChatOverlay").addEventListener("click", (e) => {
    if (e.target.id === "newChatOverlay") closeModal("newChatOverlay");
  });

  document.querySelectorAll(".modal__tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".modal__tab").forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const mode = tab.dataset.mode;
      document.getElementById("dmPanel").hidden = mode !== "dm";
      document.getElementById("groupPanel").hidden = mode !== "group";
      document.getElementById("newChatTitle").textContent = mode === "dm" ? "Start a conversation" : "Create a group";
    });
  });

  document.getElementById("groupNameInput").addEventListener("input", validateGroupForm);
  document.getElementById("groupPickList").addEventListener("change", validateGroupForm);

  document.getElementById("createGroupBtn").addEventListener("click", () => {
    const name = document.getElementById("groupNameInput").value.trim();
    const memberIds = Array.from(document.querySelectorAll("#groupPickList input:checked")).map(i => i.value);
    if (!name || memberIds.length === 0) return;
    closeModal("newChatOverlay");
    createGroup(name, memberIds);
  });

  document.getElementById("groupSettingsBtn").addEventListener("click", () => {
    renderGroupSettingsModal();
    openModal("groupSettingsOverlay");
  });
  document.getElementById("groupSettingsClose").addEventListener("click", () => closeModal("groupSettingsOverlay"));
  document.getElementById("groupSettingsOverlay").addEventListener("click", (e) => {
    if (e.target.id === "groupSettingsOverlay") closeModal("groupSettingsOverlay");
  });

  document.getElementById("addMemberBtn").addEventListener("click", () => {
    const select = document.getElementById("addMemberSelect");
    if (select.value) addMember(activeChatId, select.value);
  });

  document.getElementById("toggleOnlyAdminsMessage").addEventListener("change", (e) => {
    toggleSetting(activeChatId, "onlyAdminsCanMessage", e.target.checked);
  });
  document.getElementById("toggleOnlyAdminsDelete").addEventListener("change", (e) => {
    toggleSetting(activeChatId, "onlyAdminsCanDelete", e.target.checked);
  });

  document.getElementById("leaveGroupBtn").addEventListener("click", () => {
    if (activeChatId) leaveGroup(activeChatId);
  });

  document.getElementById("replyBarCancel").addEventListener("click", () => {
    replyingToId = null;
    renderReplyBar();
  });

  const input = document.getElementById("composerInput");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  document.getElementById("sendBtn").addEventListener("click", submit);

  function submit() {
    const text = input.value;
    if (!text.trim()) return;
    sendMessage(text);
    input.value = "";
    input.style.height = "auto";
  }
}

/* ================= BOOT ================= */

async function boot() {
  wireAuthScreen();
  wireAppEvents();
  const resumed = await tryResumeSession();
  if (resumed) {
    await enterApp();
  } else {
    document.getElementById("authScreen").hidden = false;
  }
}

boot();
