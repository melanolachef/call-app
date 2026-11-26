'use strict';

// Settings as a page of their own (docs/design/cpx-call-novas-telas.html,
// "Configurações"), instead of dialogs spread around: a list of sections on
// the left, one section on the right, Esc to leave. Sections reuse the
// controls that already exist (appearance, voice, quality, sounds): they are
// moved in while the section is open and back when it closes, so the old
// shortcuts keep working and nothing is written twice.
//
// The room adds its own sections (voice, sharing, sounds, notifications)
// with registerSettings(); in the lobby those explain where to find them.

const SETTINGS_NAV = [
  ['Você', [['perfil', 'Perfil'], ['amigos', 'Amigos e privacidade']]],
  ['App', [['voz', 'Voz'], ['transmissao', 'Transmissão'], ['sons', 'Sons'], ['notificacoes', 'Notificações'], ['aparencia', 'Aparência']]],
  ['Mais', [['windows', 'App para Windows'], ['apoiar', 'Apoiar o CPX Call'], ['sobre', 'Sobre']]],
];
const settingsSections = {};
let settingsOpen = null; // id of the section on screen
let settingsLeave = null; // undoes what the open section borrowed

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="settings" class="settings-page" aria-label="Configurações">
    <div class="settings-shell">
      <nav class="settings-nav" aria-label="Configurações"><div class="settings-nav-inner" id="settings-nav"></div></nav>
      <div class="settings-main">
        <main class="settings-content" id="settings-content"></main>
        <div class="settings-close">
          <button type="button" class="settings-x" id="settings-x" aria-label="Fechar configurações"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          <span class="mono">ESC</span>
        </div>
      </div>
    </div>
  </dialog>`);

function registerSettings(id, section) {
  settingsSections[id] = section;
  if (settingsOpen === id) showSettings(id);
}

// ---------- peças ----------

function settingsHead(title, subtitle) {
  const head = el('div', 'settings-head');
  head.append(el('h1', null, title));
  if (subtitle) head.append(el('p', null, subtitle));
  return head;
}

// A row: title and description on the left, the control on the right.
function settingsRow(title, description, ...controls) {
  const row = el('div', 'settings-row');
  const text = el('div', 'settings-row-text');
  text.append(el('span', 'settings-row-title', title));
  if (description) text.append(el('span', 'settings-row-desc', description));
  row.append(text, ...controls);
  return row;
}

function settingsSwitch(checked, label, onChange) {
  const input = el('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.className = 'settings-switch';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  input.onchange = () => onChange(input.checked);
  return input;
}

function settingsButton(text, onClick, cls = '') {
  const button = el('button', `btn small ${cls}`.trim(), text);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function settingsLink(text, href) {
  const a = el('a', 'btn small', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

// Moves `nodes` into `box` and returns a function that puts them back.
function borrowNodes(nodes, box) {
  const places = nodes.map((node) => [node, node.parentNode, node.nextSibling]);
  nodes.forEach((node) => box.append(node));
  return () => {
    for (const [node, parent, next] of places.reverse()) parent.insertBefore(node, next);
  };
}

// Where a room-only section points to, in the lobby.
function inRoomOnly(title, text) {
  return {
    title,
    render(box) {
      box.append(settingsHead(title, text), el('p', 'settings-note', 'Entre numa sala e abra as configurações por lá (engrenagem ao lado do seu nome).'));
    },
  };
}

// ---------- seções comuns ----------

registerSettings('perfil', {
  title: 'Perfil',
  render(box) {
    box.append(settingsHead('Perfil', 'Como seus amigos te veem nas salas.'));
    const card = el('div', 'settings-profile');
    const banner = el('div', 'banner settings-profile-banner');
    paintBanner(banner, validBannerColor(load('bannerColor')), validBannerImage(load('bannerImage')));
    const face = el('div', 'avatar big');
    paintAvatar(face, load('nick') || '?', 1, validPhoto(load('photo')));
    const who = el('div', 'settings-profile-who');
    who.append(el('strong', null, load('nick') || 'Sem nick ainda'));
    if (account?.signedIn && account.username) who.append(el('span', 'muted', `@${account.username}`));
    card.append(banner, face, who);
    box.append(card, settingsRow('Nick, foto e banner', 'Aparecem para quem está na sala com você.', settingsButton('Editar perfil', () => {
      closeSettings();
      $('edit').click();
    })));
    // The account part of the profile dialog, while this section is open.
    const accountBox = $('account-box');
    if (account && accountBox) {
      const holder = el('div', 'settings-account');
      box.append(holder);
      const putBack = borrowNodes([accountBox], holder);
      return putBack;
    }
    return null;
  },
});

registerSettings('amigos', {
  title: 'Amigos e privacidade',
  render(box) {
    box.append(settingsHead('Amigos e privacidade', 'Quem vê onde você está.'));
    box.append(settingsRow('Ficar invisível', 'Seus amigos não veem que você está online nem em qual sala.',
      settingsSwitch(isInvisible(), 'Ficar invisível', (on) => setInvisible(on))));
    box.append(settingsRow('Amigos e pedidos', 'Adicionar por @usuário ou código, aceitar pedidos, conversar.',
      settingsButton('Abrir amigos', () => {
        closeSettings();
        openFriendsDialog();
      })));
    if (account?.signedIn && account.username) {
      box.append(settingsRow('Seu link de amizade', `${location.host}/?u=${account.username}`,
        settingsButton('Copiar', () => copyText(`${location.origin}/?u=${account.username}`, 'Link copiado.'))));
    }
    box.append(settingsRow('O que guardamos', 'O CPX Call guarda o mínimo. Veja o que e por quanto tempo.',
      settingsLink('Privacidade', '/privacidade'), settingsLink('Termos', '/termos')));
    return null;
  },
});

registerSettings('aparencia', {
  title: 'Aparência',
  render(box) {
    box.append(settingsHead('Aparência', 'Só muda para você, neste aparelho.'));
    renderAppearance();
    const parts = [...$('appearance').querySelectorAll('.ap-section'), $('ap-reset')];
    const holder = el('div', 'settings-appearance');
    box.append(holder);
    return borrowNodes(parts, holder);
  },
});

registerSettings('windows', {
  title: 'App para Windows',
  render(box) {
    box.append(settingsHead('App para Windows', 'O CPX Call em janela própria, com atalho de voz que funciona com o jogo aberto.'));
    if (window.__TAURI__) {
      box.append(el('p', 'settings-note', 'Você já está usando o app.'));
    } else {
      box.append(settingsRow('Baixar', 'Para Windows 10 e 11. Depois de instalar, ele abre sozinho com o seu perfil.',
        settingsLink('Baixar o app', 'https://github.com/melanolachef/call-app/releases/latest/download/CPX-Call-Windows.exe')));
    }
    return null;
  },
});

registerSettings('apoiar', {
  title: 'Apoiar o CPX Call',
  render(box) {
    box.append(settingsHead('Apoiar o CPX Call', 'Sem anúncio: a galera ajuda a pagar o servidor.'));
    box.append(settingsRow('Pix', 'Qualquer valor, quando quiser. Não muda nada no app.', settingsLink('Apoiar', '/apoiar')));
    return null;
  },
});

registerSettings('sobre', {
  title: 'Sobre',
  render(box) {
    box.append(settingsHead('Sobre', 'Para assistir os amigos jogando, junto.'));
    box.append(settingsRow('Código aberto', 'Licença MIT, no GitHub.', settingsLink('GitHub', 'https://github.com/melanolachef/call-app')));
    box.append(settingsRow('Privacidade e termos', null, settingsLink('Privacidade', '/privacidade'), settingsLink('Termos', '/termos')));
    box.append(settingsRow('Contato', 'Dúvidas, ideias e denúncias.', settingsLink('cpxcallcontato@gmail.com', 'mailto:cpxcallcontato@gmail.com')));
    return null;
  },
});

// Lobby placeholders; the room registers the real ones (room/ajustes.js).
registerSettings('voz', inRoomOnly('Voz', 'Microfone, supressão de ruído e apertar para falar.'));
registerSettings('transmissao', inRoomOnly('Transmissão', 'Qualidade de quando você compartilha a tela.'));
registerSettings('sons', inRoomOnly('Sons', 'Os sons do seu soundpad.'));
registerSettings('notificacoes', inRoomOnly('Notificações', 'Avisos de quem começa a compartilhar e de mensagens.'));

// ---------- abrir e fechar ----------

function renderSettingsNav() {
  $('settings-nav').replaceChildren(...SETTINGS_NAV.flatMap(([group, items]) => [
    el('div', 'settings-group', group),
    ...items.map(([id, label]) => {
      const button = el('button', 'settings-link', label);
      button.type = 'button';
      if (id === settingsOpen) button.setAttribute('aria-current', 'page');
      button.onclick = () => showSettings(id);
      return button;
    }),
  ]));
}

function showSettings(id) {
  settingsLeave?.();
  settingsLeave = null;
  settingsOpen = settingsSections[id] ? id : 'perfil';
  const box = el('div', 'settings-section');
  $('settings-content').replaceChildren(box);
  settingsLeave = settingsSections[settingsOpen].render(box) || null;
  renderSettingsNav();
}

function openSettings(id = 'perfil') {
  const dialog = $('settings');
  if (!dialog.open) dialog.showModal();
  showSettings(id);
}

function closeSettings() {
  if ($('settings').open) $('settings').close();
}

$('settings').onclose = () => {
  settingsLeave?.();
  settingsLeave = null;
  settingsOpen = null;
  $('settings-content').replaceChildren();
};
$('settings-x').onclick = closeSettings;
// The profile dialog's old "Personalizar aparência" now opens this page.
$('open-appearance').onclick = () => {
  $('profile').close();
  openSettings('aparencia');
};
