'use strict';

// Shared by the lobby and the room: small DOM helpers, browser storage, the
// profile (nick + photo) and its dialog, the toast and the list of rooms you
// have been in. Nothing here talks to the server.

const AVATAR_COLORS = ['#2E3A5C', '#5C3B3B', '#3B5C47', '#4A3B5C', '#5C4F3B', '#3B525C'];
const MAX_PHOTO = 40_000; // photos travel inside signaling messages (64 KB limit on the server)

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function load(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

// Returns false when the browser refused (storage full or blocked).
function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
    return true;
  } catch {
    return false; // private mode: keep it in memory
  }
}

// ---------- perfil ----------

function cleanNick(value) {
  return Array.from(String(value ?? '').trim()).slice(0, 32).join('');
}

// GIFs (chat, photo, banner) come only from the GIF service's CDN.
const GIF_HOSTS = ['klipy.com', 'klipy.co'];

function gifUrlOk(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && GIF_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

// A GIF as photo or banner: an https URL on the GIF service, made only of
// characters that are safe inside CSS url("").
// An optional "#p=x,y,size" keeps how it was framed in the cropper (see
// cropGif): background position in % and width in % of the box.
const GIF_CROP = /#p=(\d{1,3}(?:\.\d)?),(\d{1,3}(?:\.\d)?),(\d{1,5}(?:\.\d)?)$/;

function profileGif(value) {
  return value.length <= 340 && /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~/-]+\.gif(#p=[0-9.,]+)?$/.test(value) &&
    (!value.includes('#') || GIF_CROP.test(value)) && gifUrlOk(value);
}

// "https://….gif#p=20,35,160" -> { url, x: 20, y: 35, size: 160 } (no crop: nulls).
function splitGif(value) {
  const match = value.match(GIF_CROP);
  const url = value.replace(/#.*$/, '');
  if (!match) return { url, x: null, y: null, size: null };
  const [x, y, size] = match.slice(1).map(Number);
  return { url, x: Math.min(100, x), y: Math.min(100, y), size: Math.max(100, size) };
}

// Where a GIF is framed inside its box (inline styles; '' = the CSS default).
function frameGif(node, gif) {
  node.style.backgroundSize = gif?.size ? `${gif.size}% auto` : '';
  node.style.backgroundPosition = gif?.size ? `${gif.x}% ${gif.y}%` : '';
}

// Inline images, or a GIF from the GIF service. Any other remote URL would
// let a participant track everyone else's IP when their browser fetches it.
function validPhoto(value) {
  if (typeof value !== 'string') return '';
  if (profileGif(value)) return value;
  return value.length <= MAX_PHOTO &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // One letter, as in the design; two only for two-word names ("Ana Paula" → AP).
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0] ?? '?').slice(0, 1);
  return chars.join('').toUpperCase();
}

// ---------- GIFs parados ----------

// A GIF as photo or banner moves only when someone looks at it: on hover and
// in the open profile card or dialog (common.css). Elsewhere its first frame
// stands still, so a room full of animated avatars doesn't keep the GPU busy
// while people game. The first frame is drawn once per GIF on a canvas (the
// GIF service allows it: CORS *) and kept in memory.
const GIF_STILL_MAX = 600; // px wide: enough for a banner
const gifStills = new Map(); // url -> Promise<data URL, or '' if it failed>

function gifStill(url) {
  if (!gifStills.has(url)) {
    gifStills.set(url, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        try {
          const scale = Math.min(1, GIF_STILL_MAX / img.naturalWidth);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          // For an animated image, drawImage uses its first frame.
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/webp', 0.85));
        } catch {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = url;
    }));
  }
  return gifStills.get(url);
}

// Puts a GIF on `node` as two CSS variables, `--{name}-still` and
// `--{name}-anim`, marked by `data-{name}`; the CSS picks one. `format` turns a
// URL into the CSS value. If the still can't be made, it just animates.
function setGif(node, url, format, name = 'gif') {
  const key = name === 'gif' ? 'gif' : 'gifBg';
  if (!url) {
    delete node.dataset[key];
    node.style.removeProperty(`--${name}-still`);
    node.style.removeProperty(`--${name}-anim`);
    return;
  }
  if (node.dataset[key] === url) return;
  node.dataset[key] = url;
  node.style.setProperty(`--${name}-anim`, format(url));
  node.style.removeProperty(`--${name}-still`);
  gifStill(url).then((still) => {
    if (node.dataset[key] === url) node.style.setProperty(`--${name}-still`, format(still || url));
  });
}

function paintAvatar(node, name, id, photo) {
  node.textContent = photo ? '' : initials(name || '?');
  // Safe inside url(""): validPhoto() only lets base64 or plain URL characters through.
  // Without a photo, the CSS grey gradient shows.
  const gif = photo && profileGif(photo) ? splitGif(photo) : null;
  setGif(node, gif?.url || '', (url) => `url("${url}")`);
  frameGif(node, gif);
  node.style.backgroundImage = photo && !gif ? `url("${photo}")` : '';
}

// ---------- banner (como no Discord) ----------

// A color, or an image cut to 3:1. Like the photo, it lives in this browser
// and goes to the others through the signaling relay; the image travels in a
// message of its own, so photo + banner never get near the 64 KB limit.
const MAX_BANNER_IMAGE = 30_000;
const BANNER_COLORS = ['#0A84FF', '#5E5CE6', '#BF5AF2', '#FF375F', '#FF9F0A', '#30D158', '#64D2FF', '#636366'];

function validBannerColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '';
}

