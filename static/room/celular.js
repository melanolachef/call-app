// ---------- celular (docs/design/cpx-call-mobile.html) ----------

// Phones get three tabs (Palco, Chat, Sons), a voice bar over the tab bar
// and, watching lying down, a rail of buttons and the last messages over the
// picture. Everything here only shows under the phone CSS in room.html; on
// wider screens it renders into hidden nodes and costs nothing per frame.

const QUICK_EMOJIS = ['🔥', '😂', '👏', '😮', '💀'];
const SHEET_REACTIONS = ['🔥', '😂', '👏', '😮', '💀', '❤️'];
const RAIL_MESSAGES = 4;
let tabBeforeSons = 'palco';

function currentTab() {
  return document.body.dataset.tab || 'palco';
}

function setTab(next) {
  const prev = currentTab();
  if (next === prev) {
    if (next === 'sons') setSoundPicker(false); // tapping "Sons" again closes the sheet
    return;
  }
  if (next === 'sons') tabBeforeSons = prev;
  document.body.dataset.tab = next;
  for (const button of $('tabbar').querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === next));
  }
  if ((next === 'sons') === soundPop.hidden) setSoundPicker(next === 'sons');
  if (next === 'chat') messagesEl.scrollTop = messagesEl.scrollHeight;
  updateUnread();
}

// Called by setSoundPicker() on phones: the sheet open is the "Sons" tab.
function syncSoundTab(open) {
  if (open && currentTab() !== 'sons') setTab('sons');
  else if (!open && currentTab() === 'sons') setTab(tabBeforeSons);
}

for (const button of $('tabbar').querySelectorAll('[data-tab]')) {
  button.onclick = () => setTab(button.dataset.tab);
}
// Back to a wide window: the sheet is a popup again, no tab is "open".
mobile.addEventListener('change', () => {
  if (!mobile.matches && currentTab() !== 'palco') {
    if (currentTab() === 'sons') setSoundPicker(false);
    setTab('palco');
  }
});

// ---------- botões fixos ----------

for (const emoji of QUICK_EMOJIS) {
  const button = el('button', null, emoji);
  button.type = 'button';
  button.disabled = true; // until the chat is on (setChatEnabled)
  button.setAttribute('aria-label', `Mandar ${emoji}`);
  button.onclick = () => sendChatText(emoji);
  $('chat-quick').append(button);
}

for (const emoji of SHEET_REACTIONS) {
  const button = el('button', null, emoji);
  button.type = 'button';
  button.setAttribute('aria-label', `Reagir com ${emoji}`);
  button.onclick = () => sendReaction(emoji);
  $('sheet-react').append(button);
}

$('dock-hangup').innerHTML = ICONS.hangup; // fixed markup
$('dock-hangup').onclick = leaveVoice;
$('cv-btn').onclick = () => (voice.joined ? micClick() : joinVoice());

// ---------- telas: carrossel com "1 / 2" e pontinhos ----------

function visibleScreens() {
  return [...$('screens').children].filter((card) => !card.hidden);
}

function renderScreensPosition() {
  const cards = visibleScreens();
  const strip = $('screens');
  let index = 0;
  if (cards.length > 1) {
    const step = cards[1].offsetLeft - cards[0].offsetLeft || 1;
    index = Math.min(cards.length - 1, Math.max(0, Math.round(strip.scrollLeft / step)));
  }
  $('screens-pos').textContent = cards.length > 1 ? `${index + 1} / ${cards.length}` : '';
  const dots = $('screens-dots');
  if (dots.childElementCount !== cards.length) dots.replaceChildren(...cards.map(() => el('i')));
  [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i === index));
  dots.classList.toggle('multi', cards.length > 1);
  strip.classList.toggle('multi', cards.length > 1);
}
$('screens').addEventListener('scroll', renderScreensPosition, { passive: true });

// ---------- a cada refresh() ----------

// "Você está falando" / "na voz": the first one shows while the speaking
// check marks the node (data-pid, see updateSpeaking in voz.js).
function myVoiceLine(node, prefix = '') {
  node.replaceChildren();
  if (!voice.joined) {
    delete node.dataset.pid;
    node.classList.remove('speaking');
    return;
  }
  const silent = voice.deafened ? 'você está sem som' : voice.muted ? 'você está mudo' : 'você está na voz';
  node.append(el('span', 'm-status', `${prefix}${silent}`), el('span', 'm-talk', `${prefix}você está falando`));
  markSpeaker(node, { id: myId, speaking: voice.speaking && !voice.muted && !voice.deafened });
}

