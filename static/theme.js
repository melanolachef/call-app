'use strict';

// Applies the saved appearance (accent color, theme, background) before the
// page paints, so the default look never flashes. Loaded in <head> by both
// pages; the editing dialog lives in common.js. Everything is static CSS: no
// blur, no animation, nothing that costs per frame (the app is for gamers).

const THEME_VARS = ['--bg', '--card', '--raised', '--frame', '--border', '--border-strong'];
const THEMES = {
  escuro: {},
  amoled: { '--bg': '#000000', '--card': '#0B0B0E', '--raised': '#17181D', '--frame': '#0F1014', '--border': '#1C1D24', '--border-strong': '#262833' },
  'meia-noite': { '--bg': '#0A0F1F', '--card': '#111933', '--raised': '#1A2444', '--frame': '#141D38', '--border': '#1E2A4A', '--border-strong': '#2A3A60' },
};
const BACKGROUNDS = {
  aurora: 'radial-gradient(circle at 15% 20%, rgb(124 92 255 / .38), transparent 45%), radial-gradient(circle at 85% 25%, rgb(59 217 138 / .22), transparent 40%), radial-gradient(circle at 50% 95%, rgb(59 130 246 / .28), transparent 50%)',
  'por-do-sol': 'linear-gradient(160deg, #1d0d2b 0%, #4a1838 45%, #8f3a2c 100%)',
  oceano: 'linear-gradient(160deg, #03141c 0%, #08354a 50%, #0b5561 100%)',
};
const DEFAULT_APPEARANCE = { accent: '#7C5CFF', theme: 'escuro', background: 'none' };

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
