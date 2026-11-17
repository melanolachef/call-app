'use strict';

// The lobby: your profile, create a room, join by link, and the rooms you
// have been in (saved in this browser) with how many people are in each now.

const COUNTS_EVERY_MS = 15_000;
let nick = load('nick');
let photo = validPhoto(load('photo'));
let counts = {}; // room id -> people in it now, from /api/rooms

// ---------- perfil ----------

function renderProfile() {
  paintAvatar($('me-avatar'), nick || '?', 1, photo);
  $('me-nick').textContent = nick;
  $('edit').textContent = nick ? 'Editar' : 'Escolher nick';
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
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return ago.format(-minutes, 'minute');
  if (minutes < 24 * 60) return ago.format(-Math.round(minutes / 60), 'hour');
  return ago.format(-Math.round(minutes / (24 * 60)), 'day');
}

function peopleText(id) {
  if (!(id in counts)) return ['…', 'muted'];
  const n = counts[id];
  if (n === 0) return ['ninguém agora', 'muted'];
  return [`● ${n} ${n === 1 ? 'pessoa' : 'pessoas'} agora`, 'online'];
}

function roomItem(room) {
  const name = displayRoomName(room.id);
  const li = el('li', 'room-item');
  const link = el('a', 'room-link');
  link.href = `/room/${room.id}`;
  const icon = el('span', 'room-icon', room.home ? '★' : '#');
  icon.style.background = colorFor(room.id);
  icon.setAttribute('aria-hidden', 'true');
  const text = el('span', 'room-text');
  const [people, cls] = peopleText(room.id);
  const meta = el('span', 'room-meta');
  const when = room.home ? 'sempre aqui' : `${room.pinned ? 'fixada · ' : ''}${timeAgo(room.at)}`;
  meta.append(el('span', cls, people), ` · ${when}`);
  text.append(el('strong', 'ellipsis', name), meta);
  link.append(icon, text);

  const pin = el('button', 'btn small ghost', room.pinned ? 'Desafixar' : 'Fixar');
  pin.setAttribute('aria-pressed', String(!!room.pinned));
  pin.setAttribute('aria-label', `${room.pinned ? 'Desafixar' : 'Fixar'} ${name}`);
  pin.onclick = () => {
    saveRooms(loadRooms().map((r) => (r.id === room.id ? { ...r, pinned: !r.pinned } : r)));
    renderRooms();
  };
  const remove = el('button', 'btn small ghost', 'Remover');
  remove.setAttribute('aria-label', `Tirar ${name} da lista`);
  remove.onclick = () => {
    saveRooms(loadRooms().filter((r) => r.id !== room.id));
    renderRooms();
  };
  li.append(link);
  if (!room.home) li.append(pin, remove); // the fixed room can't be pinned or removed
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
  $('rooms-updated').textContent = 'atualiza sozinho';
  renderRooms();
}

// ---------- início ----------

$('example-url').textContent = `${location.host}/room/churrasco-k3f9x2`;
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