function validBannerImage(value) {
  if (typeof value !== 'string') return '';
  if (profileGif(value)) return value;
  return value.length <= MAX_BANNER_IMAGE &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

// Image first, then color, else the default gradient from the CSS.
function paintBanner(node, color, image) {
  // Safe inside url(""): validBannerImage() only lets base64 or plain URL characters through.
  const gif = image && profileGif(image) ? splitGif(image) : null;
  setGif(node, gif?.url || '', (url) => `url("${url}")`);
  frameGif(node, gif);
  node.style.backgroundImage = image && !gif ? `url("${image}")` : color ? 'none' : '';
  node.style.backgroundColor = color || '';
}

// ---------- recorte de imagem (foto e banner) ----------

// Drag to place, zoom with the slider, the mouse wheel or two fingers; a
// rule-of-thirds grid helps to frame. Everything happens on a canvas in this
// browser; only the small JPEG that comes out is kept.
const CROP_STAGE = 320;
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="profile" class="profile-dialog" aria-labelledby="profile-title">
    <form id="profile-form">
      <div class="banner" id="preview-banner">
        <button type="button" class="banner-btn" id="banner-edit" title="Imagem do banner" aria-label="Escolher imagem do banner">${ICON_PENCIL}</button>
      </div>
      <div class="dialog-body">
        <div class="avatar-row">
          <button type="button" class="avatar-btn" id="photo-change" title="Trocar foto" aria-label="Trocar foto">
            <span class="avatar big" id="preview-avatar" aria-hidden="true"></span>
            <span class="avatar-badge" aria-hidden="true">${ICON_CAMERA}</span>
          </button>
          <button type="button" class="btn small" id="photo-pick">Adicionar foto</button>
          <button type="button" class="btn small" id="photo-gif" hidden>GIF</button>
          <button type="button" class="btn small" id="photo-remove">Remover</button>
          <input type="file" id="photo-input" accept="image/*" hidden>
        </div>
        <div class="heading">
          <h2 id="profile-title">Como seus amigos vão te ver?</h2>
          <span class="muted">Nick, foto e banner aparecem só para quem está na sala.</span>
        </div>
        <label class="field">
          <span class="muted">Nick</span>
          <input id="nick-input" maxlength="32" autocomplete="nickname" required>
        </label>
        <div class="field">
          <span class="muted">Banner</span>
          <div class="swatches" id="banner-colors" role="group" aria-label="Cor do banner"></div>
          <input type="file" id="banner-input" accept="image/*" hidden>
        </div>
        <button class="btn small primary" id="profile-submit">Salvar</button>
        <button type="button" class="btn small" id="open-appearance">Personalizar aparência</button>
      </div>
    </form>
  </dialog>
  <dialog id="cropper" aria-labelledby="crop-title">
    <div class="dialog-body">
      <div class="heading">
        <h2 id="crop-title">Ajustar foto</h2>
        <span class="muted">Arraste para posicionar e use o zoom.</span>
      </div>
      <div class="crop-stage" id="crop-stage" tabindex="0" aria-label="Imagem: arraste ou use as setas; + e − para zoom">
        <canvas id="crop-canvas"></canvas>
        <div class="crop-frame" id="crop-frame"></div>
      </div>
      <div class="crop-zoom">
        <button type="button" class="icon-btn" id="crop-out" aria-label="Diminuir zoom">${ICON_MINUS}</button>
        <input type="range" id="crop-zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom">
        <button type="button" class="icon-btn" id="crop-in" aria-label="Aumentar zoom">${ICON_PLUS}</button>
      </div>
      <div class="actions">
        <button type="button" class="btn small" id="crop-cancel">Cancelar</button>
        <button type="button" class="btn small primary" id="crop-apply">Aplicar</button>
      </div>
    </div>
  </dialog>
  <dialog id="gif-picker" aria-labelledby="gp-title">
    <div class="dialog-body">
      <div class="heading">
        <h2 id="gp-title">Escolher GIF</h2>
        <span class="muted" id="gp-hint"></span>
      </div>
      <input class="input gif-search" id="gp-search" maxlength="50" placeholder="Buscar GIFs" autocomplete="off" aria-label="Buscar GIFs">
      <div class="gif-grid" id="gp-grid"></div>
      <p class="gif-status" id="gp-status" role="status"></p>
      <button type="button" class="btn small ghost" id="gp-more" hidden>Mais</button>
      <div class="gp-foot">
        <span class="gif-credit">via KLIPY</span>
        <button type="button" class="btn small" id="gp-cancel">Cancelar</button>
      </div>
    </div>
  </dialog>
  <div class="toast" id="toast" role="status" hidden></div>
`);

const crop = { bitmap: null, zoom: 1, x: 0, y: 0, frame: null, opts: null, resolve: null, pointers: new Map(), pinch: null };

function cropScale() {
  const { bitmap, frame } = crop;
  return Math.max(frame.w / bitmap.width, frame.h / bitmap.height) * crop.zoom;
}

// The image always covers the frame: no empty corners in the result.
function clampCrop() {
  const s = cropScale();
  const { frame } = crop;
  crop.x = Math.min(frame.x, Math.max(frame.x + frame.w - crop.bitmap.width * s, crop.x));
  crop.y = Math.min(frame.y, Math.max(frame.y + frame.h - crop.bitmap.height * s, crop.y));
}

function drawCrop() {
  const canvas = $('crop-canvas');
  const dpr = devicePixelRatio || 1;
  canvas.width = CROP_STAGE * dpr;
  canvas.height = CROP_STAGE * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CROP_STAGE, CROP_STAGE);
  const s = cropScale();
  ctx.drawImage(crop.bitmap, crop.x, crop.y, crop.bitmap.width * s, crop.bitmap.height * s);
  $('crop-zoom').value = String(crop.zoom);
}

// Zooms keeping the point (cx, cy) of the stage still (the frame's center by default).
function setCropZoom(zoom, cx = crop.frame.x + crop.frame.w / 2, cy = crop.frame.y + crop.frame.h / 2) {
  const next = Math.min(4, Math.max(1, zoom));
  const ratio = next / crop.zoom;
  crop.x = cx - (cx - crop.x) * ratio;
  crop.y = cy - (cy - crop.y) * ratio;
  crop.zoom = next;
  clampCrop();
  drawCrop();
}

function stagePoint(e) {
  const rect = $('crop-stage').getBoundingClientRect();
  return { x: (e.clientX - rect.left) * (CROP_STAGE / rect.width), y: (e.clientY - rect.top) * (CROP_STAGE / rect.height) };
}

const cropStage = $('crop-stage');
cropStage.onpointerdown = (e) => {
  cropStage.setPointerCapture(e.pointerId);
  crop.pointers.set(e.pointerId, stagePoint(e));
  cropStage.classList.add('dragging');
  if (crop.pointers.size === 2) {
    const [a, b] = [...crop.pointers.values()];
    crop.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: crop.zoom };
  }
};
cropStage.onpointermove = (e) => {
  const last = crop.pointers.get(e.pointerId);
  if (!last) return;
  const now = stagePoint(e);
  crop.pointers.set(e.pointerId, now);
  if (crop.pointers.size === 2 && crop.pinch) { // two fingers: zoom around their middle
    const [a, b] = [...crop.pointers.values()];
    setCropZoom(crop.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / crop.pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  crop.x += now.x - last.x;
  crop.y += now.y - last.y;
  clampCrop();
  drawCrop();
};
cropStage.onpointerup = cropStage.onpointercancel = (e) => {
  crop.pointers.delete(e.pointerId);
  if (crop.pointers.size < 2) crop.pinch = null;
  if (!crop.pointers.size) cropStage.classList.remove('dragging');
};
cropStage.onwheel = (e) => {
  e.preventDefault();
  const p = stagePoint(e);
  setCropZoom(crop.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
};
cropStage.onkeydown = (e) => {
  const step = e.shiftKey ? 30 : 8;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key]) {
    crop.x += moves[e.key][0];
    crop.y += moves[e.key][1];
    clampCrop();
    drawCrop();
  } else if (e.key === '+' || e.key === '=') {
    setCropZoom(crop.zoom * 1.1);
  } else if (e.key === '-') {
    setCropZoom(crop.zoom / 1.1);
  } else {
    return;
  }
  e.preventDefault();
};
$('crop-zoom').oninput = () => setCropZoom(Number($('crop-zoom').value));
$('crop-in').onclick = () => setCropZoom(crop.zoom * 1.2);
$('crop-out').onclick = () => setCropZoom(crop.zoom / 1.2);

function finishCrop(result) {
  const { resolve } = crop;
  crop.resolve = null;
  crop.bitmap?.close();
  crop.bitmap = null;
  if ($('cropper').open) $('cropper').close();
  resolve?.(result);
}

$('crop-cancel').onclick = () => finishCrop(null);
$('cropper').oncancel = (e) => {
  e.preventDefault(); // Esc: cancel the crop, keep the profile dialog open
  finishCrop(null);
};
$('crop-apply').onclick = () => {
  const { opts, frame } = crop;
  const s = cropScale();
  if (opts.gif) {
    // The GIF stays animated: keep where its first frame was placed, as CSS
    // background position (%) and width (% of the box).
    const shownW = crop.bitmap.width * s;
    const shownH = crop.bitmap.height * s;
    const visW = frame.w / shownW;
    const visH = frame.h / shownH;
    const pos = (start, vis) => (vis < 0.999 ? Math.min(100, Math.max(0, (start / (1 - vis)) * 100)) : 50);
    const x = pos((frame.x - crop.x) / shownW, visW);
    const y = pos((frame.y - crop.y) / shownH, visH);
    finishCrop(`${opts.gif}#p=${x.toFixed(1)},${y.toFixed(1)},${(100 / visW).toFixed(1)}`);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1C1C1E'; // JPEG has no transparency
  ctx.fillRect(0, 0, opts.width, opts.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.bitmap, (frame.x - crop.x) / s, (frame.y - crop.y) / s, frame.w / s, frame.h / s, 0, 0, opts.width, opts.height);
  for (const quality of [0.86, 0.75, 0.62, 0.5, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= opts.max) {
      finishCrop(url);
      return;
    }
  }
  toast('Essa imagem ficou pesada demais. Tente outra.');
};

