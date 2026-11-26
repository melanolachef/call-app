// ---------- qualidade: resolução, FPS e prioridade ----------

// One button opens a box to pick the resolution, the frame rate and what to
// keep when the PC or the network can't keep up: "Fluidez" (games: keeps
// the frame rate, contentHint motion) or "Nitidez" (code, documents: keeps
// the resolution, contentHint text). The caps are applied in the encoder
// (works for any capture source) and, best effort, in the capture itself.
const QUALITY_HEIGHTS = [480, 720, 1080, 1440];
const QUALITY_FPS = [15, 30, 60];
const PRIORITY = {
  motion: { hint: 'motion', degradation: 'maintain-framerate', label: 'Fluidez' },
  text: { hint: 'text', degradation: 'maintain-resolution', label: 'Nitidez' },
};
const QUALITY_PRESETS = [
  { name: 'Jogo', height: 720, fps: 30, priority: 'motion', note: 'leve para o PC' },
  { name: 'Jogo liso', height: 1080, fps: 60, priority: 'motion', note: 'pesa mais' },
  { name: 'Texto', height: 1080, fps: 15, priority: 'text', note: 'código e documentos' },
];

function loadQuality() {
  try {
    const saved = JSON.parse(load('shareQuality') || 'null');
    if (saved && QUALITY_HEIGHTS.includes(saved.height) && QUALITY_FPS.includes(saved.fps) && saved.priority in PRIORITY) {
      return { height: saved.height, fps: saved.fps, priority: saved.priority };
    }
  } catch { /* broken entry */ }
  // The old Jogo / Texto setting, if any.
  const { height, fps, priority } = QUALITY_PRESETS[load('shareMode') === 'texto' ? 2 : 0];
  return { height, fps, priority };
}
let quality = loadQuality();
// What the others are told ("Jogo" / "Texto") and what the old code reads.
let shareMode = quality.priority === 'text' ? 'texto' : 'jogo';

// Upload per viewer (one encode each in a mesh): ~0,09 bit per pixel per
// frame, between 0,8 and 6 Mb/s. 720p30 ≈ 2,5 Mb/s, as before.
function qualityBitrate(height, fps) {
  const width = Math.round((height * 16) / 9);
  return Math.round(Math.min(6_000_000, Math.max(800_000, width * height * fps * 0.09)));
}

// ---------- ajuste automático (PC no limite) ----------

// Some PCs heat up after minutes of game + encoding and the game starts to
// stutter. Every 5s we read what the encoder reports: if it says it is
// CPU-limited for ~15s, the stream steps down one level (and the sharer is
// told); after 2 calm minutes it steps back up. Frame-rate
// drops alone don't count: a still screen (a game menu) also sends fewer
// frames while the PC is fine. Each step changes the capture (a small hiccup
// in the game), so after two drops in one share it stays down instead of
// going up and down for the rest of the session.
// Steps down from what was chosen: Fluidez gives up resolution first,
// Nitidez gives up frames first.
function levelCaps(level) {
  const { height, fps, priority } = quality;
  const steps = priority === 'text'
    ? [[1, 1], [1, 0.8], [1, 0.66], [0.75, 0.5]]
    : [[1, 1], [1, 0.8], [0.75, 0.8], [0.66, 0.66]];
  const [h, f] = steps[Math.min(level, steps.length - 1)];
  return { maxHeight: Math.round((height * h) / 2) * 2, fps: Math.max(5, Math.round(fps * f)) };
}
const LEVEL_COUNT = 4;
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

// With 3+ people watching (one encode each), it starts one step down.
function currentCaps() {
  const extra = viewerCount() >= 3 ? 1 : 0;
  return levelCaps(Math.min(LEVEL_COUNT - 1, adaptLevel + extra));
}

// What the others see before clicking "Assistir": "720p · 30 fps · Jogo".
// Sent with every change (mode, automatic step down, 3+ viewers).
function shareInfo() {
  const caps = currentCaps();
  return { sharing: true, audio: !!localAudio, mode: shareMode, height: caps.maxHeight, fps: caps.fps };
}
let lastShareInfo = '';
function broadcastShareInfo() {
  if (!localTrack) return;
  const info = JSON.stringify(shareInfo());
  if (info === lastShareInfo) return;
  lastShareInfo = info;
  peers.forEach((peer) => send(peer.id, shareInfo()));
}

