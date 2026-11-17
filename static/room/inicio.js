// ---------- início ----------

$('room-tag').textContent = `# ${displayRoomName(roomId)}`;
$('room-title').textContent = isHomeRoom(roomId) ? 'Block' : `Sala ${roomName(roomId)}`;
if (!canShare) {
  shareBtn.title = 'Compartilhar tela exige HTTPS ou localhost';
  $('empty-hint').textContent = 'Neste endereço o navegador não deixa compartilhar a tela (precisa de HTTPS ou localhost), mas você pode assistir.';
}
refresh();
let takeover = false;
try {
  takeover = sessionStorage.getItem('takeover') === '1';
  sessionStorage.removeItem('takeover');
} catch { /* storage blocked: no takeover */ }
if (myNick) enterRoom(takeover); else openProfile();
