// ---------- chat ----------

// Chat goes through the signaling WebSocket (one copy per participant), so it
// works even when the direct video connection fails. Nothing is stored.
const MAX_CHAT = 500;
const messagesEl = $('messages');
const chatInput = $('chat-input');
// Phones, upright or sideways (keep in sync with the CSS in room.html).
const mobile = matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
let unread = 0;

function cleanChat(value) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, MAX_CHAT).join('') : '';
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  $('chat-send').disabled = !on;
  $('emoji-btn').disabled = !on;
  $('photo-btn').disabled = !on;
  document.querySelectorAll('#chat-quick button').forEach((button) => (button.disabled = !on));
  if (!on) setEmojiPicker(false);
}

// Wide screens dock the chat (it can be collapsed); medium screens open it as
// a drawer; phones show it inline under the call.
const wide = matchMedia('(min-width: 1200px)');

function chatVisible() {
  if (document.hidden) return false;
  if (wide.matches) return !document.body.classList.contains('chat-collapsed');
  if (mobile.matches) return document.body.dataset.tab === 'chat';
  return document.body.classList.contains('chat-open');
}

function updateUnread() {
  if (chatVisible()) unread = 0;
  $('chat-badge').hidden = unread === 0;
  $('chat-badge').textContent = String(unread);
  $('tab-badge').hidden = unread === 0;
  $('tab-badge').textContent = String(unread);
  $('unfold-badge').hidden = unread === 0;
  $('unfold-badge').textContent = String(unread);
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
  while (messagesEl.childElementCount > MAX_CHAT_ITEMS) {
    const old = messagesEl.firstElementChild;
    old.querySelectorAll('img[src^="blob:"]').forEach((img) => URL.revokeObjectURL(img.src)); // photos (fotos.js)
    old.remove();
  }
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage({ authorId, name, photo, text = '', gif = null, image = null, self = false }) {
  const now = Date.now();
  // No bubbles: a small photo, the name and the time on every message, so a
  // long message that wraps never runs into the next one.
  const li = el('li', `msg${self ? ' self' : ''}`);
  const time = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, name, authorId, photo);
  const head = el('div', 'msg-head');
  head.append(el('span', 'ellipsis', name), el('span', 'msg-time', time));
  li.append(avatar, head);
  if (image) {
    // A photo or GIF sent from someone's device (fotos.js): click to open it big.
    const link = el('a', 'msg-photo-link');
    link.href = image.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = el('img', 'msg-gif msg-photo');
    img.src = image.url;
    img.alt = image.gif ? 'GIF' : 'Foto';
    img.title = time;
    if (image.w && image.h) img.style.aspectRatio = `${image.w} / ${image.h}`;
    link.append(img);
    li.append(link);
  } else if (gif) {
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
  const what = image ? (image.gif ? 'mandou um GIF' : 'mandou uma foto') : gif ? 'mandou um GIF' : text;
  mirrorToRail(name, what);

  if (!self) {
    unread += 1;
    updateUnread();
    notify(name, what, 'chat');
  }
}

function addSystem(text) {
  appendToChat(el('li', 'system', text));
}

// Also used by the quick emojis and the chat over a fullscreen picture (phones).
function sendChatText(value) {
  const text = cleanChat(value);
  if (!text || chatInput.disabled) return false;
  peers.forEach((peer) => send(peer.id, { chat: text }));
  addMessage({ authorId: myId, name: myNick, photo: myPhoto, text, self: true });
  messagesEl.scrollTop = messagesEl.scrollHeight; // always follow your own message
  return true;
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  if (sendChatText(chatInput.value)) chatInput.value = '';
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
  if (okToLeave()) goToLobby();
};


// ---------- largura do chat (telas largas) ----------

// Drag the chat's left edge to make it wider or narrower (remembered in this
// browser); double-click puts it back. Dragging it almost shut folds it away,
// like the button in its corner; a tab on the right edge brings it back.
const CHAT_W = { min: 240, normal: 300, max: 640, fold: 180 };

function setChatWidth(px, remember = true) {
  const width = Math.round(Math.min(Math.max(px, CHAT_W.min), Math.min(CHAT_W.max, innerWidth * 0.45)));
  document.documentElement.style.setProperty('--chat-w', `${width}px`);
  $('chat-resize').setAttribute('aria-valuenow', String(width));
  if (remember) save('chat-w', width === CHAT_W.normal ? '' : String(width));
}

setChatWidth(Number(load('chat-w')) || CHAT_W.normal, false);

const chatHandle = $('chat-resize');
chatHandle.setAttribute('aria-valuemin', String(CHAT_W.min));
chatHandle.setAttribute('aria-valuemax', String(CHAT_W.max));
let widthBeforeDrag = CHAT_W.normal;
chatHandle.onpointerdown = (e) => {
  widthBeforeDrag = Number(chatHandle.getAttribute('aria-valuenow')) || CHAT_W.normal;
  chatHandle.setPointerCapture(e.pointerId);
  document.body.classList.add('chat-resizing');
};
chatHandle.onpointermove = (e) => {
  if (!chatHandle.hasPointerCapture(e.pointerId)) return;
  const width = innerWidth - e.clientX - 16; // the chat keeps its 16px margin
  if (width < CHAT_W.fold) {
    chatHandle.releasePointerCapture(e.pointerId);
    document.body.classList.remove('chat-resizing');
    setChatWidth(widthBeforeDrag); // it comes back as it was
    setChatShown(false); // dragged shut
    return;
  }
  setChatWidth(width);
};
chatHandle.onpointerup = chatHandle.onpointercancel = () => document.body.classList.remove('chat-resizing');
chatHandle.ondblclick = () => setChatWidth(CHAT_W.normal);
chatHandle.onkeydown = (e) => {
  const now = Number(chatHandle.getAttribute('aria-valuenow')) || CHAT_W.normal;
  const step = e.shiftKey ? 60 : 20;
  if (e.key === 'ArrowLeft') setChatWidth(now + step); // the chat grows to the left
  else if (e.key === 'ArrowRight') setChatWidth(now - step);
  else return;
  e.preventDefault();
};
$('chat-fold').onclick = () => setChatShown(false);
$('chat-unfold').onclick = () => setChatShown(true);
