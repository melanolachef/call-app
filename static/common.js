'use strict';

// Shared by the lobby and the room: small DOM helpers, browser storage, the
// profile (nick + photo) and its dialog, the toast and the list of rooms you
// have been in. Nothing here talks to the server.

const AVATAR_COLORS = ['#2E3A5C', '#5C3B3B', '#3B5C47', '#4A3B5C', '#5C4F3B', '#3B525C'];
const MAX_PHOTO = 40_000; // photos travel inside signaling messages (64 KB limit on the server)

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function load(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* private mode: keep it in memory */ }
}

// ---------- perfil ----------

function cleanNick(value) {
  return Array.from(String(value ?? '').trim()).slice(0, 32).join('');
}

// Only inline images are accepted: a remote URL would let a participant
// track everyone else's IP when their browser fetches it.
function validPhoto(value) {
  return typeof value === 'string' && value.length <= MAX_PHOTO &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

// Center-crops and shrinks the picked image to a small JPEG data URL.
async function photoFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const size = 128;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1F2230'; // JPEG has no transparency
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= MAX_PHOTO) return url;
  }
  throw new Error('foto grande demais');
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // One letter, as in the design; two only for two-word names ("Ana Paula" → AP).
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0] ?? '?').slice(0, 1);
  return chars.join('').toUpperCase();
}

function paintAvatar(node, name, id, photo) {
  node.textContent = photo ? '' : initials(name || '?');
  // Safe inside url(""): validPhoto() only lets base64 characters through.
  // Without a photo, the CSS grey gradient shows.
  node.style.backgroundImage = photo ? `url("${photo}")` : '';
}

// ---------- diálogo de perfil e toast (marcação comum às duas páginas) ----------

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="profile" aria-labelledby="profile-title">
    <form id="profile-form">
      <div class="banner"></div>
      <div class="dialog-body">
        <div class="avatar-row">
          <div class="avatar big" id="preview-avatar" aria-hidden="true"></div>
          <button type="button" class="btn small" id="photo-pick">Adicionar foto</button>
          <button type="button" class="btn small" id="photo-remove">Remover</button>
          <input type="file" id="photo-input" accept="image/*" hidden>
        </div>
        <div class="heading">
          <h2 id="profile-title">Como seus amigos vão te ver?</h2>
          <span class="muted">Nick e foto aparecem só para quem está na sala.</span>
        </div>
        <label class="field">
          <span class="muted">Nick</span>
          <input id="nick-input" maxlength="32" autocomplete="nickname" required>
        </label>
        <button class="btn small primary" id="profile-submit">Salvar</button>
        <button type="button" class="btn small" id="open-appearance">Personalizar aparência</button>
      </div>
    </form>
  </dialog>
  <div class="toast" id="toast" role="status" hidden></div>
