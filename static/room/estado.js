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

