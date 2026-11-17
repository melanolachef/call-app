'use strict';

// STUN until /api/ice answers; with a TURN key the server adds Cloudflare TURN,
// which relays the video when a network blocks direct connections.
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceLoadedAt = 0;
const ICE_REFRESH_MS = 6 * 60 * 60_000; // credentials last a day; refresh well before

async function loadIceServers() {
  if (Date.now() - iceLoadedAt < ICE_REFRESH_MS) return;
  try {
    const res = await fetch('/api/ice', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (Array.isArray(data?.iceServers) && data.iceServers.length) {
      iceServers = data.iceServers;
      iceLoadedAt = Date.now();
    }
  } catch {
    // Keep STUN: direct connections still work for most networks.
  }
}
const roomId = location.pathname.split('/').pop();
const canShare = !!navigator.mediaDevices?.getDisplayMedia;

const shareBtn = $('share');

let ws = null; // set once we join; null means "not in the room yet"
let myId = null;
let myNick = load('nick');
let myPhoto = validPhoto(load('photo'));
let localTrack = null; // our screen's video track while sharing
let localAudio = null; // its sound (tab or system audio), when the browser gave one
let roomFull = false;
let maxPeers = 12; // the server sends the real limit in welcome/full
let left = false;
let timer = null;
// id -> { id, nick, pc, transceiver, queue, screen,
//         sharing (they share), iWatch (I watch them), watchesMe (they watch me) }
const peers = new Map();
const localScreen = buildScreen();

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
        timer = setInterval(() => ($('timer').textContent = elapsed(joinedAt)), 1000);
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

// ---------- WebRTC ----------

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = {
    id, nick: '', photo: '', pc, transceiver: null, audioTransceiver: null, voiceTransceiver: null,
    voiceIn: false, voiceMuted: false, voiceAudio: null, voiceAnalyser: null, speaking: false,
    sharing: false, hasAudio: false, iWatch: false, watchesMe: false,
    announced: initiator, // people already here when we joined don't get an "entrou" line
    hwH264: false,
    queue: Promise.resolve(),
    screen: buildScreen(),
  };
  peer.profileKnown = new Promise((resolve) => (peer.resolveProfile = resolve));
  peer.screen.watchBtn.onclick = () => setWatch(peer, true);
  peer.screen.unwatchBtn.onclick = () => setWatch(peer, false);
  peer.screen.retryBtn.onclick = () => retryConnection(peer);
  peer.screen.soundBtn.onclick = () => setSoundMuted(!soundMuted);
  peer.screen.volume.oninput = () => setVolume(Number(peer.screen.volume.value));
  peer.screen.volume.setAttribute('aria-label', 'Volume');
  peers.set(id, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) send(id, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState !== 'failed') peer.retrying = false;
    if (pc.connectionState === 'connected') tuneSender(peer); // encodings exist now
    refresh();
  };

  if (initiator) {
    // Whoever joins later sends the offer, so each pair negotiates exactly once.
    // One "sendrecv" video transceiver carries a screen in each direction;
    // starting or stopping a share later is just replaceTrack(), with no
    // renegotiation (and therefore no colliding offers between two peers).
    // ...and one "sendrecv" audio transceiver for the shared sound, same idea.
    const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    // ...and a third one for the voice channel (microphone).
    const voiceTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver);
    enqueue(peer, async () => {
      // Their profile says what they encode well; give up waiting after 3s.
      await Promise.race([peer.profileKnown, new Promise((r) => setTimeout(r, 3000))]);
      preferCodecs(transceiver, peer);
      await pc.setLocalDescription(); // creates the offer implicitly
      send(id, { description: pc.localDescription });
    });
  }

  send(id, profileMsg());
  if (localTrack) send(id, { sharing: true, audio: !!localAudio });
  if (voice.joined) send(id, { voice: voiceState() });
  refresh();
  return peer;
}

// Codec choice. A sender uses the first codec of the *other* side's list, so
// each side orders its list by what the remote can encode well:
// - H.264 first only if the remote encodes it on the GPU (NVENC, AMF,
//   QuickSync: barely touches a running game) and we are not Firefox, whose
//   H.264 needs a separately downloaded plugin that may be missing.
// - Otherwise VP8 first: it works everywhere, and software H.264 is no lighter.
const isFirefox = /firefox/i.test(navigator.userAgent);
let hwH264 = false; // sent to the others with our profile
const hwH264Ready = detectHwH264();

async function detectHwH264() {
  if (isFirefox || !navigator.mediaCapabilities?.encodingInfo) return false;
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType: 'video/H264', width: 1920, height: 1080, bitrate: 2_500_000, framerate: 30 },
    });
    return info.supported && info.powerEfficient;
  } catch {
    return false;
  }
}

function preferCodecs(transceiver, peer) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  if (!transceiver.setCodecPreferences || !codecs) return;
  const mime = (c) => c.mimeType.toLowerCase();
  const wantH264 = peer.hwH264 && !isFirefox && codecs.some((c) => mime(c) === 'video/h264');
  const rank = (c) => {
    if (mime(c) === 'video/h264') return wantH264 ? 0 : 2;
    if (mime(c) === 'video/vp8') return wantH264 ? 1 : 0;
    return 1; // VP9/AV1 (CPU-heavy) after VP8; rtx/red/ulpfec ride along
  };
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (err) {
    console.warn('codec preferences', err);
  }
}

function attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver) {
  peer.transceiver = transceiver;
  peer.audioTransceiver = audioTransceiver ?? null;
  peer.voiceTransceiver = voiceTransceiver ?? null;
  if (voiceTransceiver) {
    // Voices play through one hidden <audio> per person (Chrome also needs the
    // element playing for Web Audio to see a remote stream).
    peer.voiceAudio ??= document.body.appendChild(el('audio'));
    peer.voiceAudio.autoplay = true;
    peer.voiceAudio.srcObject = new MediaStream([voiceTransceiver.receiver.track]);
    sendVoiceTo(peer);
    applyVoiceOutput();
  }
  // The receiver tracks exist from the start; they simply carry nothing until
  // the other side calls replaceTrack() with its screen (and its sound).
  const tracks = [transceiver.receiver.track];
  if (audioTransceiver) tracks.push(audioTransceiver.receiver.track);
  peer.screen.video.srcObject = new MediaStream(tracks);
  sendScreenTo(peer); // in case they asked to watch before this was set up
}

async function handleSignal(peer, data) {
  const { pc } = peer;
  if (data.description) {
    await pc.setRemoteDescription(tuneDescription(data.description));
    if (data.description.type === 'offer') {
      // Transceivers created from a remote offer default to "recvonly";
      // switch them to "sendrecv" so we can share our screen back later.
      // In m-line order: video, then the screen's sound, then voice.
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
      const [audioTransceiver, voiceTransceiver] = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'audio');
      transceiver.direction = 'sendrecv';
      if (audioTransceiver) audioTransceiver.direction = 'sendrecv';
      if (voiceTransceiver) voiceTransceiver.direction = 'sendrecv';
      preferCodecs(transceiver, peer); // their profile arrived before the offer
      await pc.setLocalDescription(); // creates the answer implicitly
      send(peer.id, { description: pc.localDescription });
      attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver);
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  } else if ('sharing' in data) {
    const started = !!data.sharing && !peer.sharing;
    peer.sharing = !!data.sharing;
    peer.hasAudio = peer.sharing && !!data.audio;
    if (!peer.sharing) peer.iWatch = false; // a new share starts unwatched
    if (started) addSystem(`${displayName(peer)} começou a compartilhar a tela`);
    refresh();
  } else if ('chat' in data) {
    const text = cleanChat(data.chat);
    if (text) addMessage({ authorId: peer.id, name: displayName(peer), photo: peer.photo, text });
  } else if ('voice' in data) {
    const state = data.voice ?? {};
    const was = peer.voiceIn;
    peer.voiceIn = !!state.in;
    peer.voiceMuted = !!state.muted;
    if (!peer.voiceIn) peer.speaking = false;
    if (peer.voiceIn !== was && peer.announced) {
      addSystem(`${displayName(peer)} ${peer.voiceIn ? 'entrou na' : 'saiu da'} voz`);
      if (voice.joined) chime(peer.voiceIn);
    }
    sendVoiceTo(peer);
    applyVoiceOutput();
    refresh();
  } else if ('restart' in data) {
    if (myId > peer.id) restartIce(peer); // they asked us to redo the connection
  } else if ('watch' in data) {
    // Ignore a request that crossed with us stopping the share.
    peer.watchesMe = !!data.watch && !!localTrack;
    sendScreenTo(peer);
    refresh();
  }
}

// We adjust every description we receive (it only changes what *we* send):
// - Chrome sends mono Opus unless the other side says it plays stereo. Game
//   and music audio deserve stereo and a higher bitrate. Only the first Opus
//   section is touched: that's the screen's sound; voice (the next one) keeps
//   Chrome's mono speech defaults.
// - Video starts from a low bandwidth guess, so the picture opened at 180p and
//   took ~20s to sharpen. A 1.5 Mbps starting guess opens it sharp right away;
//   if the real connection is worse, the estimate drops within seconds.
const START_BITRATE_KBPS = 1500;
function tuneDescription(description) {
  let sdp = description.sdp ?? '';
  const opus = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
  for (const pt of opus) {
    sdp = sdp.replace(new RegExp(`a=fmtp:${pt} ([^\r\n]*)`), (_, params) => {
      const kept = params.split(';').filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(p));
      return `a=fmtp:${pt} ${[...kept, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].join(';')}`;
    });
  }
  const video = [...sdp.matchAll(/a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000/gi)].map((m) => m[1]);
  for (const pt of new Set(video)) {
    const fmtp = new RegExp(`a=fmtp:${pt} ([^\r\n]*)`, 'g');
    if (fmtp.test(sdp)) {
      sdp = sdp.replace(fmtp, (line, params) => (params.includes('x-google-start-bitrate') ? line : `${line};x-google-start-bitrate=${START_BITRATE_KBPS}`));
    } else {
      sdp = sdp.replace(new RegExp(`(a=rtpmap:${pt} [^\r\n]*)`, 'g'), `$1\r\na=fmtp:${pt} x-google-start-bitrate=${START_BITRATE_KBPS}`);
    }
  }
  return { type: description.type, sdp };
}

function handleProfile(peer, data) {
  peer.nick = cleanNick(data.nick);
  peer.photo = validPhoto(data.photo);
  peer.hwH264 = data.hwH264 === true;
  peer.resolveProfile();
  if (!peer.announced) {
    peer.announced = true; // wait for the nick so the line has a name
    addSystem(`${displayName(peer)} entrou`);
  }
  refresh();
}

// Video only flows to peers that clicked "Assistir": everyone else gets a null
// track, so we don't encode for them and they don't decode anything.
function sendScreenTo(peer) {
  if (!peer.transceiver) return; // attached later, once that peer's offer arrives
  const watching = !!localTrack && peer.watchesMe;
  const video = watching ? localTrack : null;
  if (peer.transceiver.sender.track !== video) {
    peer.transceiver.sender.replaceTrack(video)
      .then(() => video && tuneSender(peer))
      .catch((err) => console.warn(err));
  }
  const audio = watching ? localAudio : null;
  const audioSender = peer.audioTransceiver?.sender;
  if (audioSender && audioSender.track !== audio) {
    audioSender.replaceTrack(audio).catch((err) => console.warn(err));
  }
}

