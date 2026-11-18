// ---------- qualidade da conexão (ping) ----------

// A signal icon at the top of the room: hover (or focus) shows the round-trip
// time to each person, from the connection's own stats. The color follows the
// worst one: green under 80 ms, yellow under 200 ms, red above. Measured every
// 2 s while the tab is visible; while you share, only every 10 s (each read is
// a full stats report per person, on the PC that is also running the game,
// #75), unless the tooltip is open.
// Idea and first version by Sydowz (#69), moved to the split room script.

async function measureRtt(pc) {
  if (pc.connectionState !== 'connected') return null;
  let rtt = null;
  (await pc.getStats()).forEach((s) => {
    if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')) && typeof s.currentRoundTripTime === 'number') {
      rtt = Math.round(s.currentRoundTripTime * 1000);
    }
  });
  return rtt;
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
  for (const peer of [...peers.values()].sort((a, b) => a.id - b.id)) {
    let rtt = null;
    try {
      rtt = await measureRtt(peer.pc);
    } catch { /* closed meanwhile */ }
    if (rtt !== null) rows.push({ name: displayName(peer), rtt });
  }
  net.hidden = rows.length === 0;
  if (!rows.length) return;
  const worst = Math.max(...rows.map((r) => r.rtt));
  net.className = `net ${worst < 80 ? 'good' : worst < 200 ? 'mid' : 'bad'}`;
  $('net-tip').replaceChildren(...rows.map((r) => {
    const row = el('div', 'net-row');
    row.append(el('span', 'ellipsis', r.name), el('strong', null, `${r.rtt} ms`));
    return row;
  }));
  net.setAttribute('aria-label', `Ping: ${rows.map((r) => `${r.name} ${r.rtt} ms`).join(', ')}`);
}
setInterval(updatePing, PING_EVERY_MS);