// Opens the cropper for `file`; resolves to a JPEG data URL, or null if cancelled.
// opts: { title, aspect (width/height), round, width, height, max (characters) }
async function cropImage(file, opts) {
  const bitmap = await createImageBitmap(file); // throws for files that aren't images (a GIF: its first frame)
  crop.bitmap = bitmap;
  crop.opts = opts;
  crop.zoom = 1;
  const w = opts.aspect >= 1 ? CROP_STAGE - 40 : (CROP_STAGE - 40) * opts.aspect;
  const h = w / opts.aspect;
  crop.frame = { x: (CROP_STAGE - w) / 2, y: (CROP_STAGE - h) / 2, w, h };
  const frameEl = $('crop-frame');
  Object.assign(frameEl.style, { left: `${(crop.frame.x / CROP_STAGE) * 100}%`, top: `${(crop.frame.y / CROP_STAGE) * 100}%`, width: `${(w / CROP_STAGE) * 100}%`, height: `${(h / CROP_STAGE) * 100}%` });
  frameEl.classList.toggle('round', !!opts.round);
  const s = cropScale(); // centered
  crop.x = crop.frame.x + (w - bitmap.width * s) / 2;
  crop.y = crop.frame.y + (h - bitmap.height * s) / 2;
  $('crop-title').textContent = opts.title;
  drawCrop();
  $('cropper').showModal();
  cropStage.focus();
  return new Promise((resolve) => (crop.resolve = resolve));
}

