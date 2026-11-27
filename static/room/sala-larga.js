// ---------- sala em telas largas (docs/design/cpx-call-novas-telas.html, "Sala") ----------

// From 1200 px wide: the rooms in a thin column (like the lobby), the room's
// name, link and time at the top of the side panel, people split into "Ao
// vivo", "Na voz" and "Na sala", a "Voz conectada" box above you, and a
// compact bar with a "…" menu. The pieces are hidden on narrower layouts.

// People list in groups (every layout with the side panel).
function renderPeopleGroups(people) {
  const items = [];
  const groupHead = (text) => el('li', 'people-group', text);
  const live = [];
  if (localTrack) live.push({ label: 'Sua tela', state: viewersOfMine(), peer: null });
  for (const peer of [...peers.values()].sort((a, b) => a.id - b.id)) {
    if (peer.sharing) live.push({ label: `Tela de ${displayName(peer)}`, state: peer.iWatch ? 'assistindo' : 'assistir', peer });
  }
  if (live.length) {
    items.push(groupHead(`Ao vivo — ${live.length}`));
    for (const item of live) {
      const li = el('li');
      const row = el('button', `live-row${item.peer?.iWatch ? ' watching' : ''}`);
      row.type = 'button';
      row.append(el('span', 'live-dot'), el('span', 'ellipsis', item.label), el('span', 'live-state', item.state));
      if (item.peer) {
        row.title = item.peer.iWatch ? 'Parar de assistir' : 'Assistir';
        row.onclick = () => setWatch(item.peer, !item.peer.iWatch);
      } else {
        row.disabled = true;
      }
      li.append(row);
      items.push(li);
    }
  }
  const inVoice = people.filter((p) => p.voiceIn);
  const elsewhere = people.filter((p) => !p.voiceIn);
  if (inVoice.length) items.push(groupHead(`Na voz — ${inVoice.length}`), ...inVoice.map(personRow));
  if (elsewhere.length) items.push(groupHead(`Na sala — ${elsewhere.length}`), ...elsewhere.map(personRow));
  $('people').replaceChildren(...items);
}

function viewersOfMine() {
  const n = [...peers.values()].filter((p) => p.watchesMe).length;
  return n ? `${n} assistindo` : 'ao vivo';
}

// Top of the side panel, the voice box and you.
function renderWideSide(people) {
  renderSideRooms();
  const here = groupOfRoom(roomId);
  const shown = shownGroup();
  $('heading-name').textContent = shown ? shown.nome : displayRoomName(roomId);
  $('heading-group').hidden = !shown;
  $('heading-meta').textContent = myId === null ? '' : `${people.length}/${maxPeers}`;
  const inVoice = people.filter((p) => p.voiceIn).length;
  $('vp-title').textContent = voice.joined ? 'Voz conectada' : 'Voz';
  $('vp-title').classList.toggle('online', voice.joined);
  // Looking at another group: where the call is, and a way back to it.
  $('vp-sub').textContent = browsing && here ? `${here.room.nome} / ${here.group.nome}` : inVoice ? `${inVoice} na voz` : 'ninguém na voz';
  $('vp-back').hidden = !browsing;
  $('vp-join').hidden = voice.joined || myId === null;
  $('vp-leave').hidden = !voice.joined;
  if (!$('vp-leave').innerHTML) $('vp-leave').innerHTML = ICONS.hangup; // fixed markup
  $('more-chat').textContent = chatVisible() ? 'Esconder chat' : 'Mostrar chat';
}

// ---------- ver um grupo sem sair da call (#223) ----------

// Like switching servers in Discord: the middle shows the group's text
// channel, its members on the right, and the call goes on (the voice box
// takes you back to it). Only on wide screens, where the group rail is.
// (browsing, browseNow, browseDetail: estado.js, since lateral.js draws first)

function shownGroup() {
  if (browsing) return groups.find((g) => g.id === browsing) ?? null;
  return groupOfRoom(roomId)?.group ?? null;
}

function browse(id) {
  const g = groups.find((x) => x.id === id);
  if (!g) return;
  if (browsing !== id) {
    browseNow = null;
    browseDetail = null;
    $('group-members').replaceChildren();
  }
  browsing = id;
  document.body.classList.add('browsing');
  document.body.classList.toggle('browsing-other', groupOfRoom(roomId)?.group.id !== id);
  groupChat.mount($('group-view'));
  groupChat.open(g);
  refreshBrowse();
  renderHud();
  refresh();
}

function backToCall() {
  if (!browsing) return;
  browsing = null;
  browseNow = null;
  browseDetail = null;
  document.body.classList.remove('browsing', 'browsing-other');
  groupChat.close();
  renderHud();
  refresh();
}

async function refreshBrowse() {
  const id = browsing;
  if (!id || document.hidden) return;
  const [now, detail] = await Promise.all([
    fetchGroupNow(id),
    browseDetail?.id === id ? browseDetail : groupRequest('GET', `/api/grupos/${id}`).then((r) => (r.ok ? r.data : null)),
  ]);
  if (browsing !== id) return; // switched meanwhile
  browseNow = now;
  browseDetail = detail;
  $('group-members').replaceChildren(...groupMemberNodes(detail, now));
  renderSideRooms();
}
setInterval(refreshBrowse, 8_000);
window.addEventListener('groups-changed', () => {
  if (browsing && !groups.some((g) => g.id === browsing)) backToCall(); // left or deleted
  else if (browsing) groupChat.open(groups.find((g) => g.id === browsing)); // renamed
});

// ---------- canais do grupo (#189, #223) ----------

// Under the group's name, like Discord: its text channel, then its rooms as
// voice channels with who is in each (from the server every few seconds).
// This room's people are the detailed list right below.
function roomPeople(id) {
  const now = browsing ? browseNow : groupNow;
  return (now?.salas?.[id] ?? []).map((p) => p.nick || 'Alguém');
}

