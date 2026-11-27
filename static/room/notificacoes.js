// ---------- notificações ----------

// Optional (the bell in the top bar): a browser notification when someone starts
// sharing or writes in the chat while you are on another tab or window. Nothing
// is shown while you are looking at the room.
const NOTIFY_SUPPORTED = 'Notification' in window;
const NOTIFY_BODY_MAX = 120;
const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/></svg>';
const BELL_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4M4 4l16 16"/></svg>';
let notifyOn = NOTIFY_SUPPORTED && load('notify') === 'on' && Notification.permission === 'granted';

function renderNotify() {
  const button = $('notify-btn');
  button.hidden = !NOTIFY_SUPPORTED;
  button.innerHTML = notifyOn ? BELL : BELL_OFF; // fixed markup, no user text
  button.setAttribute('aria-pressed', String(notifyOn));
  const label = notifyOn ? 'Desligar avisos' : 'Ligar avisos de quem compartilha e de mensagens';
  button.setAttribute('aria-label', label);
  button.title = label;
}

async function toggleNotify() {
  if (notifyOn) {
    notifyOn = false;
  } else {
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') {
      toast('O navegador bloqueou os avisos. Libere no cadeado ao lado do endereço e tente de novo.', 7000);
      return;
    }
    notifyOn = true;
  }
  save('notify', notifyOn ? 'on' : '');
  renderNotify();
}

function notify(title, body, tag) {
  if (!notifyOn || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return; // you are already looking at it
  try {
    // Same tag replaces the previous one, so a busy chat is not a pile of popups.
    const note = new Notification(title, { body: Array.from(body).slice(0, NOTIFY_BODY_MAX).join(''), tag, icon: '/apple-touch-icon.png' });
    note.onclick = () => {
      window.focus();
      note.close();
    };
    setTimeout(() => note.close(), 8000);
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}

$('notify-btn').onclick = toggleNotify;
renderNotify();

// ---------- som de quem começa a transmitir ----------

// A short sound when someone starts sharing their screen (rising) or stops
// (falling), so whoever is gaming notices without looking. Not while you
// silenced everyone (Fone), and not for the shares already running when you
// arrive or reconnect. Can be turned off in Configurações › Notificações.
let shareSoundOn = load('shareSound') !== 'off';
let lastWelcomeAt = 0; // set on every (re)join: the shares announced then are not news
let alertCtx = null;

function setShareSound(on) {
  shareSoundOn = on;
  save('shareSound', on ? '' : 'off');
}

function shareSound(started) {
  if (!shareSoundOn || voice.deafened || Date.now() - lastWelcomeAt < 4000) return;
  const ctx = voice.ctx ?? (alertCtx ??= new AudioContext());
  ctx.resume().catch(() => {});
  const t = ctx.currentTime;
  const notes = started ? [[587, 0], [740, 0.09], [988, 0.18]] : [[740, 0], [494, 0.1]];
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + notes.at(-1)[1] + 0.25);
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(t + at);
    osc.stop(t + at + 0.16);
  }
}
