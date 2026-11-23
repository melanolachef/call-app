# 05 — Interface nativa, vídeo recebido e distribuição

_Estudo de 2026-11-23. Parte do plano "o mais Rust possível" (ver CLAUDE.md,
Próximos passos, item 1). Fatos de versões conferidos na web nesta data; o que
não deu para confirmar está marcado com **(não verificado)**._

Escopo: (1) qual framework de interface substitui o WebView2 na última fase,
(2) como quem assiste recebe, decodifica e desenha o vídeo, (3) câmera nativa,
(4) instalador e atualização automática no Windows e no Linux, (5) como migrar
do app Tauri atual (`desktop/`, NSIS `currentUser`, `app.cpxcall.desktop`,
v0.2.0, **sem atualizador**) sem quebrar quem já instalou.

Restrições que guiam tudo (de `priority-sharing-quality` e do CLAUDE.md):

- Quem está jogando paga quase nada: janela parada = CPU/GPU perto de zero,
  sem redesenho constante; só redesenha a região/ janela quando algo muda.
- Vários vídeos ao vivo ao mesmo tempo: telas até 1440p60 e câmeras pequenas.
- Visual do `docs/design/cpx-call-componentes.html` e dos tokens de
  `static/common.css`: fundo quase preto (`--bg #0B0B0C`, `--card #161618`,
  `--raised #1F1F22`), bordas finas, raios 8/6/4 px, amarelo `--live` para
  "ao vivo", verde `--online`, Inter + JetBrains Mono, números tabulares.
