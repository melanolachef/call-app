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
let panelView = 'amigos'; // or 'salas' (your groups)
let panelGroup = null; // a group picked in the column on the left
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

// One button per group (#189), like Discord's servers: opens it in the middle.
function groupCount(group) {
  return group.salas.reduce((sum, room) => sum + (counts[room.id] || 0), 0);
}

function renderRail() {
  $('rail-rooms').replaceChildren(...groups.map((g) => {
    const here = panelView === 'salas' && panelGroup === g.id;
    const button = el('button', `rail-room${here ? ' current' : ''}`);
    paintGroupIcon(button, g);
    button.type = 'button';
    const n = groupCount(g);
    button.title = n ? `${g.nome} · ${n} agora` : g.nome;
    button.setAttribute('aria-label', button.title);
    if (here) button.setAttribute('aria-current', 'true');
    if (n > 0) button.append(el('span', 'rail-badge', String(n)));
    button.onclick = () => {
      panelView = 'salas';
      panelGroup = g.id;
      queuePanel();
    };
    return button;
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
    const link = el(canJoinRoom(room.id) ? 'a' : 'div', 'panel-call');
    if (canJoinRoom(room.id)) link.href = `/room/${room.id}`;
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
  if (person.state === 'call' && canJoinRoom(person.room)) {
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

// ---------- grupos ----------

function roomRow(room) {
  const row = el('li', 'panel-room');
  const link = el('a', 'panel-room-link');
  link.href = `/room/${room.id}`;
  const text = el('span', 'panel-friend-text');
  text.append(el('strong', 'ellipsis', room.nome));
  const n = counts[room.id];
  link.append(el('span', 'panel-room-hash', '#'), text, el('span', `panel-room-count${n ? ' online' : ''}`, n === undefined ? '' : n ? `${n} agora` : 'vazia'));
  row.append(link);
  // Who is in it, like a voice channel in Discord (#198).
  const inside = panelNow?.salas?.[room.id] ?? [];
  if (inside.length) {
    const list = el('ul', 'panel-room-people');
    list.append(...inside.map((p) => {
      const li = el('li');
      li.append(face({ name: p.nick || 'Alguém', key: String(p.membro ?? p.nick) }, 'small'), el('span', 'ellipsis', p.nick || 'Alguém'));
      return li;
    }));
    row.append(list);
  }
  return row;
}

// ---------- um grupo aberto: quem está onde, membros online/offline (#198) ----------

let panelNow = null; // { salas: { room: [{ nick, membro }] }, online: [membro] }
let panelDetail = null; // the open group with its members
let panelDetailFor = null;

async function refreshOpenGroup() {
  const id = panelView === 'salas' ? panelGroup : null;
  if (!id || document.hidden) return;
  const [now, detail] = await Promise.all([
    fetchGroupNow(id),
    panelDetailFor === id && panelDetail ? panelDetail : groupRequest('GET', `/api/grupos/${id}`).then((r) => (r.ok ? r.data : null)),
  ]);
  if (panelGroup !== id) return; // switched meanwhile
  panelNow = now;
  panelDetail = detail;
  panelDetailFor = id;
  queuePanel();
}
setInterval(refreshOpenGroup, 8000);

function groupActions(g) {
  const bar = el('div', 'panel-group-actions');
  const invite = el('button', 'btn small primary', 'Convidar');
  invite.type = 'button';
  invite.onclick = () => inviteToGroup(g);
  const open = el('button', 'btn small ghost', g.dono ? 'Salas e pessoas' : 'Ver grupo');
  open.type = 'button';
  open.onclick = () => openGroup(g.id);
  bar.append(invite, open);
  return bar;
}

function groupForms() {
  const create = el('form', 'panel-create');
  const input = el('input', 'input');
  input.maxLength = 32;
  input.required = true;
  input.placeholder = 'Nome do grupo novo';
  input.setAttribute('aria-label', 'Nome do grupo novo');
  create.append(input, el('button', 'btn small primary', 'Criar grupo'));
  create.onsubmit = (e) => {
    e.preventDefault();
    newGroup(input.value);
  };
  const join = el('form', 'panel-create');
  const link = el('input', 'input');
  link.placeholder = 'Cole o link de um convite';
  link.setAttribute('aria-label', 'Link do convite');
  join.append(link, el('button', 'btn small', 'Entrar'));
  join.onsubmit = (e) => {
    e.preventDefault();
    joinInvite(link.value);
  };
  return [create, join];
}

function renderGroupsView() {
  const one = groups.find((g) => g.id === panelGroup);
  if (one) {
    if (panelDetailFor !== one.id) {
      panelNow = null;
      panelDetail = null;
      panelDetailFor = one.id;
      refreshOpenGroup();
    }
    // Like a Discord server: its #geral in the middle (#223), the rooms
    // with who is in them and the members beside it.
    const rooms = one.salas.filter((r) => matches(r.nome));
    const columns = el('div', 'panel-group-cols');
    const chat = el('div', 'panel-group-chat card');
    const side = el('div', 'panel-group-members');
    side.append(...group('Salas', rooms.map(roomRow)), ...groupMemberNodes(panelDetail, panelNow));
    columns.append(chat, side);
    $('panel-body').replaceChildren(groupActions(one), columns);
    groupChat.mount(chat);
    groupChat.open(one);
    return;
  }
  const body = [];
  for (const g of groups.filter((x) => matches(x.nome) || x.salas.some((r) => matches(r.nome)))) {
    const head = el('button', 'panel-group-title');
    head.type = 'button';
    head.append(el('strong', 'ellipsis', g.nome), el('span', 'muted', `${g.membros} ${g.membros === 1 ? 'pessoa' : 'pessoas'}`));
    head.onclick = () => {
      panelGroup = g.id;
      queuePanel();
    };
    const list = el('ul', 'panel-list');
    list.append(...g.salas.map(roomRow));
    body.push(head, list);
  }
  if (!groups.length) {
    body.push(el('p', 'panel-empty', groupsOn
      ? 'Você ainda não está em nenhum grupo. Crie um e mande o convite para a galera, ou cole um convite que te mandaram.'
      : 'Grupos estão desligados neste servidor.'));
  }
  $('panel-body').replaceChildren(...(groupsOn ? groupForms() : []), ...body);
}

// ---------- coluna "Agora" ----------

function renderNow(calls) {
  const cards = calls.slice(0, 6).map((room, i) => {
    const card = el('div', 'now-card');
    const text = el('span', 'panel-friend-text');
    const minutes = Math.round((room.secs || 0) / 60);
    text.append(el('strong', 'ellipsis', displayRoomName(room.id)),
      el('span', 'panel-friend-status ellipsis', `${whoIsThere(room)}${minutes ? ` · ${minutes} min` : ''}`));
    card.append(text);
    if (canJoinRoom(room.id)) {
      const join = el('a', `btn small ${i === 0 ? 'primary' : 'ghost'}`, 'Entrar');
      join.href = `/room/${room.id}`;
      card.append(join);
    }
    return card;
  });
  if (!cards.length) {
    const empty = el('div', 'now-empty');
    empty.append(el('p', null, groups.length ? 'Ninguém em call agora. Entre numa sala do seu grupo e chame a galera.' : 'Ninguém em call agora. Crie um grupo e chame a galera.'));
    const create = el('button', 'btn small', groups.length ? 'Ver grupos' : 'Novo grupo');
    create.onclick = () => {
      if (!groups.length) return $('rail-new').click();
      panelView = 'salas';
      panelGroup = null;
      queuePanel();
    };
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
  const picked = panelView === 'salas' && groups.find((g) => g.id === panelGroup);
  if (panelView === 'salas' && !picked) panelGroup = null; // left or deleted
  if (!picked) groupChat.close();
  $('panel-title').textContent = panelView === 'amigos' ? 'Amigos' : picked ? picked.nome : 'Grupos';
  $('panel-title-icon').innerHTML = panelView === 'amigos' ? PANEL_ICONS.friends : PANEL_ICONS.rooms; // fixed markup
  $('panel-tabs').hidden = panelView !== 'amigos';
  document.querySelectorAll('.panel-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === panelTab)));
  if (panelView === 'amigos') renderFriendsView(people);
  else renderGroupsView();
  renderNow(calls);
}

function queuePanel() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(renderPanel);
}

window.addEventListener('lobby-changed', queuePanel);
window.addEventListener('groups-changed', queuePanel);
window.addEventListener('group-created', (e) => {
  panelView = 'salas';
  panelGroup = e.detail;
  queuePanel();
});
window.addEventListener('account-friends-changed', queuePanel);
window.addEventListener('friends-changed', queuePanel);
onAccountChange(queuePanel);
matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)').addEventListener('change', queuePanel);

document.querySelectorAll('.panel-nav').forEach((b) => (b.onclick = () => {
  panelView = b.dataset.view;
  panelGroup = null;
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
