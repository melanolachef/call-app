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

## Releases

- Site: production at https://cpx-call.fly.dev, deployed by hand with `fly deploy` from `main`.
- Windows app: bump the version in `desktop/tauri.conf.json` and
  `desktop/Cargo.toml`, merge to `main`, then the maintainer pushes a tag
  `app-vX.Y.Z`; `.github/workflows/app-windows.yml` builds and publishes
  `CPX-Call-Windows.exe` (the lobby's download link always points to the latest).
- Code signing: free via SignPath Foundation, wired in the workflow but skipped
  until the repository variables in [docs/APP-WINDOWS.md](docs/APP-WINDOWS.md) exist.

## Estado atual

_Atualizado em 2026-11-23._

- **No ar (main, publicado em 2026-11-18):** design novo
  (`docs/design/cpx-call-componentes.html`: quem assiste, direto/relay,
  reconexão, resolução antes de assistir), caixa de qualidade (resolução, FPS,
  Fluidez/Nitidez), soundpad, volume individual por pessoa, GIFs no chat
  (KLIPY via `/api/gifs`, chave em `fly secrets`), celular com tela cheia/modo
  cinema e PWA, frases no "Boa noite", câmera sob demanda, emojis, perfil com
  recorte, banner e cartão de perfil.
- **App Windows `app-v0.2.0`** (release publicado): barra de título desenhada
  pela página. Quem tem a 0.1.0 precisa reinstalar (sem atualização
  automática ainda).
- **Na development (falta publicar):** amigos sem conta (#132): código de
  amigo por aparelho, `/api/friends`, presença só em memória
  (`src/presence.rs`), invisível, "Usar em outro aparelho" para o app.
  GIF como foto de perfil e banner (#135), com o seletor do KLIPY no diálogo.
- **Produção sem TURN:** `/api/ice` só entrega STUN (faltam `TURN_KEY_ID` e
  `TURN_KEY_API_TOKEN` em `fly secrets`). Quem está em CGNAT/4G ou rede que
  bloqueia UDP fica em "falha na conexão · sem P2P".
- **Falta testar:** Android real (tela cheia, instalar) e "relay" numa rede
  que bloqueie P2P.
- **Assinatura do instalador:** falta a inscrição na SignPath (o mantenedor faz).
- **Branch local `feat/compartilhar-nativo`** (só no Windows principal, ainda
  não enviada): protótipo `desktop/examples/captura.rs` de captura + H.264 na
  GPU (Windows Graphics Capture → processador de vídeo D3D11 → encoder de
  hardware do Media Foundation). Medido numa RX 5500 XT: 31 FPS em 720p com
  4,5% de um núcleo, contra 11,9 FPS e 28,8% do Edge fazendo o mesmo.

## Próximos passos

1. **Fase 1 do app nativo ("o mais Rust possível"):** ao clicar em
   "Compartilhar tela" dentro do app, o Rust captura e codifica (protótipo
   acima) e envia com `webrtc-rs` numa conexão extra por pessoa que assiste,
   sinalizada pelo mesmo WebSocket (a página faz a ponte). Quem assiste não
   muda. Ajuste pendente: encoder AMF em VBR de baixa latência (CBR enche o
   vídeo de NAL de preenchimento).
   Depois: voz em Rust (cpal + Opus), e por fim interface nativa (Slint ou
   egui + wgpu) no lugar do WebView2.
2. **Segurança / ECA Digital** (discussão em aberto): a ANPD suspendeu o vídeo
   do Discord no Brasil em ago/2026 porque a plataforma não vê as transmissões.
   Proposta: fechar o acesso ao grupo (login do Google + lista), moderação pelo
   dono da sala, botão "Denunciar" com o que quem denuncia viu, termos/idade;
   registros mínimos só depois de consulta jurídica.
3. **Soundpad, depois:** botão no celular, atalhos por som no app Windows.
4. **Clipes no app** (#103, estudo): buffer dos últimos ~30 s já codificados
   em RAM sobre o pipeline da fase 1, tecla → MP4 pelo Media Foundation.
   Medir o custo com jogo rodando antes; se pesar, abandonar.
5. **Para mais tarde — tolerância a queda no servidor (#78):** ao cair o
   WebSocket, segurar o lugar da pessoa ~20 s antes do `peer-left`, para as
   conexões P2P sobreviverem ao celular ir para segundo plano (seletor de
   fotos) e ao 4G instável. Esperando o relato de quem viu o problema.
6. Ideias registradas: canais fixos do servidor iguais para todos (estilo
   servidor do Discord) e contas opcionais (Google + Neon). Para devs: quadro
   colaborativo estilo Excalidraw (#127), código no chat (#128), cartões do
   GitHub (#129) e apontar sobre a tela compartilhada (#130).
