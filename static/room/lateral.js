// ---------- suas salas (barra lateral) ----------

// Same list as the lobby (fixed room first), so you can hop between rooms
// without going back. The counts come from the server's /api/rooms.
let hudCounts = {};

// Leaving while sharing cuts everyone watching: ask first.
function okToLeave() {
  return !localTrack || window.confirm('Você está compartilhando a tela. Sair desta sala mesmo assim?');
}

function hudItem(room) {
  const current = room.id === roomId;
  // The current room is not a link: clicking it would reload and reconnect.
  const link = el(current ? 'div' : 'a', 'hud-room');
  if (current) {
    link.setAttribute('aria-current', 'page');
  } else {
    link.href = `/room/${room.id}`;
    link.onclick = (e) => {
      if (!okToLeave()) e.preventDefault();
    };
  }
  const count = hudCounts[room.id];
  const text = el('span', 'hud-count', count === undefined ? '' : count === 0 ? 'vazia' : `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`);
  if (count > 0 && !current) text.classList.add('online');
  link.append(el('span', 'hud-name ellipsis', displayRoomName(room.id)), text);
  const li = el('li');
  li.append(link);
  return li;
}

function renderHud() {
  $('hud-rooms').replaceChildren(...orderedRooms().map(hudItem));
}

async function updateHudCounts() {
  if (document.hidden) return;
  const fresh = await fetchRoomCounts(orderedRooms().map((r) => r.id));
  if (!fresh) return; // offline: keep the last numbers
  hudCounts = fresh;
  renderHud();
}


$('hud-new').onsubmit = (e) => {
  e.preventDefault();
  if (!okToLeave()) return;
  const id = newRoomId($('hud-new-name').value);
  location.assign(`/room/${id}`);
};

renderHud();
updateHudCounts();
setInterval(updateHudCounts, 15_000);
window.addEventListener('storage', renderHud); // changed from another tab

// ---------- convidar ----------

// Phones open the system share sheet (WhatsApp etc.); elsewhere a ready-made
// message goes to the clipboard.
async function invite() {
  const url = location.href;
  const text = isHomeRoom(roomId)
    ? 'Bora? Entra no meu Block do CPX Call:'
    : `Bora? Entra na sala ${roomName(roomId)} do CPX Call:`;
  if (navigator.share && mobile.matches) {
    try {
      await navigator.share({ title: 'CPX Call', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Convite copiado. É só colar na conversa.');
  } catch {
    window.prompt('Copie o convite:', `${text} ${url}`); // clipboard needs HTTPS
  }
}
$('invite').onclick = invite;

const notice = $('notice');
const RELOAD = { label: 'Entrar de novo', run: () => location.reload() };
let noticeAction = RELOAD.run;

function showNotice(title, text, action = RELOAD) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice-retry').textContent = action.label;
  noticeAction = action.run;
  if (!notice.open) notice.showModal();
}
notice.oncancel = (e) => e.preventDefault(); // nothing usable behind it
$('notice-retry').onclick = () => noticeAction();

