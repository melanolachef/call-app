'use strict';

// The home on wide screens (docs/design/cpx-call-novas-telas.html, "Início ·
// Amigos"), in the shape of a chat app: a thin column of rooms on the left,
// a side panel (search, Amigos/Salas, who is in a call, you), the friends in
// the middle and "Agora" on the right. Phones keep their own layout (the
// .lobby markup). Everything here is drawn from what lobby.js already loads
// (rooms and counts, friends by code and by account) on its 'lobby-changed'.

const PANEL_ICONS = {
  friends: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/></svg>',
  rooms: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
};
let panelView = 'amigos'; // or 'salas'
let panelTab = 'online'; // or 'todos'
let panelSearch = '';
let panelQueued = false;

// Everyone you follow, by account or by code, in one shape.
function panelFriends() {
  const people = (accountFriends?.amigos ?? []).map((f) => ({
    key: `u${f.id}`, name: accountFriendName(f), sub: `@${f.username}`, account: f,
    state: f.sala ? 'call' : f.online ? 'online' : 'off', room: f.sala, count: f.pessoas, secs: f.desde, unread: f.nao_lidas || 0,
  }));
  if (friendsSupported) {
    for (const f of loadFriends()) {
      const seen = friendPresence[f.code];
      people.push({
        key: f.code, name: friendLabel(f), sub: formatFriendCode(f.code), code: f,
        state: seen ? 'call' : 'off', room: seen?.room, count: seen?.count, secs: seen?.secs, unread: 0,
      });
    }
  }
  const rank = { call: 0, online: 1, off: 2 };
  return people.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'pt-BR'));
}

// Rooms with people now: yours (counts) and wherever friends are.
function panelCalls(people) {
  const rooms = new Map();
  for (const r of orderedRooms()) if (counts[r.id] > 0) rooms.set(r.id, { id: r.id, count: counts[r.id], friends: [], secs: 0 });
  for (const p of people) {
    if (p.state !== 'call') continue;
    const room = rooms.get(p.room) ?? { id: p.room, count: p.count || 1, friends: [], secs: 0 };
    room.friends.push(p);
    room.count = Math.max(room.count, p.count || 1);
    room.secs = Math.max(room.secs, p.secs || 0);
    rooms.set(p.room, room);
  }
  return [...rooms.values()].sort((a, b) => b.friends.length - a.friends.length || b.count - a.count);
}

const matches = (text) => !panelSearch || text.toLowerCase().includes(panelSearch);

function face(person, cls = '') {
  const node = el('span', `avatar ${cls}`.trim());
  node.setAttribute('aria-hidden', 'true');
  node.textContent = initials(person.name);
  node.style.background = colorFor(person.key);
  return node;
}

function whoIsThere(room) {
  const names = room.friends.map((f) => f.name);
  const others = room.count - names.length;
  if (!names.length) return `${room.count} ${room.count === 1 ? 'pessoa' : 'pessoas'}`;
  return others > 0 ? `${names.slice(0, 2).join(', ')} e mais ${others + Math.max(0, names.length - 2)}` : names.join(', ');
}

// ---------- coluna de salas ----------

function renderRail() {
  $('rail-rooms').replaceChildren(...orderedRooms().map((r) => {
    const name = displayRoomName(r.id);
    const link = el('a', 'rail-room', Array.from(name.replace(/[^\p{L}\p{N}]/gu, '')).slice(0, 2).join('').toLowerCase() || '#');
    link.href = `/room/${r.id}`;
    link.title = counts[r.id] ? `${name} · ${counts[r.id]} agora` : name;
    link.setAttribute('aria-label', link.title);
    if (counts[r.id] > 0) link.append(el('span', 'rail-badge', String(counts[r.id])));
    return link;
  }));
}

// ---------- painel lateral ----------

