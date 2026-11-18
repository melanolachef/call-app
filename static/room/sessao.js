// ---------- perfil ----------

function profileMsg() {
  return { nick: myNick, photo: myPhoto, hwH264 };
}

function displayName(peer) {
  return peer.nick || `Participante ${peer.id}`;
}

// Joining asks for a nick first; afterwards the same dialog edits the profile.
function openProfile() {
  openProfileDialog({
    title: ws ? 'Editar perfil' : 'Como seus amigos vão te ver?',
    submitLabel: ws ? 'Salvar' : 'Entrar na sala',
    required: !ws,
    nick: myNick,
    photo: myPhoto,
    colorId: myId,
    onSave(nick, photo) {
      myNick = nick;
      myPhoto = photo;
      if (ws) {
        peers.forEach((peer) => send(peer.id, profileMsg()));
        refresh();
      } else {
        enterRoom();
      }
    },
  });
}
$('edit').onclick = openProfile;

// ---------- uma aba por sala ----------

// Opening the same room in a second tab would make you appear twice. One Web
// Lock per room (shared by all tabs of this browser) detects that: the new tab
// can "steal" it, which makes the old tab's request reject so it leaves.
const ROOM_LOCK = `friends-call-room:${roomId}`;
let releaseLock = null;

function enterRoom(takeover = false) {
  if (!navigator.locks) { // no Web Locks outside HTTPS/localhost: just join
    join();
    return;
  }
  navigator.locks.request(ROOM_LOCK, takeover ? { steal: true } : { ifAvailable: true }, (lock) => {
    if (!lock) {
      showNotice('Você já está nesta sala', 'Ela está aberta em outra aba deste navegador.', {
        label: 'Usar esta aba',
        run: () => {
          notice.close();
          enterRoom(true);
        },
      });
      return undefined;
    }
    join();
    return new Promise((resolve) => (releaseLock = resolve)); // held until we leave
  }).catch((err) => {
    if (err.name !== 'AbortError') return;
    leaveRoom('Sala aberta em outra aba', 'Você continuou nesta sala em outra aba deste navegador.', {
      label: 'Usar esta aba',
      run: () => {
        // This page's state is torn down: reload and steal the room back.
        try { sessionStorage.setItem('takeover', '1'); } catch { /* falls back to the "Usar esta aba" prompt */ }
        location.reload();
      },
    });
  });
}

// ---------- sinalização (WebSocket) ----------

// Reconnection: when the WebSocket drops, the server has already removed us
// and the others closed their connections to us, so we drop ours too and come
// back as a new participant, retrying with a growing delay.
const RETRY_MAX_MS = 30_000;
let retryDelay = 1000;
let reconnecting = false;
let reconnectTimer = null;

async function join() {
  [hwH264] = await Promise.all([hwH264Ready, loadIceServers()]); // both needed before any peer
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`);
  ws = socket;
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (left || socket !== ws) return;
    setChatEnabled(false);
    if (roomFull) {
      shareBtn.disabled = true;
      clearInterval(timer);
      showNotice('Sala cheia', `Esta sala já tem ${maxPeers} pessoas. Tente de novo mais tarde ou crie outra.`);
      return;
    }
    if (!reconnecting) addSystem('Conexão perdida. Reconectando…');
    reconnecting = true;
    [...peers.keys()].forEach(removePeer);
    myId = null;
    refresh();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(join, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };
}

// Back online: don't wait for the current back-off delay.
window.addEventListener('online', () => {
  if (!reconnecting || left) return;
  clearTimeout(reconnectTimer);
  retryDelay = 1000;
  join();
});

function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome': {
      myId = msg.id;
      maxPeers = msg.max ?? maxPeers;
      shareBtn.disabled = !canShare;
      retryDelay = 1000;
      if (!timer) { // keeps counting across reconnections
        const joinedAt = Date.now();
        const tick = () => ($('timer').textContent = elapsed(joinedAt));
        tick();
        timer = setInterval(tick, 15_000); // minutes only: no need to tick every second
      }
      for (const id of msg.peers) createPeer(id, true);
      rememberRoom(roomId); // shows up in the lobby's "Suas salas"
      renderHud();
      setChatEnabled(true);
      addSystem(reconnecting ? 'Reconectado.' : 'Você entrou na sala. As mensagens do chat não ficam salvas.');
      reconnecting = false;
      refresh();
      break;
    }
    case 'peer-joined':
      createPeer(msg.id, false); // the newcomer will send us the offer
      break;
    case 'peer-left': {
      const peer = peers.get(msg.id);
      if (peer?.announced) addSystem(`${displayName(peer)} saiu`);
      removePeer(msg.id);
      break;
    }
    case 'signal': {
      const peer = peers.get(msg.from) ?? createPeer(msg.from, false);
      // Profiles don't depend on negotiation order, and our offer waits for
      // theirs (codec choice), so they skip the queue.
      if (msg.data && typeof msg.data === 'object' && 'nick' in msg.data) handleProfile(peer, msg.data);
      else enqueue(peer, () => handleSignal(peer, msg.data));
      break;
    }
    case 'full':
      roomFull = true;
      maxPeers = msg.max ?? maxPeers;
      break;
  }
}

function send(to, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to, data }));
}

// Each negotiation step is async but they must run strictly in arrival order
// (e.g. ICE candidates can only be added after the remote description is set),
// so every peer gets its own promise chain.
function enqueue(peer, step) {
  peer.queue = peer.queue.then(step).catch((err) => console.warn(`Participante ${peer.id}:`, err));
}

