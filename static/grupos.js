'use strict';

// Group actions (#189), shared by the home and the room: send the invite,
// and one dialog to see a group. The owner manages rooms and people there;
// everyone else can leave. The list itself lives in common.js (`groups`).

const GD_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
document.body.insertAdjacentHTML('beforeend', `
  <dialog id="group-dialog" class="group-dialog" aria-labelledby="gd-title">
    <div class="dialog-body">
      <div class="gd-head">
        <h2 id="gd-title" class="ellipsis"></h2>
        <button type="button" class="icon-btn" id="gd-close" aria-label="Fechar">${GD_X}</button>
      </div>
      <p class="muted" id="gd-sub"></p>
      <div class="gd-invite">
        <input class="input mono" id="gd-link" readonly aria-label="Link do convite">
        <button type="button" class="btn small primary" id="gd-copy">Convidar</button>
      </div>
      <h3 class="gd-section">Salas</h3>
      <ul class="gd-list" id="gd-rooms"></ul>
      <form class="gd-add" id="gd-add-room">
        <input class="input" id="gd-room-name" maxlength="32" placeholder="Nome da sala nova" aria-label="Nome da sala nova" required autocomplete="off">
        <button class="btn small">Criar sala</button>
      </form>
      <h3 class="gd-section" id="gd-people-title">Pessoas</h3>
      <ul class="gd-list" id="gd-people"></ul>
      <div class="gd-foot" id="gd-foot"></div>
    </div>
  </dialog>`); // fixed markup

let gdGroup = null; // the group on screen, with its members

// Leaving a room while sharing asks first (room/lateral.js); the home just goes.
function okToGo() {
  return typeof okToLeave !== 'function' || okToLeave();
}

async function inviteToGroup(group) {
  const url = inviteUrl(group.convite);
  const text = `Bora? Entra no grupo ${group.nome} do CPX Call:`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'CPX Call', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  copyText(`${text} ${url}`, 'Convite copiado. É só colar na conversa.');
}

// Runs a group request; the answer (the group again) redraws everything.
async function groupChange(method, path, body, done) {
  const res = await groupRequest(method, path, body);
  if (!res.ok) {
    toast(res.data.error || 'Não deu certo. Tente de novo.', 4000);
    return null;
  }
  if (res.data.id) {
    putGroup(res.data);
    gdGroup = res.data;
    renderGroupDialog();
  }
  if (done) toast(done);
  return res.data;
}

function gdButton(text, run, cls = 'ghost') {
  const button = el('button', `btn small ${cls}`, text);
  button.type = 'button';
  button.onclick = run;
  return button;
}

// Left the group, or it is gone: out of its room too.
function leftGroup(id) {
  const inside = typeof roomId === 'string' && groupOfRoom(roomId)?.group.id === id;
  dropGroup(id);
  $('group-dialog').close();
  if (inside) location.assign('/');
}

function renderGroupDialog() {
  const g = gdGroup;
  const base = `/api/grupos/${g.id}`;
  $('gd-title').textContent = g.nome;
  $('gd-sub').textContent = `${g.membros.length} ${g.membros.length === 1 ? 'pessoa' : 'pessoas'}${g.dono ? ' · você é o dono' : ''}`;
  $('gd-link').value = inviteUrl(g.convite);
  $('gd-add-room').hidden = !g.dono;

  $('gd-rooms').replaceChildren(...g.salas.map((room) => {
    const li = el('li', 'gd-row');
    const here = typeof roomId === 'string' && roomId === room.id;
    const link = el(here ? 'span' : 'a', 'gd-name ellipsis', room.nome);
    if (here) {
      link.append(el('span', 'tag', 'você está aqui'));
    } else {
      link.href = `/room/${room.id}`;
      link.onclick = (e) => {
        if (!okToGo()) e.preventDefault();
      };
    }
    li.append(link);
    if (g.dono) {
      li.append(gdButton('Renomear', () => {
        const name = window.prompt('Novo nome da sala:', room.nome);
        if (name?.trim()) groupChange('PUT', `${base}/salas/${room.id}`, { nome: name });
      }));
      if (g.salas.length > 1) {
        li.append(gdButton('Apagar', () => {
          if (window.confirm(`Apagar a sala "${room.nome}"? Quem estiver nela sai da call.`)) groupChange('DELETE', `${base}/salas/${room.id}`);
        }, 'ghost danger'));
      }
    }
    return li;
  }));

  $('gd-people').replaceChildren(...g.membros.map((m) => {
    const li = el('li', 'gd-row');
    const face = el('span', 'avatar');
    face.setAttribute('aria-hidden', 'true');
    face.textContent = initials(m.nick || '?');
    face.style.background = colorFor(`m${m.id}`);
    const text = el('span', 'gd-name ellipsis', m.nick || 'Sem nome');
    if (m.usuario) text.append(el('span', 'muted', ` @${m.usuario}`));
    if (m.dono) text.append(el('span', 'tag', 'dono'));
    if (m.voce) text.append(el('span', 'tag', 'você'));
    li.append(face, text);
    if (g.dono && !m.voce) {
      li.append(gdButton('Tirar', () => {
        if (window.confirm(`Tirar ${m.nick || 'esta pessoa'} do grupo? Sai da call na hora e só volta com um convite novo.`)) {
          groupChange('DELETE', `${base}/membros/${m.id}`, null, 'Pessoa tirada do grupo.');
        }
      }, 'ghost danger'));
    }
    return li;
  }));

  const foot = [];
  if (g.dono) {
    foot.push(gdButton('Renomear grupo', () => {
      const name = window.prompt('Novo nome do grupo:', g.nome);
      if (name?.trim()) groupChange('PUT', base, { nome: name });
    }));
    foot.push(gdButton('Novo link', async () => {
      if (!window.confirm('Fazer um link de convite novo? O antigo para de funcionar (quem já entrou continua).')) return;
      const res = await groupChange('POST', `${base}/convite`, null, 'Link novo pronto.');
      if (res?.convite) {
        gdGroup.convite = res.convite;
        putGroup({ ...groups.find((x) => x.id === g.id), convite: res.convite });
        renderGroupDialog();
      }
    }));
    foot.push(gdButton('Apagar grupo', async () => {
      if (!window.confirm(`Apagar o grupo "${g.nome}"? As salas somem e todo mundo sai dele. Não dá para desfazer.`)) return;
      if (await groupChange('DELETE', base)) leftGroup(g.id);
    }, 'ghost danger'));
  } else {
    foot.push(gdButton('Sair do grupo', async () => {
      if (!window.confirm(`Sair do grupo "${g.nome}"? Para voltar, só com um convite novo.`)) return;
      if (await groupChange('POST', `${base}/sair`)) leftGroup(g.id);
    }, 'ghost danger'));
  }
  $('gd-foot').replaceChildren(...foot);
}

async function openGroup(id) {
  const res = await groupRequest('GET', `/api/grupos/${id}`);
  if (!res.ok) {
    if (res.status === 404) dropGroup(id); // gone, or you were taken out
    toast(res.data.error || 'Não deu para abrir o grupo.', 4000);
    return;
  }
  putGroup(res.data);
  gdGroup = res.data;
  renderGroupDialog();
  if (!$('group-dialog').open) $('group-dialog').showModal();
}

$('gd-close').onclick = () => $('group-dialog').close();
$('gd-copy').onclick = () => gdGroup && inviteToGroup(gdGroup);
$('gd-add-room').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('gd-room-name').value;
  if (await groupChange('POST', `/api/grupos/${gdGroup.id}/salas`, { nome: name }, 'Sala criada.')) $('gd-room-name').value = '';
};
