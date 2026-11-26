// ---------- salas do grupo (barra lateral) ----------

// The rooms of this room's group (#189), so you can hop between them without
// going back; in an old link room, all your groups' rooms. The counts come
// from the server's /api/rooms (for every group: the rail shows them too).
let hudCounts = {};

function hudRooms() {
  const here = groupOfRoom(roomId);
  return here ? here.group.salas.map((s) => ({ id: s.id, name: s.nome })) : orderedRooms();
}

// Leaving while sharing cuts everyone watching: ask first.
// Anything that leaves this page ends the call, so while you are in it
// (voice, screen or camera) every way out asks first — the logo, the group
// rail, another room. Only "Sair" itself leaves at once.
let leavingOnPurpose = false;

function inCall() {
  return voice.joined || !!localTrack || !!cam.track;
}

function okToLeave() {
  if (inCall()) {
    const why = localTrack ? 'Você está compartilhando a tela.' : 'Você está na call.';
    if (!window.confirm(`${why} Sair desta sala mesmo assim?`)) return false;
  }
  leavingOnPurpose = true;
  return true;
}

// Safety net for any other way out (a link, a mail app taking over the tab,
// F5): the browser asks before ending the call.
window.addEventListener('beforeunload', (e) => {
  if (left || leavingOnPurpose || !inCall()) return;
  e.preventDefault();
  e.returnValue = ''; // older browsers need it to show the prompt
});

function hudItem(room) {
  const current = room.id === roomId;
  // The current room is not a link: clicking it would reload and reconnect.
  const link = el(current ? 'div' : 'a', 'hud-room');
  if (current) {
    link.setAttribute('aria-current', 'page');
  } else {
    link.href = `/room/${room.id}`;
    link.onclick = (e) => {
      if (!okToLeave()) e.preventDefault();
    };
  }
  const count = hudCounts[room.id];
  const text = el('span', 'hud-count', count === undefined ? '' : count === 0 ? 'vazia' : `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`);
  if (count > 0 && !current) text.classList.add('online');
  link.append(el('span', 'hud-name ellipsis', groupOfRoom(roomId) ? room.name : displayRoomName(room.id)), text);
  const li = el('li');
  li.append(link);
  return li;
}

function renderHud() {
  const here = groupOfRoom(roomId);
  $('hud-title').textContent = here ? here.group.nome : 'Seus grupos';
  $('hud-group').hidden = !here;
  $('hud-new').hidden = !here?.group.dono; // only the owner makes rooms
  $('hud').hidden = !hudRooms().length;
  $('hud-rooms').replaceChildren(...hudRooms().map(hudItem));
  renderRoomRail(); // sala-larga.js
  renderSideRooms();
}

async function updateHudCounts() {
  if (document.hidden) return;
  const fresh = await fetchRoomCounts(orderedRooms().map((r) => r.id));
  if (!fresh) return; // offline: keep the last numbers
  hudCounts = fresh;
  renderHud();
}


$('hud-new').onsubmit = async (e) => {
  e.preventDefault();
  const here = groupOfRoom(roomId);
  if (!here) return;
  const res = await groupRequest('POST', `/api/grupos/${here.group.id}/salas`, { nome: $('hud-new-name').value });
  if (!res.ok) return toast(res.data.error || 'Não deu para criar a sala.', 4000);
  $('hud-new-name').value = '';
  putGroup(res.data);
  toast('Sala criada.');
};
$('hud-group').onclick = () => {
  const here = groupOfRoom(roomId);
  if (here) openGroup(here.group.id);
};

renderHud();
updateHudCounts();
loadGroups(); // the cached list may be old (or empty on a new device)
window.addEventListener('groups-changed', () => {
  renderHud();
  updateHudCounts();
});
setInterval(updateHudCounts, 15_000);

// ---------- amigos em call (barra lateral) ----------