function retune() {
  if (!localTrack) return;
  broadcastShareInfo();
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
    if (++strikes >= STRIKES_TO_STEP_DOWN && adaptLevel < LEVEL_COUNT - 1) {
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
  if (!localTrack) return;
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
    maxBitrate: qualityBitrate(caps.maxHeight, caps.fps),
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
  params.degradationPreference = PRIORITY[quality.priority].degradation;
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

// A new choice applies at once, also in the middle of a share, and starts
// the automatic adjustment over from it.
function setQuality(patch) {
  quality = { ...quality, ...patch };
  shareMode = quality.priority === 'text' ? 'texto' : 'jogo';
  save('shareQuality', JSON.stringify(quality));
  adaptLevel = 0;
  drops = 0;
  strikes = 0;
  calm = 0;
  if (localTrack) {
    localTrack.contentHint = PRIORITY[quality.priority].hint;
    localTrack.applyConstraints(captureConstraints())
      .catch(() => { /* capture caps are best effort; the encoder caps still apply */ })
      .finally(() => peers.forEach(tuneSender));
    broadcastShareInfo();
  }
  renderQualityPicker();
  refresh();
}

// ---------- caixa de qualidade ----------

const qualityBtn = $('quality-btn');
const qualityPop = $('quality-pop');

function choiceButton(label, pressed, onclick, title) {
  const button = el('button', 'q-choice', label);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(pressed));
  if (title) button.title = title;
  button.onclick = onclick;
  return button;
}

function renderQualityPicker() {
  const { height, fps, priority } = quality;
  qualityBtn.querySelector('.q-label').textContent = `${height}p · ${fps}`;
  qualityBtn.title = `Qualidade ao compartilhar: ${height}p a ${fps} FPS, prioridade ${PRIORITY[priority].label.toLowerCase()}`;
  // Hidden popup, unless its controls are on the settings page (ajustes.js).
  if (qualityPop.hidden && qualityPop.contains($('q-presets'))) return;
  $('q-presets').replaceChildren(...QUALITY_PRESETS.map((p) => {
    const pressed = p.height === height && p.fps === fps && p.priority === priority;
    const button = choiceButton('', pressed, () => setQuality({ height: p.height, fps: p.fps, priority: p.priority }));
    button.classList.add('q-preset');
    button.append(el('strong', null, p.name), el('span', 'mono', `${p.height}p · ${p.fps} fps`), el('span', 'q-note', p.note));
    return button;
  }));
  $('q-heights').replaceChildren(...QUALITY_HEIGHTS.map((h) => choiceButton(`${h}p`, h === height, () => setQuality({ height: h }))));
  $('q-fps').replaceChildren(...QUALITY_FPS.map((f) => choiceButton(String(f), f === fps, () => setQuality({ fps: f }))));
  $('q-priority').replaceChildren(
    choiceButton('Fluidez', priority === 'motion', () => setQuality({ priority: 'motion' }), 'Jogos e vídeo: mantém os quadros e baixa a resolução se precisar'),
    choiceButton('Nitidez', priority === 'text', () => setQuality({ priority: 'text' }), 'Código e documentos: mantém a resolução e baixa os quadros se precisar'),
  );
  const mbps = (qualityBitrate(height, fps) / 1_000_000).toFixed(1).replace('.', ',');
  const heavy = height * fps >= 1080 * 60 || height >= 1440;
  $('q-cost').textContent = `até ${mbps} Mb/s por pessoa assistindo${heavy ? ' · pesa mais no PC e na internet de quem compartilha' : ''}`;
  $('q-cost').classList.toggle('warn', heavy);
}

function setQualityPicker(open) {
  qualityPop.hidden = !open;
  qualityBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  renderQualityPicker();
  const rect = qualityBtn.getBoundingClientRect();
  const width = qualityPop.offsetWidth;
  qualityPop.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8)}px`;
  qualityPop.style.bottom = `${innerHeight - rect.top + 10}px`;
}

qualityBtn.onclick = () => setQualityPicker(qualityPop.hidden);
document.addEventListener('pointerdown', (e) => {
  if (!qualityPop.hidden && !qualityPop.contains(e.target) && !qualityBtn.contains(e.target)) setQualityPicker(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !qualityPop.hidden) {
    setQualityPicker(false);
    qualityBtn.focus();
  }
});
renderQualityPicker();

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
  refresh(); // also tells everyone else (broadcastWatching)
}

// Everyone learns who watches whom, for "assistindo Rafa" and the viewers
// on each screen. The sharer already knew from { watch }; this is the same
// fact for the rest of the room. Sent only when it changes.
function myWatching() {
  return [...peers.values()].filter((p) => p.iWatch && p.sharing).map((p) => p.id).sort((a, b) => a - b);
}
let lastWatching = '[]';
function broadcastWatching() {
  const list = myWatching();
  const text = JSON.stringify(list);
  if (text === lastWatching) return;
  lastWatching = text;
  peers.forEach((peer) => send(peer.id, { watching: list }));
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
        send(peer.id, shareInfo());
      });
      refresh();
    };
  } else {
    toast('Compartilhando sem som. Para incluir o som, escolha "Tela inteira" e marque "Compartilhar áudio do sistema", ou uma aba do Chrome com "Compartilhar áudio da guia".', 9000);
  }
  // "motion" keeps the frame rate (games); "text" keeps sharpness (code).
  localTrack.contentHint = PRIORITY[quality.priority].hint;
  localTrack.onended = stopShare; // the browser's own "stop sharing" bar
  setPreview(previewOn);
  retuneCamera(); // the camera steps down while you share
  lastShareInfo = JSON.stringify(shareInfo());
  peers.forEach((peer) => send(peer.id, shareInfo())); // media only once they ask
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

