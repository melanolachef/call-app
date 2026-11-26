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

// A light line under the greeting (#90). A fixed list, written by hand: no
// API, no key, no cost, nothing about the person leaves the browser. A few
// lines only fit some hours; the same line doesn't show twice in a row.
const TAGLINES = {
  any: [
    'Abra uma sala e mande o link para a galera.',
    'Bora juntar o grupo?',
    'A sala está pronta. Falta só a galera.',
    'Quem chamar primeiro escolhe o jogo.',
    'Hoje a ranked sai. Confia.',
    'Uma partida rápida. Só uma. Juro.',
    'Compartilha a tela que a gente torce daqui.',
    'O lag de hoje é culpa de quem?',
    'Microfone no mudo é o novo "tô ouvindo".',
    'Alguém viu o fone de quem sempre some?',
    'Aperta o botão e chama o time.',
    'Sem fila, sem anúncio, só a galera.',
    'Quem perder paga o lanche.',
    'O bonde está esperando você.',
    'Cola na call que a resenha já começou.',
    'Hoje é dia de carregar o time.',
    'Bora ver quem trava primeiro.',
    'Sala aberta, desculpa fechada.',
    'O tutorial acabou. Agora é com vocês.',
    'Mais uma e a gente para. Talvez.',
    'GG antes de começar já é atitude.',
    'Pega a água, ajeita a cadeira e vem.',
    'Seu lugar na call está guardado.',
    'Todo mundo é pro até a primeira morte.',
    'A estratégia de hoje: improvisar.',
  ],
  morning: [
    'Café na mão e controle na outra.',
    'Cedo demais para jogar? Nunca.',
    'Primeira partida do dia conta dobrado.',
  ],
  afternoon: [
    'A tarde pede uma partidinha.',
    'Intervalo merecido: chama a galera.',
    'Ainda dá tempo de subir de elo hoje.',
  ],
  night: [
    'A noite é longa e a fila é curta.',
    'Só mais uma antes de dormir. Sei.',
    'Amanhã você acorda cedo. Hoje não.',
    'Horário nobre da jogatina.',
  ],
};

function pickTagline(hour = new Date().getHours()) {
  const period = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'night';
  const pool = [...TAGLINES.any, ...TAGLINES[period]];
  const last = load('tagline');
  const options = pool.filter((line) => line !== last);
  const line = options[Math.floor(Math.random() * options.length)];
  save('tagline', line);
  return line;
}

$('tagline').textContent = pickTagline();

function renderProfile() {
  paintAvatar($('me-avatar'), nick || '?', 1, photo);
  $('me-nick').textContent = nick || 'Escolher nick';
  $('greeting').textContent = nick ? `${greeting()}, ${nick}.` : `${greeting()}.`;
}

// "2 amigos em call agora." replaces the line under the greeting while any are.
const tagline = $('tagline').textContent;
function renderTagline() {
  const byCode = Object.values(friendPresence).filter(Boolean).length;
  const byAccount = (accountFriends?.amigos ?? []).filter((f) => f.sala).length;
  const n = byCode + byAccount;
  $('tagline').textContent = n ? `${n} ${n === 1 ? 'amigo' : 'amigos'} em call agora.` : tagline;
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
  const text = minutes < 60 ? ago.format(-minutes, 'minute')
    : minutes < 24 * 60 ? ago.format(-Math.round(minutes / 60), 'hour')
      : ago.format(-Math.round(minutes / (24 * 60)), 'day');
  return `visitada ${text}`; // "visitada ontem", "visitada há 3 horas"
}