function renderMobile(people) {
  if (myId === null) return;
  const inVoice = people.filter((p) => p.voiceIn);
  const match = /-([a-z0-9]{6})$/.exec(roomId);
  const suffix = match && !isHomeRoom(roomId) ? `-${match[1]} · ` : '';
  $('sub-info').textContent = `${suffix}${people.length}/${maxPeers}`;

  // Palco
  $('voice-title').textContent = `Na voz · ${inVoice.length}`;
  $('voice-title').hidden = inVoice.length === 0;
  renderScreensPosition();

  // Voice bar: up to three faces, "Na voz · 3", and how you are in it.
  $('vb-faces').replaceChildren(...inVoice.slice(0, 3).map((person) => {
    const face = el('span', 'avatar');
    paintAvatar(face, person.name, person.id, person.photo);
    return face;
  }));
  $('vb-title').textContent = inVoice.length ? `Na voz · ${inVoice.length}` : 'Ninguém na voz';
  const sub = $('vb-sub');
  if (voice.joined) {
    myVoiceLine(sub);
  } else {
    delete sub.dataset.pid;
    sub.className = 'vb-sub';
    sub.replaceChildren(el('span', 'm-status ellipsis', inVoice.length ? inVoice.map((p) => p.name).join(', ') : 'toque para falar com a sala'));
  }
  sub.classList.toggle('on', voice.joined);
  $('dock-hangup').hidden = !voice.joined;

  // Chat: the green strip with the mic, or a way into the voice.
  const strip = $('chat-voice');
  strip.classList.toggle('off', !voice.joined);
  const text = $('cv-text');
  const button = $('cv-btn');
  if (voice.joined) {
    const silent = voice.muted || voice.deafened;
    text.replaceChildren(el('span', null, `Na voz · ${inVoice.length} ·`), el('span', 'cv-me'));
    myVoiceLine(text.lastChild);
    button.innerHTML = silent ? ICONS.micOff : ICONS.mic; // fixed markup
    button.append(silent ? 'Ligar' : 'Mudo');
    button.classList.toggle('danger', silent);
    button.setAttribute('aria-label', silent ? 'Ligar microfone' : 'Silenciar microfone');
  } else {
    text.replaceChildren(el('span', null, inVoice.length ? `Fora da voz · ${inVoice.length} na voz` : 'Fora da voz'));
    button.textContent = 'Entrar na voz';
    button.classList.remove('danger');
    button.removeAttribute('aria-label');
  }

  // Lying down: the rail and the messages follow the fullscreen picture.
  placeRail();
  $('rail-mic').hidden = !voice.joined;
}

// ---------- assistindo deitado ----------

// The rail, the messages and the reactions must live inside the fullscreen
// card: nothing outside the fullscreen element is drawn.
function placeRail() {
  const full = document.fullscreenElement;
  const card = theaterCard || (full?.classList.contains('screen') ? full : null);
  const host = card || document.body;
  for (const node of [$('rail'), $('rail-chat'), reactLayer, reactPop]) {
    if (node.parentNode !== host) host.append(node);
  }
  if (!card) setRailChat(false);
}

function setRailChat(open) {
  document.body.classList.toggle('rail-chat-open', open);
  $('rail-chat-btn').setAttribute('aria-pressed', String(open));
  if (open) $('rail-input').focus();
}

function railCard() {
  return $('rail').closest('.screen');
}

// Each message also shows over the picture for a few seconds (CSS fades it).
function mirrorToRail(name, text) {
  const list = $('rail-msgs');
  const li = el('li');
  li.append(el('b', null, name), ` ${text}`);
  list.append(li);
  while (list.childElementCount > RAIL_MESSAGES) list.firstElementChild.remove();
}

$('rail-react').onclick = () => {
  const card = railCard();
  if (card) flashScreenUi(card);
  setReactPicker(reactPop.hidden, $('rail-react'));
};
$('rail-chat-btn').onclick = () => setRailChat(!document.body.classList.contains('rail-chat-open'));
$('rail-exit').onclick = exitFullscreen;
$('rail-form').onsubmit = (e) => {
  e.preventDefault();
  if (sendChatText($('rail-input').value)) $('rail-input').value = '';
};
