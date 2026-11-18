// ---------- WebRTC ----------

// Only what we show, validated: "720p · 30 fps · Jogo".
function cleanShareInfo(data) {
  const height = Number.isInteger(data.height) && data.height > 0 && data.height <= 4320 ? data.height : null;
  const fps = Number.isInteger(data.fps) && data.fps > 0 && data.fps <= 240 ? data.fps : null;
  const mode = data.mode === 'texto' ? 'Nitidez' : data.mode === 'jogo' ? 'Fluidez' : null;
  return { height, fps, mode };
}

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = {
    id, nick: '', photo: '', pc, transceiver: null, audioTransceiver: null, voiceTransceiver: null,
    camTransceiver: null, camOn: false, camWantsMe: false, iWantCam: false, camVideo: buildCamVideo(),
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
    if (pc.connectionState === 'connected') { // encodings exist now
      tuneSender(peer);
      tuneCamSender(peer);
    }
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
    // ...and a fourth for the camera, filled only for those who see your card.
    const camTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver, camTransceiver);
    enqueue(peer, async () => {
      // Their profile says what they encode well; give up waiting after 3s.
      await Promise.race([peer.profileKnown, new Promise((r) => setTimeout(r, 3000))]);
      preferCodecs(transceiver, peer);
      preferCodecs(camTransceiver, peer);
      await pc.setLocalDescription(); // creates the offer implicitly
      send(id, { description: pc.localDescription });
    });
  }

  send(id, profileMsg());
  sendBannerImage(id);
  if (localTrack) send(id, shareInfo());
  const watching = myWatching();
  if (watching.length) send(id, { watching });
  if (voice.joined) send(id, { voice: voiceState() });
  if (cam.track) send(id, { camera: true });
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

function attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver, camTransceiver) {
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
  if (camTransceiver) attachCamera(peer, camTransceiver); // absent with someone on an older version
}

async function handleSignal(peer, data) {
  const { pc } = peer;
  if (data.description) {
    await pc.setRemoteDescription(tuneDescription(data.description));
    if (data.description.type === 'offer') {
      // Transceivers created from a remote offer default to "recvonly";
      // switch them to "sendrecv" so we can share our screen back later.
      // In m-line order: screen, its sound, voice, camera.
      const [transceiver, camTransceiver] = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video');
      const [audioTransceiver, voiceTransceiver] = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'audio');
      for (const t of [transceiver, audioTransceiver, voiceTransceiver, camTransceiver]) {
        if (t) t.direction = 'sendrecv';
      }
      preferCodecs(transceiver, peer); // their profile arrived before the offer
      if (camTransceiver) preferCodecs(camTransceiver, peer);
      await pc.setLocalDescription(); // creates the answer implicitly
      send(peer.id, { description: pc.localDescription });
      attachTransceiver(peer, transceiver, audioTransceiver, voiceTransceiver, camTransceiver);
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  } else if ('sharing' in data) {
    const started = !!data.sharing && !peer.sharing;
    peer.sharing = !!data.sharing;
    peer.hasAudio = peer.sharing && !!data.audio;
    peer.shareInfo = peer.sharing ? cleanShareInfo(data) : null;
    if (!peer.sharing) peer.iWatch = false; // a new share starts unwatched
    if (started) {
      addSystem(`${displayName(peer)} começou a compartilhar a tela`);
      notify(`${displayName(peer)} começou a compartilhar a tela`, `Sala ${displayRoomName(roomId)}`, `share-${peer.id}`);
    }
    refresh();
  } else if ('chat' in data) {
    const text = cleanChat(data.chat);
    if (text) addMessage({ authorId: peer.id, name: displayName(peer), photo: peer.photo, text });
  } else if ('reaction' in data) {
    handleReaction(peer, data);
  } else if ('sound' in data) {
    handleSound(peer, data);
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
  } else if ('bannerImage' in data) {
    peer.bannerImage = validBannerImage(data.bannerImage);
    refresh();
  } else if ('camera' in data) {
    peer.camOn = !!data.camera;
    updateCamWants();
    refresh();
  } else if ('camWatch' in data) {
    peer.camWantsMe = !!data.camWatch;
    sendCameraTo(peer);
  } else if ('restart' in data) {
    if (myId > peer.id) restartIce(peer); // they asked us to redo the connection
  } else if ('watching' in data) {
    peer.watching = Array.isArray(data.watching)
      ? data.watching.filter((id) => Number.isInteger(id)).slice(0, 16)
      : [];
    refresh();
  } else if ('watch' in data) {
    // Ignore a request that crossed with us stopping the share.
    const viewersBefore = viewerCount();
    peer.watchesMe = !!data.watch && !!localTrack;
    sendScreenTo(peer);
    // Crossing 3 viewers changes the Jogo budget for everyone watching.
    if ((viewersBefore >= 3) !== (viewerCount() >= 3)) retune();
    else refresh();
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
  peer.bannerColor = validBannerColor(data.banner);
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

