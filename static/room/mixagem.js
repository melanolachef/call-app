// ---------- volume de cada pessoa ----------

// Like Discord's user volume: each person's voice (0–200%) and stream sound
// (0–100%) can be set, and their voice silenced, only for you. Saved in this
// browser by nick (there are no accounts), never sent anywhere (#113).
//
// Up to 100% the voice plays through its <audio> element, the path the
// browser's echo cancellation knows. Above that it goes through a Web Audio
// gain instead (the element stays attached but muted: Chrome only feeds a
// remote stream to Web Audio while a media element holds it).
const AUDIO_PREFS_KEY = 'peopleAudio';
const DEFAULT_PERSON_AUDIO = { voice: 1, screen: 1, muted: false };
let audioPrefs = {};
try {
  audioPrefs = JSON.parse(load(AUDIO_PREFS_KEY) || '{}') ?? {};
} catch { /* broken entry: start over */ }

function audioKey(peer) {
  return peer.nick ? peer.nick.trim().toLowerCase() : null;
}

function personAudio(peer) {
  const key = audioKey(peer);
  const saved = key ? audioPrefs[key] : peer.audioPrefs;
  return { ...DEFAULT_PERSON_AUDIO, ...saved };
}

function setPersonAudio(peer, patch) {
  const next = { ...personAudio(peer), ...patch };
  const key = audioKey(peer);
  const isDefault = next.voice === 1 && next.screen === 1 && !next.muted;
  if (key) {
    if (isDefault) delete audioPrefs[key];
    else audioPrefs[key] = next;
    save(AUDIO_PREFS_KEY, Object.keys(audioPrefs).length ? JSON.stringify(audioPrefs) : '');
  } else {
    peer.audioPrefs = next; // no nick yet: only for this visit
  }
  applyVoiceOutput();
  refresh();
}

// Above 100%: the voice through a gain node; at or below, nothing here.
function setVoiceBoost(peer, level) {
  if (level <= 1 || !voice.ctx || !peer.voiceTransceiver) {
    dropVoiceBoost(peer);
    return;
  }
  if (!peer.voiceBoost) {
    const source = voice.ctx.createMediaStreamSource(new MediaStream([peer.voiceTransceiver.receiver.track]));
    const gain = voice.ctx.createGain();
    source.connect(gain).connect(voice.ctx.destination);
    peer.voiceBoost = { source, gain };
  }
  peer.voiceBoost.gain.gain.value = level;
}

function dropVoiceBoost(peer) {
  if (!peer.voiceBoost) return;
  peer.voiceBoost.source.disconnect();
  peer.voiceBoost.gain.disconnect();
  peer.voiceBoost = null;
}

// ---------- no cartão de perfil ----------

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function renderPersonAudio(peer) {
  const box = $('pc-audio');
  box.hidden = !peer;
  if (!peer) return;
  const prefs = personAudio(peer);
  $('pc-voice-volume').value = String(prefs.voice);
  $('pc-voice-value').textContent = percent(prefs.voice);
  $('pc-voice-volume').disabled = prefs.muted;
  $('pc-screen-volume').value = String(prefs.screen);
  $('pc-screen-value').textContent = percent(prefs.screen);
  $('pc-screen-row').hidden = !peer.sharing;
  $('pc-mute').textContent = prefs.muted ? 'Voltar a ouvir a voz' : 'Silenciar a voz para mim';
  $('pc-mute').setAttribute('aria-pressed', String(prefs.muted));
}

function cardPeer() {
  return personCardFor === myId ? null : peers.get(personCardFor) ?? null;
}

$('pc-voice-volume').oninput = () => {
  const peer = cardPeer();
  if (peer) setPersonAudio(peer, { voice: Number($('pc-voice-volume').value) });
};
$('pc-screen-volume').oninput = () => {
  const peer = cardPeer();
  if (peer) setPersonAudio(peer, { screen: Number($('pc-screen-volume').value) });
};
$('pc-mute').onclick = () => {
  const peer = cardPeer();
  if (peer) setPersonAudio(peer, { muted: !personAudio(peer).muted });
};
$('pc-audio-reset').onclick = () => {
  const peer = cardPeer();
  if (peer) setPersonAudio(peer, { ...DEFAULT_PERSON_AUDIO });
};
