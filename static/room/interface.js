// ---------- interface ----------

// "00:42:10": how long you have been in the call (top bar).
function clock(since) {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return [seconds / 3600, (seconds % 3600) / 60, seconds % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
}

// A shared screen: a header (who, quality, buttons) over the picture. Not
// watched yet, the card shrinks to a row with "Assistir" (see room.html).
function buildScreen() {
  const card = el('div', 'screen');
  card.hidden = true;
  const frame = el('div', 'frame');
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.title = 'Duplo clique para tela cheia';
  video.ondblclick = () => toggleFullscreen(card);
  card.addEventListener('click', (e) => { if (!e.target.closest('button, input')) flashScreenUi(card); });
  const waiting = el('div', 'waiting');
  const waitingBox = el('div', 'waiting-text');
  const waitingText = el('span', 'waiting-title');
  const waitingHint = el('span', 'waiting-hint');
  waitingBox.append(waitingText, waitingHint);
  const watchBtn = el('button', 'btn primary', 'Assistir');
  waiting.append(waitingBox, watchBtn);
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
  const head = el('div', 'screen-head');
  const pill = el('span', 'screen-label');
  const hint = el('span', 'screen-info');
  const soundBtn = el('button', 'btn small sound-btn');
  const volume = el('input', 'volume');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.05';
  const fullBtn = el('button', 'btn small');
  fullBtn.onclick = () => toggleFullscreen(card);
  // Picture-in-Picture: a small always-on-top window, to watch while playing.
  const pipBtn = el('button', 'btn small pip-btn', 'Flutuante');
  pipBtn.title = 'Janela flutuante: fica por cima do jogo';
  pipBtn.onclick = () => togglePip(video);
  video.addEventListener('enterpictureinpicture', () => (pipBtn.textContent = 'Fechar janela'));
  video.addEventListener('leavepictureinpicture', () => (pipBtn.textContent = 'Flutuante'));
  const unwatchBtn = el('button', 'btn small');
  unwatchBtn.append(el('span', 'long', 'Parar de assistir'), el('span', 'short', 'Parar'));
  const viewers = el('span', 'screen-viewers');
  const actions = el('div', 'screen-actions');
  actions.append(soundBtn, volume, pipBtn, fullBtn, unwatchBtn);
  head.append(pill, hint, viewers, actions);
  card.append(head, frame);
  $('screens').append(card);
  return { card, video, waiting, waitingText, waitingHint, viewers, watchBtn, failed, failedText, retryBtn, pill, hint, soundBtn, volume, pipBtn, fullBtn, unwatchBtn };
}

// Top bar: one little block per seat (MAX_PEERS on the server), then "4/12".
function renderSeats(count) {
  const seats = $('seats');
  if (seats.childElementCount !== maxPeers) seats.replaceChildren(...Array.from({ length: maxPeers }, () => el('i')));
  [...seats.children].forEach((seat, i) => seat.classList.toggle('on', i < count));
  const online = $('online');
  online.replaceChildren();
  if (!count) return;
  online.append(el('b', null, String(count)), `/${maxPeers}`);
}

function peerStatus(peer) {
  switch (peer.pc.connectionState) {
    case 'failed': return ['falha na conexão', 'warn'];
    case 'disconnected': return ['conexão instável', 'warn'];
    case 'connected':
      if (peer.sharing) return ['compartilhando', 'live'];
      if (peer.watching?.length || peer.watchesMe) {
        const names = watchedNames(peer.watching ?? []);
        if (peer.watchesMe && !names.includes('você')) names.unshift('você');
        if (names.length) return [`assistindo ${names.join(', ')}`, 'online'];
      }
      if (peer.voiceIn) return peer.voiceMuted ? ['na voz · mudo', 'muted'] : ['na voz', 'online'];
      return ['na sala', 'muted'];
    default: return ['conectando…', 'muted'];
  }
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- cartão de perfil ----------

// Clicking someone opens their card, as in Discord: banner, photo, name and
// what they are doing. Yours has a shortcut to edit the profile.
const personCard = $('person-card');
let personCardFor = null;

function openPersonCard(person, anchor) {
  personCardFor = person.id;
  paintBanner($('pc-banner'), person.bannerColor, person.bannerImage);
  paintAvatar($('pc-avatar'), person.name, person.id, person.photo);
  $('pc-name').textContent = person.name;
  $('pc-status').textContent = person.self ? 'Você' : capitalize(person.status[0]);
  $('pc-status').className = `pc-status ${person.self ? '' : person.status[1]}`;
  $('pc-edit').hidden = !person.self;
  $('pc-kick').hidden = person.self || !iOwnTheRoom();
  $('pc-report').hidden = person.self;
  $('pc-kick').onclick = () => {
    if (!window.confirm(`Tirar ${person.name} da sala? Ele não consegue voltar enquanto a sala existir.`)) return;
    sendAdmin({ kick: person.id });
    closePersonCard();
  };
  renderPersonAudio(person.self ? null : peers.get(person.id));
  personCard.hidden = false;
  // Beside the clicked row or card, kept inside the window; centered on phones.
  if (mobile.matches) {
    Object.assign(personCard.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
  } else {
    const rect = anchor.getBoundingClientRect();
    const w = personCard.offsetWidth;
    const h = personCard.offsetHeight;
    const left = rect.right + 12 + w < innerWidth ? rect.right + 12 : Math.max(12, rect.left - 12 - w);
    const top = Math.min(Math.max(12, rect.top), innerHeight - h - 12);
    Object.assign(personCard.style, { left: `${left}px`, top: `${top}px`, transform: '' });
  }
  $('pc-close').focus();
}

// The person whose card is open (for "Denunciar").
function currentCardPerson() {
  if (personCard.hidden || personCardFor === null) return null;
  const peer = peers.get(personCardFor);
  return peer ? { id: peer.id, name: displayName(peer) } : null;
}

function closePersonCard() {
  personCard.hidden = true;
  personCardFor = null;
}

function clickable(node, person) {
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `Perfil de ${person.name}`);
  node.onclick = () => (personCardFor === person.id && !personCard.hidden ? closePersonCard() : openPersonCard(person, node));
  node.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      node.click();
    }
  };
}

