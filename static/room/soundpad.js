// ---------- soundpad ----------

// Your own sounds, played into the voice for everyone (#112). Any audio file
// or video (.mp4, .webm…: only the sound is kept) becomes a clip of up to
// 15 s, trimmed and with its own volume. Clips live in this browser
// (IndexedDB), never on the server; "Exportar" saves one as .wav to pass on.
// Playing mixes the clip into the voice track (voz.js, buildVoiceMix), so it
// reaches the others through the voice connection that already exists.
const SOUND_MAX_SECONDS = 15;
const SOUND_MAX_COUNT = 30;
const SOUND_MAX_FILE = 80 * 1024 * 1024; // a video: only its audio is kept
const SOUND_RATE = 24000; // mono 16-bit at 24 kHz: ~720 KB for 15 s
const SOUND_GAP_MS = 400; // yours: no machine-gunning a sound
const SOUND_PEER_GAP_MS = 400; // theirs: ignore anyone faster than that
const SOUND_NAME_MAX = 24;

const soundpad = { list: [], buffers: new Map(), playing: null, lastAt: 0, preview: null, editing: null };
const soundBtn = $('sound-btn');
const soundPop = $('sound-pop');
const soundEditor = $('sound-editor');

// ---------- guardar (IndexedDB) ----------

function soundDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cpx-call', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sounds', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function soundStore(mode, action) {
  const db = await soundDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sounds', mode);
    const request = action(tx.objectStore('sounds'));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadSounds() {
  try {
    soundpad.list = (await soundStore('readonly', (store) => store.getAll())).sort((a, b) => a.at - b.at);
  } catch (err) {
    console.warn('soundpad', err); // private window or storage blocked: an empty pad
    soundpad.list = [];
  }
  renderSoundpad();
}

// ---------- áudio ----------

// The file, decoded and resampled to mono 24 kHz.
async function decodeSoundFile(file) {
  const ctx = new OfflineAudioContext(1, 1, SOUND_RATE);
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  return { rate: decoded.sampleRate, samples: mono };
}

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
  return out;
}

function toFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x7fff;
  return out;
}

