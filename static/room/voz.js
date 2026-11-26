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
  track: null, mix: null, ctx: null, analyser: null, speaking: false, lastLoud: 0,
  deviceId: load('micId'),
  noiseSuppression: load('noiseSuppression') !== 'off',
  volume: Math.min(1, Math.max(0, Number(load('voiceVolume') || 1))),
  ptt: load('ptt') === 'on', // push-to-talk: the mic only sends while the key is held
  pttKey: load('pttKey') || 'KeyV', // KeyboardEvent.code
  pttHeld: false,
};

// The mic sends unless muted or deafened; with push-to-talk, only while held.
function micOpen() {
  return !(voice.muted || voice.deafened) && (!voice.ptt || voice.pttHeld);
}

function applyTrackEnabled() {
  if (voice.track) voice.track.enabled = micOpen();
}

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

// What goes out to the others: the mic plus the soundpad (soundpad.js),
// mixed in Web Audio into one track. Mute and push-to-talk still close only
// the mic (track.enabled), so sounds play even with the mic muted.
function buildVoiceMix(micTrack) {
  const out = voice.ctx.createMediaStreamDestination();
  const sounds = voice.ctx.createGain();
  sounds.connect(out);
  const track = out.stream.getAudioTracks()[0];
  track.contentHint = 'speech';
  voice.mix = { out, sounds, mic: null, track };
  plugMic(micTrack);
}

function plugMic(micTrack) {
  voice.mix.mic?.disconnect();
  voice.mix.mic = voice.ctx.createMediaStreamSource(new MediaStream([micTrack]));
  voice.mix.mic.connect(voice.mix.out);
}

function dropVoiceMix() {
  if (!voice.mix) return;
  voice.mix.mic?.disconnect();
  voice.mix.sounds.disconnect();
  voice.mix.track.stop();
  voice.mix = null;
}

// Voice only flows between two people who are both in the voice channel.
function sendVoiceTo(peer) {
  const sender = peer.voiceTransceiver?.sender;
  if (!sender) return;
  const track = voice.joined && peer.voiceIn ? voice.mix.track : null;
  if (sender.track !== track) sender.replaceTrack(track).catch((err) => console.warn(err));
}

// Everyone's voice at the general volume times their own (mixagem.js).
function applyVoiceOutput() {
  peers.forEach((peer) => {
    if (!peer.voiceAudio) return;
    const prefs = personAudio(peer);
    const silenced = !voice.joined || voice.deafened || !peer.voiceIn || prefs.muted;
    const level = silenced ? 0 : voice.volume * prefs.voice;
    peer.voiceAudio.muted = silenced || level > 1; // above 100%, Web Audio plays it
    peer.voiceAudio.volume = Math.min(1, level);
    setVoiceBoost(peer, level);
    if (!silenced) peer.voiceAudio.play().catch(() => {});
  });
}

function analyserFor(track) {
  const analyser = voice.ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.source = voice.ctx.createMediaStreamSource(new MediaStream([track]));
  analyser.source.connect(analyser);
  analyser.buffer = new Float32Array(analyser.fftSize); // reused every tick
  return analyser;
}

// Audio nodes keep running on the audio thread until disconnected: every
// join/leave and every reconnect used to leave two behind (#75).
function dropAnalyser(analyser) {
  analyser?.source.disconnect();
  analyser?.disconnect();
  return null;
}

function levelOf(analyser) {
  const data = analyser.buffer;
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
  } catch (err) {
    toast(await mediaErrorMessage(err, 'microphone'), 8000);
    return;
  }
  voice.track.contentHint = 'speech';
  voice.analyser = analyserFor(voice.track);
  buildVoiceMix(voice.track);
  voice.joined = true;
  voice.muted = false;
  voice.deafened = false;
  voice.pttHeld = false;
  applyTrackEnabled(); // push-to-talk starts closed
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
  voice.pttHeld = false;
  stopSound();
  voice.track?.stop();
  voice.track = null;
  voice.analyser = dropAnalyser(voice.analyser);
  peers.forEach((peer) => (peer.voiceAnalyser = dropAnalyser(peer.voiceAnalyser)));
  voice.speaking = false;
  document.body.classList.remove('in-voice');
  chime(false);
  broadcastVoice();
  peers.forEach(sendVoiceTo);
  dropVoiceMix();
  applyVoiceOutput();
  refresh();
}

// Muting keeps sending (silence, almost free) so unmuting is instant.
function setMuted(muted) {
  if (!voice.joined) return;
  const wasSilent = voice.muted || voice.deafened;
  voice.muted = muted;
  if (!muted) voice.deafened = false; // talking again means hearing again
  applyTrackEnabled();
  // The sound follows mute, not track.enabled: push-to-talk closes the track
  // every time the key is released, and that must stay silent.
  const silent = voice.muted || voice.deafened;
  if (wasSilent !== silent) blip(silent ? 'down' : 'up');
  broadcastVoice();
  applyVoiceOutput();
  refresh();
}

