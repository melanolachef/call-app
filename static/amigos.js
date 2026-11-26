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
        <span class="muted">Seus amigos veem em que sala você está. Ninguém mais.</span>
      </div>
      <div class="fd-account" id="fd-account" hidden>
        <div id="fd-acc-out">
          <p class="muted fd-note">Com uma conta, seus amigos te acham pelo @usuário em qualquer aparelho.</p>
          <a class="btn small" id="fd-signin" href="/auth/google">Entrar com Google</a>
        </div>
        <div id="fd-acc-noname" hidden>
          <p class="muted fd-note">Escolha seu @usuário para adicionar amigos.</p>
          <button type="button" class="btn small" id="fd-pick">Escolher @usuário</button>
        </div>
        <div class="fd-acc-in" id="fd-acc-in" hidden>
          <label class="field"><span class="muted">Adicionar por @usuário</span>
            <span class="fd-search"><span aria-hidden="true">@</span><input id="fd-user" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="21" placeholder="usuario" aria-label="@usuário do amigo"></span></label>
          <div class="fd-found" id="fd-found" role="status" hidden></div>
          <div class="field">
            <span class="muted">Seu link de amizade</span>
            <div class="fd-code"><span class="mono ellipsis" id="fd-mylink"></span><button type="button" class="btn small ghost" id="fd-copy-user">Copiar</button></div>
          </div>
          <div class="fd-list" id="fd-received"></div>
          <div class="fd-list" id="fd-sent"></div>
        </div>
      </div>
      <label class="switch-row">Invisível (amigos não veem onde você está)<input type="checkbox" role="switch" id="fd-invisible"></label>
      <details class="fd-codes" id="fd-codes" open>
        <summary>Código de amigo (sem conta)</summary>
      <div class="field">
        <span class="muted">Seu código</span>
        <div class="fd-code"><strong class="mono" id="fd-code"></strong><button type="button" class="btn small ghost" id="fd-copy">Copiar link</button></div>
      </div>
      <label class="field"><span class="muted">Adicionar amigo (código ou link)</span>
        <input id="fd-add-code" autocomplete="off" placeholder="7K3F-9X2A" maxlength="200"></label>
      <label class="field"><span class="muted">Nome (opcional)</span>
        <input id="fd-add-name" autocomplete="off" maxlength="24" placeholder="Como ele aparece para você"></label>
      <button type="button" class="btn" id="fd-add">Adicionar</button>
      <details class="fd-transfer">
        <summary>Usar em outro aparelho (app, celular)</summary>
        <p class="muted">O app e cada navegador guardam o código separado. Copie aqui e cole no outro aparelho para usar o mesmo código e a mesma lista de amigos. Não mande para ninguém: quem tiver isso aparece como você.</p>
        <div class="actions">
          <button type="button" class="btn small ghost" id="fd-export">Copiar para outro aparelho</button>
        </div>
        <input id="fd-import" autocomplete="off" placeholder="Colar o texto do outro aparelho">
        <button type="button" class="btn small" id="fd-import-btn">Usar este</button>
      </details>
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
  renderAccountFriendsDialog();
  $('fd-user').value = prefill?.username || '';
  $('fd-found').hidden = true;
  if (prefill?.username) lookupUser();
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

// ---------- amigos com conta (@usuário, #157) ----------

// { amigos: [{ id, username, nick, sala?, pessoas?, desde? }], recebidos, enviados },
// or null while signed out / accounts off.
let accountFriends = null;

const accountFriendName = (f) => f.nick || `@${f.username}`;

async function loadAccountFriends() {
  if (!account?.signedIn) {
    accountFriends = null;
  } else {
    try {
      const res = await fetch('/api/amigos', { cache: 'no-store' });
      if (res.ok) accountFriends = await res.json();
      else if (res.status === 401) accountFriends = null;
    } catch { /* offline: keep the last list */ }
  }
  renderAccountFriendsDialog();
  window.dispatchEvent(new Event('account-friends-changed'));
  return accountFriends;
}
onAccountChange(() => loadAccountFriends());

function friendLinkFor(username) {
  return `${location.origin}/?u=${username}`;
}

