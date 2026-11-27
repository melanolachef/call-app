// ---------- denunciar (#152) ----------

// The server never sees what is shared, so a report is what the person saw,
// sent by e-mail to the contact in /privacidade. Nothing is stored on the
// server (keeping screenshots there could mean keeping illegal images);
// whoever reports may attach a screenshot to the e-mail themselves. Abuse
// of children also goes to SaferNet, which forwards it to the authorities.

const REPORT_EMAIL = 'cpxcallcontato@gmail.com';
const REPORT_REASONS = [
  'Conteúdo sexual envolvendo criança ou adolescente',
  'Nudez ou conteúdo sexual sem consentimento',
  'Violência, ameaça ou incentivo a se machucar',
  'Assédio, ofensa ou discriminação',
  'Golpe, vírus ou link perigoso',
  'Outro motivo',
];
let reportTarget = null;

function openReport(person) {
  reportTarget = { id: person.id, name: person.name, sharing: !!peers.get(person.id)?.sharing };
  $('report-who').textContent = person.name;
  $('report-reasons').replaceChildren(...REPORT_REASONS.map((reason, i) => {
    const label = el('label', 'report-reason');
    const input = el('input');
    input.type = 'radio';
    input.name = 'report-reason';
    input.value = reason;
    input.required = true;
    if (i === 0) input.dataset.child = '1';
    label.append(input, el('span', null, reason));
    return label;
  }));
  $('report-text').value = '';
  $('report-kick').hidden = !iOwnTheRoom();
  $('report-child').hidden = true;
  $('report-dialog').showModal();
}

function reportBody() {
  const reason = document.querySelector('input[name="report-reason"]:checked')?.value || '';
  const when = new Date().toLocaleString('pt-BR');
  return [
    `Motivo: ${reason}`,
    `Quem: ${reportTarget.name} (participante ${reportTarget.id})${reportTarget.sharing ? ', compartilhando a tela' : ''}`,
    `Sala: ${location.origin}/room/${roomId}`,
    `Quando: ${when}`,
    `Quem denuncia: ${myNick}${account?.signedIn && account.username ? ` (@${account.username})` : ''}`,
    '',
    'O que aconteceu:',
    $('report-text').value.trim() || '(não escrito)',
    '',
    'Se tiver um print, anexe a este e-mail.',
  ].join('\n');
}

$('report-reasons').onchange = (e) => {
  $('report-child').hidden = e.target.dataset.child !== '1';
};
$('report-form').onsubmit = (e) => {
  e.preventDefault();
  const subject = `Denúncia no CPX Call: ${reportTarget.name}`;
  // A new window, never this one: with a web mail (Gmail) set to handle
  // mailto links, changing this page's address would leave the call.
  window.open(`mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportBody())}`, '_blank', 'noopener');
  toast('Abrimos o seu e-mail com a denúncia. Se não abriu, use "Copiar texto".', 6000);
};
$('report-copy').onclick = async () => {
  if (!document.querySelector('input[name="report-reason"]:checked')) {
    toast('Escolha o motivo primeiro.');
    return;
  }
  try {
    await navigator.clipboard.writeText(`Para: ${REPORT_EMAIL}\n\n${reportBody()}`);
    toast(`Texto copiado. Mande para ${REPORT_EMAIL}.`, 6000);
  } catch {
    window.prompt('Copie e mande por e-mail:', reportBody());
  }
};
$('report-kick').onclick = () => {
  if (!reportTarget || !window.confirm(`Tirar ${reportTarget.name} da sala agora?`)) return;
  sendAdmin({ kick: reportTarget.id });
  toast(`${reportTarget.name} foi tirado da sala. A denúncia continua aberta para você mandar.`, 5000);
};
$('report-cancel').onclick = () => $('report-dialog').close();
$('pc-report').onclick = () => {
  const person = currentCardPerson();
  closePersonCard();
  if (person) openReport(person);
};
