'use strict';

// The lobby: your profile, create a room, join by link, and the rooms you
// have been in (saved in this browser) with how many people are in each now.

const COUNTS_EVERY_MS = 15_000;
let nick = load('nick');
let photo = validPhoto(load('photo'));
let counts = {}; // room id -> people in it now, from /api/rooms

// ---------- perfil ----------

function greeting(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function renderProfile() {
  paintAvatar($('me-avatar'), nick || '?', 1, photo);
  $('me-nick').textContent = nick || 'Escolher nick';
  $('greeting').textContent = nick ? `${greeting()}, ${nick}.` : `${greeting()}.`;
}

$('appearance-btn').onclick = openAppearance;
$('edit').onclick = () => openProfileDialog({
  title: nick ? 'Editar perfil' : 'Como seus amigos vão te ver?',
  submitLabel: 'Salvar',
  nick,
  photo,
  colorId: 1,
  onSave(newNick, newPhoto) {
    nick = newNick;
    photo = newPhoto;
    renderProfile();
    ensureHomeRoom(nick); // the fixed room is named after the first nick
    renderRooms();
    updateCounts();
  },
});

// ---------- criar / entrar ----------

// Accepts a full invite link or just the room code.
function parseRoom(input) {
  const text = input.trim();
  const id = text.match(/\/room\/([A-Za-z0-9_-]{1,64})/)?.[1] ?? text;
  return validRoomId(id) ? id : null;
}

$('create-form').onsubmit = (e) => {
  e.preventDefault();
  location.assign(`/room/${newRoomId($('room-name').value)}`);
};

$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const id = parseRoom($('join-link').value);
  if (id) location.assign(`/room/${id}`);
  else toast('Esse link não parece um convite do CPX Call.');
};

// ---------- suas salas ----------

const ago = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
function timeAgo(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'Agora há pouco';
  const text = minutes < 60 ? ago.format(-minutes, 'minute')
    : minutes < 24 * 60 ? ago.format(-Math.round(minutes / 60), 'hour')
      : ago.format(-Math.round(minutes / (24 * 60)), 'day');
  return `Visitada ${text}`; // "Visitada ontem", "Visitada há 3 horas"
}

// Right side of a row: "● 3 agora" in green, or "Vazia".
function peopleText(id) {
  if (!(id in counts)) return ['', ''];
  const n = counts[id];
  return n === 0 ? ['Vazia', ''] : [`${n} agora`, 'online'];
}

const SVG = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`; // fixed markup only
const ICON_HOME = SVG('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>');
const ICON_PIN = SVG('<path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z"/>');
const ICON_X = SVG('<path d="M18 6L6 18M6 6l12 12"/>');

function iconButton(svg, label, pressed) {
  const button = el('button', 'ghost');
  button.innerHTML = svg;
  button.title = label;
  button.setAttribute('aria-label', label);
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  return button;
}

function roomItem(room) {
  const name = displayRoomName(room.id);
  const li = el('li');
  const row = el('div', 'room-item');
  const link = el('a', 'room-link');
  link.href = `/room/${room.id}`;
  const icon = el('span', 'room-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (room.home) icon.innerHTML = ICON_HOME;
  else icon.textContent = Array.from(name)[0] ?? '#';
  const text = el('span', 'room-text');
  const when = room.home ? 'Sua sala fixa' : `${room.pinned ? 'Fixada · ' : ''}${timeAgo(room.at)}`;
  text.append(el('strong', 'ellipsis', name), el('span', 'room-meta ellipsis', when));
  const [people, cls] = peopleText(room.id);
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('class', 'chevron');
  chevron.innerHTML = '<path d="M9 6l6 6-6 6"/>';
  link.append(icon, text, el('span', `room-count ${cls}`, people), chevron);
  row.append(link);

  if (!room.home) { // the fixed room can't be pinned or removed
    const actions = el('span', 'room-actions');
    const pin = iconButton(ICON_PIN, `${room.pinned ? 'Desafixar' : 'Fixar'} ${name}`, !!room.pinned);
    pin.onclick = () => {
      saveRooms(loadRooms().map((r) => (r.id === room.id ? { ...r, pinned: !r.pinned } : r)));
      renderRooms();
    };
    const remove = iconButton(ICON_X, `Tirar ${name} da lista`);
    remove.onclick = () => {
      saveRooms(loadRooms().filter((r) => r.id !== room.id));
      renderRooms();
    };
    actions.append(pin, remove);
    row.append(actions);
  }
  li.append(row);
  return li;
}

function renderRooms() {
  const list = orderedRooms();
  $('rooms-empty').hidden = list.some((r) => !r.home);
  $('rooms').replaceChildren(...list.map(roomItem));
}

async function updateCounts() {
  const ids = orderedRooms().map((r) => r.id);
  if (!ids.length || document.hidden) return;
  const fresh = await fetchRoomCounts(ids);
  if (!fresh) return; // offline: keep the last numbers
  counts = fresh;
  renderRooms();
}

// ---------- início ----------

renderProfile();
if (nick) ensureHomeRoom(nick);
renderRooms();
updateCounts();
setInterval(updateCounts, COUNTS_EVERY_MS);
document.addEventListener('visibilitychange', updateCounts);
window.addEventListener('storage', renderRooms); // a room opened in another tab
window.addEventListener('pageshow', (e) => { // back button from a room
  if (e.persisted) {
    renderRooms();
    updateCounts();
  }
});

// The Windows app (desktop/) only makes sense on Windows, and not inside itself.
$('get-app').hidden = !!window.__TAURI__ || !/Windows/.test(navigator.userAgent);