// ---------- diálogo de perfil ----------

const PHOTO_CROP = { title: 'Ajustar foto', aspect: 1, round: true, width: 192, height: 192, max: MAX_PHOTO };
const BANNER_CROP = { title: 'Ajustar banner', aspect: 3, round: false, width: 600, height: 200, max: MAX_BANNER_IMAGE };

let draftPhoto = ''; // what the profile dialog is editing, saved only on "Salvar"
let draftBannerColor = '';
let draftBannerImage = '';
let profileColorId = 1;
let profileRequired = false;
let profileOnSave = null;

// Opens the profile dialog; `onSave(nick, photo)` runs after everything is stored.
function openProfileDialog({ title, submitLabel, required = false, nick, photo, colorId, onSave }) {
  $('profile-title').textContent = title;
  $('profile-submit').textContent = submitLabel;
  $('nick-input').value = nick;
  draftPhoto = photo;
  draftBannerColor = validBannerColor(load('bannerColor'));
  draftBannerImage = validBannerImage(load('bannerImage'));
  profileColorId = colorId ?? 1;
  profileRequired = required;
  profileOnSave = onSave;
  updateProfilePreview();
  $('profile').showModal();
}

function bannerSwatch(color, label) {
  const button = el('button', 'swatch');
  button.type = 'button';
  button.style.background = color;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(!draftBannerImage && draftBannerColor.toLowerCase() === color.toLowerCase()));
  button.onclick = () => {
    draftBannerColor = color;
    draftBannerImage = '';
    updateProfilePreview();
  };
  return button;
}

function renderBannerChoices() {
  const isPreset = BANNER_COLORS.some((c) => c.toLowerCase() === draftBannerColor.toLowerCase());
  // Free color: the picker stays open while dragging (only the preview changes);
  // the buttons are rebuilt once it closes.
  const custom = el('label', 'swatch swatch-custom');
  custom.title = 'Outra cor';
  custom.setAttribute('aria-pressed', String(!draftBannerImage && !!draftBannerColor && !isPreset));
  if (draftBannerColor && !isPreset) custom.style.background = draftBannerColor;
  const input = el('input');
  input.type = 'color';
  input.value = draftBannerColor || '#0A84FF';
  input.setAttribute('aria-label', 'Escolher outra cor de banner');
  input.oninput = () => {
    draftBannerColor = input.value;
    draftBannerImage = '';
    custom.style.background = input.value;
    paintBanner($('preview-banner'), draftBannerColor, '');
  };
  input.onchange = updateProfilePreview;
  custom.append(input);
  const image = el('button', 'swatch swatch-image');
  image.type = 'button';
  image.title = 'Imagem';
  image.setAttribute('aria-label', 'Usar uma imagem no banner');
  image.setAttribute('aria-pressed', String(!!draftBannerImage));
  if (draftBannerImage) image.style.backgroundImage = `url("${draftBannerImage}")`;
  else image.innerHTML = ICON_PLUS;
  image.onclick = () => $('banner-input').click();
  const choices = [...BANNER_COLORS.map((c) => bannerSwatch(c, 'Cor do banner')), custom, image];
  if (gifsEnabled) {
    const gif = el('button', 'swatch swatch-gif', 'GIF');
    gif.type = 'button';
    gif.title = 'GIF';
    gif.setAttribute('aria-label', 'Usar um GIF no banner');
    gif.onclick = pickBannerGif;
    choices.push(gif);
  }
  if (draftBannerColor || draftBannerImage) {
    const none = el('button', 'swatch swatch-none');
    none.type = 'button';
    none.title = 'Sem banner';
    none.setAttribute('aria-label', 'Tirar o banner');
    none.onclick = () => {
      draftBannerColor = '';
      draftBannerImage = '';
      updateProfilePreview();
    };
    choices.push(none);
  }
  $('banner-colors').replaceChildren(...choices);
}

function updateProfilePreview() {
  paintAvatar($('preview-avatar'), cleanNick($('nick-input').value), profileColorId, draftPhoto);
  paintBanner($('preview-banner'), draftBannerColor, draftBannerImage);
  $('photo-remove').hidden = !draftPhoto;
  $('photo-pick').textContent = draftPhoto ? 'Trocar foto' : 'Adicionar foto';
  renderBannerChoices();
}

async function pickImage(input, opts, apply) {
  const file = input.files[0];
  input.value = ''; // picking the same file again still fires onchange
  if (!file) return;
  try {
    const url = await cropImage(file, opts);
    if (url) {
      apply(url);
      updateProfilePreview();
    }
  } catch {
    finishCrop(null);
    toast('Não deu para usar essa imagem');
  }
}

// ---------- GIF como foto ou banner ----------

// Same search as the chat (/api/gifs). Only the GIF's URL is kept and sent:
// the small version for the photo, the full one for the banner.
let gifsEnabled = false;
const gifsOn = fetch('/api/gifs?probe=1', { method: 'HEAD' })
  .then((response) => response.status !== 404)
  .catch(() => false);
gifsOn.then((on) => {
  gifsEnabled = on;
  $('photo-gif').hidden = !on;
  if (on && $('profile').open) renderBannerChoices();
});

const GIF_SEARCH_DELAY_MS = 400;
const picker = { kind: 'photo', query: null, next: '', loading: false, seq: 0, timer: 0, resolve: null };

