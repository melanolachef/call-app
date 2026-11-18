// ---------- modo Jogo / Texto ----------

// Jogo: smooth and light. Texto: sharp text for code and documents, at a low
// frame rate. The caps are applied in the encoder (works for any capture
// source) and, best effort, in the capture itself.
const MODES = {
  jogo: { hint: 'motion', fps: 30, maxHeight: 720, bitrate: 2_500_000, degradation: 'maintain-framerate' },
  texto: { hint: 'text', fps: 15, maxHeight: 1080, bitrate: 2_500_000, degradation: 'maintain-resolution' },
};
let shareMode = load('shareMode') === 'texto' ? 'texto' : 'jogo';

// ---------- ajuste automático (PC no limite) ----------

// Some PCs heat up after minutes of game + encoding and the game starts to
// stutter. Every 5s we read what the encoder reports: if it says it is
// CPU-limited for ~15s, the stream steps down one level (and the sharer is
// told); after 2 calm minutes it steps back up. With 3+ people watching (one
// encode each in a mesh), Jogo already starts one level down. Frame-rate
// drops alone don't count: a still screen (a game menu) also sends fewer
// frames while the PC is fine. Each step changes the capture (a small hiccup
// in the game), so after two drops in one share it stays down instead of
// going up and down for the rest of the session.
const LEVELS = [
  { fps: 30, maxHeight: 720 },
  { fps: 24, maxHeight: 720 },
  { fps: 24, maxHeight: 540 },
  { fps: 20, maxHeight: 480 },
];
const ADAPT_EVERY_MS = 5000;
const STRIKES_TO_STEP_DOWN = 3; // ~15s CPU-limited
const CALM_TO_STEP_UP = 24; // ~2 min fine
const MAX_DROPS_TO_STEP_UP = 2;
let adaptLevel = 0;
let drops = 0;
let strikes = 0;
let calm = 0;

function viewerCount() {
  return [...peers.values()].filter((p) => p.watchesMe).length;
}

function currentCaps() {
  const mode = MODES[shareMode];
  if (shareMode !== 'jogo') return { fps: mode.fps, maxHeight: mode.maxHeight };
  const extra = viewerCount() >= 3 ? 1 : 0;
  return LEVELS[Math.min(LEVELS.length - 1, adaptLevel + extra)];
}

function retune() {
  if (!localTrack) return;
  localTrack.applyConstraints(captureConstraints())
    .catch(() => { /* capture caps are best effort; the encoder caps still apply */ })
    .finally(() => peers.forEach(tuneSender));
  refresh();
}

// One step of the controller; `limited` = the encoder reported CPU limits.
function adaptQuality(limited) {
  const before = currentCaps();
  if (limited) {
    calm = 0;
    if (++strikes >= STRIKES_TO_STEP_DOWN && adaptLevel < LEVELS.length - 1) {
      adaptLevel++;
      drops++;
      strikes = 0;
    }
  } else {
    strikes = 0;
    if (++calm >= CALM_TO_STEP_UP && adaptLevel > 0 && drops < MAX_DROPS_TO_STEP_UP) {
      adaptLevel--;
      calm = 0;
    }
  }
  const after = currentCaps();
  if (after.fps === before.fps && after.maxHeight === before.maxHeight) return;
  retune();
  if (after.fps < before.fps || after.maxHeight < before.maxHeight) {
    toast(`Seu PC está no limite: a transmissão foi para ${after.maxHeight}p a ${after.fps} FPS para não travar o jogo. ${drops < MAX_DROPS_TO_STEP_UP ? 'Volta sozinha quando aliviar.' : 'Fica assim até o fim desta transmissão.'}`, 7000);
  }
}

setInterval(async () => {
  if (!localTrack || shareMode !== 'jogo') return;
  let limited = false;
  let sending = false;
  for (const peer of peers.values()) {
    if (!peer.transceiver?.sender.track) continue;
    sending = true;
    (await peer.transceiver.sender.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp' && s.qualityLimitationReason === 'cpu') limited = true;
    });
  }
  if (sending) adaptQuality(limited);
}, ADAPT_EVERY_MS);

function captureConstraints() {
  const caps = currentCaps();
  return { frameRate: { ideal: caps.fps, max: caps.fps }, height: { max: caps.maxHeight } };
}