- Avatares e banners podem ser GIF animado (#135), chat com emojis e GIFs do
  KLIPY.
- Windows (RX 5500 XT, RDNA1) e Pop!_OS/Ubuntu (X11 e Wayland).

---

## 1. Frameworks de interface: comparação

Legenda: ✅ bom/pronto · ⚠️ parcial/com ressalvas · ❌ ausente · ? não verificado.

| | **Slint** | **egui / eframe** | **iced** | **gpui (Zed)** | **Dioxus Native / Blitz** | **Xilem / Masonry** | **Makepad** | **Freya** |
|---|---|---|---|---|---|---|---|---|
| Versão (nov/2026) | 1.19.1 (23/11/2026) | 0.37 (0.36.2 em 08/09/2026) | 0.14.0 (dez/2025) | crates.io oficial parado em 0.2.2; forks (`gpui-unofficial`, `gpui-ce`) | 0.7.x estável "experimental", 0.8 em alpha | alpha | 1.x (1.0 em 2025) | 0.4 (jul/2026), 0.5-rc |
| Modelo | declarativo retido (`.slint` + Rust), propriedades reativas | modo imediato | Elm (retido), renderização reativa desde 0.14 | retido híbrido, estilo Tailwind em Rust | HTML/CSS (subconjunto) + Rust | retido reativo | retido, DSL com live reload | reativo próprio (largou Dioxus na 0.4), Skia |
| Ocioso / redesenho | ✅ só redesenha ao mudar; 1.19 corrigiu redesenhos à toa (minimizado, outra janela animando) | ✅ parado sem input; ⚠️ com 1 vídeo a 60 fps a UI inteira é refeita 60×/s | ✅ (0.14 reativo) | ✅ (Zed é bem econômico) | ? | ? | ✅ | ? |
| Estilo sob medida (casar com o design) | ✅ componentes próprios, sombras, gradientes, raios, `global` de tokens | ⚠️ dá, mas é trabalho manual; "cara de egui" difícil de apagar | ⚠️ temas/estilos por widget, verboso | ✅ muito flexível (Zed) | ✅ CSS de verdade (reaproveita parte de `common.css`) | ⚠️ | ✅ shaders por widget | ✅ |
| Texto, emoji colorido, IME | ✅ IME; emoji colorido no Skia; 1.19 trouxe emoji colorido no renderizador de software (FemtoVG: ?) | ✅ IME; emoji colorido só na 0.37 (fontes do sistema) | ✅ cosmic-text; IME na 0.14; emoji ? | ✅ (editor do Zed) | ✅ (Parley) | ✅ (Parley) | ⚠️ IME fraco no 1.0 | ✅ Skia |
| Acessibilidade | ✅ AccessKit | ✅ AccessKit (bastante trabalho na 0.37) | ❌ ainda não | ? (não verificado) | ✅ AccessKit | ✅ AccessKit | ❌ "na lista" | ✅ AccessKit (?) |
| GIF animado | ✅ 1.19: `Image` toca GIF/APNG/WebP animados | ✅ `egui_extras` (gif), WebP animado desde 0.31 | ⚠️ crate de terceiros | ? | ? | ❌ | ? | ✅ (?) |
| Textura wgpu externa (vídeo) | ✅ `slint::Image::try_from(wgpu::Texture)` atrás de `unstable-wgpu-29/30` | ✅ `egui_wgpu` registra textura nativa / callbacks de pintura | ✅ widget `shader` com acesso ao `Device` | ⚠️ superfícies próprias; API de textura externa ? | ⚠️ ? | ⚠️ Vello | ⚠️ próprio renderizador | ⚠️ Skia (importar textura GPU é mais chato) |
| Windows | ✅ | ✅ | ✅ | ✅ (Zed para Windows) | ✅ | ✅ | ✅ | ✅ |
| Linux X11/Wayland | ✅ winit; 1.19 corrigiu janela/clipboard no Wayland/GNOME/Flatpak | ✅ winit | ✅ winit | ✅ (wgpu no git desde fev/2026) | ✅ | ✅ | ❌ **sem Wayland** | ✅ |
| Licença | GPLv3 **ou** Royalty-free 2.0 (grátis em desktop, **exige divulgar que usa Slint**: `AboutSlint` ou selo) **ou** comercial | MIT/Apache | MIT | Apache-2.0 | MIT/Apache | Apache | MIT/Apache | MIT |
| Tamanho do binário (estimativa, não medida) | ~5–10 MB com FemtoVG/wgpu, +10–20 MB com Skia | ~5–8 MB | ~8–12 MB | ~15–25 MB | ~10–15 MB | ? | ~5 MB | ~20 MB (Skia) |
| Maturidade para app de usuário final | ✅ empresa por trás, releases a cada ~2 meses, LSP + preview ao vivo | ✅ muito usada (Rerun), mas pensada para ferramentas | ✅ (COSMIC do System76 usa um fork) | ⚠️ sem release oficial em crates.io; API muda junto com o Zed | ❌ alpha | ❌ alpha | ⚠️ comunidade pequena, sem Wayland | ⚠️ um mantenedor principal |

Observações rápidas:

- **Slint**: a licença Royalty-free 2.0 cobre "aplicações desktop, mobile e web"
  proprietárias ou não, sem custo, **desde que** o app diga que usa Slint
  (widget `AboutSlint` ou selo, por exemplo no "Sobre"/ configurações). Nosso
  repositório continua MIT: o código é nosso; o binário distribuído usa o
  Slint sob a licença RF. Alternativa GPLv3 obrigaria o app a ser GPL — não
  precisamos. Risco: dependência de uma empresa (SixtyFPS GmbH) e de uma
  licença que já mudou (1.1 → 2.0); a 2.0 é irrevogável para versões já
  publicadas, mas leia a cláusula antes de publicar **(texto integral não
  revisado por advogado)**.
- **egui**: o mais simples de começar e já integra wgpu de fábrica, mas o
  modo imediato reconstrói a interface inteira a cada quadro; com uma tela
  compartilhada a 60 fps, a UI toda (chat, lista de pessoas) é refeita 60×/s.
  Barato em CPU, mas não é "zero". Emoji colorido só chegou na 0.37.
- **iced 0.14**: arquitetura bonita, renderização reativa, IME e animações;
  falta acessibilidade e o design custa mais código de estilo.
- **gpui**: tecnicamente o mais "Discord-like" (Zed é polido e leve), mas
  sem pacote oficial atualizado no crates.io (0.2.2, ~11 meses atrás do
  `main` do Zed em out/2026); teríamos de seguir o Git do Zed. Risco alto de
  quebra a cada atualização.
- **Dioxus Native/Blitz**: atraente porque reaproveitaria HTML/CSS, mas é
  alpha (0.8.0-alpha) e o motor CSS é parcial.
- **Makepad**: sem Wayland — descarta para Pop!_OS.
- **Freya 0.4**: reescrito sem Dioxus em 2026; Skia pesa no binário; projeto
  de uma pessoa.

### Opção híbrida (WebView para parte da UI + vídeo nativo)

Possível no Windows e é uma boa **etapa intermediária** (seção 5), mas não
como destino final:

- No Linux o WebView do Tauri/wry é WebKitGTK. Sem WebRTC (FOSDEM 2026:
  WebKitGTK ainda migrando para GstWebRTC; bug 274711 de habilitação aberto).
  Num híbrido isso não importa — toda mídia fica no Rust e o WebView só
  desenha chat/lista —, porém:
- Sobrepor uma superfície wgpu a um WebView exige webviews filhas
  (`Window::add_child`, feature `unstable` do Tauri) e no Linux o wry só
  suporta isso em **X11** (não Wayland). Ordem de empilhamento, transparência
  e foco entre HWND/WebView2 e superfície nativa não têm caminho estável
  documentado **(não verificado na prática)**.
- Mantém o custo de memória do WebView2 (~100–200 MB) que queremos tirar.

---

## 2. Recomendação: Slint (com egui como plano B)

**Escolha: Slint 1.19+, renderizador FemtoVG-wgpu (ou Skia se o texto/emoji
exigir), backend winit, licença Royalty-free 2.0 com `AboutSlint` na tela
"Sobre".**

Por quê:

1. **Leveza ociosa**: modelo retido com rastreamento de dependências; só
   redesenha quando uma propriedade muda. A 1.19 corrigiu exatamente os casos
   que nos importam (não acordar na taxa de atualização minimizado, não
   redesenhar ao reatribuir a mesma textura wgpu).
2. **Vídeo**: importa `wgpu::Texture` como `slint::Image` (exemplo oficial
   `wgpu_texture`, `set_rendering_notifier` para pegar o `Device`). Cada novo
   quadro de vídeo só invalida o elemento de vídeo.
3. **Design**: componentes declarativos, `global Theme { in property <color>
   bg: #0B0B0C; ... }` espelhando `common.css`; sombras, raios, gradientes,
   fontes embutidas (Inter, JetBrains Mono). Preview ao vivo no VS Code
   acelera o "pixel perfect" contra `docs/design/*.html`.
4. **GIF animado nativo** (1.19), AccessKit, IME, Wayland e X11.
5. Empresa ativa, releases frequentes, e o mesmo código roda em Android/iOS
   se um dia quisermos.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Interop wgpu é `unstable-wgpu-NN`: muda a cada versão do wgpu (28 → 29 → 30) | Isolar todo o caminho de vídeo num crate `cpx-video` que expõe "me dê a textura RGBA do quadro"; travar versões no `Cargo.lock`; atualizar Slint e wgpu juntos. |
| Chat rico (texto + emoji inline + links + GIF + menção) é o ponto fraco de toolkits não-web | Spike S2 antes de decidir. Emoji como imagens (Twemoji/Noto em atlas) intercaladas com `Text` num `HorizontalLayout`/flow; GIFs como `Image`. Se ficar ruim, plano B: egui só para o chat? (não — misturar toolkits é pior); avaliar `StyledText`/markdown do Slint **(não verificado se existe na 1.19)**. |
| Emoji colorido depende do renderizador (Skia ✅, software ✅ 1.19, FemtoVG ?) | Usar emoji como imagem (igual ao Discord, que usa Twemoji) — independe do renderizador. |
| Licença RF exige divulgação; mudança futura de termos | `AboutSlint` no "Sobre"; GPLv3 como saída de emergência (o app já é open source). |
| Animações de GIF de 12 avatares rodando = redesenho contínuo | Regra de produto: GIF anima só no hover/ quem está falando (como o Discord); parado mostra o 1º quadro. |

**Plano B — egui/eframe 0.37**: se o spike de chat no Slint falhar ou a
interop de textura der problema. Mais simples, wgpu nativo, mas exige mais
esforço para o visual e aceita redesenho da UI inteira enquanto houver vídeo.
**Não recomendados agora**: gpui (sem release estável), Dioxus Native e Xilem
(alpha), Makepad (sem Wayland), Freya (Skia + bus factor).

---

## 3. Pipeline de recebimento de vídeo (quem assiste)

```
str0m (RTP/SRTP, ver 02)                     thread de rede
   │  pacotes H.264 (RTP payload, RFC 6184)
   ▼
depacketizer + jitter buffer de vídeo        thread "video-rx" por pessoa
   │  access units completas (ordem por seq, timestamp RTP 90 kHz)
   │  perda → NACK; sem keyframe → PLI (pedir quadro-chave)
   ▼
decoder (trait VideoDecoder)                 thread "decode" por stream
   │  hw: Vulkan Video (gpu-video) | MF/D3D11VA | VA-API ; sw: openh264
   ▼  quadro NV12 na GPU (ou planos Y/UV na CPU no fallback)
conversão NV12 → RGBA (shader WGSL, BT.709, faixa limitada)
   │  textura RGBA do tamanho exibido (não da fonte, se reduzir)
   ▼
slint::Image::try_from(texture) → elemento de vídeo → redesenho só dele
```

### 3.1 Jitter buffer e pacing

- **Tela compartilhada prioriza latência**: buffer pequeno (alvo 0–30 ms,
  adaptativo pelo jitter medido, teto ~100 ms). Câmera pode ir até ~60 ms.
- Remontar quadros pelo número de sequência; quadro incompleto após o prazo
  → descartar e pedir NACK (se RTT permitir) ou PLI.
- **Sem fila de quadros decodificados**: guardar só o *último* quadro pronto
  por stream (`ArcSwap`/ slot único). Se dois quadros chegarem no mesmo
  vsync, o mais antigo é descartado — nunca acumula atraso.
- Apresentação: o decoder pede redesenho (`slint::invoke_from_event_loop` +
  `window.request_redraw()`); o compositor/vsync faz o resto. Sem timer
  próprio a 60 Hz.
- A/V sync: não sincronizar voz com tela compartilhada (latência mínima em
  ambos); para câmera + voz da mesma pessoa, alinhar por RTCP SR se der lip
  sync visível **(provavelmente desnecessário no mesh pequeno)**.
- Stream fora da tela (aba escondida, janela minimizada, tile fora da área
  visível): **parar de decodificar** e avisar quem envia para pausar/baixar
  camada (já é a regra da página: "câmera sob demanda", resolução antes de
  assistir).

### 3.2 Decodificação por plataforma

| | Windows (RX 5500 XT) | Linux (Mesa/RADV, Intel, NVIDIA) |
|---|---|---|
| Hardware, opção 1 | **`gpu-video` 0.5 (ex-`vk-video`, Software Mansion, 10/11/2026)**: Vulkan Video, H.264 decode e encode, devolve `wgpu::Texture` NV12, wgpu 30. Exige wgpu no backend **Vulkan** também no Windows | **mesmo `gpu-video`**: AMD/NVIDIA com Mesa recente (Mesa antigo: `RADV_PERFTEST=video_decode`) |
| Hardware, opção 2 | **Media Foundation** (MFT H.264 com `IMFDXGIDeviceManager`, DXVA/D3D11VA) → `ID3D11Texture2D` NV12 → copiar para textura compartilhada (NT handle) → abrir no D3D12 do wgpu → `create_texture_from_hal` + `dx12::Texture::with_plane_slice` (wgpu 30) para os planos Y e UV. Já temos experiência com MF no protótipo de captura | **VA-API** (via ffmpeg hwaccel ou `cros-libva`) → exportar DMA-BUF → importar no Vulkan do wgpu (`VK_EXT_image_drm_format_modifier`) — mais frágil |
| Hardware, opção 3 | ffmpeg (`ffmpeg-the-third` 5.x com FFmpeg 8.1; `ffmpeg-next` está congelado) com `d3d11va` | ffmpeg com `vaapi`/`vulkan` |
| Software (fallback) | **`openh264` 0.9** — usar o binário da Cisco baixado na instalação (é assim que a Cisco paga os royalties de patente) ou compilar o fonte (BSD-2, sem a cobertura de patente da Cisco) | igual |
| AV1 / HEVC | RX 5500 XT (RDNA1) decodifica HEVC, **não AV1** (sem verificação nova, conhecido do hardware). `gpu-video`: HEVC/AV1 decode ainda não | idem |

Recomendação: **H.264 em toda parte** (é o que o navegador também entende —
compatibilidade com quem está no site). Decoder em camadas:

1. `gpu-video` (Vulkan Video) se o driver expõe `VK_KHR_video_decode_h264`;
2. Windows: MF/D3D11VA com cópia compartilhada para o wgpu (DX12);
3. `openh264` em software, upload dos planos como texturas `R8Unorm` + `Rg8Unorm`.

O fallback de software sozinho já viabiliza a fase de UI nativa; o caminho
de hardware entra depois do spike S4. Custo do fallback sem cópia zero: 1440p
NV12 ≈ 5,5 MB/quadro → ~330 MB/s de upload a 60 fps; aceitável para quem
assiste, ruim para quem joga *e* assiste — por isso o hardware é a meta.

**Importante — escolha do backend wgpu**: Slint (FemtoVG-wgpu) passou a ter
`require_vulkan()`/`require_d3d()` na 1.19. Se adotarmos `gpu-video` no
Windows, a UI inteira tem de usar wgpu-Vulkan para a textura ser do mesmo
`Device`. Testar se o Vulkan no Windows (driver AMD) se comporta bem em
janela com DWM/HDR; senão, usar DX12 + MF.

### 3.3 Conversão e desenho

- Shader WGSL: amostrar `Y` (R8) e `UV` (RG8), matriz BT.709 de faixa
  limitada (o encoder do protótipo e os navegadores mandam BT.709/limited;
  ler o VUI do SPS para ter certeza).
- Renderizar direto no **tamanho exibido** (tile de câmera 240p não precisa
  de textura 1440p) com filtro bilinear; tela cheia usa o tamanho nativo.
- Wgpu 30 tem formato `NV12` com feature `TEXTURE_FORMAT_NV12` e textura
  externa (`ExternalTexture`, formatos RGBA/NV12/YU12) — pode dispensar o
  shader próprio **(suporte por backend não verificado)**.
- Reaproveitar texturas (pool por stream); recriar só quando a resolução muda.

---

## 4. Câmera nativa

| | Windows | Linux |
|---|---|---|
| API | **Media Foundation** (`IMFSourceReader`, saída NV12, pode ir para GPU) — mesma pilha do protótipo de captura | **PipeWire via portal Camera** (`org.freedesktop.portal.Camera`, `ashpd` 0.13 `Camera::request_access` + `open_pipe_wire_remote`, crate `pipewire`) — obrigatório no Flatpak e o caminho do futuro; **V4L2** direto como fallback fora do sandbox |
| Crate pronta | `nokhwa` 0.10.11 (backends MSMF/V4L2; atividade em 2026 não confirmada; não usa o portal) | idem |

Recomendação: `nokhwa` só no spike; no produto, código próprio fino sobre MF
(Windows) e portal+PipeWire (Linux, com V4L2 se o portal não existir). Saída
NV12 → encoder H.264 do pipeline de envio (documento de captura/envio).
Câmera é sob demanda: não abrir o dispositivo antes de a pessoa ligar.

---

## 5. Distribuição e atualização

### 5.1 Situação atual

- `desktop/tauri.conf.json`: NSIS, `installMode: currentUser`, pt-BR,
  identificador `app.cpxcall.desktop`; o workflow `app-windows.yml` publica
  `CPX-Call-Windows.exe` no release `app-vX.Y.Z`; assinatura SignPath
  preparada. **Sem atualizador**: quem tem 0.1.0/0.2.0 reinstala à mão.

### 5.2 Ferramentas avaliadas

| Ferramenta | Formatos | Atualização | Observações |
|---|---|---|---|
| **cargo-packager** (CrabNebula, 0.11.x) + **cargo-packager-updater** | NSIS, MSI (WiX), .deb, AppImage, pacman | sim (manifesto JSON + assinatura `.sig`, formatos `nsis`/`wix`/`appimage`) | Herdeiro direto do bundler/updater do Tauri: mesmo NSIS, mesmo esquema de assinatura minisign. Melhor continuidade com o que temos. |
| **Velopack** (crate `velopack` 1.2.161, set/2026; 1.3 em pré) | Windows: `Setup.exe` próprio em `%LocalAppData%`; Linux: só `.AppImage`; macOS | sim, **com pacotes delta** | Empacotamento pelo CLI `vpk` (ferramenta .NET — só no CI). Delta é ótimo para app de dezenas de MB; troca o NSIS, exige migração única. |
| Tauri updater (`tauri-plugin-updater`) | — | sim | Referência; útil **agora** no app Tauri para fazer a ponte (5.4). |
| `dist` (ex-cargo-dist, 0.30.x, dez/2025) | tarballs, MSI, instaladores shell/PowerShell | só via `axoupdater`, pensado para CLIs | Bom para CLI; fraco para app GUI. Usar só se quisermos gerar o workflow de CI. |
| `self_update` | — | troca o binário | Para CLI; sem instalador nem atalhos. Não. |
| MSIX | Windows | via App Installer | Exige assinatura confiável sempre; atrito com SignPath e com o `currentUser`. Não agora. |
| Flatpak (Flathub) | Linux | pelo sistema | Sandbox força portais (câmera, captura de tela, atalhos globais via portal GlobalShortcuts) — bom para Wayland; revisão do Flathub leva tempo. Fase 2 do Linux. |

### 5.3 Recomendação por SO

- **Windows**: continuar com **NSIS `currentUser`** gerado pelo
  **cargo-packager**, mesmo `identifier`/pasta de instalação, assinado pela
  SignPath, e **cargo-packager-updater** lendo um `latest.json` publicado no
  release do GitHub (URL fixa `.../releases/latest/download/latest.json`).
  Reavaliar Velopack quando o tamanho do download incomodar (delta).
- **Linux**: **AppImage** com atualização pelo cargo-packager-updater (o
  updater troca o arquivo) + **.deb** para quem prefere apt (sem auto-update;
  avisar na interface que há versão nova). Flatpak depois, quando captura de
  tela e câmera já usarem portais.
- **Assinatura**: Windows = SignPath (Authenticode) no instalador **e** no
  `.exe`; atualizações = assinatura minisign do updater (chave privada em
  secret do GitHub). Linux = minisign no AppImage; GPG se um dia houver repo apt.
- **CI** (GitHub Actions): matriz `windows-latest` + `ubuntu-22.04` (glibc
  mais antiga = AppImage roda em mais distros). Linux precisa de
  `libxkbcommon-dev`, `libwayland-dev`, `libpipewire-0.3-dev`,
  `libfontconfig1-dev`, `libvulkan-dev`. Reaproveitar `app-windows.yml`
  (tag `app-v*`), gerar `latest.json` com as URLs e assinaturas, e manter o
  nome fixo `CPX-Call-Windows.exe` porque o lobby aponta para ele.

### 5.4 Migração a partir do app Tauri

Princípio: **quem tem o app nunca precisa reinstalar de novo depois da
próxima versão**, e o site continua funcionando para quem está no navegador
(os clientes nativos falam WebRTC compatível com o navegador).

1. **0.3.0 (Tauri, já):** adicionar `tauri-plugin-updater` com chave
   minisign e `latest.json` no GitHub Releases. Última reinstalação manual
   (avisar no lobby para quem tem 0.1/0.2). Ganho imediato: atualizações da
   parte Rust (atalhos, fase 1) chegam sozinhas.
2. **0.4–0.x (Tauri + Rust, fase 1/2):** a página continua sendo a UI; o
   Rust compartilha a tela e (depois) faz a voz, sinalizando pelo mesmo
   WebSocket (a página faz a ponte). Atualizações pelo updater.
3. **Etapa híbrida opcional (só Windows):** vídeo recebido decodificado no
   Rust e mostrado numa **janela nativa separada** ("abrir tela em janela"
   / tela cheia) feita em Slint+wgpu — evita o problema de sobrepor
   superfícies ao WebView e já testa o pipeline da seção 3 com usuários
   reais. Chat e lista continuam no WebView.
4. **1.0 (nativo):** app Slint completo. Empacotado com cargo-packager como
   NSIS **com o mesmo `identifier` e pasta de instalação** e o mesmo formato
   de manifesto/assinatura minisign; o updater do Tauri 0.x baixa e roda esse
   NSIS como se fosse mais uma versão → troca transparente. Manter o mesmo
   nome de executável/atalho e a mesma pasta de dados (perfil, código de
   amigo por aparelho, #132) ou migrar os dados no primeiro início.
5. **Linux** estreia direto no nativo (AppImage/.deb), sem passar pelo Tauri
   (WebKitGTK sem WebRTC tornaria a fase Tauri inútil no Linux).
6. Manter por alguns meses uma chave `?legacy` / flag para cair no WebView
   caso o nativo tenha um bug grave **(decidir no spike S6)**.

Ponto a validar no spike S6: o `tauri-plugin-updater` executa o NSIS baixado
com argumentos próprios (`/UPDATE`, modo passivo); confirmar que um NSIS do
cargo-packager aceita isso e que a desinstalação antiga (entrada no
"Programas e Recursos") é substituída, não duplicada.

---

## 6. Spikes (ordem sugerida, cada um com critério de pronto)

| # | Spike | Mede/decide | Máquina |
|---|---|---|---|
| S1 | **Slint ocioso**: janela com a lista de pessoas e 12 avatares (3 GIFs) com o visual do `cpx-call-componentes.html` | CPU/GPU parado (alvo < 0,5% de um núcleo, GPU ~0), RAM, binário; FemtoVG-wgpu vs Skia; X11 vs Wayland | Pop!_OS e Windows |
| S2 | **Chat no Slint**: 500 mensagens virtualizadas, emoji como imagem inline, links, GIF do KLIPY, IME (acentos, `ç`, dead keys no Windows e IBus no Linux), seleção e copiar texto | Decide Slint × egui | ambas |
| S3 | **Vídeo software**: `openh264` decodificando 1440p60 de um arquivo H.264 (gerado pelo `captura.rs`) → planos R8/RG8 → shader → `slint::Image` | CPU do decode, latência, redesenho só do tile; 4 câmeras 360p + 1 tela | ambas |
| S4 | **Vídeo hardware**: `gpu-video` (Vulkan Video) com textura no mesmo `Device` do Slint; no Windows comparar com MF/D3D11VA → NT handle → DX12 (`with_plane_slice`) | Funciona na RX 5500 XT? Custo vs S3; impacto num jogo rodando (FPS do jogo) | Windows primeiro, depois Pop!_OS (RADV) |
| S5 | **Câmera**: MF (Windows) e portal Camera + PipeWire (Pop!_OS/GNOME Wayland) | Permissão, NV12, latência | ambas |
| S6 | **Distribuição**: cargo-packager NSIS + updater; atualizar um Tauri 0.3 (com `tauri-plugin-updater`) para um "nativo" de teste com mesmo identifier | Migração transparente, entrada única no Painel de Controle, dados preservados; AppImage atualizando sozinho | ambas |
| S7 | **Licença/AboutSlint** e créditos (Slint RF, openh264/Cisco, fontes OFL) numa tela "Sobre" | Conformidade antes do 1.0 | — |

---

## 7. Pontos não verificados

- Emoji colorido no renderizador FemtoVG do Slint; existência de texto rico
  (`StyledText`) na 1.19.
- Acessibilidade do gpui; status do GIF animado no Freya.
- Tamanhos de binário da tabela (estimativas, não medidas).
- Suporte do formato `NV12`/`ExternalTexture` do wgpu 30 em cada backend.
- `gpu-video` na RX 5500 XT com driver AMD no Windows ("should work",
  segundo o autor).
- Se o `tauri-plugin-updater` instala um NSIS gerado pelo cargo-packager sem
  problemas (S6).
- Manutenção ativa do `nokhwa` em 2026.
- Leitura jurídica da licença Slint Royalty-free 2.0.

---

## Fontes

- Slint — licenças: https://raw.githubusercontent.com/slint-ui/slint/HEAD/LICENSE.md
- Slint — Royalty-free 2.0: https://unpkg.com/slint-ui@1.12.0/LICENSES/LicenseRef-Slint-Royalty-free-2.0.md
- Slint — CHANGELOG (1.18, 1.19, 1.19.1): https://raw.githubusercontent.com/slint-ui/slint/master/CHANGELOG.md
- Slint 1.15 (wgpu 28): https://slint.dev/blog/slint-1.15-released
- Slint — importação de textura wgpu: https://docs.slint.dev/latest/docs/rust/slint/wgpu_28
- Slint — exemplo `wgpu_texture`: https://cdn.jsdelivr.net/gh/slint-ui/slint@1.16.0/examples/wgpu_texture/README.md
- Slint — AccessKit: https://github.com/slint-ui/slint/issues/32
- egui — CHANGELOG (0.33–0.37): https://raw.githubusercontent.com/emilk/egui/main/CHANGELOG.md
- egui — acessibilidade: https://raw.githubusercontent.com/emilk/egui/main/docs/accessibility.md
- eframe (versões): https://docs.rs/crate/eframe/latest
- iced 0.14.0: https://github.com/iced-rs/iced/releases/tag/0.14.0
- iced — widget shader: https://docs.iced.rs/iced/widget/shader/index.html
- iced_video_player: https://github.com/jazzfool/iced_video_player
- gpui no crates.io (estado em 2026): https://baeseokjae.github.io/posts/native-app-for-coding-agents-rust-gpui/
- gpui forks: https://docs.rs/crate/gpui-ce/0.3.2 , https://docs.rs/crate/gpuikit/0.9.0
- Dioxus releases (0.8 alpha): https://github.com/DioxusLabs/dioxus/releases
- Blitz: https://github.com/DioxusLabs/blitz , https://lib.rs/crates/blitz-html
- Linebender (Xilem/Masonry) dez/2025: https://linebender.org/blog/tmil-24/
- Makepad 1.0 (discussão): https://axebps-redlib.hf.space/r/rust/comments/1kllldg/makepad_10_rust_ui_framework
- Freya 0.4: https://docs.freyaui.dev/posts/0.4 , https://github.com/marc2332/freya
- WebKitGTK + WebRTC (FOSDEM 2026): https://fosdem.org/2026/schedule/event/KMMLGM-webrtc_support_in_webkitgtk_and_wpewebkit_with_gstreamer_current_status_and_plan/
- WebKit bug 274711: https://www2.webkit.org/show_bug.cgi?id=274711
- Tauri — WebRTC no WebKitGTK: https://github.com/tauri-apps/tauri/discussions/8426
- Tauri — webview filha (unstable): https://tauri.app/reference/javascript/api/namespacewebview/
- wry (filhas só X11 no Linux): https://docs.rs/crate/wry/0.54.3/source/README.md
- tauri-wgpu-cam: https://uithub.com/clearlysid/tauri-wgpu-cam
- wgpu v30.0.0: https://sourceforge.net/projects/wgpu.mirror/files/v30.0.0/
- wgpu external texture: https://wgpu.rs/doc/src/wgpu_types/texture/external_texture.rs.html
- Firefox/wgpu NV12: https://bugzilla.mozilla.org/show_bug.cgi?id=2071520
- gpu-video (ex-vk-video): https://docs.rs/crate/gpu-video/latest , https://docs.rs/crate/vk-video/latest
- ffmpeg-next (congelado) e ffmpeg-the-third: https://docs.rs/crate/ffmpeg-next/9.0.0 , https://docs.rs/crate/ffmpeg-the-third/latest
- Estado da mídia em Rust 2026 (blog): https://dev.to/yeauty/the-state-of-media-processing-in-rust-2026-what-each-crate-actually-covers-2k2c
- openh264 crate: https://docs.rs/crate/openh264/0.9.3/source/README.md
- openh264-sys2 (licença Cisco): https://docs.rs/crate/openh264-sys2/0.9.6/source/src/lib.rs
- nokhwa: https://docs.rs/crate/nokhwa
- Portal Camera: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Camera.html
- ashpd Camera: https://docs.rs/crate/ashpd/0.13.0/source/src/desktop/camera.rs
- libwebrtc camera_portal.cc: https://webrtc.googlesource.com/src/+/main/modules/video_capture/linux/camera_portal.cc
- cargo-packager: https://github.com/crabnebula-dev/cargo-packager
- cargo-packager updater: https://docs.crabnebula.dev/packager/updater/ , https://docs.rs/crate/cargo-packager-updater/latest/
- Velopack crate: https://docs.rs/crate/velopack/latest
- Velopack Linux: https://docs.velopack.io/packaging/operating-systems/linux
- dist (cargo-dist): https://axodotdev.github.io/cargo-dist/changelog , https://raw.githubusercontent.com/axodotdev/cargo-dist/main/README.md
