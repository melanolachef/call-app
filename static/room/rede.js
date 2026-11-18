// ---------- qualidade da conexão (ping) ----------

// A signal icon at the top of the room: hover (or focus) shows the round-trip
// time to each person, from the connection's own stats. The color follows the
// worst one: green under 80 ms, yellow under 200 ms, red above. Measured every
// 2 s while the tab is visible; while you share, only every 10 s (each read is
// a full stats report per person, on the PC that is also running the game,
// #75), unless the tooltip is open.
// Idea and first version by Sydowz (#69), moved to the split room script.

// Round-trip time of the pair in use, and whether it goes through the TURN
// relay (a network that blocks direct connections) instead of peer to peer.
async function measureRtt(pc, peer) {
  if (pc.connectionState !== 'connected') return null;
  let rtt = null;
  let local = null;
  const report = await pc.getStats();
  report.forEach((s) => {
    if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')) && typeof s.currentRoundTripTime === 'number') {
      rtt = Math.round(s.currentRoundTripTime * 1000);
      local = report.get(s.localCandidateId);
    }
  });
  if (peer && local) peer.relayNow = local.candidateType === 'relay';
  return rtt;
}

// Bars for the people list: 3 under 80 ms, 2 under 200 ms, 1 above. A
// failed connection shows "sem P2P" instead (interface.js).
function p2pLevel(rtt) {
  return rtt === null ? 0 : rtt < 80 ? 3 : rtt < 200 ? 2 : 1;
}

const PING_EVERY_MS = 2000;
const PING_SHARING_EVERY_MS = 10_000;
let lastPing = 0;

async function updatePing() {
  if (document.hidden) return;
  const net = $('net');
  const looking = net.matches(':hover, :focus');
  if (localTrack && !looking && Date.now() - lastPing < PING_SHARING_EVERY_MS) return;
  lastPing = Date.now();
  const rows = [];
  let changed = false;
  for (const peer of [...peers.values()].sort((a, b) => a.id - b.id)) {
    let rtt = null;
    try {
      rtt = await measureRtt(peer.pc, peer);
    } catch { /* closed meanwhile */ }
    if (rtt !== null) rows.push({ name: displayName(peer), rtt, relay: !!peer.relayNow });
    const level = p2pLevel(rtt);
    if (level !== (peer.p2p ?? 0) || !!peer.relayNow !== !!peer.relay) {
      peer.p2p = level;
      peer.relay = !!peer.relayNow;
      changed = true;
    }
  }
  if (changed) refresh();
  net.hidden = rows.length === 0;
  if (!rows.length) return;
  const worst = Math.max(...rows.map((r) => r.rtt));
  net.className = `net ${worst < 80 ? 'good' : worst < 200 ? 'mid' : 'bad'}`;
  $('net-tip').replaceChildren(...rows.map((r) => {
    const row = el('div', 'net-row');
    row.append(el('span', 'ellipsis', r.name), el('strong', null, `${r.rtt} ms${r.relay ? ' · relay' : ''}`));
    return row;
  }));
  net.setAttribute('aria-label', `Ping: ${rows.map((r) => `${r.name} ${r.rtt} ms`).join(', ')}`);
}
setInterval(updatePing, PING_EVERY_MS);