function renderSide(people, calls) {
  const online = people.filter((p) => p.state !== 'off').length;
  $('panel-friends-count').textContent = people.length ? `${online}/${people.length}` : '';
  document.querySelectorAll('.panel-nav').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === panelView)));
  const shown = calls.filter((c) => matches(displayRoomName(c.id)) || c.friends.some((f) => matches(f.name)));
  $('panel-calls-title').hidden = !shown.length;
  $('panel-calls').replaceChildren(...shown.map((room) => {
    const link = el('a', 'panel-call');
    link.href = `/room/${room.id}`;
    const text = el('span', 'panel-call-text');
    text.append(el('span', 'ellipsis', displayRoomName(room.id)), el('span', 'panel-call-sub ellipsis', whoIsThere(room)));
    const faces = el('span', 'panel-faces');
    faces.append(...room.friends.slice(0, 3).map((f) => face(f)));
    link.append(text, faces);
    const li = el('li');
    li.append(link);
    return li;
  }));
  // You, at the bottom.
  paintAvatar($('panel-me-face'), nick || '?', 1, photo);
  $('panel-me-name').textContent = nick || 'Escolher nick';
  $('panel-me-status').textContent = isInvisible() ? 'invisível' : account?.signedIn ? 'online' : account ? 'sem conta' : '';
  $('panel-me-status').classList.toggle('online', !isInvisible() && !!account?.signedIn);
  $('panel-signin').hidden = !account || account.signedIn;
}

// ---------- amigos ----------

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.friend-more')) closeMenu();
});

