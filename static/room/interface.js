// ---------- interface ----------

// "agora", "42 min", "1 h 05 min": how long you have been in the room.
function elapsed(since) {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function buildScreen() {
  const card = el('div', 'screen');
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
  // Over the picture: "● Tela de Rafa" bottom-left, details bottom-right,
  // the controls top-right (shown on hover).
  const pill = el('span', 'pill glass screen-label');
  const hint = el('span', 'pill glass screen-info');
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
  const actions = el('div', 'screen-actions glass');
  actions.append(soundBtn, volume, pipBtn, fullBtn, unwatchBtn);
  card.append(frame, pill, hint, actions);
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

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "Na sala" list: avatar, name and, below it, what the person is doing.
function personRow(person) {
  const li = el('li');
  const row = el('div', 'person');
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  markSpeaker(avatar, person);
  const text = el('div', 'person-text');
  const name = el('span', 'person-name');
  name.append(el('span', 'ellipsis', person.name));
  if (person.voiceIn) name.append(voiceIcon(person));
  const [status, cls] = person.self && !person.status[0].startsWith('compartilhando') ? ['Você', ''] : person.status;
  text.append(name, el('span', `person-status ellipsis ${cls}`, capitalize(status)));
  row.append(avatar, text);
  li.append(row);
  return li;
}

function personTile(person) {
  const tile = el('div', person.self ? 'tile card self' : 'tile card');
  markSpeaker(tile, person);
  tile.classList.toggle('is-live', person.status[1] === 'live');
  // Shown in the strip under a shared screen as soon as the camera is on: the
  // video is only requested once the card is visible, so it can't wait for it.
  tile.classList.toggle('cam-on', !!person.camOn);
  if (person.camVideo) {
    // The same <video> moves into each rebuilt card, so the picture never restarts.
    tile.classList.add('has-cam');
    tile.append(person.camVideo);
    if (person.camVideo.paused) person.camVideo.play().catch(() => {});
  }
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  markSpeaker(avatar, person);
  const status = person.self ? ['você', ''] : person.status;
  const text = el('div', 'tile-text');
  const name = el('strong', 'ellipsis', person.self && mobile.matches ? 'Você' : person.name);
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
    camVideo: cam.track ? myCamVideo : null, camOn: !!cam.track,
  };
  const others = list.map((p) => ({
    id: p.id, name: displayName(p), photo: p.photo, status: peerStatus(p),
    voiceIn: p.voiceIn, voiceMuted: p.voiceMuted, speaking: p.speaking,
    camVideo: camLive(p) ? p.camVideo : null, camOn: p.camOn,
  }));
  const people = myId === null ? [] : [me, ...others];

  $('online').textContent = people.length ? `${people.length}/${maxPeers}` : '';
  $('people-count').textContent = people.length ? `${people.length} ${people.length === 1 ? 'pessoa' : 'pessoas'} · ` : '';
  $('people').replaceChildren(...people.map(personRow));
  $('tiles').replaceChildren(...people.map(personTile));
  $('tiles').classList.toggle('no-cams', !people.some((p) => p.camOn));
  observeTiles();

  const viewers = list.filter((p) => p.watchesMe).length;
  showScreen(localScreen, {
    visible: !!localTrack,
    watching: previewOn,
    label: 'Sua tela',
    hint: `${viewers === 0 ? 'ninguém assistindo' : viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`} · ${localAudio ? 'com som' : 'sem som'}${shareMode === 'jogo' && (currentCaps().fps < 30 || currentCaps().maxHeight < 720) ? ` · ${currentCaps().maxHeight}p ${currentCaps().fps} FPS (ajuste automático)` : ''}`,
    waitingText: 'Sua tela está indo para quem clicar em Assistir. A prévia fica escondida para poupar o PC.',
    canUnwatch: previewOn,
  });
  for (const peer of list) {
    const name = displayName(peer);
    const failed = peer.pc.connectionState === 'failed';
    showScreen(peer.screen, {
      visible: peer.sharing,
      watching: peer.iWatch,
      label: `Tela de ${name}`,
      hint: failed ? '' : peer.iWatch ? [peer.quality, peer.hasAudio ? '' : 'sem som'].filter(Boolean).join(' · ') : '',
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
  $('content').classList.toggle('has-screens', shown > 0);
  $('screens').style.setProperty('--cols', shown > 2 ? 2 : 1);
  $('live').hidden = shown === 0;
  $('reconnecting').hidden = !reconnecting;

  paintAvatar($('me-avatar'), myNick, myId, myPhoto);
  $('me-nick').textContent = myNick;
  $('me-status').textContent = localTrack ? 'Compartilhando'
    : !voice.joined ? 'Na sala'
      : voice.deafened ? 'Na voz · sem som' : voice.muted ? 'Na voz · mudo' : 'Na voz';
  $('me-status').className = me.status[1] === 'live' ? 'live' : voice.joined ? 'online' : '';
  renderVoiceUi();
  renderCameraUi();
  syncDesktopKeys();

  $('share-long').textContent = localTrack ? 'Parar compartilhamento' : 'Compartilhar tela';
  $('share-short').textContent = localTrack ? 'Parar' : 'Compartilhar';
  $('share').classList.toggle('sharing', !!localTrack);
  $('mode-jogo').setAttribute('aria-pressed', String(shareMode === 'jogo'));
  $('mode-texto').setAttribute('aria-pressed', String(shareMode === 'texto'));
}


// "1080p · 30 fps" on the screens you watch: the receiver's own numbers, read
// every 2 s and only for screens being watched (nothing runs otherwise).
setInterval(async () => {
  for (const peer of peers.values()) {
    if (!peer.iWatch || !peer.sharing || !peer.transceiver) continue;
    let quality = '';
    (await peer.transceiver.receiver.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.frameHeight) quality = `${s.frameHeight}p · ${Math.round(s.framesPerSecond || 0)} fps`;
    });
    if (quality !== peer.quality) {
      peer.quality = quality;
      peer.screen.hint.textContent = [quality, peer.hasAudio ? '' : 'sem som'].filter(Boolean).join(' · ');
    }
  }
}, 2000);