function encoderSettings(sender) {
  const caps = currentCaps();
  const height = sender.track.getSettings().height || caps.maxHeight;
  return {
    maxBitrate: MODES[shareMode].bitrate,
    maxFramerate: caps.fps,
    scaleResolutionDownBy: Math.max(1, height / caps.maxHeight),
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

function togglePip(video) {
  if (document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {});
  } else {
    video.requestPictureInPicture().catch((err) => console.warn('picture-in-picture', err));
  }
}

// ---------- tela cheia ----------

// The whole screen card goes fullscreen, so the label and the controls stay
// over the picture. Where the browser can't do that (iPhone Safari only has
// its own <video> player), the card covers the page instead ("theater"); with
// the site added to the home screen (manifest.webmanifest) that is the whole
// display. A phone turned sideways while watching enters theater by itself,
// like a video app, and leaves it when turned back.
let theaterCard = null;
let autoTheater = false;
const phoneLandscape = matchMedia('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)');

function isFullscreen(card) {
  return document.fullscreenElement === card || theaterCard === card;
}

function toggleFullscreen(card) {
  if (isFullscreen(card)) {
    exitFullscreen();
  } else if (document.fullscreenEnabled && card.requestFullscreen) {
    card.requestFullscreen({ navigationUI: 'hide' }).then(
      () => screen.orientation?.lock?.('landscape').catch(() => {}),
      () => setTheater(card),
    );
  } else {
    setTheater(card);
  }
}

function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTheater(null);
}

// Only the classes: safe to call from refresh().
function placeTheater(card, auto = false) {
  theaterCard?.classList.remove('theater', 'show-ui');
  theaterCard = card;
  autoTheater = !!card && auto;
  card?.classList.add('theater');
  document.body.classList.toggle('in-theater', !!card);
}

function setTheater(card, auto = false) {
  placeTheater(card, auto);
  refresh();
  if (card) flashScreenUi(card); // show how to leave
}

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) flashScreenUi(document.fullscreenElement);
  else screen.orientation?.unlock?.();
  refresh();
});

phoneLandscape.addEventListener('change', () => {
  if (phoneLandscape.matches) {
    if (theaterCard || document.fullscreenElement) return;
    const watched = [...peers.values()].find((p) => p.sharing && p.iWatch);
    if (watched) setTheater(watched.screen.card, true);
  } else if (autoTheater) {
    setTheater(null);
  }
});

// On touch screens the controls over a fullscreen picture hide; a tap brings
// them back for a few seconds.
function flashScreenUi(card) {
  if (!isFullscreen(card)) return;
  card.classList.add('show-ui');
  clearTimeout(card.uiTimer);
  card.uiTimer = setTimeout(() => card.classList.remove('show-ui'), 3000);
}

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
  peer.voiceAnalyser = dropAnalyser(peer.voiceAnalyser);
  dropVoiceBoost(peer);
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

// By default, Chrome and Edge bring the chosen window or tab to the front as
// soon as sharing starts, which hides the call. A CaptureController asks them
// to stay here instead, so you can see that the share worked. It has to be
// called right after the picker resolves; browsers without it just switch.
async function getDisplay(options) {
  const controller = typeof CaptureController === 'function' ? new CaptureController() : null;
  const stream = await navigator.mediaDevices.getDisplayMedia(controller ? { ...options, controller } : options);
  try {
    controller?.setFocusBehavior?.('no-focus-change');
  } catch {
    // Whole screens can't take focus anyway, and some captures refuse the call.
  }
  return stream;
}

async function captureScreen() {
  try {
    return await getDisplay({ video: captureConstraints(), audio: SHARE_AUDIO, systemAudio: 'include' });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') throw err; // picker cancelled
    // A browser that rejects audio capture outright: share without sound.
    return getDisplay({ video: captureConstraints(), audio: false });
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
  retuneCamera(); // the camera steps down while you share
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
  adaptLevel = 0;
  drops = 0;
  strikes = 0;
  calm = 0;
  localTrack.onended = null;
  localTrack.stop();
  localTrack = null;
  if (localAudio) {
    localAudio.onended = null;
    localAudio.stop();
    localAudio = null;
  }
  localScreen.video.srcObject = null;
  retuneCamera();
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
  stopCamera();
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

