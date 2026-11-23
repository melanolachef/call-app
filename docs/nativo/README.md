# Cliente nativo em Rust: estudo

Estudo reunido em 23/11/2026 para escrever o CPX Call nativo em Rust, para
Windows e Linux. As versões de crates e o estado dos projetos foram conferidos
nessa data. O que não deu para confirmar está marcado como **não verificado**
em cada documento. Antes de decidir qualquer ponto, rode o spike
correspondente.

| Documento | Assunto |
|---|---|
| [01-protocolo.md](01-protocolo.md) | O contrato de hoje: HTTP, WebSocket, mensagens entre participantes, negociação WebRTC e as armadilhas para quem não é navegador |
| [02-webrtc.md](02-webrtc.md) | Qual WebRTC usar em Rust, bitrate em mesh, quando vale um SFU |
| [03-captura-encoder.md](03-captura-encoder.md) | Captura de tela e de som do jogo, encoder na placa de vídeo (Windows e Linux), clipes |
| [04-voz-atalhos.md](04-voz-atalhos.md) | Voz (entrada/saída, Opus, eco e ruído, jitter buffer) e atalhos globais |
| [05-interface-distribuicao.md](05-interface-distribuicao.md) | Interface nativa, receber e decodificar vídeo, câmera, instalador e atualização |

## Escolhas propostas

| Parte | Proposta | Plano B |
|---|---|---|
| WebRTC | **str0m** (Rust puro, sans-IO; GCC/pacer, TWCC, NACK/RTX, PLI) | `libwebrtc` da LiveKit, que aceita quadros já codificados |
| Codec de tela | **H.264** Constrained Baseline/High, packetization-mode=1 | HEVC/AV1 só depois (a RX 5500 XT não faz AV1) |
| Captura e encoder no Windows | **WGC → video processor D3D11 → MFT de hardware** (o protótipo) | AMF/NVENC direto |
| Captura e encoder no Linux | **Portal ScreenCast + PipeWire (DMA-BUF) → VA-API** (GStreamer `vah264enc`) | `openh264` em software |
| Som do jogo | **Process loopback do WASAPI** (exclui o próprio app); monitor do PipeWire no Linux | Loopback clássico |
| Áudio | **cpal** 0.18 + **opus** 0.4 + **sonora** (eco, ruído e ganho em Rust puro) | `webrtc-audio-processing` (C++) |
| Jitter buffer de voz | **Nosso**, pequeno, com FEC e PLC do Opus | O NetEQ do `libwebrtc` |
| Atalhos | Windows: Raw Input (hook de hoje como reserva). Linux: XInput2 no X11, portal `GlobalShortcuts` no Wayland | evdev (grupo `input`) ou só com a janela em foco |
| Interface | **Slint** 1.19+ (redesenha só quando muda, GIF animado, textura wgpu) | egui |
| Decodificar vídeo | **gpu-video** (Vulkan Video) → Media Foundation D3D11VA → `openh264` | ffmpeg (`ffmpeg-the-third`) |
| Instalador e atualização | **cargo-packager** + updater (NSIS no Windows, AppImage e .deb no Linux) | Velopack |

## A decisão grande em aberto: str0m ou libwebrtc

- **str0m:** é Rust de verdade, leve, sem C++ e compila fácil no Windows e no
  Linux. Em troca, ficam por nossa conta o jitter buffer de voz, o
  TURN/coleta de candidatos e a junção dos pedidos de quadro-chave. O README
  dele diz que o uso P2P foi menos testado que o uso como SFU.
- **libwebrtc (LiveKit):** é o mesmo motor do Chrome. Traz NetEQ, eco/ruído,
  decoders e TURN prontos, o que é forte nas fases 2 e 3. Em troca, é um
  download de 100+ MB no build, exige clang no Linux, tem um conflito de CRT
  no MSVC sem solução prevista e é "menos Rust".
- **Proposta:** str0m na fase 1, porque só envia vídeo já codificado e é onde
  ele brilha. Reavaliar antes da fase 2 com o spike de voz: se o nosso jitter
  buffer com o Opus não ficar tão bom quanto o navegador, migrar para o
  libwebrtc nas fases 2 e 3.

