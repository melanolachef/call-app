// ---------- chat ----------

// Chat goes through the signaling WebSocket (one copy per participant), so it
// works even when the direct video connection fails. Nothing is stored.
const MAX_CHAT = 500;
const GROUP_MS = 5 * 60_000; // consecutive messages from the same person share a header
const messagesEl = $('messages');
const chatInput = $('chat-input');
const mobile = matchMedia('(max-width: 760px)');
let lastAuthor = null;
let lastAt = 0;
let unread = 0;

function cleanChat(value) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, MAX_CHAT).join('') : '';
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  $('chat-send').disabled = !on;
}

function chatVisible() {
  return !document.hidden && (!mobile.matches || document.body.classList.contains('chat-open'));
}

function updateUnread() {
  if (chatVisible()) unread = 0;
  $('chat-badge').hidden = unread === 0;
  $('chat-badge').textContent = String(unread);
  document.title = unread ? `(${unread}) CPX Call` : 'CPX Call';
}

// Builds text with http(s) links as anchors, never as HTML.
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    frag.append(text.slice(last, match.index));
    const a = el('a', null, match[0]);
    a.href = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = match.index + match[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function appendToChat(item) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  messagesEl.append(item);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage({ authorId, name, photo, text, self = false }) {
  const now = Date.now();
  const grouped = authorId === lastAuthor && now - lastAt < GROUP_MS;
  lastAuthor = authorId;
  lastAt = now;

  const li = el('li', grouped ? 'msg grouped' : 'msg');
  if (!grouped) {
    const head = el('div', 'msg-head');
    const avatar = el('div', 'avatar');
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, name, authorId, photo);
    const time = el('time', null, new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    head.append(avatar, el('strong', 'ellipsis', self ? `${name} (você)` : name), time);
    li.append(head);
  }
  const body = el('p', 'msg-text');
  body.append(linkify(text));
  li.append(body);
  appendToChat(li);

  if (!self) {
    unread += 1;
    updateUnread();
    notify(name, text, 'chat');
  }
}

function addSystem(text) {
  lastAuthor = null; // the next message starts a new group
  appendToChat(el('li', 'system', text));
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = cleanChat(chatInput.value);
  if (!text || chatInput.disabled) return;
  peers.forEach((peer) => send(peer.id, { chat: text }));
  addMessage({ authorId: myId, name: myNick, photo: myPhoto, text, self: true });
  chatInput.value = '';
  messagesEl.scrollTop = messagesEl.scrollHeight; // always follow your own message
};

$('chat-toggle').onclick = () => {
  document.body.classList.add('chat-open');
  updateUnread();
  chatInput.focus();
};
$('chat-close').onclick = () => {
  document.body.classList.remove('chat-open');
};
document.addEventListener('visibilitychange', updateUnread);
mobile.addEventListener('change', updateUnread);

// Leaving goes back to the lobby, where your rooms are listed.
function goToLobby() {
  left = true;
  leaveVoice();
  stopCamera();
  clearTimeout(reconnectTimer);
  stopShare();
  ws?.close();
  releaseLock?.();
  location.assign('/');
}
$('leave').onclick = goToLobby;
$('home').onclick = (e) => {
  e.preventDefault();
  goToLobby();
};

