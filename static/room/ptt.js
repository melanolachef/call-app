// ---------- apertar para falar ----------

// Optional, in the voice settings. While it is on, the mic only sends while the
// key (or the mic button) is held; the track just flips enabled, so nothing renegotiates.
const PTT_TAIL_MS = 180; // keeps sending a moment after release so word endings are not clipped
const MODIFIER_KEY = /^(Control|Shift|Alt|Meta)(Left|Right)$/;
let pttTail = null;
let pttCapturing = false;

function pttKeyName(code = voice.pttKey) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Space') return 'Espaço';
  return code.replace(/(Left|Right)$/, ' $1').replace('Left', 'esq.').replace('Right', 'dir.');
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function pttChanged() {
  applyTrackEnabled();
  for (const id of ['mic', 'me-mic']) $(id).classList.toggle('talking', voice.pttHeld);
  updateSpeaking();
}

function pttDown() {
  if (!voice.joined || !voice.ptt || voice.muted || voice.deafened) return;
  clearTimeout(pttTail);
  if (voice.pttHeld) return;
  voice.pttHeld = true;
  pttChanged();
}

function pttUp(immediately = false) {
  clearTimeout(pttTail);
  const release = () => {
    if (!voice.pttHeld) return;
    voice.pttHeld = false;
    pttChanged();
  };
  if (immediately) release(); else pttTail = setTimeout(release, PTT_TAIL_MS);
}

document.addEventListener('keydown', (e) => {
  if (pttCapturing) return; // the settings are choosing a new key
  if (e.code !== voice.pttKey || !voice.joined || !voice.ptt) return;
  if (isTyping(e.target) || $('voice-settings').open) return;
  if (!MODIFIER_KEY.test(e.code) && (e.ctrlKey || e.altKey || e.metaKey)) return; // Ctrl+V and friends
  e.preventDefault(); // Space must not scroll or click a focused button
  if (!e.repeat) pttDown();
});
document.addEventListener('keyup', (e) => {
  if (e.code === voice.pttKey && voice.pttHeld) pttUp();
});
// Never leave the mic open if the key release happens while we cannot see it.
window.addEventListener('blur', () => pttUp(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) pttUp(true); });

// The mic buttons work as "hold to talk" too (phones have no keyboard).
for (const id of ['mic', 'me-mic']) {
  const button = $(id);
  button.addEventListener('pointerdown', () => pttDown());
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, () => pttUp());
}

// ---------- push-to-talk nas configurações ----------

function renderPttSettings() {
  $('vs-ptt').checked = voice.ptt;
  $('vs-ptt-row').hidden = !voice.ptt;
  $('vs-ptt-key').textContent = pttCapturing ? 'Aperte uma tecla…' : pttKeyName();
}

$('vs-ptt').onchange = () => {
  voice.ptt = $('vs-ptt').checked;
  save('ptt', voice.ptt ? 'on' : '');
  voice.pttHeld = false;
  pttChanged();
  renderPttSettings();
  refresh();
};

$('vs-ptt-key').onclick = () => {
  pttCapturing = true;
  renderPttSettings();
};
// Capture phase, so it also wins over the dialog's own Esc handling.
document.addEventListener('keydown', (e) => {
  if (!pttCapturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code !== 'Escape') {
    voice.pttKey = e.code;
    save('pttKey', e.code);
  }
  pttCapturing = false;
  renderPttSettings();
  refresh();
}, true);