function setDeafened(deafened) {
  if (!voice.joined) return;
  voice.deafened = deafened;
  applyTrackEnabled();
  blip(deafened ? 'deaf' : 'up');
  broadcastVoice();
  applyVoiceOutput();
  refresh();
}

const toggleMic = () => setMuted(!(voice.muted || voice.deafened));
$('voice-join').onclick = joinVoice;
$('voice-leave').onclick = leaveVoice;
// With push-to-talk the button is "hold to talk" (see ptt.js); a click only
// brings the mic back from muted/deafened.
const micClick = () => {
  if (!voice.ptt || voice.muted || voice.deafened) toggleMic();
};
$('mic').onclick = micClick;
$('me-mic').onclick = micClick;
$('rail-mic').onclick = micClick;
$('deafen').onclick = () => setDeafened(!voice.deafened);
$('me-deafen').onclick = () => setDeafened(!voice.deafened);
// Shortcuts like Discord's: Ctrl+Shift+M mutes the mic, Ctrl+Shift+D the
// headphones (everyone). In the Windows app they also work with a game in
// front (desktop/src/keys.rs → window.cpxDesktop).
const VOICE_SHORTCUTS = { m: () => toggleMic(), d: () => setDeafened(!voice.deafened) };
document.addEventListener('keydown', (e) => {
  const run = VOICE_SHORTCUTS[e.key.toLowerCase()];
  if (!run || !voice.joined || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
  e.preventDefault(); // Ctrl+Shift+D would bookmark every tab
  run();
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
    } else if (!peer.voiceIn && peer.voiceAnalyser) {
      peer.voiceAnalyser = dropAnalyser(peer.voiceAnalyser);
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
  for (const id of ['mic', 'me-mic', 'rail-mic']) {
    const button = $(id);
    const label = silent ? 'Ligar microfone' : 'Silenciar microfone';
    button.innerHTML = silent ? ICONS.micOff : ICONS.mic;
    button.setAttribute('aria-pressed', String(silent));
    button.setAttribute('aria-label', label);
    button.title = voice.ptt && !silent
      ? `Segure para falar (${pttKeyName()}). Ctrl+Shift+M silencia`
      : `${label} (Ctrl+Shift+M)`;
  }
  for (const id of ['deafen', 'me-deafen']) {
    const button = $(id);
    const label = voice.deafened ? 'Voltar a ouvir' : 'Silenciar todo mundo';
    button.innerHTML = voice.deafened ? ICONS.headphonesOff : ICONS.headphones;
    button.setAttribute('aria-pressed', String(voice.deafened));
    button.setAttribute('aria-label', label);
    button.title = `${label} (Ctrl+Shift+D)`;
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

// Short click so you know you muted, even with a fullscreen game in front
// (Ctrl+Shift+M): falling for mute, rising for unmute, low double for "Fone".
// Plays even when deafened: it's your own confirmation, not someone's voice.
function blip(kind) {
  if (!voice.ctx) return;
  const t = voice.ctx.currentTime;
  const notes = kind === 'down' ? [[620, 0], [440, 0.07]] : kind === 'deaf' ? [[392, 0], [294, 0.09]] : [[440, 0], [620, 0.07]];
  const gain = voice.ctx.createGain();
  gain.connect(voice.ctx.destination);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  const osc = voice.ctx.createOscillator();
  osc.type = 'triangle';
  for (const [freq, at] of notes) osc.frequency.setValueAtTime(freq, t + at);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.22);
}

// ---------- configurações de voz ----------

let previewTrack = null; // mic opened just for the meter, when not in voice
let previewAnalyser = null;
let meterTimer = null;

// Fills the voice controls with the current values (the dialog and the
// "Voz" page of the settings share them).
function renderVoiceSettings() {
  $('vs-ns').checked = voice.noiseSuppression;
  renderPttSettings();
  $('vs-volume').value = String(voice.volume);
}

async function openVoiceSettings() {
  renderVoiceSettings();
  $('voice-settings').showModal();
  await startVoicePreview();
}

// The input meter: opens the mic just for it when not in the voice.
async function startVoicePreview() {
  stopVoicePreview();
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
    applyTrackEnabled();
    dropAnalyser(voice.analyser);
    voice.analyser = analyserFor(track);
    plugMic(track); // the others keep receiving the same mixed track
  } else {
    previewTrack?.stop();
    previewTrack = track;
  }
  previewAnalyser = analyserFor(track);
}

$('voice-settings-btn').onclick = openVoiceSettings;
function stopVoicePreview() {
  clearInterval(meterTimer);
  previewTrack?.stop();
  previewTrack = null;
  previewAnalyser = null;
}
$('voice-settings').onclose = stopVoicePreview;
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

