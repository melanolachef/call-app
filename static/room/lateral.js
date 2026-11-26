// ---------- suas salas (barra lateral) ----------

// Same list as the lobby (fixed room first), so you can hop between rooms
// without going back. The counts come from the server's /api/rooms.
let hudCounts = {};

// Leaving while sharing cuts everyone watching: ask first.
function okToLeave() {
  return !localTrack || window.confirm('Você está compartilhando a tela. Sair desta sala mesmo assim?');
}

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
  link.append(el('span', 'hud-name ellipsis', displayRoomName(room.id)));
  if (room.home) link.append(el('span', 'tag', 'fixa'));
  link.append(text);
  const li = el('li');
  li.append(link);
  return li;
}

function renderHud() {
  $('hud-rooms').replaceChildren(...orderedRooms().map(hudItem));
  renderRoomRail(); // sala-larga.js
}

async function updateHudCounts() {
  if (document.hidden) return;
  const fresh = await fetchRoomCounts(orderedRooms().map((r) => r.id));
  if (!fresh) return; // offline: keep the last numbers
  hudCounts = fresh;
  renderHud();
}


$('hud-new').onsubmit = (e) => {
  e.preventDefault();
  if (!okToLeave()) return;
  const id = newRoomId($('hud-new-name').value);
  location.assign(`/room/${id}`);
};

renderHud();
updateHudCounts();
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
  const url = location.href;
  const text = isHomeRoom(roomId)
    ? 'Bora? Entra no meu Block do CPX Call:'
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

