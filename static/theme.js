'use strict';

// Applies the saved appearance (accent color, theme, background) before the
// page paints, so the default look never flashes. Loaded in <head> by both
// pages; the editing dialog lives in common.js. Everything is static CSS: no
// blur, no animation, nothing that costs per frame (the app is for gamers).
// The end of the file draws the Windows app's title bar.

const THEME_VARS = ['--bg', '--card', '--raised', '--raised-2', '--frame', '--border', '--border-strong'];
const THEMES = {
  escuro: {}, // the design: black with grey cards
  grafite: { '--bg': '#141416', '--card': '#232326', '--raised': '#323236', '--raised-2': '#424247', '--frame': '#18181B', '--border': '#323236', '--border-strong': '#45454A' },
  'meia-noite': { '--bg': '#0A0F1F', '--card': '#111933', '--raised': '#1A2444', '--raised-2': '#243056', '--frame': '#0D1428', '--border': '#1E2A4A', '--border-strong': '#2A3A60' },
};
const BACKGROUNDS = {
  aurora: 'radial-gradient(circle at 15% 20%, rgb(124 92 255 / .38), transparent 45%), radial-gradient(circle at 85% 25%, rgb(59 217 138 / .22), transparent 40%), radial-gradient(circle at 50% 95%, rgb(59 130 246 / .28), transparent 50%)',
  'por-do-sol': 'linear-gradient(160deg, #1d0d2b 0%, #4a1838 45%, #8f3a2c 100%)',
  oceano: 'linear-gradient(160deg, #03141c 0%, #08354a 50%, #0b5561 100%)',
};
const DEFAULT_APPEARANCE = { accent: '#0A84FF', theme: 'escuro', background: 'none' };

function loadAppearance() {
  try {
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(localStorage.getItem('appearance') || '{}') };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

// Text on the accent: white while it keeps at least 3:1 contrast (enough for
// bold button labels, and it keeps the design's white-on-purple), otherwise
// near-black (yellow, green, cyan, orange...).
function onAccent(hex) {
  const lin = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return 1.05 / (l + 0.05) >= 3 ? '#FFFFFF' : '#0B0C10';
}

function applyAppearance(appearance = loadAppearance()) {
  const root = document.documentElement;
  const accent = /^#[0-9a-f]{6}$/i.test(appearance.accent) ? appearance.accent : DEFAULT_APPEARANCE.accent;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--on-accent', onAccent(accent));
  for (const name of THEME_VARS) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(THEMES[appearance.theme] ?? {})) root.style.setProperty(name, value);
  let image = BACKGROUNDS[appearance.background] ?? '';
  if (appearance.background === 'image') {
    try {
      const url = localStorage.getItem('appearance-image') || '';
      // Only our own resized JPEG: safe inside url("") (base64 characters only).
      if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(url)) image = `url("${url}")`;
    } catch { /* storage blocked */ }
  }
  root.style.setProperty('--bg-image', image || 'none');
  root.classList.toggle('has-bg', !!image);
}

applyAppearance();

// ---------- title bar of the Windows app ----------

// Inside the app (desktop/), the page draws the window's title bar so it
// follows the theme. The app keeps the native bar until the page asks for it
// to go (`window_control('enable')`); an older app answers with an error and
// keeps its bar, so the window never ends up with two bars or none. The class
// is set right away when this tab already had the bar (lobby → room), so the
// layout doesn't jump on every page.
(() => {
  const app = window.__TAURI__?.core;
  if (!app) return;
  const root = document.documentElement;
  const control = (action) => app.invoke('window_control', { action });
  const remember = (on) => { try { sessionStorage.setItem('app-titlebar', on ? '1' : ''); } catch { /* storage blocked */ } };
  try { if (sessionStorage.getItem('app-titlebar')) root.classList.add('app-titlebar'); } catch { /* storage blocked */ }

  const svg = (path) => `<svg viewBox="0 0 10 10" aria-hidden="true">${path}</svg>`;
  const ICON_MAXIMIZE = svg('<rect x=".5" y=".5" width="9" height="9"/>');
  const ICON_RESTORE = svg('<path d="M2.5 2.5V.5h7v7h-2"/><rect x=".5" y="2.5" width="7" height="7"/>');
  let maxButton = null;
  let isMaximized = false;
  const showState = (maximized) => {
    isMaximized = maximized;
    if (!maxButton) return;
    maxButton.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
    maxButton.setAttribute('aria-label', maximized ? 'Restaurar' : 'Maximizar');
    maxButton.title = maxButton.getAttribute('aria-label');
  };
  const run = (action) => control(action).then(showState).catch((err) => console.warn('app', err));

  function build() {
    const bar = document.createElement('div');
    bar.className = 'titlebar';
    bar.innerHTML = `<span class="titlebar-name">CPX Call</span>
      <button type="button" data-action="minimize" aria-label="Minimizar" title="Minimizar">${svg('<path d="M0 5h10"/>')}</button>
      <button type="button" data-action="toggle_maximize"></button>
      <button type="button" class="close" data-action="close" aria-label="Fechar" title="Fechar">${svg('<path d="M.5.5l9 9M9.5.5l-9 9"/>')}</button>`;
    maxButton = bar.querySelector('[data-action="toggle_maximize"]');
    bar.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (button) run(button.dataset.action);
    });
    // Dragging the empty bar moves the window; double-click maximizes, like
    // the native bar. The drag must start while the button is down.
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      run(e.detail === 2 ? 'toggle_maximize' : 'drag');
    });
    // Maximized by Win+↑, a snap or the taskbar: the icon follows.
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => run('state'), 150);
    });
    document.body.prepend(bar);
    showState(isMaximized);
  }

  control('enable').then((maximized) => {
    root.classList.add('app-titlebar');
    remember(true);
    showState(maximized);
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  }).catch((err) => {
    root.classList.remove('app-titlebar');
    remember(false);
    console.warn('app', err);
  });
})();
