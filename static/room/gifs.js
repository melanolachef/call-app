// ---------- GIFs no chat ----------

// A "GIFs" tab in the emoji picker: what's trending, or a search, through our
// own server (/api/gifs: it keeps the key and the GIF service doesn't see who
// searches). Picking one sends it to the room as a chat message
// { gif: { url, w, h, title } }; it shows up animated for everyone, loaded
// from the GIF service's CDN. Without a key on the server the tab is hidden.
const gifState = { on: false, query: null, next: '', loading: false, timer: 0 };

// What goes over the wire, and what we accept from others: only these
// fields, an https URL on the GIF service, sane sizes.
function cleanGif(gif) {
  if (!gif || typeof gif.url !== 'string' || gif.url.length > 500 || !gifUrlOk(gif.url)) return null;
  const size = (n) => (Number.isInteger(n) && n > 0 && n <= 4096 ? n : 0);
  const title = typeof gif.title === 'string' ? gif.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { url: gif.url, w: size(gif.w), h: size(gif.h), title };
}

function setEmojiMode(mode) {
  const gifs = mode === 'gif' && gifState.on;
  $('emoji-mode-emoji').setAttribute('aria-pressed', String(!gifs));
  $('emoji-mode-gif').setAttribute('aria-pressed', String(gifs));
  $('emoji-tabs').hidden = gifs;
  $('emoji-grid').hidden = gifs;
  $('gif-panel').hidden = !gifs;
  if (gifs) {
    if (gifState.query === null) loadGifs('', false);
    if (!mobile.matches) $('gif-search').focus();
  }
}

async function loadGifs(query, more) {
  if (gifState.loading) return;
  gifState.loading = true;
  const grid = $('gif-grid');
  if (!more) {
    gifState.query = query;
    gifState.next = '';
    grid.replaceChildren();
  }
  $('gif-status').textContent = 'Carregando…';
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (more && gifState.next) params.set('pos', gifState.next);
    const response = await fetch(`/api/gifs?${params}`);
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (query !== gifState.query) return; // a newer search started meanwhile
    gifState.next = data.next || '';
    grid.append(...(data.results || []).map(gifChoice).filter(Boolean));
    $('gif-status').textContent = grid.childElementCount ? '' : 'Nenhum GIF encontrado.';
  } catch {
    $('gif-status').textContent = 'Os GIFs não responderam agora. Tente de novo daqui a pouco.';
  } finally {
    gifState.loading = false;
    $('gif-more').hidden = !gifState.next || !$('gif-grid').childElementCount;
  }
}

function gifChoice(item) {
  const gif = cleanGif({ ...item.gif, title: item.title });
  const preview = item.preview && gifUrlOk(item.preview.url) ? item.preview.url : gif?.url;
  if (!gif) return null;
  const button = el('button', 'gif-choice');
  button.type = 'button';
  button.title = gif.title || 'GIF';
  button.setAttribute('aria-label', `Enviar GIF${gif.title ? `: ${gif.title}` : ''}`);
  const img = el('img');
  img.src = preview;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  button.append(img);
  button.onclick = () => {
    sendGif(gif);
    setEmojiPicker(false);
  };
  return button;
}

function sendGif(gif) {
  if (chatInput.disabled) return;
  peers.forEach((peer) => send(peer.id, { gif }));
  addMessage({ authorId: myId, name: myNick, photo: myPhoto, gif, self: true });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleGif(peer, data) {
  const gif = cleanGif(data.gif);
  if (gif) addMessage({ authorId: peer.id, name: displayName(peer), photo: peer.photo, gif });
}

$('emoji-mode-emoji').onclick = () => setEmojiMode('emoji');
$('emoji-mode-gif').onclick = () => setEmojiMode('gif');
$('gif-search').oninput = () => {
  clearTimeout(gifState.timer);
  const query = $('gif-search').value.trim();
  gifState.timer = setTimeout(() => loadGifs(query, false), GIF_SEARCH_DELAY_MS);
};
$('gif-more').onclick = () => loadGifs(gifState.query ?? '', true);

// Is the server set up for GIFs? (common.js asks; no key: hide the tab.)
gifsOn.then((on) => {
  gifState.on = on;
  $('emoji-mode').hidden = !on;
});