function friendMenu(person, anchor) {
  closeMenu();
  const menu = el('div', 'panel-menu card');
  const item = (text, run, cls = '') => {
    const b = el('button', `panel-menu-item ${cls}`.trim(), text);
    b.type = 'button';
    b.onclick = () => {
      closeMenu();
      run();
    };
    menu.append(b);
  };
  if (person.account) {
    item('Mensagem', () => openDm(person.account));
    item('Desfazer amizade', () => {
      if (window.confirm(`Desfazer a amizade com ${person.name} (${person.sub})?`)) friendAction('DELETE', `/api/amigos/${person.account.id}`);
    }, 'danger');
  } else {
    item('Copiar código', () => copyText(formatFriendCode(person.code.code), 'Código copiado.'));
    item('Tirar dos amigos', () => {
      if (window.confirm(`Tirar ${person.name} dos seus amigos?`)) removeFriend(person.code.code);
    }, 'danger');
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  openMenu = menu;
}

function friendRowWide(person) {
  const row = el('li', `panel-friend ${person.state}`);
  const avatar = el('span', 'panel-face-wrap');
  avatar.append(face(person), el('span', `presence-dot ${person.state}`));
  const text = el('span', 'panel-friend-text');
  const status = el('span', 'panel-friend-status ellipsis');
  if (person.state === 'call') {
    status.append('em ', el('b', null, displayRoomName(person.room)), person.count ? ` · ${person.count} ${person.count === 1 ? 'pessoa' : 'pessoas'}` : '');
  } else {
    status.textContent = person.state === 'online' ? 'online' : 'offline';
  }
  text.append(el('strong', 'ellipsis', person.name), status);
  row.append(avatar, text);
  if (person.account && person.unread) {
    const msg = el('button', 'btn small ghost panel-unread', 'Mensagem');
    msg.type = 'button';
    msg.append(el('span', 'badge', String(person.unread)));
    msg.onclick = () => openDm(person.account);
    row.append(msg);
  }
  if (person.state === 'call') {
    const join = el('a', 'btn small primary', 'Entrar junto');
    join.href = `/room/${person.room}`;
    row.append(join);
  }
  const more = el('button', 'icon-btn friend-more');
  more.type = 'button';
  more.innerHTML = PANEL_ICONS.dots; // fixed markup
  more.setAttribute('aria-label', `Mais opções para ${person.name}`);
  more.onclick = () => (openMenu ? closeMenu() : friendMenu(person, more));
  row.append(more);
  if (person.account) {
    row.classList.add('clickable');
    row.ondblclick = () => openDm(person.account);
  }
  return row;
}

function requestRowWide(f) {
  const person = { key: `u${f.id}`, name: accountFriendName(f) };
  const row = el('li', 'panel-friend request');
  const text = el('span', 'panel-friend-text');
  text.append(el('strong', 'ellipsis', person.name), el('span', 'panel-friend-status ellipsis', `@${f.username} quer ser seu amigo`));
  const yes = el('button', 'btn small primary', 'Aceitar');
  yes.onclick = () => friendAction('POST', `/api/amigos/${f.id}/aceitar`, null, `Agora você e ${person.name} são amigos.`);
  const no = el('button', 'btn small ghost', 'Recusar');
  no.onclick = () => friendAction('DELETE', `/api/amigos/${f.id}`);
  row.append(face(person), text, yes, no);
  return row;
}

function group(title, items) {
  if (!items.length) return [];
  return [el('h3', 'panel-group', `${title} — ${items.length}`), el('ul', 'panel-list', null)].map((node, i) => {
    if (i === 1) node.append(...items);
    return node;
  });
}

function renderFriendsView(people) {
  const visible = people.filter((p) => matches(p.name) || matches(p.sub));
  const requests = (accountFriends?.recebidos ?? []).filter((f) => matches(accountFriendName(f)) || matches(f.username));
  const online = visible.filter((p) => p.state !== 'off');
  const offline = visible.filter((p) => p.state === 'off');
  const body = [
    ...group('Pedidos', requests.map(requestRowWide)),
    ...group('Online', online.map(friendRowWide)),
    ...(panelTab === 'todos' ? group('Fora do ar', offline.map(friendRowWide)) : []),
  ];
  if (!body.length) {
    const empty = el('div', 'panel-empty');
    empty.append(el('p', null, people.length
      ? (panelTab === 'online' ? 'Nenhum amigo online agora.' : 'Ninguém com esse nome.')
      : 'Ainda sem amigos por aqui. Adicione pelo @usuário ou mande o seu código.'));
    const add = el('button', 'btn small primary', 'Adicionar amigo');
    add.onclick = () => openFriendsDialog();
    empty.append(add);
    body.push(empty);
  }
  $('panel-body').replaceChildren(...body);
}

// ---------- salas ----------

function renderRoomsView() {
  const list = orderedRooms().filter((r) => matches(displayRoomName(r.id)) || matches(r.id));
  const rows = list.map((r) => {
    const row = el('li', 'panel-room');
    const link = el('a', 'panel-room-link');
    link.href = `/room/${r.id}`;
    const text = el('span', 'panel-friend-text');
    const title = el('strong', 'ellipsis', displayRoomName(r.id));
    if (r.home) title.append(el('span', 'tag', 'fixa'));
    text.append(title, el('span', 'panel-friend-status mono ellipsis', r.id));
    const n = counts[r.id];
    link.append(text, el('span', `panel-room-count${n ? ' online' : ''}`, n === undefined ? '' : n ? `${n} agora` : 'vazia'));
    row.append(link);
    if (!r.home) {
      const pin = el('button', 'icon-btn friend-more', null);
      pin.type = 'button';
      pin.innerHTML = ICON_PIN; // fixed markup
      pin.classList.toggle('pinned', !!r.pinned);
      pin.title = r.pinned ? 'Desafixar' : 'Fixar';
      pin.setAttribute('aria-label', `${pin.title} ${displayRoomName(r.id)}`);
      pin.onclick = () => {
        saveRooms(loadRooms().map((x) => (x.id === r.id ? { ...x, pinned: !x.pinned } : x)));
        renderRooms();
      };
      const remove = el('button', 'icon-btn friend-more', null);
      remove.type = 'button';
      remove.innerHTML = ICON_X; // fixed markup
      remove.title = 'Tirar da lista';
      remove.setAttribute('aria-label', `Tirar ${displayRoomName(r.id)} da lista`);
      remove.onclick = () => {
        saveRooms(loadRooms().filter((x) => x.id !== r.id));
        renderRooms();
      };
      row.append(pin, remove);
    }
    return row;
  });
  const create = el('form', 'panel-create');
  const input = el('input', 'input');
  input.maxLength = 40;
  input.placeholder = 'Nome da sala nova (opcional)';
  input.setAttribute('aria-label', 'Nome da sala nova');
  const go = el('button', 'btn small primary', 'Criar sala');
  create.append(input, go);
  create.onsubmit = (e) => {
    e.preventDefault();
    location.assign(`/room/${newRoomId(input.value)}`);
  };
  $('panel-body').replaceChildren(create, ...group('Suas salas', rows));
}

// ---------- coluna "Agora" ----------

function renderNow(calls) {
  const cards = calls.slice(0, 6).map((room, i) => {
    const card = el('div', 'now-card');
    const text = el('span', 'panel-friend-text');
    const minutes = Math.round((room.secs || 0) / 60);
    text.append(el('strong', 'ellipsis', displayRoomName(room.id)),
      el('span', 'panel-friend-status ellipsis', `${whoIsThere(room)}${minutes ? ` · ${minutes} min` : ''}`));
    const join = el('a', `btn small ${i === 0 ? 'primary' : 'ghost'}`, 'Entrar');
    join.href = `/room/${room.id}`;
    card.append(text, join);
    return card;
  });
  if (!cards.length) {
    const empty = el('div', 'now-empty');
    empty.append(el('p', null, 'Ninguém em call agora. Abra uma sala e chame a galera.'));
    const create = el('button', 'btn small', 'Nova sala');
    create.onclick = () => $('rail-new').click();
    empty.append(create);
    cards.push(empty);
  }
  $('now-rooms').replaceChildren(...cards);
  $('now-invisible').checked = isInvisible();
  $('now-code-box').hidden = !friendsSupported;
}

// ---------- tudo junto ----------

function renderPanel() {
  panelQueued = false;
  if (!$('home-panel') || getComputedStyle($('home-panel')).display === 'none') return;
  const people = panelFriends();
  const calls = panelCalls(people);
  renderRail();
  renderSide(people, calls);
  $('panel-title').textContent = panelView === 'amigos' ? 'Amigos' : 'Salas';
  $('panel-title-icon').innerHTML = panelView === 'amigos' ? PANEL_ICONS.friends : PANEL_ICONS.rooms; // fixed markup
  $('panel-tabs').hidden = panelView !== 'amigos';
  document.querySelectorAll('.panel-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === panelTab)));
  if (panelView === 'amigos') renderFriendsView(people);
  else renderRoomsView();
  renderNow(calls);
}

function queuePanel() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(renderPanel);
}

window.addEventListener('lobby-changed', queuePanel);
window.addEventListener('account-friends-changed', queuePanel);
window.addEventListener('friends-changed', queuePanel);
onAccountChange(queuePanel);
matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)').addEventListener('change', queuePanel);

