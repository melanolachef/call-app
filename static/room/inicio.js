// ---------- início ----------

// "churrasco-k3f9x2": the name in bold, the random suffix (what keeps the
// room private) dimmed. The fixed room just shows its name.
(() => {
  const tag = $('room-tag');
  const match = /^(.+)-([a-z0-9]{6})$/.exec(roomId);
  if (isHomeRoom(roomId) || !match) {
    tag.append(el('b', null, displayRoomName(roomId)));
  } else {
    tag.append(el('b', null, match[1]), el('span', null, `-${match[2]}`));
  }
  tag.title = displayRoomName(roomId);
})();
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
