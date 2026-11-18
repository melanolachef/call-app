'use strict';

// STUN until /api/ice answers; with a TURN key the server adds Cloudflare TURN,
// which relays the video when a network blocks direct connections.
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceLoadedAt = 0;
const ICE_REFRESH_MS = 6 * 60 * 60_000; // credentials last a day; refresh well before

async function loadIceServers() {
  if (Date.now() - iceLoadedAt < ICE_REFRESH_MS) return;
  try {
    const res = await fetch('/api/ice', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    if (Array.isArray(data?.iceServers) && data.iceServers.length) {
      iceServers = data.iceServers;
      iceLoadedAt = Date.now();
    }
  } catch {
    // Keep STUN: direct connections still work for most networks.
  }
}
const roomId = location.pathname.split('/').pop();
const canShare = !!navigator.mediaDevices?.getDisplayMedia;

const shareBtn = $('share');

let ws = null; // set once we join; null means "not in the room yet"
let myId = null;
let myNick = load('nick');
let myPhoto = validPhoto(load('photo'));
let localTrack = null; // our screen's video track while sharing
let localAudio = null; // its sound (tab or system audio), when the browser gave one
let roomFull = false;
let maxPeers = 12; // the server sends the real limit in welcome/full
let left = false;
let timer = null;
// id -> { id, nick, pc, transceiver, queue, screen,
//         sharing (they share), iWatch (I watch them), watchesMe (they watch me) }
const peers = new Map();
const localScreen = buildScreen();


// Why the camera or microphone didn't open, in words that say what to do.
// "Permission" was the only message before, even when access was already
// granted and the device was simply busy in another app.
async function mediaErrorMessage(err, kind) {
  console.warn(kind, err);
  const what = kind === 'camera' ? 'a câmera' : 'o microfone';
  const What = kind === 'camera' ? 'A câmera' : 'O microfone';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError': {
      let granted = false;
      try {
        granted = (await navigator.permissions.query({ name: kind })).state === 'granted';
      } catch { /* the Permissions API doesn't know this name: assume the site prompt */ }
      return granted
        ? `O sistema está bloqueando ${what}. No Windows: Configurações › Privacidade e segurança › ${kind === 'camera' ? 'Câmera' : 'Microfone'}, e libere o acesso para aplicativos da área de trabalho.`
        : `Não deu para usar ${what}. Libere o acesso no cadeado ao lado do endereço e tente de novo.`;
    }
    case 'NotReadableError':
    case 'AbortError':
      return `${What} está sendo usad${kind === 'camera' ? 'a' : 'o'} por outro app (Discord, OBS, Teams, Zoom…). Feche esse app e tente de novo.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return kind === 'camera' ? 'Nenhuma câmera foi encontrada. Confira se ela está conectada.' : 'Nenhum microfone foi encontrado. Confira se ele está conectado.';
    default:
      return `Não deu para usar ${what} (${err?.name || 'erro desconhecido'}). Tente de novo.`;
  }
}
