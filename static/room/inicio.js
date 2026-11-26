// ---------- início ----------

// "churrasco-k3f9x2": the name in bold, the random suffix (what keeps the
// room private) dimmed. A group room shows "Grupo · sala".
function paintRoomTag() {
  const tag = $('room-tag');
  const match = /^(.+)-([a-z0-9]{6})$/.exec(roomId);
  if (isGroupRoom(roomId) || !match) {
    tag.replaceChildren(el('b', null, displayRoomName(roomId)));
  } else {
    tag.replaceChildren(el('b', null, match[1]), el('span', null, `-${match[2]}`));
  }
  tag.title = displayRoomName(roomId);
  chatInput.placeholder = `Mensagem para ${displayRoomName(roomId)}`;
}
paintRoomTag();
window.addEventListener('groups-changed', () => {
  paintRoomTag();
  refresh();
});
if (!canShare) {
  document.body.classList.add('no-share');
  shareBtn.title = 'Compartilhar tela exige HTTPS ou localhost';
  $('empty-hint').textContent = 'Neste endereço o navegador não deixa compartilhar a tela (precisa de HTTPS ou localhost), mas você pode assistir.';
}
refresh();
let takeover = false;
try {
  takeover = sessionStorage.getItem('takeover') === '1';
  sessionStorage.removeItem('takeover');
} catch { /* storage blocked: no takeover */ }
whenAgeOk(() => (myNick ? enterRoom(takeover) : openProfile()));