function sideRoomPerson(nick) {
  const li = el('li', 'side-person');
  const face = el('span', 'avatar');
  face.setAttribute('aria-hidden', 'true');
  paintAvatar(face, nick, 1, '');
  li.append(face, el('span', 'ellipsis', nick));
  return li;
}

function sideTextChannel(group) {
  const on = browsing === group.id;
  const row = el('button', `side-room${on ? ' current' : ''}`);
  row.type = 'button';
  row.title = 'Chat do grupo';
  if (on) row.setAttribute('aria-current', 'page');
  row.append(el('span', 'side-room-hash', '#'), el('span', 'ellipsis', 'geral'));
  row.onclick = () => browse(group.id);
  const li = el('li');
  li.append(row);
  return li;
}

function sideVoiceRoom(room) {
  const here = room.id === roomId;
  const onStage = here && !browsing;
  // The room you are in goes back to the call; another one moves you there.
  const link = el(onStage ? 'span' : here ? 'button' : 'a', `side-room${onStage ? ' current' : ''}${here ? ' here' : ''}`);
  if (onStage) {
    link.setAttribute('aria-current', 'page');
  } else if (here) {
    link.type = 'button';
    link.title = 'Voltar para a call';
    link.onclick = backToCall;
  } else {
    link.href = `/room/${room.id}`;
    link.title = 'Entrar nesta sala';
    link.onclick = (e) => {
      if (!okToSwitchRoom()) e.preventDefault();
    };
  }
  const icon = el('span', 'side-room-hash side-room-voice');
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>'; // fixed markup
  const people = here ? [] : roomPeople(room.id);
  const n = here ? peers.size + (myId === null ? 0 : 1) : hudCounts[room.id];
  link.append(icon, el('span', 'ellipsis', room.nome));
  if (n > 0) link.append(el('span', 'side-room-count', String(n)));
  const li = el('li');
  li.append(link);
  if (people.length) {
    const list = el('ul', 'side-room-people');
    list.append(...people.map(sideRoomPerson));
    li.append(list);
  }
  return li;
}

function renderSideRooms() {
  const shown = shownGroup();
  if (!shown) return $('side-rooms').replaceChildren();
  $('side-rooms').replaceChildren(
    el('li', 'side-cat', 'Texto'),
    sideTextChannel(shown),
    el('li', 'side-cat', 'Salas de voz'),
    ...shown.salas.map(sideVoiceRoom),
  );
}
$('heading-group').onclick = () => {
  const shown = shownGroup();
  if (shown) openGroup(shown.id);
};
$('vp-back').onclick = backToCall;

// ---------- coluna de grupos ----------

// One button per group (#189). Another group opens on screen without
// leaving the call (#223); the call's group gets a green dot meanwhile.
function renderRoomRail() {
  const callGroup = groupOfRoom(roomId)?.group.id;
  const shown = shownGroup()?.id;
  $('rail-rooms').replaceChildren(...groups.map((g) => {
    const here = g.id === shown;
    const button = el('button', `rail-room${here ? ' current' : ''}${g.id === callGroup && browsing ? ' voice-here' : ''}`);
    button.type = 'button';
    paintGroupIcon(button, g);
    const count = g.salas.reduce((n, s) => n + (hudCounts[s.id] || 0), 0);
    button.title = count ? `${g.nome} · ${count} agora` : g.nome;
    button.setAttribute('aria-label', button.title);
    if (here) button.setAttribute('aria-current', 'page');
    button.onclick = () => {
      if (g.id === callGroup) backToCall();
      else browse(g.id);
    };
    if (count > 0) button.append(el('span', 'rail-badge', String(count)));
    return button;
  }));
}

$('rail-home').onclick = (e) => {
  e.preventDefault();
  if (okToLeave()) goToLobby();
};
$('rail-new').onclick = async () => {
  const name = window.prompt('Nome do grupo novo:', '');
  if (!name?.trim()) return;
  const group = await createGroup(name);
  if (group) {
    browse(group.id);
    openGroup(group.id); // the invite is there, ready to send
  }
};
$('rail-paste').onclick = async () => {
  const code = parseInvite(window.prompt('Cole o link do convite do grupo:', '') || '');
  if (!code) return;
  const group = await acceptInvite(code);
  if (group) browse(group.id);
};
$('rail-settings').onclick = () => openSettings('voz');
$('vp-join').onclick = joinVoice;
$('vp-leave').onclick = leaveVoice;
$('me-avatar').onclick = openProfile; // the "Editar perfil" button hides here
// The button beside your name opens the settings page: a gear.
$('voice-settings-btn').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'; // fixed markup

// ---------- menu "…" da barra ----------

const morePop = $('more-pop');
function setMoreMenu(open) {
  morePop.hidden = !open;
  $('more-btn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const rect = $('more-btn').getBoundingClientRect();
  morePop.style.left = `${Math.min(rect.left, innerWidth - morePop.offsetWidth - 8)}px`;
  morePop.style.bottom = `${innerHeight - rect.top + 10}px`;
}
$('more-btn').onclick = () => setMoreMenu(morePop.hidden);
document.addEventListener('pointerdown', (e) => {
  if (!morePop.hidden && !morePop.contains(e.target) && !$('more-btn').contains(e.target)) setMoreMenu(false);
});
const fromMenu = (run) => () => {
  setMoreMenu(false);
  run();
};
$('more-quality').onclick = fromMenu(() => openSettings('transmissao'));
$('more-invite').onclick = fromMenu(invite);
$('more-chat').onclick = fromMenu(() => $('chat-toggle').click());
$('more-leave').onclick = fromMenu(() => okToLeave() && goToLobby());