// ---------- modo Jogo / Texto ----------

// Jogo: smooth and light. Texto: sharp text for code and documents, at a low
// frame rate. The caps are applied in the encoder (works for any capture
// source) and, best effort, in the capture itself.
const MODES = {
  jogo: { hint: 'motion', fps: 30, maxHeight: 720, bitrate: 2_500_000, degradation: 'maintain-framerate' },
  texto: { hint: 'text', fps: 15, maxHeight: 1080, bitrate: 2_500_000, degradation: 'maintain-resolution' },
};
let shareMode = load('shareMode') === 'texto' ? 'texto' : 'jogo';

function captureConstraints() {
  const mode = MODES[shareMode];
  return { frameRate: { ideal: mode.fps, max: mode.fps }, height: { max: mode.maxHeight } };
}

function encoderSettings(sender) {
  const mode = MODES[shareMode];
  const height = sender.track.getSettings().height || mode.maxHeight;
  return {
    maxBitrate: mode.bitrate,
    maxFramerate: mode.fps,
    scaleResolutionDownBy: Math.max(1, height / mode.maxHeight),
  };
}

async function tuneSender(peer) {
  const sender = peer.transceiver?.sender;
  if (!sender?.track) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return; // not negotiated yet: retried once connected
  Object.assign(params.encodings[0], encoderSettings(sender));
  params.degradationPreference = MODES[shareMode].degradation;
  try {
    await sender.setParameters(params);
  } catch {
    // Some browsers reject degradationPreference: retry with fresh params without it.
    const retry = sender.getParameters();
    if (!retry.encodings?.length) return;
    Object.assign(retry.encodings[0], encoderSettings(sender));
    await sender.setParameters(retry).catch((err) => console.warn('encoder', err));
  }
}

function setShareMode(mode) {
  shareMode = mode;
  save('shareMode', mode);
  if (localTrack) {
    localTrack.contentHint = MODES[mode].hint;
    localTrack.applyConstraints(captureConstraints())
      .catch(() => { /* capture caps are best effort; the encoder caps still apply */ })
      .finally(() => peers.forEach(tuneSender));
  }
  refresh();
}
$('mode-jogo').onclick = () => setShareMode('jogo');
$('mode-texto').onclick = () => setShareMode('texto');

// "Tentar de novo": an ICE restart (new offer with fresh ICE credentials).
// Only the participant with the higher number sends it, so both sides
// clicking at once can't produce two colliding offers; the other one asks.
function retryConnection(peer) {
  peer.retrying = true;
  refresh();
  setTimeout(() => {
    if (peer.pc.connectionState === 'failed') {
      peer.retrying = false; // give the button back if nothing changed
      refresh();
    }
  }, 15_000);
  if (myId > peer.id) restartIce(peer);
  else send(peer.id, { restart: true });
}

function restartIce(peer) {
  enqueue(peer, async () => {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
    send(peer.id, { description: peer.pc.localDescription });
  });
}

// Fullscreen on desktop and Android; iPhone Safari only supports it on the
// <video> element through its own webkit API. Phones also try landscape.
function togglePip(video) {
  if (document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {});
  } else {
    video.requestPictureInPicture().catch((err) => console.warn('picture-in-picture', err));
  }
}

function enterFullscreen(video) {
  const landscape = () => screen.orientation?.lock?.('landscape').catch(() => {});
  if (video.requestFullscreen) {
    video.requestFullscreen().then(landscape, () => video.webkitEnterFullscreen?.());
  } else {
    video.webkitEnterFullscreen?.();
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) screen.orientation?.unlock?.();
});

// One volume and mute for every stream you watch, saved in this browser.
let soundVolume = Math.min(1, Math.max(0, Number(load('volume') || 1)));
let soundMuted = load('muted') === '1';

function setVolume(value) {
  soundVolume = value;
  save('volume', String(value));
  if (value > 0 && soundMuted) setSoundMuted(false);
  else refresh();
}

function setSoundMuted(muted) {
  soundMuted = muted;
  save('muted', muted ? '1' : '');
  refresh();
}

function setWatch(peer, watch) {
  peer.iWatch = watch;
  if (watch) {
    // The click on "Assistir" lets the browser play sound: unmute right here.
    const video = peer.screen.video;
    video.volume = soundVolume;
    video.muted = soundMuted;
    video.play().catch(() => {});
  }
  send(peer.id, { watch });
  refresh();
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  if (document.pictureInPictureElement === peer.screen.video) document.exitPictureInPicture().catch(() => {});
  peer.screen.card.remove();
  peer.voiceAudio?.remove();
  peers.delete(id);
  refresh();
}

// ---------- compartilhar / parar / sair ----------

shareBtn.onclick = () => (localTrack ? stopShare() : startShare());

// What is shared also brings its sound when the browser allows it: a tab, or
// the whole screen's system audio on Windows. No voice processing (it ruins
// music and game audio), and restrictOwnAudio keeps what this tab plays (the
// friends' streams) out of it, so nobody hears an echo of themselves.
const SHARE_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true,
  suppressLocalAudioPlayback: false,
};

async function captureScreen() {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: captureConstraints(), audio: SHARE_AUDIO, systemAudio: 'include' });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') throw err; // picker cancelled
    // A browser that rejects audio capture outright: share without sound.
    return navigator.mediaDevices.getDisplayMedia({ video: captureConstraints(), audio: false });
  }
}

