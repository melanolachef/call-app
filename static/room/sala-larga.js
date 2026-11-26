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
  $('heading-name').textContent = displayRoomName(roomId);
  $('heading-meta').textContent = myId === null ? '' : `${people.length}/${maxPeers}`;
  const inVoice = people.filter((p) => p.voiceIn).length;
  $('vp-title').textContent = voice.joined ? 'Voz conectada' : 'Voz';
  $('vp-title').classList.toggle('online', voice.joined);
  $('vp-sub').textContent = inVoice ? `${inVoice} na voz` : 'ninguém na voz';
  $('vp-join').hidden = voice.joined || myId === null;
  $('vp-leave').hidden = !voice.joined;
  if (!$('vp-leave').innerHTML) $('vp-leave').innerHTML = ICONS.hangup; // fixed markup
  $('more-chat').textContent = chatVisible() ? 'Esconder chat' : 'Mostrar chat';
}

// ---------- coluna de salas ----------

function renderRoomRail() {
  $('rail-rooms').replaceChildren(...orderedRooms().map((r) => {
    const name = displayRoomName(r.id);
    const here = r.id === roomId;
    const link = el(here ? 'span' : 'a', `rail-room${here ? ' current' : ''}`, Array.from(name.replace(/[^\p{L}\p{N}]/gu, '')).slice(0, 2).join('').toLowerCase() || '#');
    const count = hudCounts[r.id];
    link.title = count ? `${name} · ${count} agora` : name;
    link.setAttribute('aria-label', link.title);
    if (here) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.href = `/room/${r.id}`;
      link.onclick = (e) => {
        if (!okToLeave()) e.preventDefault();
      };
    }
    if (count > 0) link.append(el('span', 'rail-badge', String(count)));
    return link;
  }));
}

$('rail-home').onclick = (e) => {
  e.preventDefault();
  if (okToLeave()) goToLobby();
};
$('rail-new').onclick = () => {
  const name = window.prompt('Nome da sala nova (opcional):', '');
  if (name === null || !okToLeave()) return;
  location.assign(`/room/${newRoomId(name)}`);
};
$('rail-paste').onclick = () => {
  const text = window.prompt('Cole o link ou o código da sala:', '');
  if (!text) return;
  const id = text.trim().match(/\/room\/([A-Za-z0-9_-]{1,64})/)?.[1] ?? text.trim();
  if (!validRoomId(id)) return toast('Esse link não parece um convite do CPX Call.');
  if (okToLeave()) location.assign(`/room/${id}`);
};
$('rail-settings').onclick = () => openSettings('voz');
$('vp-join').onclick = joinVoice;
$('vp-leave').onclick = leaveVoice;
$('me-avatar').onclick = openProfile; // the "Editar perfil" button hides here
// The button beside your name opens the settings page: a gear.
$('voice-settings-btn').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'; // fixed markup
chatInput.placeholder = `Mensagem para ${displayRoomName(roomId)}`;

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
