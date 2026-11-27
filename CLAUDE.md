# CLAUDE.md

Context for AI coding agents (Claude Code and others) working on CPX Call.
It is loaded automatically on every machine that opens the repository, so it is
the shared memory between the maintainer's computers (Windows and Pop!_OS).
**At the end of a working session, update [Estado atual](#estado-atual) and
[Próximos passos](#próximos-passos).** Humans: start at the [README](README.md)
and [CONTRIBUTING.md](CONTRIBUTING.md).

## Project in one paragraph

Screen sharing, voice, camera and chat for a group of friends who game
together. A Rust server (axum + tokio, `src/`) only relays WebRTC signaling and
chat over WebSocket and stores nothing; media goes peer to peer (mesh).
Pages are plain HTML/JS embedded in the binary (`static/`, the room script split
in `static/room/` and concatenated in `ROOM_JS` order in `src/main.rs`). A
Windows app (`desktop/`, Tauri 2) loads the site and adds global push-to-talk.
Details: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## How we work

- Talk to the maintainer in **Brazilian Portuguese**. Code comments in English;
  user-facing text, commits and PRs in Portuguese.
- Branch from `development` (`feat/`, `fix/`, `chore/`), PR to `development`,
  never to `main`. `main` only receives `development` via PR. CODEOWNERS review.
- New bugs/ideas often arrive mid-task: park the current work on its branch
  (commit), fix the new thing on its own branch + PR, then resume.
- Before a PR: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test` (also inside `desktop/` when it changed — CI runs both, on Linux
  and Windows). Then **test in a real browser** with two or more people and look
  at screenshots; say in the PR what was and wasn't tested.
- Principles: light for whoever is gaming (no extra CPU/GPU for the sharer),
  the server stores nothing, minimal dependencies, follow the design in
  `docs/design/` and the tokens in `static/common.css`.
- New file in `static/room/` → add it to `ROOM_JS` in `src/main.rs`.
  Static changes need a rebuild (files are embedded).

## Machines

| | Windows (main) | Pop!_OS (notebook) |
|---|---|---|
| Server (`cargo run`) | yes | yes |
| `desktop/` app, `desktop/examples/captura.rs` | yes (needs VS Build Tools C++) | no: Windows-only APIs (keyboard hook, Windows Graphics Capture, Media Foundation) |
| Shell quirks | Windows PowerShell 5.1: no `&&`, use `;` or `if ($?) {}` | bash |

Browser testing with Playwright: on Pop!_OS port 3000 is often taken by
another project, so run the server with `PORT=3001`. On Windows only Edge is installed, so use
`playwright-core` with `channel: 'msedge'`. Fake media: Edge's default fake
camera stops after ~1 s, so feed a `.y4m` file with
`--use-file-for-fake-video-capture=<absolute path>`; the fake screen capture is
a green test card, so override `getDisplayMedia` to return
`canvas.captureStream()` when a realistic picture matters.

**Windows: Smart App Control** (ligado no PC principal desde 26/11) bloqueia
binários recém-compilados sem assinatura, **de forma intermitente**: o
`cargo-fmt` sempre, DLLs de macros do `desktop/` e às vezes o `call-app.exe`
do servidor ("Uma política de Controle de Aplicativo bloqueou este arquivo").
Use `rustfmt --edition 2021 --check src/main.rs` no lugar do `cargo fmt`;
`cargo clippy`/`cargo test` costumam rodar; se o servidor não abrir, tente de
novo ou teste no Pop!_OS. O CI compila e testa o app.

## Releases

- Site: production at https://cpx-call.fly.dev, deployed by hand with `fly deploy` from `main`.
- Windows app: bump the version in `desktop/tauri.conf.json` and
  `desktop/Cargo.toml`, add a `## X.Y.Z` section on top of
  `desktop/NOVIDADES.md` (it becomes the release text, for users, in
  Portuguese), merge to `main`, then the maintainer pushes a tag
  `app-vX.Y.Z`; `.github/workflows/app-windows.yml` builds and publishes
  `CPX-Call-Windows.exe` (the lobby's download link always points to the latest).
- Code signing: free via SignPath Foundation, wired in the workflow but skipped
  until the repository variables in [docs/APP-WINDOWS.md](docs/APP-WINDOWS.md) exist.

## Estado atual

_Atualizado em 2026-11-26._

- **No ar (main = development, #191):** grupos estilo servidor do Discord
  (#190, `src/contas/grupos.rs`, `static/grupos.js`), telas novas
  (configurações, Início e sala largos, #182–#184), mensagens diretas
  (#181), foto/GIF no chat por P2P (#179), contas fases 1–4, dono da sala,
  Denunciar + idade 13+, CSP, TURN só na sala, limites, `/privacidade`,
  `/termos`, `/apoiar`. App Windows `app-v0.2.0`.
- **Na development (26/11, falta publicar):** #201 só o Sair tira da call
  sem perguntar · #202 celular ouve a call mesmo mudo (mudo = ganho na
  mixagem) · #203 Apoiar/Pix e links externos no app (`open_url`) · #204
  Ctrl+Shift+D para o fone · #205 som de quem começa/para de compartilhar ·
  #206 chat com largura ajustável · #207 cards no estilo do Discord.
  #203 e #204 mexem no app: valem a partir do app 0.3.0.
- **PR aberto #209 — grupos com a lógica do Discord (#198) e ícone do grupo
  (#199):** quem está em cada sala (`GET /api/grupos/{id}/agora`, nick vindo
  por `?nick=` na WebSocket, só em memória), membros online/offline no Início,
  trocar de sala no grupo leva a voz junto (`sessionStorage voz-continua`),
  ícone do grupo (`PUT .../icone`, migração `icon`).
- **Revisão de segurança de 26/11:** 15 problemas; corrigidos #8, #12 e
  #13. A lista completa ficou na memória do agente no outro computador; o
  mais grave é a fila cheia expulsar quem recebe em vez de quem inunda
  (`rooms.rs`).
- **Issues já resolvidas mas abertas** (os PRs citaram o número sem
  "Closes"): #149–#152, #156–#159, #176, #177, #180, #189.
- **Produção sem TURN:** falta pôr `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` (já
  seguro depois do #167; criar alerta de gastos na Cloudflare antes).
- **Falta testar:** app Windows com a CSP, Android/iPhone reais (o #202 só
  se confirma num iPhone) e "relay" numa rede que bloqueie P2P.
- **Assinatura do instalador:** falta a inscrição na SignPath (o mantenedor faz).
- **Branch local `feat/compartilhar-nativo`** (só no Windows principal, ainda
  não enviada): protótipo `desktop/examples/captura.rs` de captura + H.264 na
  GPU (Windows Graphics Capture → processador de vídeo D3D11 → encoder de
  hardware do Media Foundation). Medido numa RX 5500 XT: 31 FPS em 720p com
  4,5% de um núcleo, contra 11,9 FPS e 28,8% do Edge fazendo o mesmo.

## Próximos passos

0. **Revisar e publicar:** mergear o #209, levar a development para a main
   e fazer o deploy; gerar o app 0.3.0 (traz `open_url` e Ctrl+Shift+D).
   Depois: corrigir o resto da revisão de segurança (fila/inundação, pong, sala
   trancada ao reconectar, TURN por conexão, expulsão); GIF próprio no
   perfil (#175); #153 (primeira vez) e #154 (operação).
1. **Fase 1 do app nativo ("o mais Rust possível"):** ao clicar em
   "Compartilhar tela" dentro do app, o Rust captura e codifica (protótipo
   acima) e envia com `str0m` (proposta do estudo em docs/nativo) numa conexão extra por pessoa que assiste,
   sinalizada pelo mesmo WebSocket (a página faz a ponte). Quem assiste não
   muda. Ajuste pendente: encoder AMF em VBR de baixa latência (CBR enche o
   vídeo de NAL de preenchimento).
   Depois: voz em Rust (cpal + Opus), e por fim interface nativa (Slint ou
   egui + wgpu) no lugar do WebView2.
   **Linux (#141) vem por esse caminho:** o WebKitGTK do Ubuntu/Pop não tem
   WebRTC, então o app Tauri não serve lá; o cliente nativo é escrito para
   Windows e Linux desde o início (parte comum: WebRTC, sinalização, voz,
   interface; por sistema: captura/encoder e atalhos globais). Estudo de
   todas as fases em [docs/nativo/](docs/nativo/).
2. **Segurança / ECA Digital** (discussão em aberto): a ANPD suspendeu o vídeo
   do Discord no Brasil em ago/2026 porque a plataforma não vê as transmissões.
   Proposta: fechar o acesso ao grupo (login do Google + lista), moderação pelo
   dono da sala, botão "Denunciar" com o que quem denuncia viu, termos/idade;
   registros mínimos só depois de consulta jurídica.
3. **Soundpad, depois:** botão no celular, atalhos por som no app Windows.
4. **Clipes no app** (#103, estudo): buffer dos últimos ~30 s já codificados
   em RAM sobre o pipeline da fase 1, tecla → MP4 pelo Media Foundation.
   Medir o custo com jogo rodando antes; se pesar, abandonar.
5. Ideias registradas: canais fixos do servidor iguais para todos (estilo
   servidor do Discord). Para devs: quadro
   colaborativo estilo Excalidraw (#127), código no chat (#128), cartões do
   GitHub (#129) e apontar sobre a tela compartilhada (#130).