$('pc-close').onclick = closePersonCard;
$('pc-edit').onclick = () => {
  closePersonCard();
  openProfile();
};
document.addEventListener('pointerdown', (e) => {
  if (!personCard.hidden && !personCard.contains(e.target) && !e.target.closest('[role="button"][aria-label^="Perfil de"]')) closePersonCard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !personCard.hidden) closePersonCard();
});

// Banner behind a card on the stage: the image darkened, or the color blended in.
const darkBanner = (url) => `linear-gradient(rgb(0 0 0 / .45), rgb(0 0 0 / .62)), url("${url}") center / cover no-repeat`;
function tileBackground(person) {
  if (person.bannerImage && profileGif(person.bannerImage)) return ''; // still/animated: setGif()
  if (person.bannerImage) return darkBanner(person.bannerImage);
  if (person.bannerColor) return `color-mix(in srgb, ${person.bannerColor} 42%, var(--card))`;
  return '';
}

// "Na sala" list: avatar, name and, below it, what the person is doing.
function personRow(person) {
  const li = el('li');
  const row = el('div', 'person');
  clickable(row, person);
  const avatar = el('div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  paintAvatar(avatar, person.name, person.id, person.photo);
  markSpeaker(avatar, person);
  const text = el('div', 'person-text');
  const name = el('span', 'person-name');
  name.append(el('span', 'ellipsis', person.name));
  if (person.self) name.append(el('span', 'you', 'você'));
  if (person.id === roomOwner) name.append(el('span', 'tag owner-tag', 'dono'));
  if (person.voiceIn) name.append(voiceIcon(person));
  const [status, cls] = person.status;
  text.append(name, el('span', `person-status ellipsis ${cls}`, status));
  row.append(avatar, text);
  if (person.p2p === 'off') {
    row.append(el('span', 'p2p-off', 'sem P2P'));
  } else if (person.p2p) {
    const bars = el('span', `p2p q${person.p2p}`);
    const how = person.relay ? 'Via servidor de apoio (TURN): a rede bloqueou a conexão direta' : 'Conexão direta (P2P)';
    bars.title = `${how}; ${person.p2p === 3 ? 'rápida' : person.p2p === 2 ? 'média' : 'lenta'}`;
    bars.append(el('i'), el('i'), el('i'));
    const kind = el('span', 'p2p-kind', person.relay ? 'relay' : 'direto');
    kind.title = how;
    row.append(bars, kind);
  }
  li.append(row);
  return li;
}

function personTile(person) {
  const tile = el('div', person.self ? 'tile card self' : 'tile card');
  markSpeaker(tile, person);
  clickable(tile, person);
  const background = tileBackground(person);
  if (background) tile.style.setProperty('--tile-bg', background);
  if (person.bannerImage && profileGif(person.bannerImage)) {
    // Stage cards aren't 3:1: keep the framing's focus, filled with cover.
    const gif = splitGif(person.bannerImage);
    const at = gif.size ? `${gif.x}% ${gif.y}%` : 'center';
    setGif(tile, gif.url, (url) => `linear-gradient(rgb(0 0 0 / .45), rgb(0 0 0 / .62)), url("${url}") ${at} / cover no-repeat`, 'gif-bg');
  }
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
  // Phones (docs/design/cpx-call-mobile.html): voice people as big faces with
  // a short word under the name, the others as rows ("na sala, fora da voz").
  const [shortText, shortCls] = shortStatus(person);
  tile.classList.toggle('away', !person.voiceIn);
  tile.classList.toggle('muted', !!person.voiceIn && !!person.voiceMuted);
  text.append(name, el('span', `status ${status[1]}`, status[0]), el('span', `m-status ellipsis ${shortCls}`, shortText), el('span', 'm-talk', 'falando'));
  const badge = el('span', 'mute-badge');
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = ICONS.micOff; // fixed markup
  tile.append(avatar, text, badge);
  if (person.p2p === 'off') tile.append(el('span', 'p2p-off', 'sem P2P'));
  return tile;
}

// The word under a face on phones.
function shortStatus(person) {
  const live = person.self ? !!localTrack : person.status[1] === 'live';
  if (live) return ['na tela', 'live'];
  if (person.voiceIn) return person.voiceMuted ? ['mudo', ''] : ['na voz', ''];
  if (!person.self && person.status[0] !== 'na sala') return person.status;
  return ['na sala, fora da voz', ''];
}

// `watching` false shows the "Assistir" placeholder instead of the video.
// `failedText` replaces both the video and the "Assistir" placeholder.
function showScreen(screen, { visible, watching, label, hint, waitingText = '', waitingHint = '', viewers = [], canUnwatch = false, failedText = '', sound = false }) {
  if (screen.soundBtn.isConnected) {
    screen.soundBtn.hidden = !sound;
    screen.volume.hidden = !sound;
    screen.soundBtn.textContent = soundMuted ? 'Ouvir' : 'Silenciar';
    screen.soundBtn.setAttribute('aria-pressed', String(soundMuted));
    screen.volume.value = String(soundVolume);
  }
  screen.fullBtn.hidden = !canUnwatch; // only for a screen you are watching
  // Leave theater when its picture goes away (stopped sharing, unwatched).
  if (theaterCard === screen.card && (!visible || !watching || failedText)) placeTheater(null);
  screen.fullBtn.textContent = isFullscreen(screen.card) ? 'Sair da tela cheia' : 'Tela cheia';
  screen.pipBtn.hidden = !canUnwatch || !document.pictureInPictureEnabled;
  // Close the floating window when that screen stops being watched.
  if ((!visible || !watching || failedText) && document.pictureInPictureElement === screen.video) {
    document.exitPictureInPicture().catch(() => {});
  }
  screen.card.hidden = !visible;
  screen.card.classList.toggle('watching', visible && watching && !failedText);
  screen.card.classList.toggle('idle', visible && !watching);
  screen.video.hidden = !watching || !!failedText;
  screen.waiting.hidden = watching || !!failedText;
  if (screen.failed) {
    screen.failed.hidden = !failedText;
    screen.failedText.textContent = failedText;
  }
  screen.waitingText.textContent = waitingText;
  screen.waitingHint.textContent = waitingHint;
  renderViewers(screen.viewers, viewers);
  screen.pill.textContent = label;
  screen.hint.textContent = hint;
  screen.unwatchBtn.hidden = !canUnwatch;
  if (visible && watching && screen.video.paused) screen.video.play().catch(() => {});
}

// "[L][B] 2 assistindo" in a screen's header (up to 3 faces).
function renderViewers(node, people) {
  node.hidden = people.length === 0;
  if (!people.length) return;
  const faces = el('span', 'viewer-faces');
  for (const person of people.slice(0, 3)) {
    const face = el('span', 'avatar');
    face.title = person.name;
    paintAvatar(face, person.name, person.id, person.photo);
    faces.append(face);
  }
  node.replaceChildren(faces, `${people.length} assistindo`);
  node.title = people.map((p) => p.name).join(', ');
}

function shareHint(info) {
  if (!info) return '';
  return [info.height && `${info.height}p`, info.fps && `${info.fps} fps`, info.mode].filter(Boolean).join(' · ');
}

// Names of the screens someone watches, "você" for yours.
function watchedNames(ids) {
  return ids.map((id) => (id === myId ? (localTrack ? 'você' : null) : peers.get(id)?.sharing ? displayName(peers.get(id)) : null)).filter(Boolean);
}

// Yours, in the people list: what you are doing for the room right now.
function myStatus(list) {
  if (localTrack) return ['compartilhando', 'live'];
  const watched = list.filter((p) => p.iWatch && p.sharing).map(displayName);
  if (watched.length) return [`assistindo ${watched.join(', ')}`, 'online'];
  return voice.joined ? ['na voz', 'online'] : ['na sala', ''];
}

function personOf(peer) {
  return { id: peer.id, name: displayName(peer), photo: peer.photo };
}

function refresh() {
  const list = [...peers.values()].sort((a, b) => a.id - b.id);
  const me = {
    self: true, id: myId, name: myNick, photo: myPhoto,
    status: myStatus(list),
    voiceIn: voice.joined, voiceMuted: voice.muted || voice.deafened, speaking: voice.speaking,
    camVideo: cam.track ? myCamVideo : null, camOn: !!cam.track,
    bannerColor: validBannerColor(load('bannerColor')), bannerImage: validBannerImage(load('bannerImage')),
  };
  const others = list.map((p) => ({
    id: p.id, name: displayName(p), photo: p.photo, status: peerStatus(p),
    p2p: p.pc.connectionState === 'failed' ? 'off' : p.p2p ?? 0,
    relay: !!p.relay,
    voiceIn: p.voiceIn, voiceMuted: p.voiceMuted, speaking: p.speaking,
    camVideo: camLive(p) ? p.camVideo : null, camOn: p.camOn,
    bannerColor: p.bannerColor || '', bannerImage: p.bannerImage || '',
  }));
  const people = myId === null ? [] : [me, ...others];
  // An open card follows changes (status, banner) or closes if the person left.
  const carded = people.find((p) => p.id === personCardFor);
  if (!personCard.hidden) {
    if (carded) {
      paintBanner($('pc-banner'), carded.bannerColor, carded.bannerImage);
      paintAvatar($('pc-avatar'), carded.name, carded.id, carded.photo);
      $('pc-name').textContent = carded.name;
      if (!carded.self) $('pc-status').textContent = capitalize(carded.status[0]);
      renderPersonAudio(carded.self ? null : peers.get(carded.id));
    } else {
      closePersonCard();
    }
  }

  renderSeats(people.length);
  renderPeopleGroups(people); // sala-larga.js
  $('tiles').replaceChildren(...people.map(personTile));
  $('tiles').classList.toggle('no-cams', !people.some((p) => p.camOn));
  observeTiles();

  const viewers = list.filter((p) => p.watchesMe).length;
  showScreen(localScreen, {
    visible: !!localTrack,
    watching: previewOn,
    label: 'Sua tela',
    hint: `${viewers === 0 ? 'ninguém assistindo' : viewers === 1 ? '1 pessoa assistindo' : `${viewers} pessoas assistindo`} · ${localAudio ? 'com som' : 'sem som'}${currentCaps().fps < quality.fps || currentCaps().maxHeight < quality.height ? ` · ${currentCaps().maxHeight}p ${currentCaps().fps} FPS (ajuste automático)` : ''}`,
    waitingText: 'Sua tela está indo para quem clicar em Assistir. A prévia fica escondida para poupar o PC.',
    viewers: list.filter((p) => p.watchesMe).map(personOf),
    canUnwatch: previewOn,
  });
  for (const peer of list) {
    const name = displayName(peer);
    const failed = peer.pc.connectionState === 'failed';
    showScreen(peer.screen, {
      visible: peer.sharing,
      watching: peer.iWatch,
      label: name,
      hint: failed ? '' : peer.iWatch ? [peer.quality, peer.hasAudio ? '' : 'sem som'].filter(Boolean).join(' · ') : '',
      sound: peer.iWatch && peer.hasAudio && !failed,
      waitingText: `${name} está compartilhando`,
      waitingHint: shareHint(peer.shareInfo),
      viewers: [...(peer.iWatch ? [{ id: myId, name: myNick, photo: myPhoto }] : []), ...list.filter((p) => p !== peer && p.watching?.includes(peer.id)).map(personOf)],
      canUnwatch: peer.iWatch && !failed,
      failedText: failed ? (peer.retrying ? 'Tentando conectar de novo…' : `Não foi possível conectar com ${name}`) : '',
    });
    peer.screen.retryBtn.hidden = !!peer.retrying;
    peer.screen.video.volume = soundVolume * personAudio(peer).screen;
    peer.screen.video.muted = !peer.iWatch || soundMuted;
  }
  const shown = (localTrack ? 1 : 0) + list.filter((p) => p.sharing).length;
  $('empty').hidden = shown > 0;
  $('content').classList.toggle('has-screens', shown > 0);
  $('screens').style.setProperty('--cols', shown > 2 ? 2 : 1);
  $('live').hidden = shown === 0;
  $('reconnecting').hidden = true; // the banner on the stage says it now
  renderReconnect();

  paintAvatar($('me-avatar'), myNick, myId, myPhoto);
  $('me-nick').textContent = myNick;
  $('me-status').textContent = localTrack ? 'Compartilhando'
    : !voice.joined ? 'Na sala'
      : voice.deafened ? 'Na voz · sem som' : voice.muted ? 'Na voz · mudo' : 'Na voz';
  $('me-status').className = me.status[1] === 'live' ? 'live' : voice.joined ? 'online' : '';
  broadcastWatching();
  renderVoiceUi();
  renderCameraUi();
  if (!soundPop.hidden) renderSoundpad(); // "entre na voz" hint follows the voice
  syncDesktopKeys();
  renderMobile(people);
  renderWideSide(people);
  renderRoomLock();

  $('share-long').textContent = localTrack ? 'Parar compartilhamento' : 'Compartilhar tela';
  $('share-short').textContent = localTrack ? 'Parar' : 'Compartilhar';
  $('share').classList.toggle('sharing', !!localTrack);

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

// ---------- dono da sala: trancar (#151) ----------

const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';

function renderRoomLock() {
  const button = $('lock-btn');
  button.hidden = !iOwnTheRoom();
  button.innerHTML = roomLocked ? LOCK_ICON : UNLOCK_ICON; // fixed markup
  button.setAttribute('aria-pressed', String(roomLocked));
  const label = roomLocked ? 'Destrancar a sala' : 'Trancar a sala (ninguém novo entra)';
  button.title = label;
  button.setAttribute('aria-label', label);
  $('locked-pill').hidden = !roomLocked || myId === null;
}
$('lock-btn').onclick = () => sendAdmin({ lock: !roomLocked });