// Only the friends who are in a call right now, with a link to join. The
// full list, your code and "adicionar" are in the Amigos box (amigos.js).
async function updateFriendsHud() {
  if (document.hidden) return;
  const withAccount = !!account?.signedIn;
  if (!friendsSupported && !withAccount) return;
  const list = friendsSupported ? loadFriends() : [];
  const [presence, fromAccount] = await Promise.all([
    list.length ? fetchFriendPresence(list.map((f) => f.code)) : {},
    withAccount ? loadAccountFriends() : null,
  ]);
  if (!presence) return; // offline
  // Code friends and account friends in a call, as one list.
  const online = [
    ...(fromAccount?.amigos ?? []).filter((f) => f.sala).map((f) => ({
      key: `u${f.id}`, name: accountFriendName(f), room: f.sala, count: f.pessoas,
    })),
    ...list.filter((f) => presence[f.code]).map((f) => ({
      key: f.code,
      name: f.name || cleanFriendName(presence[f.code].nick) || formatFriendCode(f.code),
      room: presence[f.code].room,
      count: presence[f.code].count,
    })),
  ];
  $('friends-hud').hidden = false;
  if (!online.length) {
    const any = list.length || fromAccount?.amigos?.length;
    $('friends-hud-list').replaceChildren(el('li', 'friends-hud-empty', any ? 'Nenhum amigo em call agora.' : 'Adicione amigos para ver em que call estão.'));
    return;
  }
  $('friends-hud-list').replaceChildren(...online.map((friend) => {
    const here = friend.room === roomId;
    const item = el(here ? 'div' : 'a', 'hud-room friend-hud');
    if (!here) {
      item.href = `/room/${friend.room}`;
      item.onclick = (e) => {
        if (!okToLeave()) e.preventDefault();
      };
    }
    const face = el('span', 'avatar');
    face.textContent = initials(friend.name);
    face.style.background = colorFor(friend.key);
    const text = el('span', 'friend-hud-text');
    text.append(el('span', 'ellipsis', friend.name), el('span', 'friend-hud-room ellipsis', here ? 'nesta sala' : `${displayRoomName(friend.room)} · ${friend.count}`));
    item.append(face, text);
    const li = el('li');
    li.append(item);
    return li;
  }));
}
$('friends-hud-btn').onclick = () => openFriendsDialog();
updateFriendsHud();
setInterval(updateFriendsHud, 15_000);
window.addEventListener('friends-changed', updateFriendsHud);
onAccountChange(() => updateFriendsHud()); // signed in: account friends join the list
window.addEventListener('storage', renderHud); // changed from another tab

// ---------- convidar ----------

// Phones open the system share sheet (WhatsApp etc.); elsewhere a ready-made
// message goes to the clipboard.
async function invite() {
  const here = groupOfRoom(roomId);
  // A group room only lets members in: send the group's invite (#189).
  const url = here ? inviteUrl(here.group.convite) : location.href;
  const text = here
    ? `Bora? Entra no grupo ${here.group.nome} do CPX Call:`
    : `Bora? Entra na sala ${roomName(roomId)} do CPX Call:`;
  if (navigator.share && mobile.matches) {
    try {
      await navigator.share({ title: 'CPX Call', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Convite copiado. É só colar na conversa.');
    // The button itself confirms, as in the design ("✓ Copiado").
    const button = $('invite');
    $('invite-desk').textContent = '✓ Copiado';
    $('invite-mob').textContent = '✓ Copiado';
    button.classList.add('copied');
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => {
      $('invite-desk').textContent = 'Copiar';
      $('invite-mob').textContent = 'Convidar';
      button.classList.remove('copied');
    }, 2000);
  } catch {
    window.prompt('Copie o convite:', `${text} ${url}`); // clipboard needs HTTPS
  }
}
$('invite').onclick = invite;
$('invite-bar').onclick = invite;

const notice = $('notice');
const RELOAD = { label: 'Entrar de novo', run: () => location.reload() };
let noticeAction = RELOAD.run;

function showNotice(title, text, action = RELOAD) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice-retry').textContent = action.label;
  noticeAction = action.run;
  if (!notice.open) notice.showModal();
}
notice.oncancel = (e) => e.preventDefault(); // nothing usable behind it
$('notice-retry').onclick = () => noticeAction();

