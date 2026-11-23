// ---------- reações ----------

// Quick emoji reactions: a button in the bottom bar opens a small picker, and the
// pick floats up over the room for everyone. They go through the same signaling
// relay as the chat (nothing stored), so the server needs no change. Only emojis
// from this list are ever shown, whatever arrives.
const REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '🙏', '👀', '🤔', '💀'];
const REACT_COOLDOWN_MS = 250; // yours: no flooding by holding the mouse down
const REACT_PEER_GAP_MS = 150; // theirs: ignore anyone sending faster than a human can
const REACT_MAX_FLOATING = 30;
const REACT_LIFETIME_MS = 2800;
const reactBtn = $('react-btn');
const reactPop = $('react-pop');
const reactLayer = $('react-layer');
let lastReactAt = 0;

function floatReaction(name, emoji) {
  if (reactLayer.childElementCount >= REACT_MAX_FLOATING) return;
  const node = el('div', 'float-react');
  node.style.setProperty('--x', `${10 + Math.random() * 80}%`);
  node.style.setProperty('--drift', `${Math.round(Math.random() * 60 - 30)}px`);
  node.append(el('span', 'float-emoji', emoji), el('span', 'float-name', name));
  reactLayer.append(node);
  setTimeout(() => node.remove(), REACT_LIFETIME_MS + 200); // also covers browsers that skip the animation
}

function sendReaction(emoji) {
  const now = Date.now();
  if (!REACTIONS.includes(emoji) || now - lastReactAt < REACT_COOLDOWN_MS) return;
  lastReactAt = now;
  peers.forEach((peer) => send(peer.id, { reaction: emoji }));
  floatReaction('Você', emoji);
}

function handleReaction(peer, data) {
  const now = Date.now();
  if (typeof data.reaction !== 'string' || !REACTIONS.includes(data.reaction)) return;
  if (now - (peer.lastReaction ?? 0) < REACT_PEER_GAP_MS) return;
  peer.lastReaction = now;
  floatReaction(displayName(peer), data.reaction);
}

// Opens over the bar button, or beside another one (the rail over a
// fullscreen picture on phones).
function setReactPicker(open, anchor = reactBtn) {
  reactPop.hidden = !open;
  reactBtn.setAttribute('aria-expanded', String(open && anchor === reactBtn));
  if (!open) return;
  const rect = anchor.getBoundingClientRect();
  const width = reactPop.offsetWidth;
  if (anchor === reactBtn) {
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8);
    reactPop.style.left = `${left}px`;
    reactPop.style.bottom = `${innerHeight - rect.top + 10}px`;
  } else {
    reactPop.style.left = `${Math.max(8, rect.left - width - 10)}px`;
    reactPop.style.bottom = `${Math.max(8, innerHeight - rect.bottom)}px`;
  }
}

for (const emoji of REACTIONS) {
  const button = el('button', 'react-choice', emoji);
  button.type = 'button';
  button.setAttribute('aria-label', `Reagir com ${emoji}`);
  button.onclick = () => {
    sendReaction(emoji);
    setReactPicker(false);
  };
  reactPop.append(button);
}

reactBtn.onclick = () => setReactPicker(reactPop.hidden);
document.addEventListener('pointerdown', (e) => {
  if (!reactPop.hidden && !reactPop.contains(e.target) && !reactBtn.contains(e.target) && !e.target.closest('.react-anchor')) setReactPicker(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !reactPop.hidden) {
    setReactPicker(false);
    reactBtn.focus();
  }
});