async function loadPickerGifs(query, more) {
  if (picker.loading && more) return;
  picker.loading = true;
  if (!more) {
    picker.seq++;
    picker.query = query;
    picker.next = '';
    $('gp-grid').replaceChildren();
  }
  const seq = picker.seq;
  $('gp-status').textContent = 'Carregando…';
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (more && picker.next) params.set('pos', picker.next);
    const response = await fetch(`/api/gifs?${params}`);
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (seq !== picker.seq) return; // a newer search started meanwhile
    picker.next = data.next || '';
    $('gp-grid').append(...(data.results || []).map(pickerChoice).filter(Boolean));
    $('gp-status').textContent = $('gp-grid').childElementCount ? '' : 'Nenhum GIF encontrado.';
  } catch {
    if (seq === picker.seq) $('gp-status').textContent = 'Os GIFs não responderam agora. Tente de novo daqui a pouco.';
  } finally {
    if (seq === picker.seq) picker.loading = false;
    $('gp-more').hidden = !picker.next || !$('gp-grid').childElementCount;
  }
}

function pickerChoice(item) {
  const preview = item.preview?.url;
  const url = picker.kind === 'photo' ? preview : item.gif?.url;
  if (typeof url !== 'string' || !profileGif(url) || typeof preview !== 'string' || !gifUrlOk(preview)) return null;
  const button = el('button', 'gif-choice');
  button.type = 'button';
  button.title = item.title || 'GIF';
  button.setAttribute('aria-label', `Escolher GIF${item.title ? `: ${item.title}` : ''}`);
  const img = el('img');
  img.src = preview;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  button.append(img);
  button.onclick = () => finishGifPicker(url);
  return button;
}

// Resolves with the chosen GIF's URL, or '' if closed.
function openGifPicker(kind) {
  picker.kind = kind;
  $('gp-title').textContent = kind === 'photo' ? 'GIF como foto' : 'GIF no banner';
  $('gp-hint').textContent = kind === 'photo' ? 'Aparece animado no seu perfil, para quem está na sala.' : 'Aparece no topo do seu cartão de perfil.';
  $('gp-search').value = '';
  $('gp-grid').classList.toggle('wide', kind === 'banner');
  loadPickerGifs('', false);
  $('gif-picker').showModal();
  return new Promise((resolve) => (picker.resolve = resolve));
}

function finishGifPicker(url) {
  const resolve = picker.resolve;
  picker.resolve = null;
  if ($('gif-picker').open) $('gif-picker').close();
  resolve?.(url || '');
}

// The same cropper as for photos, on the GIF's first frame. Resolves to
// "url#p=…", or '' if cancelled or the GIF couldn't be loaded.
async function cropGif(url, opts) {
  try {
    const response = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(String(response.status));
    return (await cropImage(await response.blob(), { ...opts, gif: url })) || '';
  } catch {
    finishCrop(null);
    toast('Não deu para abrir esse GIF. Tente outro.');
    return '';
  }
}

async function pickPhotoGif() {
  const url = await openGifPicker('photo');
  const framed = url && await cropGif(url, PHOTO_CROP);
  if (framed) {
    draftPhoto = framed;
    updateProfilePreview();
  }
}

async function pickBannerGif() {
  const url = await openGifPicker('banner');
  const framed = url && await cropGif(url, BANNER_CROP);
  if (framed) {
    draftBannerImage = framed;
    draftBannerColor = '';
    updateProfilePreview();
  }
}

$('gp-search').oninput = () => {
  clearTimeout(picker.timer);
  const query = $('gp-search').value.trim();
  picker.timer = setTimeout(() => loadPickerGifs(query, false), GIF_SEARCH_DELAY_MS);
};
$('gp-more').onclick = () => loadPickerGifs(picker.query ?? '', true);
$('gp-cancel').onclick = () => finishGifPicker('');
$('gif-picker').onclose = () => finishGifPicker('');
$('photo-gif').onclick = pickPhotoGif;

$('nick-input').oninput = () => paintAvatar($('preview-avatar'), cleanNick($('nick-input').value), profileColorId, draftPhoto);
$('photo-pick').onclick = () => $('photo-input').click();
$('photo-change').onclick = () => $('photo-input').click();
$('photo-remove').onclick = () => {
  draftPhoto = '';
  updateProfilePreview();
};
$('photo-input').onchange = () => pickImage($('photo-input'), PHOTO_CROP, (url) => (draftPhoto = url));
$('banner-edit').onclick = () => $('banner-input').click();
$('banner-input').onchange = () => pickImage($('banner-input'), BANNER_CROP, (url) => {
    draftBannerImage = url;
    draftBannerColor = '';
  });
$('profile').oncancel = (e) => {
  if (profileRequired) e.preventDefault(); // e.g. a nick is required before joining
};
$('profile-form').onsubmit = (e) => {
  e.preventDefault();
  const nick = cleanNick($('nick-input').value);
  if (!nick) return;
  const stored = [save('nick', nick), save('photo', draftPhoto), save('bannerColor', draftBannerColor), save('bannerImage', draftBannerImage)];
  if (stored.includes(false)) toast('O navegador não deixou guardar o perfil: ele vale só até fechar esta página.', 6000);
  $('profile').close();
  profileOnSave?.(nick, draftPhoto);
  // With an account, the profile is saved there too (every device gets it).
  if (account?.signedIn) pushProfile();
};

// Another tab of this browser changed the profile: `callback` refreshes this one.
const PROFILE_KEYS = ['nick', 'photo', 'bannerColor', 'bannerImage'];
function onProfileChangedElsewhere(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key === null || PROFILE_KEYS.includes(e.key)) callback();
  });
  window.addEventListener('profile-synced', callback); // brought from the account
}

let toastTimer = null;
function toast(text, ms = 2500) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

// ---------- aparência ----------