## Roteiro

Cada fase só começa depois que os spikes dela passam. Os spikes, com os
critérios de pronto, estão em cada documento.

### Fase 0: base comum (dá para fazer no Pop!_OS)
1. Biblioteca `cpx-core` com a sinalização do [01](01-protocolo.md): entra
   numa sala pelo WebSocket, troca perfil e responde às mensagens P2P.
2. Spike: str0m ↔ Chrome/Edge/Firefox com H.264 de um arquivo e com
   `openh264`. Medir interop, o BWE inicial (str0m #1127) e a remoção dos NAL
   de preenchimento.

### Fase 1: compartilhar tela pelo app do Windows
1. O protótipo `captura.rs` vira o `Capturer`/`Encoder` do
   [03](03-captura-encoder.md), seção 10. O AMF vai para VBR de baixa
   latência.
2. Uma conexão extra por pessoa que assiste: o app sempre oferece
   (`sendonly`), sinalizada por `{native:{…}}` dentro de `data` ([02](02-webrtc.md)).
   O servidor não muda; o `webrtc.js` ganha um segundo `RTCPeerConnection`
   que só responde.
3. O bitrate fica com o app: o mínimo das estimativas de quem assiste × 0,85
   e no máximo 1 quadro-chave a cada ~500 ms para todos.
4. Medir com jogo rodando (PresentMon/typeperf) contra o Edge.
5. Firefox sem OpenH264 não decodifica: nesse caso volta para o
   compartilhamento pela WebView.

### Fase 2: voz em Rust
cpal → sonora → Opus → RTP, e RTP → jitter buffer → Opus → mistura (volume
por pessoa) → saída. O soundpad entra depois da supressão de ruído. O
apertar para falar passa para Raw Input. Aqui se decide str0m ou libwebrtc.

### Fase 3: interface nativa (e Linux)
1. Slint no lugar do WebView2.
2. Receber vídeo: gpu-video/Media Foundation → NV12 → shader.
3. Câmera: Media Foundation no Windows; portal Camera + PipeWire no Linux.
4. Linux:
   - captura por portal + PipeWire;
   - VA-API;
   - atalhos por XInput2 ou portal;
   - AppImage e .deb.
5. Migração do Tauri:
   - a 0.3.0 do Tauri já sai com atualizador;
   - o nativo 1.0 usa o mesmo `identifier` e é instalado como mais uma
     versão;
   - o Linux estreia direto no nativo.

### Depois
- Clipes (#103): anel em RAM com os últimos ~30 s já codificados e montagem
  do MP4 sem recodificar ([03](03-captura-encoder.md), seção 8).
- SFU (#25): quando o upload de quem compartilha não der conta. O str0m
  também serve para isso.

## O que dá para fazer em cada máquina

| | Windows | Pop!_OS |
|---|---|---|
| `cpx-core` (sinalização, str0m, interop com o navegador) | sim | sim |
| Captura e encoder da fase 1 (WGC, Media Foundation) | sim | não |
| Voz (cpal, Opus, sonora) | sim | sim |
| Interface Slint e decodificação | sim | sim |
| Captura no Linux (portal, PipeWire, VA-API) | não | sim; melhor no 24.04 em Wayland, porque o 22.04 traz GStreamer 1.20 sem os encoders VA novos |

## Riscos que atravessam tudo

- **COSMIC (Pop 24.04) e GNOME 46 (Ubuntu 24.04) não têm o portal de atalhos
  globais.** O apertar para falar com o jogo em foco cai no evdev ou só
  funciona com a janela em foco.
- **Anti-cheat e jogos rodando como administrador** podem bloquear captura e
  atalhos (não verificado).
- **A licença do Slint** (Royalty-free 2.0) exige um crédito visível no app.
  Ninguém da área jurídica revisou.
- **O mesh limita pelo upload** de quem compartilha: cerca de 27 Mbit/s para
  11 pessoas assistindo a 2,5 Mbit/s.
