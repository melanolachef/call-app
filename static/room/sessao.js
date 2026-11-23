// ---------- perfil ----------

function profileMsg() {
  return { nick: myNick, photo: myPhoto, hwH264, banner: validBannerColor(load('bannerColor')) };
}

// The banner image goes in a message of its own (photo + banner together
// could pass the server's 64 KB limit). `always` also sends an empty one, to
// clear a banner that was removed.
function sendBannerImage(id, always = false) {
  const image = validBannerImage(load('bannerImage'));
  if (image || always) send(id, { bannerImage: image });
}

function broadcastProfile() {
  peers.forEach((peer) => {
    send(peer.id, profileMsg());
    sendBannerImage(peer.id, true);
  });
  announcePresence(); // friends see the new nick
  refresh();
}

// Friends (amigos.js): tell the server "the owner of my friend code is in
// this room", or that I'm invisible. Not relayed to anyone; the server keeps
// it in memory while this connection is open.
function announcePresence() {
  if (ws?.readyState !== WebSocket.OPEN || !friendsSupported) return;
  const presence = isInvisible() || !myNick ? null : { secret: friendSecret(), nick: myNick };
  ws.send(JSON.stringify({ presence }));
}
window.addEventListener('friends-changed', announcePresence);

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
        broadcastProfile();
      } else {
        enterRoom();
      }
    },
  });
}
$('edit').onclick = openProfile;

// Edited in another tab (the lobby, say): this room follows, and tells the others.
onProfileChangedElsewhere(() => {
  myNick = cleanNick(load('nick')) || myNick;
  myPhoto = validPhoto(load('photo'));
  if (ws) broadcastProfile();
  else refresh();
});

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
let reconnectAttempt = 0;
let reconnectAt = 0; // when the next attempt starts (for the countdown)

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
    reconnectAttempt += 1;
    reconnectAt = Date.now() + retryDelay;
    reconnectTimer = setTimeout(join, retryDelay);
    startReconnectCountdown(retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };
}

// The banner on the stage: "Sem conexão com o servidor · Tentando de novo
// em 4 s · tentativa 3", a bar filling up to the next attempt, and
// "Tentar agora". Ticks once a second, only while reconnecting.
let countdownTimer = null;
function startReconnectCountdown(delay) {
  const bar = $('rc-bar');
  bar.style.transition = 'none';
  bar.style.width = '0%';
  bar.getBoundingClientRect(); // restart the transition
  bar.style.transition = `width ${delay}ms linear`;
  bar.style.width = '100%';
  clearInterval(countdownTimer);
  countdownTimer = setInterval(renderReconnect, 1000);
  renderReconnect();
}

function renderReconnect() {
  const banner = $('reconnect');
  banner.hidden = !reconnecting;
  if (!reconnecting) {
    clearInterval(countdownTimer);
    return;
  }
  const seconds = Math.ceil((reconnectAt - Date.now()) / 1000);
  $('rc-when').textContent = seconds > 0 ? `${seconds} s` : 'agora';
  $('rc-attempt').textContent = String(reconnectAttempt);
}

$('rc-now').onclick = () => {
  if (!reconnecting || left) return;
  clearTimeout(reconnectTimer);
  retryDelay = 1000;
  reconnectAt = Date.now();
  renderReconnect();
  join();
};

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
      reconnectAttempt = 0;
      announcePresence();
      if (!timer) { // keeps counting across reconnections
        const joinedAt = Date.now();
        const tick = () => ($('timer').textContent = clock(joinedAt));
        tick();
        timer = setInterval(tick, 1000); // one text node a second: no layout work
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