// Right side of a row: "● 3 agora" in green, or "Vazia".
function peopleText(id) {
  if (!(id in counts)) return ['', ''];
  const n = counts[id];
  return n === 0 ? [mobile.matches ? 'vazia' : 'Vazia', ''] : [`${n} agora`, 'online'];
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

// One square per person in the room (up to 3). Only counts: the server
// doesn't know names, and the lobby shouldn't expose who is where.
function presence(count) {
  const faces = el('span', 'presence');
  faces.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < Math.min(count || 0, 3); i++) faces.append(el('i'));
  return faces;
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
  // "Block [fixa]" over the room code in mono ("block-q81zd0 · visitada
  // ontem"), then who is there and "Entrar", as in the design.
  const text = el('span', 'room-text');
  const title = el('span', 'room-title');
  title.append(el('strong', 'ellipsis', name));
  if (room.home) title.append(el('span', 'tag', 'fixa'));
  else if (room.pinned) title.append(el('span', 'tag', 'fixada'));
  const meta = el('span', 'room-meta ellipsis');
  meta.append(el('span', 'mono', room.id));
  if (!room.home) meta.append(el('span', 'm-hide', ` · ${timeAgo(room.at)}`));
  text.append(title, meta);
  const [people, cls] = peopleText(room.id);
  const chevron = el('span', 'm-only');
  chevron.innerHTML = '<svg class="chevron m-only" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  link.append(icon, text, presence(counts[room.id]), el('span', `room-count ${cls}`, people), el('span', 'room-enter', 'Entrar'), chevron.firstChild);
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

// ---------- amigos ----------

let friendPresence = {}; // code -> { nick, room, count, secs } | null

// Name shown for a friend: what you called them, else their nick (kept
// from the last time they were seen), else the code.
function friendLabel(friend) {
  return friend.name || formatFriendCode(friend.code);
}

function friendItem(friend) {
  const seen = friendPresence[friend.code];
  const li = el('li');
  const row = el('div', 'room-item friend-item');
  const link = el(seen ? 'a' : 'div', 'room-link');
  if (seen) link.href = `/room/${seen.room}`;
  const icon = el('span', 'room-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = initials(friendLabel(friend));
  icon.style.background = colorFor(friend.code);
  icon.classList.toggle('live', !!seen);
  const text = el('span', 'room-text');
  text.append(el('strong', 'ellipsis', friendLabel(friend)));
  const status = el('span', `friend-status ellipsis${seen ? ' online' : ''}`);
  if (seen) {
    status.append('em ', el('b', null, displayRoomName(seen.room)), el('span', 'm-hide', ` · ${seen.count} ${seen.count === 1 ? 'pessoa' : 'pessoas'} · ${friendSince(seen.secs)}`));
  } else {
    status.textContent = 'fora de call';
  }
  text.append(status);
  link.append(icon, text);
  if (seen) {
    const enter = el('span', 'room-enter', 'Entrar');
    enter.append(el('span', 'm-only', '\u00a0junto'));
    link.append(enter);
  }
  row.append(link);
  const actions = el('span', 'room-actions');
  const remove = iconButton(ICON_X, `Tirar ${friendLabel(friend)} dos amigos`);
  remove.onclick = () => {
    if (window.confirm(`Tirar ${friendLabel(friend)} dos seus amigos?`)) removeFriend(friend.code);
  };
  actions.append(remove);
  row.append(actions);
  li.append(row);
  return li;
}

// A friend with an account: same card as a code friend (enter their room),
// removing asks the server.
function accountFriendItem(friend) {
  const li = el('li');
  const row = el('div', 'room-item friend-item');
  const link = el(friend.sala ? 'a' : 'div', 'room-link');
  if (friend.sala) link.href = `/room/${friend.sala}`;
  const icon = el('span', 'room-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = initials(accountFriendName(friend));
  icon.style.background = colorFor(`u${friend.id}`);
  icon.classList.toggle('live', !!friend.sala);
  const text = el('span', 'room-text');
  text.append(el('strong', 'ellipsis', accountFriendName(friend)));
  const status = el('span', `friend-status ellipsis${friend.sala ? ' online' : ''}`);
  if (friend.sala) {
    status.append('em ', el('b', null, displayRoomName(friend.sala)), el('span', 'm-hide', ` · ${friend.pessoas} ${friend.pessoas === 1 ? 'pessoa' : 'pessoas'} · ${friendSince(friend.desde)}`));
  } else if (friend.online) {
    status.classList.add('online');
    status.textContent = 'online';
  } else {
    status.textContent = `@${friend.username}`;
  }
  text.append(status);
  link.append(icon, text);
  if (friend.sala) {
    const enter = el('span', 'room-enter', 'Entrar');
    enter.append(el('span', 'm-only', '\u00a0junto'));
    link.append(enter);
  }
  row.append(link);
  const message = el('button', 'btn small ghost dm-btn', 'Mensagem');
  message.type = 'button';
  message.onclick = () => openDm(friend);
  if (friend.nao_lidas) message.append(el('span', 'badge', String(friend.nao_lidas)));
  row.append(message);
  const actions = el('span', 'room-actions');
  const remove = iconButton(ICON_X, `Desfazer amizade com ${accountFriendName(friend)}`);
  remove.onclick = () => {
    if (window.confirm(`Desfazer a amizade com ${accountFriendName(friend)} (@${friend.username})?`)) friendAction('DELETE', `/api/amigos/${friend.id}`);
  };
  actions.append(remove);
  row.append(actions);
  li.append(row);
  return li;
}

// Someone asked to be your friend: answer right in the list.
function requestItem(friend) {
  const li = el('li');
  const row = el('div', 'room-item friend-item friend-request');
  const box = el('div', 'room-link');
  const icon = el('span', 'room-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = initials(accountFriendName(friend));
  icon.style.background = colorFor(`u${friend.id}`);
  const text = el('span', 'room-text');
  text.append(el('strong', 'ellipsis', accountFriendName(friend)), el('span', 'friend-status ellipsis', `@${friend.username} quer ser seu amigo`));
  const buttons = el('span', 'request-actions');
  const yes = el('button', 'btn small primary', 'Aceitar');
  yes.onclick = () => friendAction('POST', `/api/amigos/${friend.id}/aceitar`, null, `Agora você e ${accountFriendName(friend)} são amigos.`);
  const no = el('button', 'btn small ghost', 'Recusar');
  no.onclick = () => friendAction('DELETE', `/api/amigos/${friend.id}`);
  buttons.append(yes, no);
  box.append(icon, text, buttons);
  row.append(box);
  li.append(row);
  return li;
}

function renderFriends() {
  const withAccount = !!accountFriends;
  $('friends-section').hidden = !friendsSupported && !withAccount;
  if ($('friends-section').hidden) return;
  // Requests first; then friends in a call, then by name (accounts and codes together).
  const inCall = (item) => (item.account ? !!item.account.sala : !!friendPresence[item.code.code]);
  const online = (item) => !!item.account?.online;
  const label = (item) => (item.account ? accountFriendName(item.account) : friendLabel(item.code));
  const everyone = [
    ...(accountFriends?.amigos ?? []).map((account) => ({ account })),
    ...(friendsSupported ? loadFriends() : []).map((code) => ({ code })),
  ].sort((a, b) => Number(inCall(b)) - Number(inCall(a)) || Number(online(b)) - Number(online(a))
    || label(a).localeCompare(label(b), 'pt-BR'));
  const requests = accountFriends?.recebidos ?? [];
  $('friends').replaceChildren(...requests.map(requestItem), ...everyone.map((item) => (item.account ? accountFriendItem(item.account) : friendItem(item.code))));
  $('friends-empty').hidden = requests.length + everyone.length > 0;
  $('friends-empty').textContent = account?.signedIn
    ? 'Adicione amigos pelo @usuário deles, ou mande o seu link de amizade.'
    : 'Adicione amigos pelo código deles para ver em que call estão agora. Mande o seu para eles também.';
  const btn = $('friends-btn');
  btn.replaceChildren(account?.signedIn ? 'Adicionar amigos' : 'Seu código · adicionar');
  if (requests.length) btn.append(el('span', 'badge', String(requests.length)));
  renderTagline();
}
window.addEventListener('account-friends-changed', renderFriends);
// The lobby (and the Windows app on it) keeps you "online" for friends.
onAccountChange(syncOnline);
window.addEventListener('friends-changed', syncOnline); // invisible toggled

async function updateFriends() {
  if (!friendsSupported || document.hidden) return;
  const list = loadFriends();
  const fresh = await fetchFriendPresence(list.map((f) => f.code));
  if (!fresh) return; // offline: keep what we had
  friendPresence = fresh;
  renderTagline();
  // A friend added without a name takes the nick they use.
  let named = false;
  for (const friend of list) {
    const nickSeen = cleanFriendName(fresh[friend.code]?.nick);
    if (!friend.name && nickSeen) {
      friend.name = nickSeen;
      named = true;
    }
  }
  if (named) saveFriends(list); // re-renders through friends-changed
  else renderFriends();
}

$('friends-btn').onclick = () => openFriendsDialog();
window.addEventListener('friends-changed', () => {
  renderFriends();
  updateFriends();
});

// A friend link with an account ("/?u=rafa"): open "Adicionar" with it.
(() => {
  const params = new URLSearchParams(location.search);
  const username = (params.get('u') || '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) return;
  history.replaceState(null, '', location.pathname);
  let opened = false;
  onAccountChange((value) => {
    if (opened || value === undefined) return;
    opened = true;
    if (value && !value.signedIn) toast(`Entre com Google para adicionar @${username}.`, 5000);
    openFriendsDialog({ username });
  });
})();

// A friend link (".../?amigo=7K3F9X2A&nome=Rafa"): offer to add them.
(() => {
  const params = new URLSearchParams(location.search);
  const friend = params.get('amigo') ? parseFriendInput(location.href) : null;
  if (!friend || !friendsSupported) return;
  history.replaceState(null, '', location.pathname);
  openFriendsDialog(friend);
})();

// ---------- celular: Nova sala, Colar convite, Editar ----------

// Phones (same test as the room): the two forms become buttons at the bottom.
const mobile = matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)');
let mobileOk = null;

function askMobile(title, placeholder, okLabel, onOk) {
  $('m-dialog-title').textContent = title;
  $('m-input').value = '';
  $('m-input').placeholder = placeholder;
  $('m-ok').textContent = okLabel;
  mobileOk = onOk;
  $('m-dialog').showModal();
}
$('m-form').onsubmit = (e) => {
  e.preventDefault();
  if (mobileOk?.($('m-input').value) !== false) $('m-dialog').close();
};
$('m-cancel').onclick = () => $('m-dialog').close();

$('m-new').onclick = () => askMobile('Nova sala', 'Nome (opcional)', 'Criar sala', (name) => {
  location.assign(`/room/${newRoomId(name)}`);
});

function joinInvite(text) {
  const id = parseRoom(text);
  if (id) {
    location.assign(`/room/${id}`);
    return true;
  }
  toast('Esse link não parece um convite do CPX Call.');
  return false;
}
// Reads the clipboard when the browser lets it; otherwise asks for the link.
$('m-paste').onclick = async () => {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch { /* no permission: ask */ }
  if (text && parseRoom(text) && text.includes('/room/')) {
    joinInvite(text);
    return;
  }
  askMobile('Entrar com convite', 'Cole o link ou o código', 'Entrar', (value) => joinInvite(value));
};

$('rooms-edit').onclick = () => {
  const on = document.body.classList.toggle('editing');
  $('rooms-edit').setAttribute('aria-pressed', String(on));
  $('rooms-edit').textContent = on ? 'Pronto' : 'Editar';
};
mobile.addEventListener('change', renderRooms);

// ---------- início ----------

renderProfile();
whenAgeOk();
if (nick) ensureHomeRoom(nick);
onProfileChangedElsewhere(() => { // edited in a room open in another tab
  nick = cleanNick(load('nick'));
  photo = validPhoto(load('photo'));
  renderProfile();
});
renderRooms();
updateCounts();
setInterval(updateCounts, COUNTS_EVERY_MS);
document.addEventListener('visibilitychange', updateCounts);
renderFriends();
updateFriends();
setInterval(updateFriends, COUNTS_EVERY_MS);
setInterval(() => !document.hidden && loadAccountFriends(), COUNTS_EVERY_MS);
document.addEventListener('visibilitychange', updateFriends);
window.addEventListener('storage', (e) => { // changed in another tab
  renderRooms();
  if (e.key === 'friends' || e.key === 'friendSecret') renderFriends();
});
window.addEventListener('pageshow', (e) => { // back button from a room
  if (e.persisted) {
    renderRooms();
    updateCounts();
  }
});

// "Apoiar" only when the server has a Pix key (/api/apoio answers).
fetch('/api/apoio', { cache: 'no-store' }).then((res) => {
  $('support').hidden = !res.ok;
}, () => {});

// Accounts (optional): "Entrar" while signed out, the @username on the profile button.
onAccountChange((value) => {
  $('signin-top').hidden = !value || value.signedIn;
  $('edit').title = value?.signedIn && value.username ? `@${value.username} · Editar perfil` : 'Editar perfil';
});
$('signin-top').onclick = (e) => {
  e.preventDefault();
  location.assign(signInUrl());
};

// The Windows app (desktop/) only makes sense on Windows, and not inside itself.
$('get-app').hidden = !!window.__TAURI__ || !/Windows/.test(navigator.userAgent);

// Phones: "Instalar" puts the site on the home screen, where it opens without
// the browser's bars (on iPhone that is the only way to watch a stream on the
// whole display). Android offers the install prompt; iPhone only has the
// Share menu, so the button explains it.
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const touch = matchMedia('(pointer: coarse)').matches;
const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = installed || !touch;
});
$('install').hidden = installed || !iphone;
$('install').onclick = async () => {
  if (!installPrompt) {
    toast('No Safari, toque em Compartilhar e depois em "Adicionar à Tela de Início".', 8000);
    return;
  }
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome === 'accepted') $('install').hidden = true;
};
