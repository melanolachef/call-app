'use strict';

// Friends without accounts (#132): each browser keeps a random secret, and
// its friend code ("7K3F-9X2A") is derived from it by SHA-256, as the server
// does (src/presence.rs). You give your code to whoever may see where you
// are; you add theirs to see where they are. While you are in a room (and
// not invisible), the room tells the server "the owner of this secret is
// here"; the server keeps that in memory only, while you are connected.
//
// The code lives in this browser: the Windows app and the phone have their
// own storage, so "Levar para outro aparelho" copies the secret and the
// friend list as one text to paste there.

const FRIEND_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// SHA-256 in the page needs a secure context (https or localhost).
const friendsSupported = !!globalThis.crypto?.subtle;
const FRIENDS_MAX = 64;
const FRIEND_NAME_MAX = 24;

function friendSecret() {
  let secret = load('friendSecret');
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    save('friendSecret', secret);
  }
  return secret;
}

// The first 40 bits of SHA-256(secret) in base32: same as the server.
async function codeOfSecret(secret) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  let bits = 0n;
  for (const byte of hash.slice(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 7; i >= 0; i--) code += FRIEND_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

const myFriendCode = () => codeOfSecret(friendSecret());

function normalizeFriendCode(text) {
  const code = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '');
  return code.length === 8 && [...code].every((c) => FRIEND_ALPHABET.includes(c)) ? code : null;
}

const formatFriendCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// A pasted code, or a friend link (".../?amigo=7K3F9X2A&nome=Rafa").
function parseFriendInput(text) {
  const value = String(text).trim();
  try {
    const url = new URL(value);
    const code = normalizeFriendCode(url.searchParams.get('amigo') || '');
    if (code) return { code, name: url.searchParams.get('nome') || '' };
  } catch { /* not a link */ }
  const code = normalizeFriendCode(value);
  return code ? { code, name: '' } : null;
}

function cleanFriendName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, FRIEND_NAME_MAX);
}

function loadFriends() {
  try {
    const list = JSON.parse(load('friends') || '[]');
    return Array.isArray(list)
      ? list.filter((f) => f && normalizeFriendCode(f.code)).map((f) => ({ code: f.code, name: cleanFriendName(f.name), at: Number(f.at) || 0 }))
      : [];
  } catch {
    return [];
  }
}

function saveFriends(list) {
  save('friends', list.length ? JSON.stringify(list.slice(0, FRIENDS_MAX)) : '');
  window.dispatchEvent(new Event('friends-changed'));
}

async function addFriend(code, name) {
  if (code === await myFriendCode()) return 'self';
  const list = loadFriends();
  const existing = list.find((f) => f.code === code);
  if (existing) {
    if (name && !existing.name) existing.name = cleanFriendName(name);
    saveFriends(list);
    return 'exists';
  }
  if (list.length >= FRIENDS_MAX) return 'full';
  saveFriends([...list, { code, name: cleanFriendName(name), at: Date.now() }]);
  return 'added';
}

function removeFriend(code) {
  saveFriends(loadFriends().filter((f) => f.code !== code));
}

const isInvisible = () => load('invisible') === '1';
function setInvisible(on) {
  save('invisible', on ? '1' : '');
  window.dispatchEvent(new Event('friends-changed'));
}