async function startShare() {
  let stream;
  try {
    stream = await captureScreen();
  } catch {
    return; // usuário cancelou a escolha
  }
  localTrack = stream.getVideoTracks()[0];
  localAudio = stream.getAudioTracks()[0] ?? null;
  if (localAudio) {
    localAudio.contentHint = 'music'; // Opus in music mode, not voice
    localAudio.onended = () => { // sound stopped but the screen goes on
      localAudio = null;
      peers.forEach((peer) => {
        sendScreenTo(peer);
        send(peer.id, { sharing: true, audio: false });
      });
      refresh();
    };
  } else {
    toast('Compartilhando sem som. Para incluir o som, escolha "Tela inteira" e marque "Compartilhar áudio do sistema", ou uma aba do Chrome com "Compartilhar áudio da guia".', 9000);
  }
  // "motion" keeps the frame rate (games); "text" keeps sharpness (code).
  localTrack.contentHint = MODES[shareMode].hint;
  localTrack.onended = stopShare; // the browser's own "stop sharing" bar
  setPreview(previewOn);
  peers.forEach((peer) => send(peer.id, { sharing: true, audio: !!localAudio })); // media only once they ask
  refresh();
}

// Our own preview is one more video to decode and paint, so it starts hidden.
let previewOn = load('preview') === 'on';
localScreen.watchBtn.textContent = 'Mostrar prévia';
localScreen.pipBtn.remove(); // no point floating your own screen
localScreen.soundBtn.remove(); // your own sound is never played back to you
localScreen.volume.remove();
localScreen.unwatchBtn.textContent = 'Esconder prévia';
localScreen.watchBtn.onclick = () => setPreview(true);
localScreen.unwatchBtn.onclick = () => setPreview(false);

function setPreview(on) {
  previewOn = on;
  save('preview', on ? 'on' : '');
  localScreen.video.srcObject = on && localTrack ? new MediaStream([localTrack]) : null;
  refresh();
}

function stopShare() {
  if (!localTrack) return;
  localTrack.onended = null;
  localTrack.stop();
  localTrack = null;
  if (localAudio) {
    localAudio.onended = null;
    localAudio.stop();
    localAudio = null;
  }
  localScreen.video.srcObject = null;
  peers.forEach((peer) => {
    peer.watchesMe = false;
    sendScreenTo(peer);
    send(peer.id, { sharing: false });
  });
  refresh();
}

function leaveRoom(title, text, action) {
  left = true;
  leaveVoice();
  clearTimeout(reconnectTimer);
  stopShare();
  ws?.close();
  clearInterval(timer);
  [...peers.keys()].forEach(removePeer);
  shareBtn.disabled = true;
  setChatEnabled(false);
  releaseLock?.();
  showNotice(title, text, action);
}

// ---------- voz ----------

// A voice channel inside the room, optional like Discord's: only people who
// joined it send and hear voice. Each pair has its own voice transceiver
// (negotiated once with the others) that replaceTrack() fills or empties, so
// joining, leaving and muting never renegotiate.
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>',
  headphones: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/></svg>',
  headphonesOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/><path d="M3 3l18 18"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15.5c5-4.7 13-4.7 18 0l-2.3 2.6a1.2 1.2 0 0 1-1.6.2l-2.4-1.6a1.2 1.2 0 0 1-.5-1v-1.6a12 12 0 0 0-4.4 0v1.6a1.2 1.2 0 0 1-.5 1l-2.4 1.6a1.2 1.2 0 0 1-1.6-.2z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>',
};
const SPEAKING_LEVEL = 0.02; // RMS above this counts as talking
const SPEAKING_HOLD_MS = 300; // keeps the ring steady between words
const voice = {
  joined: false, muted: false, deafened: false,
  track: null, ctx: null, analyser: null, speaking: false, lastLoud: 0,
  deviceId: load('micId'),
  noiseSuppression: load('noiseSuppression') !== 'off',
  volume: Math.min(1, Math.max(0, Number(load('voiceVolume') || 1))),
};

// Voice wants the opposite of the screen's sound: echo cancellation, noise
// suppression and automatic gain.
function micConstraints() {
  return {
    deviceId: voice.deviceId ? { exact: voice.deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: voice.noiseSuppression,
    autoGainControl: true,
  };
}

async function openMic() {
  try {
    return (await navigator.mediaDevices.getUserMedia({ audio: micConstraints() })).getAudioTracks()[0];
  } catch (err) {
    if (voice.deviceId && err.name === 'OverconstrainedError') { // the saved mic is gone
      voice.deviceId = '';
      save('micId', '');
      return openMic();
    }
    throw err;
  }
}

function voiceState() {
  return { in: voice.joined, muted: voice.muted || voice.deafened };
}

function broadcastVoice() {
  peers.forEach((peer) => send(peer.id, { voice: voiceState() }));
}

// Voice only flows between two people who are both in the voice channel.
function sendVoiceTo(peer) {
  const sender = peer.voiceTransceiver?.sender;
  if (!sender) return;
  const track = voice.joined && peer.voiceIn ? voice.track : null;
  if (sender.track !== track) sender.replaceTrack(track).catch((err) => console.warn(err));
}

function applyVoiceOutput() {
  peers.forEach((peer) => {
    if (!peer.voiceAudio) return;
    peer.voiceAudio.muted = !voice.joined || voice.deafened || !peer.voiceIn;
    peer.voiceAudio.volume = voice.volume;
    if (!peer.voiceAudio.muted) peer.voiceAudio.play().catch(() => {});
  });
}

function analyserFor(track) {
  const analyser = voice.ctx.createAnalyser();
  analyser.fftSize = 512;
  voice.ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  return analyser;
}

function levelOf(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / data.length);
}

