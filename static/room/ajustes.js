// ---------- configurações da sala (configuracoes.js) ----------

// In the room, the settings page gets the real controls: the voice dialog's
// fields (with the input meter), the sharing quality box, the soundpad and
// the notification switch. They are borrowed while the section is open.

registerSettings('voz', {
  title: 'Voz',
  render(box) {
    box.append(settingsHead('Voz', 'Valem para este navegador.'));
    renderVoiceSettings();
    const fields = [...$('voice-settings').querySelectorAll('.dialog-body > .field, .dialog-body > .switch-row')];
    const holder = el('div', 'settings-borrowed');
    box.append(holder);
    const putBack = borrowNodes(fields, holder);
    startVoicePreview();
    return () => {
      stopVoicePreview();
      putBack();
    };
  },
});

registerSettings('transmissao', {
  title: 'Transmissão',
  render(box) {
    box.append(settingsHead('Transmissão', 'A qualidade de quando você compartilha a tela. Vale na hora, também durante a transmissão.'));
    const parts = [...qualityPop.children].filter((node) => node.id !== 'q-title');
    const holder = el('div', 'settings-borrowed settings-quality');
    box.append(holder);
    const putBack = borrowNodes(parts, holder);
    renderQualityPicker(); // once the controls are here (the popup is hidden)
    return putBack;
  },
});

registerSettings('sons', {
  title: 'Sons',
  render(box) {
    box.append(settingsHead('Sons', 'Seu soundpad: todo mundo na voz ouve. Os sons ficam só neste navegador.'));
    renderSoundpad();
    const parts = [...soundPop.children].filter((node) => !node.classList.contains('sheet-react'));
    const holder = el('div', 'settings-borrowed settings-sounds');
    box.append(holder);
    return borrowNodes(parts, holder);
  },
});

registerSettings('notificacoes', {
  title: 'Notificações',
  render(box) {
    box.append(settingsHead('Notificações', 'Avisos do sistema quando esta aba não está na frente.'));
    const sound = settingsSwitch(shareSoundOn, 'Som de transmissão', setShareSound);
    box.append(settingsRow('Som quando alguém começa ou para de compartilhar', 'Um toque curto, mesmo com a aba na frente. Fica quieto quando você silencia todo mundo (Fone).', sound));
    if ($('notify-btn').hidden) {
      box.append(el('p', 'settings-note', 'Este navegador não deixa o site mandar avisos.'));
      return null;
    }
    const on = () => $('notify-btn').getAttribute('aria-pressed') === 'true';
    const toggle = settingsSwitch(on(), 'Avisos', () => {
      $('notify-btn').click(); // asks the browser the first time
      setTimeout(() => (toggle.checked = on()), 300);
    });
    box.append(settingsRow('Avisar quando alguém compartilha ou manda mensagem', 'Só aparecem com a aba em segundo plano.', toggle));
    return null;
  },
});

// The gear beside your name opens the page (it used to open the voice dialog).
$('voice-settings-btn').onclick = () => openSettings('voz');
$('voice-settings-btn').title = 'Configurações';
$('voice-settings-btn').setAttribute('aria-label', 'Configurações');