function audioBufferFor(ctx, rate, samples) {
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function bufferForSound(sound) {
  let cached = soundpad.buffers.get(sound.id);
  if (!cached || cached.ctx !== voice.ctx) {
    cached = { ctx: voice.ctx, buffer: audioBufferFor(voice.ctx, sound.rate, toFloat32(new Int16Array(sound.pcm))) };
    soundpad.buffers.set(sound.id, cached);
  }
  return cached.buffer;
}

function playSound(sound) {
  if (!voice.joined || !voice.mix) {
    toast('Entre na voz para tocar sons para a sala.');
    return;
  }
  if (voice.deafened) {
    toast('Você está com o som desligado ("Fone"). Ligue para tocar sons.');
    return;
  }
  const now = Date.now();
  if (now - soundpad.lastAt < SOUND_GAP_MS) return;
  soundpad.lastAt = now;
  stopSound(); // one at a time
  const ctx = voice.ctx;
  const source = ctx.createBufferSource();
  source.buffer = bufferForSound(sound);
  const gain = ctx.createGain();
  gain.gain.value = sound.volume;
  const monitor = ctx.createGain(); // you hear it too, at your voice volume
  monitor.gain.value = voice.volume;
  source.connect(gain);
  gain.connect(voice.mix.sounds);
  gain.connect(monitor).connect(ctx.destination);
  source.onended = () => {
    if (soundpad.playing?.source === source) stopSound();
  };
  source.start();
  soundpad.playing = { source, gain, monitor, id: sound.id };
  peers.forEach((peer) => send(peer.id, { sound: sound.name.slice(0, SOUND_NAME_MAX) }));
  renderSoundpad();
}

function stopSound() {
  const playing = soundpad.playing;
  if (!playing) return;
  soundpad.playing = null;
  try {
    playing.source.stop();
  } catch { /* already over */ }
  playing.source.disconnect();
  playing.gain.disconnect();
  playing.monitor.disconnect();
  renderSoundpad();
}

// Someone else played a sound: say who and which, over the room like a
// reaction. The sound itself arrives inside their voice.
function handleSound(peer, data) {
  if (typeof data.sound !== 'string') return;
  const now = Date.now();
  if (now - (peer.lastSound ?? 0) < SOUND_PEER_GAP_MS) return;
  peer.lastSound = now;
  const name = data.sound.replace(/\s+/g, ' ').trim().slice(0, SOUND_NAME_MAX);
  floatReaction(name ? `${displayName(peer)}: ${name}` : displayName(peer), '🔊');
}

// ---------- painel ----------

function renderSoundpad() {
  const grid = $('sound-grid');
  grid.replaceChildren(...soundpad.list.map((sound) => {
    const item = el('div', 'sound-item');
    const play = el('button', 'sound-play ellipsis', sound.name);
    play.type = 'button';
    play.title = `Tocar "${sound.name}" para a sala`;
    play.classList.toggle('playing', soundpad.playing?.id === sound.id);
    play.onclick = () => (soundpad.playing?.id === sound.id ? stopSound() : playSound(sound));
    const edit = el('button', 'sound-edit');
    edit.type = 'button';
    edit.title = `Editar "${sound.name}"`;
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
    edit.onclick = () => openSoundEditor(sound);
    item.append(play, edit);
    return item;
  }));
  $('sound-empty').hidden = soundpad.list.length > 0;
  $('sound-stop').disabled = !soundpad.playing;
  $('sound-add').disabled = soundpad.list.length >= SOUND_MAX_COUNT;
  $('sound-hint').textContent = voice.joined
    ? `${soundpad.list.length}/${SOUND_MAX_COUNT} · ficam só neste navegador`
    : 'Entre na voz para a sala ouvir.';
  soundBtn.classList.toggle('playing', !!soundpad.playing);
}

function setSoundPicker(open) {
  soundPop.hidden = !open;
  soundBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  renderSoundpad();
  const rect = soundBtn.getBoundingClientRect();
  const width = soundPop.offsetWidth;
  soundPop.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8)}px`;
  soundPop.style.bottom = `${innerHeight - rect.top + 10}px`;
}

soundBtn.onclick = () => setSoundPicker(soundPop.hidden);
$('sound-stop').onclick = stopSound;
$('sound-add').onclick = () => $('sound-file').click();
document.addEventListener('pointerdown', (e) => {
  if (!soundPop.hidden && !soundPop.contains(e.target) && !soundBtn.contains(e.target) && !soundEditor.open) setSoundPicker(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !soundPop.hidden && !soundEditor.open) {
    setSoundPicker(false);
    soundBtn.focus();
  }
});

$('sound-file').onchange = async () => {
  const input = $('sound-file');
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > SOUND_MAX_FILE) {
    toast('Arquivo grande demais. Corte antes ou use um trecho menor (até 80 MB).', 6000);
    return;
  }
  let decoded;
  try {
    decoded = await decodeSoundFile(file);
  } catch {
    toast('Não deu para ler o som desse arquivo. Tente .mp3, .wav, .ogg, .m4a ou .mp4.', 6000);
    return;
  }
  if (!decoded.samples.length) {
    toast('Esse arquivo não tem som.');
    return;
  }
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, SOUND_NAME_MAX) || 'Som';
  openSoundEditor(null, { name, ...decoded });
};

// ---------- editor: nome, trecho, volume ----------

function fmtSeconds(value) {
  return `${value.toFixed(1).replace('.', ',')} s`;
}

function editorRange() {
  const start = Number($('se-start').value);
  const end = Number($('se-end').value);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function drawWave() {
  const { samples, rate } = soundpad.editing;
  const canvas = $('se-wave');
  const ratio = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const g = canvas.getContext('2d');
  const { width, height } = canvas;
  const { start, end } = editorRange();
  const duration = samples.length / rate;
  g.clearRect(0, 0, width, height);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--raised-2');
  g.fillRect((start / duration) * width, 0, ((end - start) / duration) * width, height);
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x++) {
    let peak = 0;
    for (let i = x * step; i < (x + 1) * step && i < samples.length; i += 4) peak = Math.max(peak, Math.abs(samples[i]));
    const t = (x / width) * duration;
    g.fillStyle = t >= start && t <= end ? css.getPropertyValue('--text') : css.getPropertyValue('--faint');
    const h = Math.max(1, peak * height);
    g.fillRect(x, (height - h) / 2, 1, h);
  }
}

function updateEditor(changed) {
  const editing = soundpad.editing;
  const duration = editing.samples.length / editing.rate;
  let start = Number($('se-start').value);
  let end = Number($('se-end').value);
  // Keep the clip between 0,1 s and 15 s, moving the other handle if needed.
  if (end - start > SOUND_MAX_SECONDS) {
    if (changed === 'start') end = start + SOUND_MAX_SECONDS; else start = end - SOUND_MAX_SECONDS;
  }
  if (end - start < 0.1) {
    if (changed === 'start') start = Math.max(0, end - 0.1); else end = Math.min(duration, start + 0.1);
  }
  $('se-start').value = String(start);
  $('se-end').value = String(end);
  $('se-start-value').textContent = fmtSeconds(start);
  $('se-end-value').textContent = fmtSeconds(end);
  $('se-length').textContent = fmtSeconds(end - start);
  $('se-volume-value').textContent = `${Math.round(Number($('se-volume').value) * 100)}%`;
  drawWave();
}

function openSoundEditor(sound, fresh) {
  stopPreview();
  const editing = sound
    ? { id: sound.id, name: sound.name, rate: sound.rate, samples: toFloat32(new Int16Array(sound.pcm)), volume: sound.volume }
    : { id: null, name: fresh.name, rate: fresh.rate, samples: fresh.samples, volume: 1 };
  soundpad.editing = editing;
  const duration = editing.samples.length / editing.rate;
  $('se-title').textContent = sound ? 'Editar som' : 'Novo som';
  $('se-name').value = editing.name;
  for (const id of ['se-start', 'se-end']) {
    $(id).max = String(duration);
    $(id).step = '0.05';
  }
  $('se-start').value = '0';
  $('se-end').value = String(Math.min(duration, SOUND_MAX_SECONDS));
  $('se-volume').value = String(editing.volume);
  $('se-delete').hidden = !sound;
  $('se-export').hidden = !sound;
  $('se-note').textContent = duration > SOUND_MAX_SECONDS
    ? `O arquivo tem ${fmtSeconds(duration)}: escolha um trecho de até ${SOUND_MAX_SECONDS} s.`
    : 'Arraste para cortar o começo e o fim.';
  soundEditor.showModal();
  updateEditor();
}

function stopPreview() {
  if (!soundpad.preview) return;
  try {
    soundpad.preview.source.stop();
  } catch { /* already over */ }
  soundpad.preview.source.disconnect();
  soundpad.preview.gain.disconnect();
  soundpad.preview = null;
  $('se-preview').textContent = 'Ouvir';
}

// "Ouvir": only for you, even outside the voice.
async function previewSound() {
  if (soundpad.preview) {
    stopPreview();
    return;
  }
  voice.ctx ??= new AudioContext(); // created on this click, so it may play
  await voice.ctx.resume();
  const { samples, rate } = soundpad.editing;
  const { start, end } = editorRange();
  const clip = samples.subarray(Math.floor(start * rate), Math.floor(end * rate));
  const source = voice.ctx.createBufferSource();
  source.buffer = audioBufferFor(voice.ctx, rate, clip);
  const gain = voice.ctx.createGain();
  gain.gain.value = Number($('se-volume').value);
  source.connect(gain).connect(voice.ctx.destination);
  source.onended = () => {
    if (soundpad.preview?.source === source) stopPreview();
  };
  source.start();
  soundpad.preview = { source, gain };
  $('se-preview').textContent = 'Parar';
}

async function saveSound() {
  const editing = soundpad.editing;
  const { start, end } = editorRange();
  const clip = editing.samples.subarray(Math.floor(start * editing.rate), Math.floor(end * editing.rate));
  const sound = {
    id: editing.id ?? `${Date.now()}-${randomChars(6, 'abcdefghijklmnopqrstuvwxyz0123456789')}`,
    name: $('se-name').value.replace(/\s+/g, ' ').trim().slice(0, SOUND_NAME_MAX) || 'Som',
    rate: editing.rate,
    pcm: toInt16(clip).buffer,
    volume: Number($('se-volume').value),
    at: soundpad.list.find((s) => s.id === editing.id)?.at ?? Date.now(),
  };
  try {
    await soundStore('readwrite', (store) => store.put(sound));
  } catch {
    toast('Não deu para guardar o som neste navegador (armazenamento cheio ou bloqueado).', 6000);
    return;
  }
  soundpad.buffers.delete(sound.id);
  soundEditor.close();
  await loadSounds();
}

async function deleteSound() {
  const editing = soundpad.editing;
  if (!editing?.id || !window.confirm(`Apagar o som "${editing.name}"?`)) return;
  if (soundpad.playing?.id === editing.id) stopSound();
  await soundStore('readwrite', (store) => store.delete(editing.id));
  soundpad.buffers.delete(editing.id);
  soundEditor.close();
  await loadSounds();
}

// The saved clip as a .wav, to pass to a friend (they add it with "Adicionar").
function exportSound() {
  const sound = soundpad.list.find((s) => s.id === soundpad.editing?.id);
  if (!sound) return;
  const pcm = new Uint8Array(sound.pcm);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset, value) => [...value].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sound.rate, true);
  header.setUint32(28, sound.rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.length, true);
  const url = URL.createObjectURL(new Blob([header, pcm], { type: 'audio/wav' }));
  const link = el('a');
  link.href = url;
  link.download = `${sound.name}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$('se-start').oninput = () => updateEditor('start');
$('se-end').oninput = () => updateEditor('end');
$('se-volume').oninput = () => updateEditor();
$('se-preview').onclick = previewSound;
$('se-save').onclick = saveSound;
$('se-delete').onclick = deleteSound;
$('se-export').onclick = exportSound;
$('se-cancel').onclick = () => soundEditor.close();
soundEditor.addEventListener('close', () => {
  stopPreview();
  soundpad.editing = null;
});

loadSounds();