async function joinVoice() {
  if (voice.joined) return;
  try {
    voice.ctx ??= new AudioContext(); // created on this click, so it may play
    await voice.ctx.resume();
    voice.track = await openMic();
  } catch {
    toast('Não deu para usar o microfone. Libere o acesso no cadeado ao lado do endereço e tente de novo.', 7000);
    return;
  }
  voice.track.contentHint = 'speech';
  voice.analyser = analyserFor(voice.track);
  voice.joined = true;
  voice.muted = false;
  voice.deafened = false;
  document.body.classList.add('in-voice');
  chime(true);
  addSystem('Você entrou na voz.');
  broadcastVoice();
  peers.forEach(sendVoiceTo);
  applyVoiceOutput();
  refresh();
}

function leaveVoice() {
  if (!voice.joined) return;
  voice.joined = false;
  voice.track?.stop();
  voice.track = null;
  voice.analyser = null;
  voice.speaking = false;
  document.body.classList.remove('in-voice');
  chime(false);
  broadcastVoice();
  peers.forEach(sendVoiceTo);
  applyVoiceOutput();
  refresh();
}

// Muting keeps sending (silence, almost free) so unmuting is instant.
function setMuted(muted) {
  if (!voice.joined) return;
  voice.muted = muted;
  if (!muted) voice.deafened = false; // talking again means hearing again
  voice.track.enabled = !(voice.muted || voice.deafened);
  broadcastVoice();
  applyVoiceOutput();
  refresh();
}

function setDeafened(deafened) {
  if (!voice.joined) return;
  voice.deafened = deafened;
  voice.track.enabled = !(voice.muted || voice.deafened);
  broadcastVoice();
  applyVoiceOutput();
  refresh();
}

const toggleMic = () => setMuted(!(voice.muted || voice.deafened));
$('voice-join').onclick = joinVoice;
$('voice-leave').onclick = leaveVoice;
$('mic').onclick = toggleMic;
$('me-mic').onclick = toggleMic;
$('deafen').onclick = () => setDeafened(!voice.deafened);
$('me-deafen').onclick = () => setDeafened(!voice.deafened);
document.addEventListener('keydown', (e) => { // Ctrl+Shift+M, like Discord
  if (voice.joined && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
  }
});

// Speaking rings: a cheap level check 10 times a second, only while in voice.
setInterval(() => {
  if (!voice.joined || !voice.ctx) return;
  const now = Date.now();
  let changed = false;
  const check = (who, analyser, active) => {
    if (active && analyser && levelOf(analyser) > SPEAKING_LEVEL) who.lastLoud = now;
    const speaking = active && now - (who.lastLoud ?? 0) < SPEAKING_HOLD_MS;
    if (speaking !== !!who.speaking) {
      who.speaking = speaking;
      changed = true;
    }
  };
  check(voice, voice.analyser, !voice.muted && !voice.deafened);
  peers.forEach((peer) => {
    if (peer.voiceIn && peer.voiceTransceiver && !peer.voiceAnalyser) {
      peer.voiceAnalyser = analyserFor(peer.voiceTransceiver.receiver.track);
    }
    check(peer, peer.voiceAnalyser, peer.voiceIn && !peer.voiceMuted && !voice.deafened);
  });
  if (changed) updateSpeaking();
}, 100);

function markSpeaker(node, person) {
  node.dataset.pid = String(person.id);
  node.classList.toggle('speaking', !!person.speaking);
}

// Only toggles classes: no need to rebuild the lists for every syllable.
function updateSpeaking() {
  document.querySelectorAll('[data-pid]').forEach((node) => {
    const id = Number(node.dataset.pid);
    node.classList.toggle('speaking', id === myId ? voice.speaking : !!peers.get(id)?.speaking);
  });
}

function voiceIcon(person) {
  const icon = el('span', person.voiceMuted ? 'voice-icon off' : 'voice-icon');
  icon.innerHTML = person.voiceMuted ? ICONS.micOff : ICONS.mic; // fixed markup, no user text
  icon.title = person.voiceMuted ? 'Na voz, mudo' : 'Na voz';
  return icon;
}

function renderVoiceUi() {
  const silent = voice.muted || voice.deafened;
  $('voice-join').hidden = voice.joined;
  for (const id of ['mic', 'deafen', 'voice-leave']) $(id).hidden = !voice.joined;
  $('me-voice').hidden = !voice.joined;
  for (const id of ['mic', 'me-mic']) {
    const button = $(id);
    const label = silent ? 'Ligar microfone' : 'Silenciar microfone';
    button.innerHTML = silent ? ICONS.micOff : ICONS.mic;
    button.setAttribute('aria-pressed', String(silent));
    button.setAttribute('aria-label', label);
    button.title = `${label} (Ctrl+Shift+M)`;
  }
  for (const id of ['deafen', 'me-deafen']) {
    const button = $(id);
    const label = voice.deafened ? 'Voltar a ouvir' : 'Silenciar todo mundo';
    button.innerHTML = voice.deafened ? ICONS.headphonesOff : ICONS.headphones;
    button.setAttribute('aria-pressed', String(voice.deafened));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  if (!$('voice-settings-btn').innerHTML) $('voice-settings-btn').innerHTML = ICONS.sliders;
  if (!$('voice-leave').innerHTML) $('voice-leave').innerHTML = ICONS.hangup;
  if (!$('edit').innerHTML) $('edit').innerHTML = ICONS.pencil;
}

// Two soft synthesized notes: up when someone joins the voice, down on leave.
function chime(up) {
  if (!voice.ctx) return;
  const t = voice.ctx.currentTime;
  const gain = voice.ctx.createGain();
  gain.connect(voice.ctx.destination);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  const osc = voice.ctx.createOscillator();
  osc.frequency.setValueAtTime(up ? 523 : 659, t);
  osc.frequency.setValueAtTime(up ? 659 : 523, t + 0.12);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.32);
}