`);

let draftPhoto = ''; // photo being edited in the profile dialog
let profileColorId = 1;
let profileRequired = false;
let profileOnSave = null;

// Opens the profile dialog; `onSave(nick, photo)` runs after both are stored.
function openProfileDialog({ title, submitLabel, required = false, nick, photo, colorId, onSave }) {
  $('profile-title').textContent = title;
  $('profile-submit').textContent = submitLabel;
  $('nick-input').value = nick;
  draftPhoto = photo;
  profileColorId = colorId ?? 1;
  profileRequired = required;
  profileOnSave = onSave;
  updateProfilePreview();
  $('profile').showModal();
}

function updateProfilePreview() {
  paintAvatar($('preview-avatar'), cleanNick($('nick-input').value), profileColorId, draftPhoto);
  $('photo-remove').hidden = !draftPhoto;
  $('photo-pick').textContent = draftPhoto ? 'Trocar foto' : 'Adicionar foto';
}

$('nick-input').oninput = updateProfilePreview;
$('photo-pick').onclick = () => $('photo-input').click();
$('photo-remove').onclick = () => {
  draftPhoto = '';
  updateProfilePreview();
};
$('photo-input').onchange = async () => {
  const file = $('photo-input').files[0];
  $('photo-input').value = ''; // picking the same file again still fires onchange
  if (!file) return;
  try {
    draftPhoto = await photoFromFile(file);
    updateProfilePreview();
  } catch {
    toast('Não deu para usar essa imagem');
  }
};
$('profile').oncancel = (e) => {
  if (profileRequired) e.preventDefault(); // e.g. a nick is required before joining
};
$('profile-form').onsubmit = (e) => {
  e.preventDefault();
  const nick = cleanNick($('nick-input').value);
  if (!nick) return;
  save('nick', nick);
  save('photo', draftPhoto);
  $('profile').close();
  profileOnSave?.(nick, draftPhoto);
};

let toastTimer = null;
function toast(text, ms = 2500) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

// ---------- aparência ----------

// Accent, theme and background: only on this screen, saved in this browser.
// Changes apply live behind the dialog; theme.js (in <head>) applies them on
// every page load. Nothing here runs per frame.
const ACCENTS = [['Azul', '#0A84FF'], ['Roxo', '#7C5CFF'], ['Ciano', '#64D2FF'], ['Verde', '#30D158'], ['Rosa', '#FF375F'], ['Laranja', '#FF9F0A']];
const THEME_CHOICES = [['escuro', 'Escuro'], ['grafite', 'Grafite'], ['meia-noite', 'Meia-noite']];
const BG_CHOICES = [['none', 'Nenhum'], ['aurora', 'Aurora'], ['por-do-sol', 'Pôr do sol'], ['oceano', 'Oceano'], ['image', 'Sua imagem']];
const MAX_BG_IMAGE = 1_800_000; // characters of data URL (localStorage holds ~5 MB)

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="appearance" aria-labelledby="ap-title">
    <form method="dialog" class="dialog-body">
      <div class="heading">
        <h2 id="ap-title">Aparência</h2>
        <span class="muted">Só na sua tela, salva neste navegador.</span>
      </div>
      <fieldset class="ap-section"><legend>Cor de destaque</legend><div class="swatches" id="ap-accents"></div></fieldset>
      <fieldset class="ap-section"><legend>Tema</legend><div class="choices" id="ap-themes"></div></fieldset>
      <fieldset class="ap-section"><legend>Fundo</legend><div class="bg-grid" id="ap-backgrounds"></div></fieldset>
      <input type="file" id="ap-image" accept="image/*" hidden>
      <div class="actions">
        <button type="button" class="btn small" id="ap-reset">Restaurar padrão</button>
        <button class="btn small primary">Pronto</button>
      </div>
    </form>
  </dialog>
`);

function saveAppearance(patch) {
  const next = { ...loadAppearance(), ...patch };
  save('appearance', JSON.stringify(next));
  applyAppearance(next);
  renderAppearance();
}

function renderAppearance() {
  const current = loadAppearance();
  const isPreset = ACCENTS.some(([, hex]) => hex.toLowerCase() === current.accent.toLowerCase());
  $('ap-accents').replaceChildren(...ACCENTS.map(([name, hex]) => {
    const button = el('button', 'swatch');
    button.type = 'button';
    button.style.background = hex;
    button.title = name;
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', String(hex.toLowerCase() === current.accent.toLowerCase()));
    button.onclick = () => saveAppearance({ accent: hex });
    return button;
  }), (() => {
    const label = el('label', 'swatch swatch-custom');
    label.title = 'Outra cor';
    label.setAttribute('aria-pressed', String(!isPreset));
    if (!isPreset) label.style.background = current.accent;
    const input = el('input');
    input.type = 'color';
    input.value = current.accent;
    input.setAttribute('aria-label', 'Escolher outra cor');
    input.oninput = () => saveAppearance({ accent: input.value });
    label.append(input);
    return label;
  })());
  $('ap-themes').replaceChildren(...THEME_CHOICES.map(([id, name]) => {
    const button = el('button', 'choice', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(current.theme === id));
    button.onclick = () => saveAppearance({ theme: id });
    return button;
  }));
  $('ap-backgrounds').replaceChildren(...BG_CHOICES.map(([id, name]) => {
    const button = el('button', 'bg-tile', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(current.background === id));
    if (BACKGROUNDS[id]) button.style.backgroundImage = BACKGROUNDS[id];
    if (id === 'image') {
      const saved = load('appearance-image');
      if (saved) button.style.backgroundImage = `url("${saved}")`;
      button.textContent = saved ? 'Sua imagem' : 'Enviar imagem';
    }
    button.onclick = () => {
      if (id === 'image' && (!load('appearance-image') || current.background === 'image')) $('ap-image').click();
      else saveAppearance({ background: id });
    };
    return button;
  }));
}