function personRow(f, ...buttons) {
  const row = el('div', 'fd-person');
  const face = el('span', 'avatar');
  face.textContent = initials(accountFriendName(f));
  face.style.background = colorFor(`u${f.id}`);
  const text = el('span', 'fd-person-text');
  text.append(el('strong', 'ellipsis', accountFriendName(f)), el('span', 'muted ellipsis', `@${f.username}`));
  row.append(face, text, ...buttons);
  return row;
}

function actionButton(label, cls, onClick) {
  const button = el('button', `btn small ${cls}`, label);
  button.type = 'button';
  if (onClick) button.onclick = onClick;
  else button.disabled = true;
  return button;
}

async function friendAction(method, path, body, done) {
  const { ok, data } = await accountRequest(method, path, body);
  if (!ok) {
    toast(data.error || 'Não deu agora. Tente de novo.');
    return false;
  }
  if (done) toast(done);
  await loadAccountFriends();
  return data;
}

function renderAccountFriendsDialog() {
  const box = $('fd-account');
  if (!box) return;
  box.hidden = !account;
  if (!account) return;
  const named = account.signedIn && !!account.username;
  $('fd-acc-out').hidden = account.signedIn;
  $('fd-acc-noname').hidden = !account.signedIn || named;
  $('fd-acc-in').hidden = !named;
  // With an account, the codes are the old way: tucked away but still there.
  $('fd-codes').open = !named;
  if (!named) return;
  $('fd-mylink').textContent = friendLinkFor(account.username).replace(/^https?:\/\//, '');
  const received = accountFriends?.recebidos ?? [];
  const sent = accountFriends?.enviados ?? [];
  $('fd-received').replaceChildren(...(received.length ? [el('span', 'muted fd-list-title', 'Pedidos recebidos')] : []),
    ...received.map((f) => personRow(f,
      actionButton('Aceitar', 'primary', () => friendAction('POST', `/api/amigos/${f.id}/aceitar`, null, `Agora você e ${accountFriendName(f)} são amigos.`)),
      actionButton('Recusar', 'ghost', () => friendAction('DELETE', `/api/amigos/${f.id}`)))));
  $('fd-sent').replaceChildren(...(sent.length ? [el('span', 'muted fd-list-title', 'Pedidos enviados')] : []),
    ...sent.map((f) => personRow(f, actionButton('Cancelar', 'ghost', () => friendAction('DELETE', `/api/amigos/${f.id}`)))));
}

// Exact @username only: the server never lists or completes names.
let lookupTimer = null;
let lookupSeq = 0;
async function lookupUser() {
  const name = $('fd-user').value.trim().replace(/^@/, '').toLowerCase();
  const found = $('fd-found');
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(name)) {
    found.hidden = true;
    return;
  }
  const seq = ++lookupSeq;
  let res;
  try {
    res = await fetch(`/api/usuarios/${name}`, { cache: 'no-store' });
  } catch {
    return;
  }
  if (seq !== lookupSeq) return; // typed more meanwhile
  found.hidden = false;
  if (!res.ok) {
    found.replaceChildren(el('span', 'muted', res.status === 404 ? 'Ninguém com esse @usuário.' : 'Não deu para procurar agora.'));
    return;
  }
  const user = await res.json();
  const ask = async () => {
    const data = await friendAction('POST', '/api/amigos', { username: user.username });
    if (data) toast(data.relacao === 'amigo' ? `Agora você e ${accountFriendName(user)} são amigos.` : `Pedido enviado para @${user.username}.`);
    lookupUser();
  };
  const button = {
    nenhuma: actionButton('Mandar pedido', 'primary', ask),
    recebido: actionButton('Aceitar', 'primary', ask),
    enviado: actionButton('Pedido enviado', 'ghost'),
    amigo: actionButton('Já são amigos', 'ghost'),
    voce: actionButton('É você', 'ghost'),
  }[user.relacao] ?? actionButton('Mandar pedido', 'primary', ask);
  found.replaceChildren(personRow(user, button));
}
$('fd-user').oninput = () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(lookupUser, 350);
};
$('fd-user').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // the dialog's form would close
    clearTimeout(lookupTimer);
    lookupUser();
  }
};
$('fd-copy-user').onclick = () => copyText(friendLinkFor(account.username), 'Link copiado. Quem abrir pode te mandar um pedido.');
$('fd-signin').onclick = (e) => {
  e.preventDefault();
  location.assign(signInUrl());
};
$('fd-pick').onclick = () => {
  $('friends-dialog').close();
  openUsernameDialog();
};
