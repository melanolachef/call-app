// ---------- emojis no chat ----------

// A small built-in picker (no library): the most used emojis in a few tabs, plus
// your recent ones (kept only in this browser). Picking inserts the emoji at the
// cursor; the message itself is still plain text, relayed like any other.
const EMOJI_TABS = [
  { label: 'Rostos', icon: '😀', list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 😌 😔 😪 😴 😷 🤒 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 🤡 👻 👽 🤖 💩' },
  { label: 'Gestos', icon: '👍', list: '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 ✋ 🖖 👏 🙌 🫶 👐 🤲 🤝 🙏 💪 🫡 🤷 🤦 🙋 🙇 👀 🧠 🫠' },
  { label: 'Corações', icon: '❤️', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💤 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🎁 🏆 🥇 🥈 🥉' },
  { label: 'Jogos', icon: '🎮', list: '🎮 🕹️ 👾 🎲 🃏 ♟️ 🎯 🎳 ⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🥊 🏎️ 🚗 🚀 ✈️ 🗡️ ⚔️ 🛡️ 🏹 🔫 💣 🧨 🪙 💰 💎 🎧 🎤 🎵 🎶 📺 💻 🖥️ ⌨️ 🖱️ 📱 📸 🍿' },
  { label: 'Comida', icon: '🍕', list: '🍕 🍔 🍟 🌭 🥪 🌮 🌯 🍝 🍜 🍣 🍱 🥟 🍗 🥩 🥓 🍳 🧀 🥗 🍿 🍩 🍪 🎂 🍰 🍫 🍬 🍭 🍦 🍉 🍓 🍌 🍎 🥑 🌶️ ☕ 🍺 🍻 🥂 🍷 🥃 🧃 🥤 🧉' },
];
const EMOJI_RECENT_MAX = 18;
const emojiBtn = $('emoji-btn');
const emojiPop = $('emoji-pop');
const emojiGrid = $('emoji-grid');
const emojiTabs = $('emoji-tabs');
let emojiTab = 0;

function recentEmojis() {
  try {
    const list = JSON.parse(load('emoji-recent') || '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string').slice(0, EMOJI_RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji) {
  const list = [emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, EMOJI_RECENT_MAX);
  save('emoji-recent', JSON.stringify(list));
}

// Tab -1 is "Recentes" (only offered once there is something in it).
function showEmojiTab(index) {
  const recent = recentEmojis();
  emojiTab = index === -1 && !recent.length ? 0 : index;
  const list = emojiTab === -1 ? recent : EMOJI_TABS[emojiTab].list.split(' ');
  emojiGrid.replaceChildren(...list.map((emoji) => {
    const button = el('button', 'emoji-choice', emoji);
    button.type = 'button';
    button.setAttribute('aria-label', emoji);
    return button;
  }));
  emojiTabs.replaceChildren(...[
    ...(recent.length ? [{ label: 'Recentes', icon: '🕘', index: -1 }] : []),
    ...EMOJI_TABS.map((tab, i) => ({ ...tab, index: i })),
  ].map((tab) => {
    const button = el('button', 'emoji-tab', tab.icon);
    button.type = 'button';
    button.title = tab.label;
    button.setAttribute('aria-label', tab.label);
    button.setAttribute('aria-pressed', String(tab.index === emojiTab));
    button.onclick = () => showEmojiTab(tab.index);
    return button;
  }));
}

function setEmojiPicker(open) {
  emojiPop.hidden = !open;
  emojiBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  showEmojiTab(recentEmojis().length ? -1 : emojiTab);
  const rect = emojiBtn.getBoundingClientRect();
  const width = emojiPop.offsetWidth;
  const left = Math.min(Math.max(8, rect.right - width), innerWidth - width - 8);
  emojiPop.style.left = `${left}px`;
  emojiPop.style.bottom = `${innerHeight - rect.top + 8}px`;
}

function insertEmoji(emoji) {
  if (chatInput.disabled) return;
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  const value = chatInput.value.slice(0, start) + emoji + chatInput.value.slice(end);
  if (value.length > chatInput.maxLength) return;
  chatInput.value = value;
  const caret = start + emoji.length;
  chatInput.setSelectionRange(caret, caret);
  rememberEmoji(emoji);
}

// Clicking keeps the picker open (to pick several); Escape or clicking outside closes it.
emojiGrid.onclick = (e) => {
  const button = e.target.closest('.emoji-choice');
  if (!button) return;
  insertEmoji(button.textContent);
  if (!mobile.matches) chatInput.focus(); // on phones, focusing would pop the keyboard over the picker
};
emojiBtn.onclick = () => setEmojiPicker(emojiPop.hidden);
document.addEventListener('pointerdown', (e) => {
  if (!emojiPop.hidden && !emojiPop.contains(e.target) && !emojiBtn.contains(e.target)) setEmojiPicker(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !emojiPop.hidden) {
    setEmojiPicker(false);
    chatInput.focus();
  }
});

// A message made only of a few emojis is shown big, as in Discord.
const JUMBO_MAX = 10;
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[‍️]|\s)+$/u;
function isJumbo(text) {
  if (!ONLY_EMOJI.test(text) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return false;
  const visible = text.replace(/\s/g, '');
  const count = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter().segment(visible)].length
    : Array.from(visible).length;
  return count <= JUMBO_MAX;
}