// Accent, theme and background: only on this screen, saved in this browser.
// Changes apply live behind the dialog; theme.js (in <head>) applies them on
// every page load. Nothing here runs per frame.
const ACCENTS = [['Azul', '#0A84FF'], ['Roxo', '#7C5CFF'], ['Ciano', '#64D2FF'], ['Verde', '#30D158'], ['Rosa', '#FF375F'], ['Laranja', '#FF9F0A']];
const THEME_CHOICES = [['escuro', 'Escuro'], ['grafite', 'Grafite'], ['meia-noite', 'Meia-noite']];
const BG_CHOICES = [['none', 'Nenhum'], ['aurora', 'Aurora'], ['por-do-sol', 'Pôr do sol'], ['oceano', 'Oceano'], ['image', 'Sua imagem']];
const MAX_BG_IMAGE = 1_800_000; // characters of data URL (localStorage holds ~5 MB)

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="appearance" aria-labelledby="ap-title">
    <form method="dialog" class="dialog-body">
      <div class="heading">
        <h2 id="ap-title">Aparência</h2>
        <span class="muted">Só na sua tela, salva neste navegador.</span>
      </div>
      <fieldset class="ap-section"><legend>Cor de destaque</legend><div class="swatches" id="ap-accents"></div></fieldset>
      <fieldset class="ap-section"><legend>Tema</legend><div class="choices" id="ap-themes"></div></fieldset>
      <fieldset class="ap-section"><legend>Fundo</legend><div class="bg-grid" id="ap-backgrounds"></div></fieldset>
      <input type="file" id="ap-image" accept="image/*" hidden>
      <div class="actions">
        <button type="button" class="btn small" id="ap-reset">Restaurar padrão</button>
        <button class="btn small primary">Pronto</button>
      </div>
    </form>
  </dialog>
`);

function saveAppearance(patch) {
  const next = { ...loadAppearance(), ...patch };
  save('appearance', JSON.stringify(next));
  applyAppearance(next);
  renderAppearance();
}

function renderAppearance() {
  const current = loadAppearance();
  const isPreset = ACCENTS.some(([, hex]) => hex.toLowerCase() === current.accent.toLowerCase());
  $('ap-accents').replaceChildren(...ACCENTS.map(([name, hex]) => {
    const button = el('button', 'swatch');
    button.type = 'button';
    button.style.background = hex;
    button.title = name;
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', String(hex.toLowerCase() === current.accent.toLowerCase()));
    button.onclick = () => saveAppearance({ accent: hex });
    return button;
  }), (() => {
    const label = el('label', 'swatch swatch-custom');
    label.title = 'Outra cor';
    label.setAttribute('aria-pressed', String(!isPreset));
    if (!isPreset) label.style.background = current.accent;
    const input = el('input');
    input.type = 'color';
    input.value = current.accent;
    input.setAttribute('aria-label', 'Escolher outra cor');
    // Live while dragging, without rebuilding the buttons: rebuilding would
    // remove this input and the browser would close its picker mid-drag.
    input.oninput = () => {
      const next = { ...loadAppearance(), accent: input.value };
      save('appearance', JSON.stringify(next));
      applyAppearance(next);
      label.style.background = input.value;
    };
    input.onchange = renderAppearance; // the picker closed
    label.append(input);
    return label;
  })());
  $('ap-themes').replaceChildren(...THEME_CHOICES.map(([id, name]) => {
    const button = el('button', 'choice', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(current.theme === id));
    button.onclick = () => saveAppearance({ theme: id });
    return button;
  }));
  $('ap-backgrounds').replaceChildren(...BG_CHOICES.map(([id, name]) => {
    const button = el('button', 'bg-tile', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(current.background === id));
    if (BACKGROUNDS[id]) button.style.backgroundImage = BACKGROUNDS[id];
    if (id === 'image') {
      const saved = load('appearance-image');
      if (saved) button.style.backgroundImage = `url("${saved}")`;
      button.textContent = saved ? 'Sua imagem' : 'Enviar imagem';
    }
    button.onclick = () => {
      if (id === 'image' && (!load('appearance-image') || current.background === 'image')) $('ap-image').click();
      else saveAppearance({ background: id });
    };
    return button;
  }));
}

// Shrinks the picked picture to at most 1920x1080 JPEG so it fits in storage.
async function backgroundFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.8, 0.65, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= MAX_BG_IMAGE) return url;
  }
  throw new Error('imagem grande demais');
}

$('ap-image').onchange = async () => {
  const file = $('ap-image').files[0];
  $('ap-image').value = '';
  if (!file) return;
  try {
    const url = await backgroundFromFile(file);
    localStorage.setItem('appearance-image', url); // may throw if storage is full
    saveAppearance({ background: 'image' });
  } catch {
    toast('Não deu para usar essa imagem como fundo. Tente uma menor.');
  }
};

$('ap-reset').onclick = () => {
  save('appearance', '');
  save('appearance-image', '');
  applyAppearance();
  renderAppearance();
};

function openAppearance() {
  renderAppearance();
  $('appearance').showModal();
}
$('open-appearance').onclick = openAppearance;

// ---------- salas ----------

function validRoomId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// "churrasco-k3f9x2" (name + random suffix) shows as "churrasco"; random IDs
// show their first 8 characters.
function roomName(id) {
  return id.match(/^(.+)-[a-z0-9]{4,6}$/)?.[1] ?? id.slice(0, 8);
}

// Rooms you have been in, newest first: [{ id, at, pinned }].
function loadRooms() {
  try {
    const list = JSON.parse(load('rooms') || '[]');
    return Array.isArray(list) ? list.filter((r) => r && validRoomId(r.id)) : [];
  } catch {
    return [];
  }
}

function saveRooms(list) {
  save('rooms', JSON.stringify(list.slice(0, 30)));
}

function rememberRoom(id) {
  const list = loadRooms();
  const old = list.find((r) => r.id === id);
  saveRooms([{ id, at: Date.now(), pinned: !!old?.pinned }, ...list.filter((r) => r.id !== id)]);
}

function roomUrl(id) {
  return `${location.origin}/room/${id}`;
}

function slugify(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '') // "Sábado" -> "Sabado"
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
}

function randomChars(count, alphabet) {
  return Array.from(crypto.getRandomValues(new Uint8Array(count)), (b) => alphabet[b % alphabet.length]).join('');
}

// A name gets a 6-character random suffix so strangers can't guess the room;
// no name gives a fully random ID.
function newRoomId(name) {
  const slug = slugify(name);
  return slug
    ? `${slug}-${randomChars(6, 'abcdefghijklmnopqrstuvwxyz0123456789')}`
    : randomChars(16, '0123456789abcdef');
}

function colorFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ---------- Block (sala fixa) ----------

// Your fixed room: created once in the lobby (after you pick a nick), kept in
// this browser and always one click away (like a Discord group). It is a
// normal room with a stable, unguessable ID named after you
// ("block-de-lucas-x7k2p9"), so invited friends see whose room it is; the
// server knows nothing about it. Without storage (private mode) it lasts until
// the page is closed. Only reading never creates it: opening an invite
// shouldn't leave a room behind in a friend's browser.
let homeFallback = '';
function homeRoomId() {
  const saved = load('home-room');
  return validRoomId(saved) ? saved : homeFallback;
}

function ensureHomeRoom(nick) {
  const existing = homeRoomId();
  // The first version made it a bare random code ("faa5361814923c29"), which
  // friends saw as gibberish: swap it for a named one, keeping the old room
  // in the list so links already sent still lead somewhere.
  if (existing && !/^[0-9a-f]{16}$/.test(existing)) return existing;
  if (existing) rememberRoom(existing);
  const slug = slugify(nick);
  const id = newRoomId(slug ? `block-de-${slug}` : 'meu-block');
  homeFallback = id;
  save('home-room', id);
  return id;
}

function isHomeRoom(id) {
  return !!id && id === homeRoomId();
}

function displayRoomName(id) {
  return isHomeRoom(id) ? 'Block' : roomName(id);
}

// Fixed room first (when there is one), then pinned ones, then the rest by most recent.
function orderedRooms() {
  const home = homeRoomId();
  const rest = loadRooms()
    .filter((r) => r.id !== home)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);
  return home ? [{ id: home, at: 0, pinned: true, home: true }, ...rest] : rest;
}

// How many people are in each room now (server's /api/rooms); null if offline.
async function fetchRoomCounts(ids) {
  if (!ids.length) return null;
  try {
    const res = await fetch(`/api/rooms?ids=${ids.join(',')}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------- conta (opcional, docs/CONTAS.md) ----------

