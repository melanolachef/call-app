// ---------- fotos e GIFs no chat (#177, #175) ----------

// Photos go straight to each person over a data channel of the peer
// connection ("arquivos"), never through the server, which keeps nothing.
// Before sending, a photo is redrawn (at most 1600 px, JPEG): smaller, and
// without the metadata phones put in them (location, device). A GIF goes as
// is, to keep its animation. Whoever receives checks the size, the first
// bytes (really a JPEG or a GIF) and how many arrive per minute.

const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1600;
const PHOTO_CHUNK = 16 * 1024;
const PHOTO_PER_MINUTE = 6; // from each person
const PHOTO_SEND_GAP_MS = 1500; // yours: no flooding the others
const PHOTO_BUFFER_HIGH = 1024 * 1024; // pause sending above this much queued
let lastPhotoAt = 0;

// Called by createPeer() before any offer, so the channel is part of the
// single negotiation (negotiated: both sides open it with the same id).
function attachFileChannel(peer) {
  const channel = peer.pc.createDataChannel('arquivos', { negotiated: true, id: 0 });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = PHOTO_BUFFER_HIGH / 4;
  channel.onmessage = (e) => receiveFile(peer, e.data);
  peer.files = channel;
  peer.incoming = null;
  peer.photoTimes = [];
}

function looksLike(kind, bytes) {
  if (kind === 'jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (kind === 'gif') return String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  return false;
}

async function preparePhoto(file) {
  if (file.type === 'image/gif') {
    if (file.size > PHOTO_MAX_BYTES) throw new Error('GIF grande demais (até 2 MB).');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLike('gif', bytes)) throw new Error('Esse arquivo não parece um GIF.');
    const frame = await createImageBitmap(file);
    const size = { w: frame.width, h: frame.height };
    frame.close();
    return { kind: 'gif', bytes, ...size };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Não deu para abrir essa imagem. Tente JPG, PNG ou WebP.');
  }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= PHOTO_MAX_BYTES) {
      return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
    }
  }
  throw new Error('Imagem grande demais.');
}

async function sendOver(channel, header, bytes) {
  channel.send(header);
  for (let offset = 0; offset < bytes.length; offset += PHOTO_CHUNK) {
    if (channel.readyState !== 'open') return;
    if (channel.bufferedAmount > PHOTO_BUFFER_HIGH) {
      await new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true }));
    }
    channel.send(bytes.subarray(offset, offset + PHOTO_CHUNK));
  }
}

async function sendPhoto(file) {
  if (!file || chatInput.disabled) return;
  if (!file.type.startsWith('image/')) {
    toast('Só dá para mandar imagens.');
    return;
  }
  const now = Date.now();
  if (now - lastPhotoAt < PHOTO_SEND_GAP_MS) return;
  lastPhotoAt = now;
  let photo;
  try {
    photo = await preparePhoto(file);
  } catch (err) {
    toast(err.message || 'Não deu para mandar essa imagem.', 5000);
    return;
  }
  const mime = photo.kind === 'gif' ? 'image/gif' : 'image/jpeg';
  addMessage({
    authorId: myId, name: myNick, photo: myPhoto, self: true,
    image: { url: URL.createObjectURL(new Blob([photo.bytes], { type: mime })), w: photo.w, h: photo.h, gif: photo.kind === 'gif' },
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const header = JSON.stringify({ foto: { kind: photo.kind, size: photo.bytes.length, w: photo.w, h: photo.h } });
  const missing = [];
  for (const peer of peers.values()) {
    if (peer.files?.readyState === 'open') sendOver(peer.files, header, photo.bytes);
    else missing.push(displayName(peer));
  }
  if (missing.length) {
    toast(`A imagem não chegou para ${missing.join(', ')}: sem conexão direta.`, 6000);
  }
}

function receiveFile(peer, data) {
  if (typeof data === 'string') {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const f = msg?.foto;
    const valid = f && (f.kind === 'jpeg' || f.kind === 'gif')
      && Number.isInteger(f.size) && f.size > 0 && f.size <= PHOTO_MAX_BYTES
      && Number.isInteger(f.w) && Number.isInteger(f.h) && f.w > 0 && f.h > 0 && f.w <= 10_000 && f.h <= 10_000;
    if (!valid) {
      peer.incoming = null;
      return;
    }
    const now = Date.now();
    peer.photoTimes = peer.photoTimes.filter((t) => now - t < 60_000);
    const tooMany = peer.photoTimes.length >= PHOTO_PER_MINUTE;
    if (!tooMany) peer.photoTimes.push(now);
    // Over the limit: the bytes still arrive (ordered channel), so skip them.
    peer.incoming = { ...f, skip: tooMany, parts: [], got: 0 };
    return;
  }
  const incoming = peer.incoming;
  if (!incoming || !(data instanceof ArrayBuffer)) return;
  incoming.got += data.byteLength;
  if (incoming.got > incoming.size) {
    peer.incoming = null; // more than announced: drop it
    return;
  }
  if (!incoming.skip) incoming.parts.push(data);
  if (incoming.got < incoming.size) return;
  peer.incoming = null;
  if (incoming.skip) return;
  const head = new Uint8Array(incoming.parts[0].slice(0, 6));
  if (!looksLike(incoming.kind, head)) return;
  const blob = new Blob(incoming.parts, { type: incoming.kind === 'gif' ? 'image/gif' : 'image/jpeg' });
  addMessage({
    authorId: peer.id, name: displayName(peer), photo: peer.photo,
    image: { url: URL.createObjectURL(blob), w: incoming.w, h: incoming.h, gif: incoming.kind === 'gif' },
  });
}

// ---------- jeitos de mandar: botão, colar, arrastar ----------

$('photo-btn').onclick = () => $('chat-photo-input').click();
$('chat-photo-input').onchange = () => {
  const input = $('chat-photo-input');
  const file = input.files[0];
  input.value = '';
  sendPhoto(file);
};
chatInput.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  sendPhoto(file);
});
const chatPanel = document.querySelector('.chat');
chatPanel.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) return;
  e.preventDefault();
  chatPanel.classList.add('dropping');
});
chatPanel.addEventListener('dragleave', (e) => {
  if (!chatPanel.contains(e.relatedTarget)) chatPanel.classList.remove('dropping');
});
chatPanel.addEventListener('drop', (e) => {
  chatPanel.classList.remove('dropping');
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  sendPhoto(file);
});