// ---------- configurações de voz ----------

let previewTrack = null; // mic opened just for the meter, when not in voice
let previewAnalyser = null;
let meterTimer = null;

async function openVoiceSettings() {
  $('vs-ns').checked = voice.noiseSuppression;
  $('vs-volume').value = String(voice.volume);
  $('voice-settings').showModal();
  try {
    voice.ctx ??= new AudioContext();
    await voice.ctx.resume();
    const track = voice.track ?? (previewTrack = await openMic());
    previewAnalyser = analyserFor(track);
    await fillMicList();
    meterTimer = setInterval(() => {
      $('vs-meter').style.width = `${Math.min(100, Math.round(levelOf(previewAnalyser) * 400))}%`;
    }, 80);
  } catch {
    $('vs-mic').replaceChildren(el('option', null, 'Microfone bloqueado ou indisponível'));
  }
}

async function fillMicList() {
  const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  $('vs-mic').replaceChildren(...mics.map((device, i) => {
    const option = el('option', null, device.label || `Microfone ${i + 1}`);
    option.value = device.deviceId;
    option.selected = device.deviceId === (voice.deviceId || 'default');
    return option;
  }));
}

// A new device or setting: reopen the mic and swap it in wherever it is sent.
async function switchMic() {
  let track;
  try {
    track = await openMic();
  } catch {
    toast('Não deu para abrir esse microfone.');
    return;
  }
  if (voice.joined) {
    voice.track.stop();
    voice.track = track;
    track.contentHint = 'speech';
    track.enabled = !(voice.muted || voice.deafened);
    voice.analyser = analyserFor(track);
    peers.forEach((peer) => {
      const sender = peer.voiceTransceiver?.sender;
      if (sender?.track) sender.replaceTrack(track).catch((err) => console.warn(err));
    });
  } else {
    previewTrack?.stop();
    previewTrack = track;
  }
  previewAnalyser = analyserFor(track);
}

$('voice-settings-btn').onclick = openVoiceSettings;
$('voice-settings').onclose = () => {
  clearInterval(meterTimer);
  previewTrack?.stop();
  previewTrack = null;
  previewAnalyser = null;
};
$('vs-mic').onchange = () => {
  voice.deviceId = $('vs-mic').value;
  save('micId', voice.deviceId);
  switchMic();
};
$('vs-ns').onchange = () => {
  voice.noiseSuppression = $('vs-ns').checked;
  save('noiseSuppression', voice.noiseSuppression ? '' : 'off');
  switchMic();
};
$('vs-volume').oninput = () => {
  voice.volume = Number($('vs-volume').value);
  save('voiceVolume', String(voice.volume));
  applyVoiceOutput();
};

// ---------- chat ----------

// Chat goes through the signaling WebSocket (one copy per participant), so it
// works even when the direct video connection fails. Nothing is stored.
const MAX_CHAT = 500;
const GROUP_MS = 5 * 60_000; // consecutive messages from the same person share a header
const messagesEl = $('messages');
const chatInput = $('chat-input');
const mobile = matchMedia('(max-width: 760px)');
let lastAuthor = null;
let lastAt = 0;
let unread = 0;

function cleanChat(value) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, MAX_CHAT).join('') : '';
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  $('chat-send').disabled = !on;
}

function chatVisible() {
  return !document.hidden && (!mobile.matches || document.body.classList.contains('chat-open'));
}

function updateUnread() {
  if (chatVisible()) unread = 0;
  $('chat-badge').hidden = unread === 0;
  $('chat-badge').textContent = String(unread);
  document.title = unread ? `(${unread}) CPX Call` : 'CPX Call';
}

// Builds text with http(s) links as anchors, never as HTML.
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    frag.append(text.slice(last, match.index));
    const a = el('a', null, match[0]);
    a.href = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = match.index + match[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function appendToChat(item) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  messagesEl.append(item);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage({ authorId, name, photo, text, self = false }) {
  const now = Date.now();
  const grouped = authorId === lastAuthor && now - lastAt < GROUP_MS;
  lastAuthor = authorId;
  lastAt = now;

  const li = el('li', grouped ? 'msg grouped' : 'msg');
  if (!grouped) {
    const head = el('div', 'msg-head');
    const avatar = el('div', 'avatar');
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, name, authorId, photo);
    const time = el('time', null, new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    head.append(avatar, el('strong', 'ellipsis', self ? `${name} (você)` : name), time);
    li.append(head);
  }
  const body = el('p', 'msg-text');
  body.append(linkify(text));
  li.append(body);
  appendToChat(li);

  if (!self) {
    unread += 1;
    updateUnread();
  }
}

function addSystem(text) {
  lastAuthor = null; // the next message starts a new group
  appendToChat(el('li', 'system', text));
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = cleanChat(chatInput.value);
  if (!text || chatInput.disabled) return;
  peers.forEach((peer) => send(peer.id, { chat: text }));
  addMessage({ authorId: myId, name: myNick, photo: myPhoto, text, self: true });
  chatInput.value = '';
  messagesEl.scrollTop = messagesEl.scrollHeight; // always follow your own message
};

$('chat-toggle').onclick = () => {
  document.body.classList.add('chat-open');
  updateUnread();
  chatInput.focus();
};
$('chat-close').onclick = () => {
  document.body.classList.remove('chat-open');
};
document.addEventListener('visibilitychange', updateUnread);
mobile.addEventListener('change', updateUnread);

// Leaving goes back to the lobby, where your rooms are listed.
function goToLobby() {
  left = true;
  leaveVoice();
  clearTimeout(reconnectTimer);
  stopShare();
  ws?.close();
  releaseLock?.();
  location.assign('/');
}
$('leave').onclick = goToLobby;
$('home').onclick = (e) => {
  e.preventDefault();
  goToLobby();
};

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
  const icon = el('span', 'hud-icon', room.home ? '★' : '#');
  icon.style.background = colorFor(room.id);
  icon.setAttribute('aria-hidden', 'true');
  const count = hudCounts[room.id];
  const text = el('span', 'hud-count', count > 0 ? `● ${count}` : '');
  if (count > 0) text.classList.add('online');
  link.append(icon, el('span', 'hud-name ellipsis', displayRoomName(room.id)), text);
  const li = el('li');
  li.append(link);
  return li;
}

