// ---------- chat ----------

// Chat goes through the signaling WebSocket (one copy per participant), so it
// works even when the direct video connection fails. Nothing is stored.
const MAX_CHAT = 500;
const GROUP_MS = 5 * 60_000; // consecutive messages from the same person share a header
const messagesEl = $('messages');
const chatInput = $('chat-input');
// Phones, upright or sideways (keep in sync with the CSS in room.html).
const mobile = matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
let lastAuthor = null;
let lastAt = 0;
let unread = 0;

function cleanChat(value) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, MAX_CHAT).join('') : '';
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  $('chat-send').disabled = !on;
  $('emoji-btn').disabled = !on;
  if (!on) setEmojiPicker(false);
}

// Wide screens dock the chat (it can be collapsed); medium screens open it as
// a drawer; phones show it inline under the call.
const wide = matchMedia('(min-width: 1200px)');

function chatVisible() {
  if (document.hidden) return false;
  if (wide.matches) return !document.body.classList.contains('chat-collapsed');
  return mobile.matches || document.body.classList.contains('chat-open');
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

// Long sessions: only the last messages stay on the page (nothing is saved
// anyway), so the chat never grows without limit.
const MAX_CHAT_ITEMS = 300;

function appendToChat(item) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  messagesEl.append(item);
  while (messagesEl.childElementCount > MAX_CHAT_ITEMS) messagesEl.firstElementChild.remove();
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage({ authorId, name, photo, text = '', gif = null, self = false }) {
  const now = Date.now();
  const grouped = authorId === lastAuthor && now - lastAt < GROUP_MS;
  lastAuthor = authorId;
  lastAt = now;

  // No bubbles: a small photo, the name and the time on the first message of
  // a run, then just the text.
  const li = el('li', `msg${self ? ' self' : ''}${grouped ? ' grouped' : ''}`);
  const time = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (!grouped) {
    const avatar = el('div', 'avatar');
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, name, authorId, photo);
    const head = el('div', 'msg-head');
    head.append(el('span', 'ellipsis', self ? `${name}` : name), el('span', 'msg-time', time));
    li.append(avatar, head);
  }
  if (gif) {
    // Sized before it loads, so the chat doesn't jump when it arrives.
    const img = el('img', 'msg-gif');
    img.src = gif.url;
    img.alt = gif.title || 'GIF';
    img.title = gif.title ? `${gif.title} · ${time}` : time;
    img.referrerPolicy = 'no-referrer';
    if (gif.w && gif.h) img.style.aspectRatio = `${gif.w} / ${gif.h}`;
    li.append(img);
  } else {
    const body = el('p', isJumbo(text) ? 'msg-text jumbo' : 'msg-text');
    body.title = time;
    body.append(linkify(text));
    li.append(body);
  }
  appendToChat(li);

  if (!self) {
    unread += 1;
    updateUnread();
    notify(name, gif ? 'mandou um GIF' : text, 'chat');
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

function setChatShown(shown) {
  if (wide.matches) {
    document.body.classList.toggle('chat-collapsed', !shown);
    save('chat-collapsed', shown ? '' : '1');
  } else {
    document.body.classList.toggle('chat-open', shown);
  }
  $('chat-toggle').setAttribute('aria-label', chatVisible() ? 'Esconder chat' : 'Mostrar chat');
  updateUnread();
  if (shown && !mobile.matches) chatInput.focus();
}
$('chat-toggle').onclick = () => setChatShown(!chatVisible() || (mobile.matches && !document.body.classList.contains('chat-open')));
$('chat-close').onclick = () => setChatShown(false);
document.body.classList.toggle('chat-collapsed', load('chat-collapsed') === '1');
wide.addEventListener('change', updateUnread);
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

