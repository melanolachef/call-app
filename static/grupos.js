'use strict';

// Group actions (#189), shared by the home and the room: send the invite,
// and one dialog to see a group. The owner manages rooms and people there;
// everyone else can leave. The list itself lives in common.js (`groups`).

const GD_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
document.body.insertAdjacentHTML('beforeend', `
  <dialog id="group-dialog" class="group-dialog" aria-labelledby="gd-title">
    <div class="dialog-body">
      <div class="gd-head">
        <span class="gd-icon" id="gd-icon" aria-hidden="true"></span>
        <h2 id="gd-title" class="ellipsis"></h2>
        <button type="button" class="icon-btn" id="gd-close" aria-label="Fechar">${GD_X}</button>
      </div>
      <p class="muted" id="gd-sub"></p>
      <div class="gd-icon-actions" id="gd-icon-actions" hidden>
        <button type="button" class="btn small ghost" id="gd-icon-pick">Trocar ícone</button>
        <button type="button" class="btn small ghost" id="gd-icon-remove">Remover ícone</button>
        <input type="file" id="gd-icon-input" accept="image/*" hidden>
      </div>
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
  $('gd-icon').replaceChildren();
  paintGroupIcon($('gd-icon'), g);
  $('gd-icon-actions').hidden = !g.dono;
  $('gd-icon-remove').hidden = !validGroupIcon(g.icone);
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
        // Another room of the group you are in: a channel switch (#198).
        const sameGroup = typeof okToSwitchRoom === 'function' && groupOfRoom(roomId)?.group.id === g.id;
        if (!(sameGroup ? okToSwitchRoom() : okToGo())) e.preventDefault();
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

// The group's icon (#199): the owner picks a picture, cuts a square of it.
$('gd-icon-pick').onclick = () => $('gd-icon-input').click();
$('gd-icon-input').onchange = async () => {
  const file = $('gd-icon-input').files[0];
  $('gd-icon-input').value = '';
  if (!file || !gdGroup) return;
  let url = null;
  try {
    url = await cropImage(file, { title: 'Ícone do grupo', aspect: 1, round: false, width: 128, height: 128, max: 60_000 });
  } catch {
    toast('Não deu para usar essa imagem.');
    return;
  }
  if (url) groupChange('PUT', `/api/grupos/${gdGroup.id}/icone`, { icone: url }, 'Ícone trocado.');
};
$('gd-icon-remove').onclick = () => {
  if (gdGroup) groupChange('PUT', `/api/grupos/${gdGroup.id}/icone`, { icone: '' }, 'Ícone removido.');
};
$('gd-copy').onclick = () => gdGroup && inviteToGroup(gdGroup);
$('gd-add-room').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('gd-room-name').value;
  if (await groupChange('POST', `/api/grupos/${gdGroup.id}/salas`, { nome: name }, 'Sala criada.')) $('gd-room-name').value = '';
};

// ---------- canal de texto do grupo (#223) ----------

// The group's #geral, like a Discord text channel: kept 30 days on the
// server, readable from anywhere (the home, or a call in another group).
// While it is on screen it asks for what is new every few seconds.
const GC_POLL_MS = 4000;
const GC_GROUP_GAP = 5 * 60; // same author within 5 min: no new header

function gcTime(seconds) {
  const at = new Date(seconds * 1000);
  const time = at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return `hoje às ${time}`;
  return `${at.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

// One per page; `mount(node)` puts it where it should show.
const groupChat = (() => {
  const root = el('section', 'gchat');
  root.setAttribute('aria-label', 'Chat do grupo');
  const head = el('header', 'gchat-head');
  const title = el('strong', 'ellipsis', 'geral');
  const where = el('span', 'gchat-group ellipsis');
  head.append(el('span', 'gchat-hash', '#'), title, where, el('span', 'gchat-note', 'fica guardado por 30 dias'));
  const list = el('ol', 'gchat-list');
  list.setAttribute('aria-live', 'polite');
  const form = el('form', 'gchat-form');
  const input = el('input', 'gchat-input');
  input.maxLength = 2000;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Mensagem para o grupo');
  const send = el('button', 'btn small primary', 'Enviar');
  form.append(input, send);
  root.append(head, list, form);

  let group = null; // { id, nome, dono }
  let firstId = null;
  let lastId = 0;
  let olderDone = false;
  let loadingOlder = false;
  let polling = null;
  let generation = 0; // a reply for a group we already left is ignored

  function shown() {
    return root.isConnected && root.offsetParent !== null && !document.hidden;
  }

  function face(m) {
    const node = el('span', 'avatar');
    node.setAttribute('aria-hidden', 'true');
    node.textContent = initials(m.nick || '?');
    node.style.background = colorFor(`m${m.membro}`);
    return node;
  }

  function item(m, prev) {
    const li = el('li', 'gchat-msg');
    li.msg = m;
    li.dataset.id = String(m.id);
    li.dataset.membro = String(m.membro);
    li.dataset.em = String(m.em);
    const together = prev && Number(prev.dataset.membro) === m.membro && m.em - Number(prev.dataset.em) < GC_GROUP_GAP;
    if (together) {
      li.classList.add('cont');
    } else {
      const top = el('span', 'gchat-msg-head');
      top.append(el('strong', 'ellipsis', m.nick || 'Alguém'), el('span', 'gchat-time', gcTime(m.em)));
      li.append(face(m), top);
    }
    const text = el('p', 'gchat-text');
    text.append(linkify(m.texto));
    li.append(text);
    if (m.voce || group?.dono) {
      const drop = el('button', 'gchat-delete', 'Apagar');
      drop.type = 'button';
      drop.title = m.voce ? 'Apagar sua mensagem' : 'Apagar mensagem (você é o dono)';
      drop.onclick = () => remove(m, li);
      li.append(drop);
    }
    return li;
  }

  function empty(text) {
    list.replaceChildren(el('li', 'gchat-empty muted', text));
  }

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  function append(messages) {
    const fresh = messages.filter((m) => !list.querySelector(`[data-id="${m.id}"]`));
    if (!fresh.length) return;
    const stick = nearBottom();
    list.querySelector('.gchat-empty')?.remove();
    for (const m of fresh) {
      // Usually at the end; a sent message whose answer came after a newer
      // poll goes back to its place.
      const after = m.id < lastId ? [...list.children].find((n) => n.msg && n.msg.id > m.id) : null;
      const prev = after ? after.previousElementSibling : list.lastElementChild;
      const node = item(m, prev?.msg ? prev : null);
      if (after) {
        after.before(node);
        after.replaceWith(item(after.msg, node));
      } else {
        list.append(node);
      }
      lastId = Math.max(lastId, m.id);
      firstId = firstId === null ? m.id : Math.min(firstId, m.id);
    }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  async function poll() {
    if (!group || !shown()) return;
    const asked = generation;
    const res = await groupRequest('GET', `/api/grupos/${group.id}/mensagens?depois=${lastId}`);
    if (asked !== generation || !res.ok) return;
    append(res.data.mensagens ?? []);
  }

  async function older() {
    if (!group || olderDone || loadingOlder || firstId === null) return;
    loadingOlder = true;
    const asked = generation;
    const res = await groupRequest('GET', `/api/grupos/${group.id}/mensagens?antes=${firstId}`);
    loadingOlder = false;
    if (asked !== generation || !res.ok) return;
    const page = res.data.mensagens ?? [];
    if (page.length < 50) olderDone = true;
    if (!page.length) return;
    const before = list.scrollHeight;
    const nodes = [];
    for (const m of page) nodes.push(item(m, nodes[nodes.length - 1] ?? null));
    // The first message already here may now continue the last old one.
    const next = list.firstElementChild;
    list.prepend(...nodes);
    if (next?.msg) next.replaceWith(item(next.msg, nodes[nodes.length - 1]));
    firstId = page[0].id;
    list.scrollTop += list.scrollHeight - before;
  }

  async function remove(m, li) {
    if (!window.confirm('Apagar esta mensagem para todo mundo?')) return;
    const res = await groupRequest('DELETE', `/api/grupos/${group.id}/mensagens/${m.id}`);
    if (!res.ok) return toast(res.data.error || 'Não deu para apagar.', 4000);
    // The next one may need its own name again (or now join the one before).
    const next = li.nextElementSibling;
    const prev = li.previousElementSibling;
    li.remove();
    if (next?.msg) next.replaceWith(item(next.msg, prev?.msg ? prev : null));
    if (!list.querySelector('.gchat-msg')) empty('Nenhuma mensagem ainda. Comece a conversa!');
  }

  // Pages that redraw (the home) move this node around, which resets the
  // scroll: remember where it was.
  let kept = { top: 0, bottom: true };
  list.addEventListener('scroll', () => {
    if (!list.isConnected) return;
    kept = { top: list.scrollTop, bottom: nearBottom() };
    if (list.scrollTop < 60) older();
  });

  // Sent in order, one after the other; the field is free right away, and a
  // message that didn't go comes back to it.
  let sending = Promise.resolve();
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const to = group;
    if (!text || !to) return;
    input.value = '';
    sending = sending.then(async () => {
      const res = await groupRequest('POST', `/api/grupos/${to.id}/mensagens`, { texto: text });
      if (!res.ok) {
        toast(res.data.error || 'Não deu para mandar. Tente de novo.', 4000);
        if (!input.value) input.value = text;
        return;
      }
      if (group?.id !== to.id) return; // switched groups meanwhile
      list.scrollTop = list.scrollHeight;
      append([res.data]);
      list.scrollTop = list.scrollHeight;
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });

  return {
    root,
    mount(node) {
      if (root.parentNode === node) return;
      node.append(root);
      list.scrollTop = kept.bottom ? list.scrollHeight : kept.top;
    },
    // Shows group `g`'s channel (same group: just catches up).
    async open(g) {
      where.textContent = g.nome;
      input.placeholder = `Conversar em ${g.nome}`;
      if (group?.id === g.id) {
        group = g;
        poll();
        return;
      }
      group = g;
      generation += 1;
      firstId = null;
      lastId = 0;
      olderDone = false;
      empty('Carregando…');
      clearInterval(polling);
      polling = setInterval(poll, GC_POLL_MS);
      const asked = generation;
      const res = await groupRequest('GET', `/api/grupos/${g.id}/mensagens`);
      if (asked !== generation) return;
      if (!res.ok) return empty(res.data.error || 'Não deu para carregar agora.');
      const page = res.data.mensagens ?? [];
      olderDone = page.length < 50;
      if (!page.length) return empty('Nenhuma mensagem ainda. Comece a conversa!');
      list.replaceChildren();
      append(page);
      list.scrollTop = list.scrollHeight;
    },
    close() {
      group = null;
      generation += 1;
      clearInterval(polling);
      polling = null;
    },
    get groupId() {
      return group?.id ?? null;
    },
  };
})();

// ---------- membros do grupo (#198, #223) ----------

// Online (in one of the group's rooms) and offline, like Discord's member
// list. `detail` is GET /api/grupos/{id}, `now` its /agora.
function groupMemberNodes(detail, now) {
  if (!detail?.membros) return [];
  const online = new Set(now?.online ?? []);
  const row = (m, on) => {
    const li = el('li', `gm-row${on ? '' : ' offline'}`);
    const face = el('span', 'avatar');
    face.setAttribute('aria-hidden', 'true');
    face.textContent = initials(m.nick || '?');
    face.style.background = colorFor(`m${m.id}`);
    li.append(face, el('span', 'ellipsis', m.nick || 'Sem nome'));
    if (m.dono) li.append(el('span', 'tag', 'dono'));
    if (m.voce) li.append(el('span', 'gm-you muted', 'você'));
    return li;
  };
  const part = (title, people, on) => {
    if (!people.length) return [];
    const list = el('ul', 'gm-list');
    list.append(...people.map((m) => row(m, on)));
    return [el('h3', 'gm-title', `${title} — ${people.length}`), list];
  };
  return [
    ...part('Online', detail.membros.filter((m) => online.has(m.id)), true),
    ...part('Offline', detail.membros.filter((m) => !online.has(m.id)), false),
  ];
}