function renderHud() {
  $('hud-rooms').replaceChildren(...orderedRooms().map(hudItem));
}

async function updateHudCounts() {
  if (document.hidden || !$('hud').open) return; // nothing to show while folded
  const fresh = await fetchRoomCounts(orderedRooms().map((r) => r.id));
  if (!fresh) return; // offline: keep the last numbers
  hudCounts = fresh;
  renderHud();
}

// Folded by default so the chat keeps its space; remembered per browser.
$('hud').open = load('hud-open') === '1';
$('hud').ontoggle = () => {
  save('hud-open', $('hud').open ? '1' : '');
  updateHudCounts();
};

$('hud-new').onsubmit = (e) => {
  e.preventDefault();
  if (!okToLeave()) return;
  const id = newRoomId($('hud-new-name').value);
  location.assign(`/room/${id}`);
};

renderHud();
updateHudCounts();
setInterval(updateHudCounts, 15_000);
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
  } catch {
    window.prompt('Copie o convite:', `${text} ${url}`); // clipboard needs HTTPS
  }
}
$('invite').onclick = invite;
$('invite-side').onclick = invite;

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

// ---------- interface ----------

function elapsed(since) {
  const s = Math.floor((Date.now() - since) / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
}

function buildScreen() {
  const card = el('div', 'screen card');
  card.hidden = true;
  const frame = el('div', 'frame');
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.title = 'Duplo clique para tela cheia';
  video.ondblclick = () => enterFullscreen(video);
  const waiting = el('div', 'waiting');
  const waitingText = el('span');
  const watchBtn = el('button', 'btn primary', 'Assistir');
  waiting.append(waitingText, watchBtn);
  const failed = el('div', 'waiting failed');
  failed.hidden = true;
  const failedText = el('strong');
  const retryBtn = el('button', 'btn primary', 'Tentar de novo');
  failed.append(
    failedText,
    el('span', null, 'Costuma acontecer com VPN ligada, 4G ou rede de empresa. Desligar a VPN costuma resolver.'),
    retryBtn,
  );
  frame.append(video, waiting, failed);
  const pill = el('span', 'pill');
  const hint = el('span', 'hint muted');
  const soundBtn = el('button', 'btn small sound-btn');
  const volume = el('input', 'volume');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.05';
  const fullBtn = el('button', 'btn small', 'Tela cheia');
  fullBtn.onclick = () => enterFullscreen(video);
  // Picture-in-Picture: a small always-on-top window, to watch while playing.
  const pipBtn = el('button', 'btn small pip-btn', 'Janela flutuante');
  pipBtn.onclick = () => togglePip(video);
  video.addEventListener('enterpictureinpicture', () => (pipBtn.textContent = 'Fechar janela'));
  video.addEventListener('leavepictureinpicture', () => (pipBtn.textContent = 'Janela flutuante'));
  const unwatchBtn = el('button', 'btn small');
  unwatchBtn.append(el('span', 'long', 'Parar de assistir'), el('span', 'short', 'Parar'));
  const foot = el('div', 'screen-foot');
  const actions = el('div', 'screen-actions'); // wraps below the label when space runs out
  actions.append(soundBtn, volume, pipBtn, fullBtn, unwatchBtn);
  foot.append(pill, hint, actions);
  card.append(frame, foot);
  $('screens').append(card);
  return { card, video, waiting, waitingText, watchBtn, failed, failedText, retryBtn, pill, hint, soundBtn, volume, pipBtn, fullBtn, unwatchBtn };
}

function peerStatus(peer) {
  switch (peer.pc.connectionState) {
    case 'failed': return ['falha na conexão', 'warn'];
    case 'disconnected': return ['conexão instável', 'warn'];
    case 'connected':
      if (peer.sharing) return ['compartilhando', 'live'];
      if (peer.watchesMe) return ['assistindo você', 'online'];
      if (peer.voiceIn) return peer.voiceMuted ? ['na voz · mudo', 'muted'] : ['na voz', 'online'];
      return ['na sala', 'muted'];
    default: return ['conectando…', 'muted'];
  }
}

function personRow(person) {
  const li = el('li', 'row');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  markSpeaker(avatar, person);
  const name = el('span', 'ellipsis', person.name);
  if (person.self) name.append(el('span', 'muted', ' (você)'));
  if (person.voiceIn) name.append(voiceIcon(person));
  li.append(avatar, name, el('span', `end ${person.status[1]}`, person.status[0]));
  return li;
}

function personTile(person) {
  const tile = el('div', person.self ? 'tile card self' : 'tile card');
  markSpeaker(tile, person);
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  markSpeaker(avatar, person);
  const status = person.self ? ['você', 'online'] : person.status;
  const text = el('div', 'tile-text');
  const name = el('strong', 'ellipsis', person.name);
  if (person.voiceIn) name.append(voiceIcon(person));
  text.append(name, el('span', `status ${status[1]}`, status[0]));
  tile.append(avatar, text);
  return tile;
}

// `watching` false shows the "Assistir" placeholder instead of the video.
// `failedText` replaces both the video and the "Assistir" placeholder.
function showScreen(screen, { visible, watching, label, hint, waitingText = '', canUnwatch = false, failedText = '', sound = false }) {
  if (screen.soundBtn.isConnected) {
    screen.soundBtn.hidden = !sound;
    screen.volume.hidden = !sound;
    screen.soundBtn.textContent = soundMuted ? 'Ouvir' : 'Silenciar';
    screen.soundBtn.setAttribute('aria-pressed', String(soundMuted));
    screen.volume.value = String(soundVolume);
  }
  screen.fullBtn.hidden = !canUnwatch; // only for a screen you are watching
  screen.pipBtn.hidden = !canUnwatch || !document.pictureInPictureEnabled;
  // Close the floating window when that screen stops being watched.
  if ((!visible || !watching || failedText) && document.pictureInPictureElement === screen.video) {
    document.exitPictureInPicture().catch(() => {});
  }
  screen.card.hidden = !visible;
  screen.video.hidden = !watching || !!failedText;
  screen.waiting.hidden = watching || !!failedText;
  if (screen.failed) {
    screen.failed.hidden = !failedText;
    screen.failedText.textContent = failedText;
  }
  screen.waitingText.textContent = waitingText;
  screen.pill.textContent = label;
  screen.hint.textContent = hint;
  screen.unwatchBtn.hidden = !canUnwatch;
  if (visible && watching && screen.video.paused) screen.video.play().catch(() => {});
}

function refresh() {
  const list = [...peers.values()].sort((a, b) => a.id - b.id);
  const me = {
    self: true, id: myId, name: myNick, photo: myPhoto,
    status: localTrack ? ['compartilhando', 'live'] : voice.joined ? ['na voz', 'online'] : ['na sala', 'online'],
    voiceIn: voice.joined, voiceMuted: voice.muted || voice.deafened, speaking: voice.speaking,
  };
  const others = list.map((p) => ({
    id: p.id, name: displayName(p), photo: p.photo, status: peerStatus(p),
    voiceIn: p.voiceIn, voiceMuted: p.voiceMuted, speaking: p.speaking,
  }));
  const people = myId === null ? [] : [me, ...others];

  $('online').textContent = people.length ? `● ${people.length}/${maxPeers} online` : '';
  $('people').replaceChildren(...people.map(personRow));
  $('tiles').replaceChildren(...people.map(personTile));
  $('tiles').classList.toggle('compact', people.length > 4); // big avatars don't fit

  const viewers = list.filter((p) => p.watchesMe).length;
  showScreen(localScreen, {
    visible: !!localTrack,
    watching: previewOn,
    label: '● Você está compartilhando',
    hint: `${viewers === 0 ? 'ninguém assistindo' : viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`} · ${localAudio ? 'com som' : 'sem som'}`,
    waitingText: 'Sua tela está indo para quem clicar em Assistir. A prévia fica escondida para poupar o PC.',
    canUnwatch: previewOn,
  });
  for (const peer of list) {
    const name = displayName(peer);
    const failed = peer.pc.connectionState === 'failed';
    showScreen(peer.screen, {
      visible: peer.sharing,
      watching: peer.iWatch,
      label: `● ${name} está compartilhando`,
      hint: failed ? '' : peer.iWatch ? (peer.hasAudio ? '' : 'sem som') : 'O vídeo só chega para quem assiste',
      sound: peer.iWatch && peer.hasAudio && !failed,
      waitingText: `${name} está compartilhando a tela`,
      canUnwatch: peer.iWatch && !failed,
      failedText: failed ? (peer.retrying ? 'Tentando conectar de novo…' : `Não foi possível conectar com ${name}`) : '',
    });
    peer.screen.retryBtn.hidden = !!peer.retrying;
    peer.screen.video.volume = soundVolume;
    peer.screen.video.muted = !peer.iWatch || soundMuted;
  }
  const shown = (localTrack ? 1 : 0) + list.filter((p) => p.sharing).length;
  $('empty').hidden = shown > 0;
  $('screens').style.setProperty('--cols', shown > 2 ? 2 : 1);
  $('live').hidden = shown === 0;
  $('reconnecting').hidden = !reconnecting;

  paintAvatar($('me-avatar'), myNick, myId, myPhoto);
  $('me-nick').textContent = myNick;
  $('me-status').textContent = localTrack ? 'Compartilhando'
    : !voice.joined ? 'Na sala'
      : voice.deafened ? 'Na voz · sem som' : voice.muted ? 'Na voz · mudo' : 'Na voz';
  $('me-status').className = me.status[1];
  renderVoiceUi();

  $('share-long').textContent = localTrack ? 'Parar compartilhamento' : 'Compartilhar tela';
  $('share-short').textContent = localTrack ? 'Parar' : 'Tela';
  $('mode-jogo').setAttribute('aria-pressed', String(shareMode === 'jogo'));
  $('mode-texto').setAttribute('aria-pressed', String(shareMode === 'texto'));
}

// ---------- início ----------

$('room-tag').textContent = `# ${displayRoomName(roomId)}`;
$('room-title').textContent = isHomeRoom(roomId) ? 'Block' : `Sala ${roomName(roomId)}`;
if (!canShare) {
  shareBtn.title = 'Compartilhar tela exige HTTPS ou localhost';
  $('empty-hint').textContent = 'Neste endereço o navegador não deixa compartilhar a tela (precisa de HTTPS ou localhost), mas você pode assistir.';
}
refresh();
let takeover = false;
try {
  takeover = sessionStorage.getItem('takeover') === '1';
  sessionStorage.removeItem('takeover');
} catch { /* storage blocked: no takeover */ }
if (myNick) enterRoom(takeover); else openProfile();