// Shrinks the picked picture to at most 1920x1080 JPEG so it fits in storage.
async function backgroundFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.8, 0.65, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= MAX_BG_IMAGE) return url;
  }
  throw new Error('imagem grande demais');
}

$('ap-image').onchange = async () => {
  const file = $('ap-image').files[0];
  $('ap-image').value = '';
  if (!file) return;
  try {
    const url = await backgroundFromFile(file);
    localStorage.setItem('appearance-image', url); // may throw if storage is full
    saveAppearance({ background: 'image' });
  } catch {
    toast('Não deu para usar essa imagem como fundo. Tente uma menor.');
  }
};

$('ap-reset').onclick = () => {
  save('appearance', '');
  save('appearance-image', '');
  applyAppearance();
  renderAppearance();
};

function openAppearance() {
  renderAppearance();
  $('appearance').showModal();
}
$('open-appearance').onclick = openAppearance;

// ---------- salas ----------

function validRoomId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// "churrasco-k3f9x2" (name + random suffix) shows as "churrasco"; random IDs
// show their first 8 characters.
function roomName(id) {
  return id.match(/^(.+)-[a-z0-9]{4,6}$/)?.[1] ?? id.slice(0, 8);
}

// Rooms you have been in, newest first: [{ id, at, pinned }].
function loadRooms() {
  try {
    const list = JSON.parse(load('rooms') || '[]');
    return Array.isArray(list) ? list.filter((r) => r && validRoomId(r.id)) : [];
  } catch {
    return [];
  }
}

function saveRooms(list) {
  save('rooms', JSON.stringify(list.slice(0, 30)));
}

function rememberRoom(id) {
  const list = loadRooms();
  const old = list.find((r) => r.id === id);
  saveRooms([{ id, at: Date.now(), pinned: !!old?.pinned }, ...list.filter((r) => r.id !== id)]);
}

function roomUrl(id) {
  return `${location.origin}/room/${id}`;
}

function slugify(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '') // "Sábado" -> "Sabado"
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
}

function randomChars(count, alphabet) {
  return Array.from(crypto.getRandomValues(new Uint8Array(count)), (b) => alphabet[b % alphabet.length]).join('');
}

// A name gets a 6-character random suffix so strangers can't guess the room;
// no name gives a fully random ID.
function newRoomId(name) {
  const slug = slugify(name);
  return slug
    ? `${slug}-${randomChars(6, 'abcdefghijklmnopqrstuvwxyz0123456789')}`
    : randomChars(16, '0123456789abcdef');
}

function colorFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ---------- Block (sala fixa) ----------

// Your fixed room: created once in the lobby (after you pick a nick), kept in
// this browser and always one click away (like a Discord group). It is a
// normal room with a stable, unguessable ID named after you
// ("block-de-lucas-x7k2p9"), so invited friends see whose room it is; the
// server knows nothing about it. Without storage (private mode) it lasts until
// the page is closed. Only reading never creates it: opening an invite
// shouldn't leave a room behind in a friend's browser.
let homeFallback = '';
function homeRoomId() {
  const saved = load('home-room');
  return validRoomId(saved) ? saved : homeFallback;
}

function ensureHomeRoom(nick) {
  const existing = homeRoomId();
  // The first version made it a bare random code ("faa5361814923c29"), which
  // friends saw as gibberish: swap it for a named one, keeping the old room
  // in the list so links already sent still lead somewhere.
  if (existing && !/^[0-9a-f]{16}$/.test(existing)) return existing;
  if (existing) rememberRoom(existing);
  const slug = slugify(nick);
  const id = newRoomId(slug ? `block-de-${slug}` : 'meu-block');
  homeFallback = id;
  save('home-room', id);
  return id;
}

function isHomeRoom(id) {
  return !!id && id === homeRoomId();
}

function displayRoomName(id) {
  return isHomeRoom(id) ? 'Block' : roomName(id);
}

// Fixed room first (when there is one), then pinned ones, then the rest by most recent.
function orderedRooms() {
  const home = homeRoomId();
  const rest = loadRooms()
    .filter((r) => r.id !== home)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);
  return home ? [{ id: home, at: 0, pinned: true, home: true }, ...rest] : rest;
}

// How many people are in each room now (server's /api/rooms); null if offline.
async function fetchRoomCounts(ids) {
  if (!ids.length) return null;
  try {
    const res = await fetch(`/api/rooms?ids=${ids.join(',')}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