// { CODE: { nick, room, count, secs } | null }, or null when offline.
async function fetchFriendPresence(codes) {
  if (!codes.length) return {};
  try {
    const res = await fetch(`/api/friends?codes=${codes.join(',')}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function friendLink() {
  const params = new URLSearchParams({ amigo: await myFriendCode() });
  const nick = cleanFriendName(load('nick'));
  if (nick) params.set('nome', nick);
  return `${location.origin}/?${params}`;
}

// "há 12 min", "há 1 h" for how long a friend has been in their room.
function friendSince(secs) {
  const minutes = Math.floor(secs / 60);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  return `há ${Math.floor(minutes / 60)} h`;
}

// Carrying your code and friends to another device (app, phone): one text.
function exportFriends() {
  const data = JSON.stringify({ s: friendSecret(), f: loadFriends() });
  return `CPX-AMIGOS:${btoa(unescape(encodeURIComponent(data)))}`;
}

async function importFriends(text) {
  const value = String(text).trim();
  if (!value.startsWith('CPX-AMIGOS:')) return false;
  let data;
  try {
    data = JSON.parse(decodeURIComponent(escape(atob(value.slice('CPX-AMIGOS:'.length)))));
  } catch {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(data?.s)) return false;
  save('friendSecret', data.s);
  const mine = await myFriendCode();
  const merged = loadFriends();
  for (const f of Array.isArray(data.f) ? data.f : []) {
    const code = normalizeFriendCode(f?.code);
    if (code && code !== mine && !merged.some((m) => m.code === code)) merged.push({ code, name: cleanFriendName(f.name), at: Number(f.at) || Date.now() });
  }
  saveFriends(merged);
  return true;
}

// ---------- caixa "Amigos": seu código, adicionar, invisível, outro aparelho ----------

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="friends-dialog" aria-labelledby="fd-title">
    <form method="dialog" class="dialog-body">
      <div class="heading">
        <h2 id="fd-title">Amigos</h2>
        <span class="muted">Quem tem o seu código vê em que sala você está. Ninguém mais.</span>
      </div>
      <div class="field">
        <span class="muted">Seu código</span>
        <div class="fd-code"><strong class="mono" id="fd-code"></strong><button type="button" class="btn small ghost" id="fd-copy">Copiar link</button></div>
      </div>
      <label class="field"><span class="muted">Adicionar amigo (código ou link)</span>
        <input id="fd-add-code" autocomplete="off" placeholder="7K3F-9X2A" maxlength="200"></label>
      <label class="field"><span class="muted">Nome (opcional)</span>
        <input id="fd-add-name" autocomplete="off" maxlength="24" placeholder="Como ele aparece para você"></label>
      <button type="button" class="btn" id="fd-add">Adicionar</button>
      <label class="switch-row">Invisível (amigos não veem onde você está)<input type="checkbox" role="switch" id="fd-invisible"></label>
      <details class="fd-transfer">
        <summary>Usar em outro aparelho (app, celular)</summary>
        <p class="muted">O app e cada navegador guardam o código separado. Copie aqui e cole no outro aparelho para usar o mesmo código e a mesma lista de amigos. Não mande para ninguém: quem tiver isso aparece como você.</p>
        <div class="actions">
          <button type="button" class="btn small ghost" id="fd-export">Copiar para outro aparelho</button>
        </div>
        <input id="fd-import" autocomplete="off" placeholder="Colar o texto do outro aparelho">
        <button type="button" class="btn small" id="fd-import-btn">Usar este</button>
      </details>
      <button class="btn primary">Pronto</button>
    </form>
  </dialog>`);

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    window.prompt('Copie:', text); // clipboard needs HTTPS
  }
}

async function openFriendsDialog(prefill) {
  $('fd-code').textContent = formatFriendCode(await myFriendCode());
  $('fd-invisible').checked = isInvisible();
  $('fd-add-code').value = prefill?.code ? formatFriendCode(prefill.code) : '';
  $('fd-add-name').value = prefill?.name || '';
  $('fd-import').value = '';
  $('friends-dialog').showModal();
}

$('fd-copy').onclick = async () => copyText(await friendLink(), 'Link do seu código copiado. Mande para os amigos.');
$('fd-invisible').onchange = () => setInvisible($('fd-invisible').checked);
$('fd-add').onclick = async () => {
  const parsed = parseFriendInput($('fd-add-code').value);
  if (!parsed) {
    toast('Esse código não parece certo. São 8 letras e números, como 7K3F-9X2A.');
    return;
  }
  const result = await addFriend(parsed.code, $('fd-add-name').value || parsed.name);
  toast({ self: 'Esse é o seu próprio código.', exists: 'Já está nos seus amigos.', full: 'Limite de amigos atingido.', added: 'Amigo adicionado.' }[result]);
  if (result === 'added' || result === 'exists') {
    $('fd-add-code').value = '';
    $('fd-add-name').value = '';
  }
};
$('fd-export').onclick = () => copyText(exportFriends(), 'Copiado. Cole no outro aparelho, em Amigos › Usar em outro aparelho.');
$('fd-import-btn').onclick = async () => {
  if (!window.confirm('Usar o código e os amigos do outro aparelho neste aqui? O código atual deste aparelho deixa de valer.')) return;
  if (await importFriends($('fd-import').value)) {
    $('fd-code').textContent = formatFriendCode(await myFriendCode());
    $('fd-import').value = '';
    toast('Pronto: este aparelho usa o mesmo código e amigos.');
  } else {
    toast('Esse texto não veio de "Copiar para outro aparelho".');
  }
};