document.querySelectorAll('.panel-nav').forEach((b) => (b.onclick = () => {
  panelView = b.dataset.view;
  queuePanel();
}));
document.querySelectorAll('.panel-tab').forEach((b) => (b.onclick = () => {
  panelTab = b.dataset.tab;
  queuePanel();
}));
$('panel-add').onclick = () => openFriendsDialog();
$('panel-search').oninput = () => {
  panelSearch = $('panel-search').value.trim().toLowerCase();
  queuePanel();
};
$('rail-new').onclick = () => $('m-new').click(); // same "Nova sala" dialog as the phone
$('rail-paste').onclick = () => $('m-paste').click();
$('rail-settings').onclick = () => openSettings('perfil');
$('panel-me-settings').onclick = () => openSettings('perfil');
$('panel-me-face').onclick = () => $('edit').click();
$('panel-signin').onclick = () => location.assign(signInUrl());
$('panel-code-copy').onclick = async () => copyText(await friendLink(), 'Link do seu código copiado. Mande para os amigos.');
$('now-invisible').onchange = () => setInvisible($('now-invisible').checked);
$('now-add').onsubmit = async (e) => {
  e.preventDefault();
  const parsed = parseFriendInput($('now-code').value);
  if (!parsed) {
    toast('Esse código não parece certo. São 8 letras e números, como 7K3F-9X2A.');
    return;
  }
  const result = await addFriend(parsed.code, parsed.name);
  toast({ self: 'Esse é o seu próprio código.', exists: 'Já está nos seus amigos.', full: 'Limite de amigos atingido.', added: 'Amigo adicionado.' }[result]);
  if (result === 'added' || result === 'exists') $('now-code').value = '';
};
(async () => {
  if (friendsSupported) $('panel-code').textContent = formatFriendCode(await myFriendCode());
})();
queuePanel();