// `account`: undefined while unknown, null when the server has accounts off,
// { signedIn: false } or { signedIn: true, id, username, nick }.
let account;
const accountListeners = [];

function onAccountChange(callback) {
  accountListeners.push(callback);
  if (account !== undefined) callback(account);
}

function setAccount(value) {
  account = value;
  renderAccountSection();
  accountListeners.forEach((callback) => callback(account));
}

async function loadAccount() {
  try {
    const res = await fetch('/api/me', { cache: 'no-store' });
    if (res.status === 404) return setAccount(null);
    if (res.status === 401) return setAccount({ signedIn: false });
    if (res.ok) return setAccount({ signedIn: true, ...(await res.json()) });
  } catch { /* offline: try again on the next page load */ }
  return setAccount(account ?? null);
}

function signInUrl() {
  return `/auth/google?volta=${encodeURIComponent(location.pathname)}`;
}

async function accountRequest(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// The "Conta" part of the profile dialog.
function renderAccountSection() {
  const box = $('account-box');
  box.hidden = !account;
  if (!account) return;
  $('account-out').hidden = account.signedIn;
  $('account-in').hidden = !account.signedIn;
  if (account.signedIn) $('account-username').textContent = account.username ? `@${account.username}` : 'sem @usuário ainda';
}

// First sign-in: pick the @username (and confirm the name friends will see).
function suggestUsername(nick) {
  const base = (nick || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return /^[a-z]/.test(base) ? base.slice(0, 20) : '';
}

function openUsernameDialog() {
  $('username-input').value = account?.username || suggestUsername(load('nick'));
  $('username-nick').value = account?.nick || load('nick');
  $('username-error').textContent = '';
  $('username-dialog').showModal();
}

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="username-dialog" aria-labelledby="username-title">
    <form class="dialog-body" id="username-form">
      <div class="heading">
        <h2 id="username-title">Escolha seu @usuário</h2>
        <span class="muted">É por ele que seus amigos vão te achar. Dá para trocar depois.</span>
      </div>
      <label class="field"><span class="muted">@usuário</span>
        <input id="username-input" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="@?[A-Za-z][A-Za-z0-9_]{2,19}" required></label>
      <label class="field"><span class="muted">Nome que aparece</span>
        <input id="username-nick" maxlength="32" autocomplete="nickname" required></label>
      <p class="muted account-error" id="username-error" role="alert"></p>
      <div class="actions">
        <button type="button" class="btn ghost" id="username-later">Depois</button>
        <button class="btn primary">Salvar</button>
      </div>
    </form>
  </dialog>`);

$('username-later').onclick = () => $('username-dialog').close();
$('username-form').onsubmit = async (e) => {
  e.preventDefault();
  const { ok, data } = await accountRequest('POST', '/api/me', { username: $('username-input').value, nick: $('username-nick').value });
  if (!ok) {
    $('username-error').textContent = data.error || 'Não deu para salvar. Tente de novo.';
    return;
  }
  $('username-dialog').close();
  if (data.nick) save('nick', data.nick);
  setAccount({ signedIn: true, ...data });
  toast(`Pronto, você é @${data.username}.`);
};

// The account part inside the profile dialog (added after its form exists).
$('open-appearance').insertAdjacentHTML('afterend', `
  <div class="account-box" id="account-box" hidden>
    <div id="account-out">
      <p class="muted account-note">Com uma conta você ganha um @usuário e seus amigos em qualquer aparelho. Guardamos só um identificador da sua conta Google, sem e-mail nem foto (<a href="/privacidade" target="_blank">privacidade</a> · <a href="/termos" target="_blank">termos</a>).</p>
      <a class="btn small" id="account-signin" href="/auth/google">Entrar com Google</a>
    </div>
    <div id="account-in" hidden>
      <div class="account-row"><span class="account-label">Conta</span><strong id="account-username"></strong>
        <button type="button" class="btn small ghost" id="account-edit">Trocar</button></div>
      <div class="account-row">
        <button type="button" class="btn small ghost" id="account-signout">Sair</button>
        <button type="button" class="btn small danger" id="account-delete">Apagar conta</button>
      </div>
    </div>
  </div>`);

$('account-signin').onclick = (e) => {
  e.preventDefault();
  location.assign(signInUrl());
};
$('account-edit').onclick = () => {
  $('profile').close();
  openUsernameDialog();
};
$('account-signout').onclick = async () => {
  await accountRequest('POST', '/auth/sair');
  setAccount({ signedIn: false });
  toast('Você saiu da conta neste aparelho.');
};
$('account-delete').onclick = async () => {
  if (!window.confirm('Apagar sua conta? Seu @usuário e suas amizades somem e não dá para desfazer. O que está neste navegador (nick, foto) continua.')) return;
  const { ok } = await accountRequest('DELETE', '/api/me');
  if (!ok) return toast('Não deu para apagar agora. Tente de novo.');
  $('profile').close();
  setAccount({ signedIn: false });
  toast('Conta apagada.');
};

// Back from Google: "?conta=entrou" or "?conta=erro".
(() => {
  const params = new URLSearchParams(location.search);
  const result = params.get('conta');
  if (!result) return;
  params.delete('conta');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  if (result === 'erro') toast('Não deu para entrar com Google. Tente de novo.', 5000);
  if (result === 'entrou') {
    onAccountChange((value) => {
      if (value?.signedIn && !value.username && !$('username-dialog').open) openUsernameDialog();
    });
  }
})();

// ---------- perfil na conta (#159) ----------

// Signed in, the profile lives in the account: on this device it is replaced
// by the saved one; an account that never saved one gets this device's.
async function pushProfile() {
  const { ok, data } = await accountRequest('PUT', '/api/me/perfil', {
    nick: load('nick'), photo: load('photo'), bannerColor: load('bannerColor'), bannerImage: load('bannerImage'),
  });
  if (!ok) toast(data.error ? `${data.error} O perfil ficou só neste aparelho.` : 'O perfil ficou só neste aparelho.', 5000);
  else if (account?.signedIn && data.nick !== account.nick) setAccount({ ...account, nick: data.nick });
}

let profileChecked = false;
async function syncProfileWithAccount(value) {
  if (!value?.signedIn || profileChecked) return;
  profileChecked = true;
  const { ok, data } = await accountRequest('GET', '/api/me/perfil');
  if (!ok) return;
  if (!data.salvo) {
    if (load('nick')) pushProfile();
    return;
  }
  const saved = { nick: data.nick, photo: data.photo, bannerColor: data.bannerColor, bannerImage: data.bannerImage };
  const changed = Object.entries(saved).filter(([key, value]) => (load(key) || '') !== (value || ''));
  if (!changed.length) return;
  changed.forEach(([key, value]) => save(key, value || ''));
  window.dispatchEvent(new Event('profile-synced'));
}
onAccountChange(syncProfileWithAccount);

// ---------- idade no primeiro acesso (#152) ----------

// The terms ask for 13 or older. Asked once per browser; whoever answers
// "under 13" can't use the app here. A declaration, not a check.
document.body.insertAdjacentHTML('beforeend', `
  <dialog id="age-dialog" aria-labelledby="age-title">
    <div class="dialog-body">
      <div class="heading">
        <h2 id="age-title">Antes de começar</h2>
        <span class="muted">O CPX Call é para quem tem 13 anos ou mais. Menores de 18 precisam da autorização dos pais ou responsáveis.</span>
      </div>
      <p class="muted age-links">Ao continuar, você concorda com os <a href="/termos" target="_blank">termos de uso</a> e a <a href="/privacidade" target="_blank">privacidade</a>.</p>
      <div class="age-actions">
        <button type="button" class="btn primary" id="age-yes" autofocus>Tenho 13 anos ou mais</button>
        <button type="button" class="btn ghost" id="age-no">Tenho menos de 13</button>
      </div>
    </div>
  </dialog>`);

// A layer over the whole page (the page underneath keeps working, unseen;
// the room never connects, since it waits for whenAgeOk).
function blockUnderAge() {
  if ($('age-block')) return;
  const box = el('div', 'age-block');
  box.id = 'age-block';
  const text = el('div', 'age-block-text');
  text.append(el('h1', null, 'O CPX Call é para quem tem 13 anos ou mais.'),
    el('p', null, 'Quando você tiver 13, volta aqui. Até lá, chame um adulto se precisar de ajuda.'));
  box.append(text);
  document.body.append(box);
}

// Runs `then` once the age is declared (right away if it already was).
function whenAgeOk(then) {
  if (load('idade') === 'menor') return blockUnderAge();
  if (load('idade') === '13+') return then?.();
  const dialog = $('age-dialog');
  dialog.oncancel = (e) => e.preventDefault(); // must answer
  $('age-yes').onclick = () => {
    save('idade', '13+');
    dialog.close();
    then?.();
  };
  $('age-no').onclick = () => {
    save('idade', 'menor');
    blockUnderAge();
  };
  dialog.showModal();
}

loadAccount();

