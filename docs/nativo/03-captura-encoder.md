# 03 · Captura de tela, áudio do jogo e encoder de vídeo (Windows e Linux, em Rust)

_Pesquisa de 2026-11-23. Contexto: fases 1–3 do cliente nativo (ver CLAUDE.md,
"Próximos passos"). Itens marcados **[não verificado]** não foram confirmados em
fonte primária nesta pesquisa; confira antes de depender deles._

## 1. Resumo e decisões propostas

1. **H.264 continua sendo o codec da fase 1.** É o único que todo navegador
   decodifica em hardware no WebRTC. HEVC no WebRTC só no Chrome 136+ e com
   encoder de hardware, e o Edge não envia HEVC. AV1 não tem encoder na RX 5500 XT
   (VCN 2.0) e pesa na CPU de quem assiste sem decodificador de AV1. AV1 fica
   como opção futura para quem tem RTX 40+/RDNA3+/Arc **e** só tem espectadores
   que o decodificam.
2. **Um encode por transmissão, N envios.** O encoder roda uma vez e cada
   espectador recebe os mesmos NAL units, empacotados em RTP por conexão. Em
   mesh, o upload é `bitrate × espectadores`: 6 Mb/s × 5 = 30 Mb/s de upload.
   Os pedidos de keyframe (PLI/FIR) dos espectadores são somados e limitados a
   no máximo 1 IDR por ~1 s.
3. **Windows: manter o caminho do protótipo** (WGC → D3D11 Video Processor
   BGRA→NV12 → MFT de hardware do Media Foundation), tudo no mesmo
   `ID3D11Device`. O MF cobre AMD, NVIDIA e Intel com um código só. AMF direto
   ou NVENC direto só entram se o spike de filler/latência (seção 6.1) mostrar
   que o MFT não basta.
4. **Linux: portal ScreenCast (ashpd) + PipeWire (DMA-BUF) → VA-API**, de início
   por GStreamer (`vapostproc ! vah264enc`), porque é o caminho mais curto com
   DMA-BUF zero-copy e funciona em AMD e Intel. NVIDIA no Linux: `nvh264enc`
   (GStreamer) ou NVENC direto. X11 (Pop!_OS 22.04) fica com um fallback caro
   (XShm, cópia na CPU) e limite de 720p30, ou fica sem suporte; decidir depois
   de medir.
5. **Áudio do jogo:** process loopback do WASAPI no modo *excluir a árvore do
   nosso processo* (Windows 10 build 20348+ / Windows 11). No Linux, o monitor
   do sink padrão do PipeWire, ou só os nós do jogo.
6. **Clipes (#103):** anel em RAM com os access units já codificados, cortado
   em GOPs. 30 s a 8 Mb/s dão ~30 MB. O MP4 é montado sem recodificar o vídeo
   (`muxide` ou `mp4-atom` em Rust puro; `IMFSinkWriter` no Windows).
7. **Referência principal: m3llo** (mollohq/m3llo). Tem o mesmo produto e as
   mesmas escolhas, já implementadas em C++ (`libmello/src/video`). Resumo na
   seção 9.

## 2. Arquitetura por sistema

### 2.1 Windows (fase 1)

```
 Jogo (DX11/DX12/Vulkan, janela ou sem borda)
   │  DWM compõe
   ▼
 WGC: GraphicsCaptureItem (HWND ou HMONITOR)       ← DXGI DuplicateOutput1 como alternativa p/ monitor
   │  Direct3D11CaptureFramePool (FreeThreaded, 2–3 buffers)
   │  ID3D11Texture2D BGRA8 (ou RGBA16F se HDR)       [VRAM, mesmo ID3D11Device]
   ▼
 ID3D11VideoProcessor (BGRA→NV12 + escala + recorte da área do cliente)
   │  textura NV12 de um anel de 3–4 (D3D11_BIND_RENDER_TARGET | VIDEO_ENCODER)
   ▼
 MFT H.264 de hardware (assíncrono, IMFDXGIDeviceManager)
   │  AMD: "AMDh264Encoder"  NVIDIA: "NVIDIA H.264 Encoder MFT"  Intel: "Intel® Quick Sync Video H.264 Encoder MFT"
   ▼
 Access unit Annex-B (Vec<u8>) ──► remover NAL 12 (filler) ──► Arc<[u8]>
   ├──► empacotador RTP H.264 (RFC 6184) × N espectadores (webrtc-rs/str0m, outro doc)
   └──► anel de clipes (seção 8)

 Áudio: ActivateAudioInterfaceAsync(PROCESS_LOOPBACK, EXCLUDE nossa árvore)
        → IAudioClient float32 48 kHz → Opus 48 kHz estéreo → trilha "som da tela"
```

Nenhum quadro passa pela CPU. A única cópia na CPU é o bitstream comprimido
(dezenas de KB por quadro).

### 2.2 Linux (fase 3; spike antes)

```
 Wayland (GNOME/mutter, COSMIC, KDE)                X11 (Pop!_OS 22.04 padrão)
   │                                                  │
 xdg-desktop-portal ScreenCast (ashpd)              XShm (x11rb) / XComposite p/ janela
   │ CreateSession → SelectSources(cursor=embedded,   │ cópia na CPU, BGRx em RAM
   │   persist_mode=2) → Start → OpenPipeWireRemote   │
   ▼                                                  ▼
 PipeWire stream (pipewire-rs)                      upload/conversão na CPU (caro)
   │ negocia SPA_DATA_DmaBuf + modifier; senão MemFd
   ▼
 DMA-BUF (BGRx/BGRA + modifier)
   │  importa como VASurface (DRM_PRIME_2)         ← NVIDIA: EGL/CUDA import (nvh264enc via GL)
   ▼
 VA-API VPP (RGB→NV12, escala)  ── vapostproc
   ▼
 VA-API encode H.264  ── vah264enc (AMD radeonsi / Intel iHD), vah264lpenc (Intel low-power)
   ▼
 access units → RTP × N / anel de clipes

 Áudio: PipeWire, captura do monitor do sink padrão (ou nós do jogo por PID),
        excluindo o nosso próprio nó de saída.
```

## 3. Captura no Windows

| Tema | O que fazer | Notas |
|---|---|---|
| API | **WGC** (`Windows.Graphics.Capture`) por janela ou monitor | Windows 10 1803+. Passa pelo DWM e funciona com jogos em janela ou sem borda, que hoje são a maioria (os "fullscreen optimizations" deixam o "tela cheia" sobre o DWM). |
| Monitor | WGC com `CreateForMonitor`, ou DXGI Desktop Duplication (`IDXGIOutput5::DuplicateOutput1`) | O m3llo usa DXGI para monitor por padrão e WGC para janela. O DXGI precisa de um `ID3D11Device` no **mesmo adaptador** do monitor (notebook híbrido: atenção). |
| Tela cheia exclusiva de verdade | Nenhum caminho de tela vê; só um *hook* dentro do jogo (OBS "game capture") | Hook = injeção de DLL, risco com anti-cheat (Vanguard, EAC, BattlEye). **Não fazer.** Mostrar "o jogo está em tela cheia exclusiva; use sem borda". O m3llo detecta com `SHQueryUserNotificationState`. |
| Cursor | WGC: `GraphicsCaptureSession::SetIsCursorCaptureEnabled(true)` (desenhado no quadro). DXGI: o ponteiro vem à parte (`GetFramePointerShape`) e precisa ser composto | Para jogo com mira própria, oferecer "sem cursor". |
| Borda amarela | `SetIsBorderRequired(false)` após `GraphicsCaptureAccess::RequestAccessAsync(Borderless)` | Windows 10 20348+ / 11. |
| Limitar a taxa de captura | `GraphicsCaptureSession::MinUpdateInterval` | Windows 11 24H2+ **[não verificado: versão exata]**. Sem isso o WGC entrega na taxa do monitor (144 Hz) e o descarte fica com a gente: descartar **antes** do video processor. |
| Barra de título | Recortar a área do cliente (`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` contra `ClientToScreen`) no próprio video processor (`VideoProcessorSetStreamSourceRect`) | O m3llo faz isso (`window_crop.hpp`). |
| Redimensionar janela | Quadro com `ContentSize` diferente → `FramePool::Recreate` no tamanho novo; o encoder mantém o tamanho fixo e o VP escala com letterbox | Recriar o encoder custa um IDR e ~100 ms; evitar. |
| HDR | WGC/DXGI entregam `R16G16B16A16_FLOAT` (scRGB) se o pool for criado nesse formato | Para espectador SDR: tone mapping PQ/scRGB→BT.709 num compute shader antes do NV12. Fase 1: pedir BGRA8 (o DWM converte, com cor "lavada" em HDR) e medir. |
| Multi-monitor | Listar com `EnumDisplayMonitors`; DPI por monitor (`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`) | GPU híbrida: monitor ligado na iGPU e jogo na dGPU = cópia entre adaptadores. |
| Minimizado | WGC para de entregar quadros de janela minimizada | Mostrar estado "pausado"; não derrubar a transmissão. |
| Threading | `CreateFreeThreaded` + evento `FrameArrived` num thread nosso; COM em MTA | Nada de `DispatcherQueue` de UI. |

**Crates:** `windows` 0.62.2 (Microsoft, oficial; o protótipo já usa) dá WGC,
D3D11, DXGI, MF e WASAPI. `windows-capture` 2.0.1 (ago/2026, MIT) embrulha WGC
e DXGI e tem encoder para MP4. Serve de **referência**, mas a gente precisa
controlar o device compartilhado, o pool e o descarte de quadros; o README não
mostra acesso direto à `ID3D11Texture2D` **[não verificado]**. Recomendação:
WGC direto com `windows`, como no protótipo. (O `windows-core` aparece como
0.100.0 no crates.io; a numeração do windows-rs mudou **[não verificado:
compatibilidade com `windows` 0.62]**.)

## 4. Captura no Linux

- **Wayland: portal ScreenCast.** `ashpd` 0.14.3 (21/11/2026, zbus, ativo) faz
  `CreateSession`/`SelectSources`/`Start`/`OpenPipeWireRemote` e entrega o fd e
  o `node_id`. Pedir `cursor_mode = Embedded` (ou `Metadata` para desenhar
  depois), `source_type = Monitor | Window` e `persist_mode = ExplicitlyRevoked`,
  guardando o `restore_token` para não abrir o diálogo do portal toda vez. O
  diálogo é do compositor e não dá para pular: é o modelo de segurança.
- **PipeWire:** `pipewire` 0.10.1 (ago/2026, pipewire-rs/freedesktop). Negociar
  `SPA_PARAM_Buffers` com `dataType = 1<<SPA_DATA_DmaBuf` e
  `SPA_FORMAT_VIDEO_modifier`, como a página de DMA-BUF do PipeWire descreve.
  Sem DMA-BUF (driver ou portal antigo) cai em MemFd, ou seja, cópia na CPU.
  Devolver o `pw_buffer` logo depois do encoder importar o quadro (o m3llo faz
  isso com uma fila de retorno ao loop thread).
- **COSMIC** (Pop!_OS 24.04): `xdg-desktop-portal-cosmic` (Rust, ativo, último
  commit em 18/11/2026) implementa ScreenCast com monitor, janela e virtual,
  cursor hidden/embedded/metadata, persistência e DMA-BUF com negociação de
  modifier (via gbm), com SHM de fallback. Isso foi conferido no
  `src/screencast*.rs`. Há um TODO sobre usar `buffer_infos` para os
  modifiers: testar de verdade.
- **GNOME (mutter, xdg-desktop-portal-gnome) e KDE (xdg-desktop-portal-kde):** ScreenCast com DMA-BUF há anos. wlroots
  usa `xdg-desktop-portal-wlr` ≥ 0.6 (DMA-BUF).
- **X11:** o portal do GNOME em sessão X11 não faz ScreenCast **[não
  verificado no Pop 22.04]**. As opções são XShm (`x11rb` 0.14 com `shm`), que
  é cópia na CPU, ~8 MB por quadro em 1080p, e conversão para NV12 na CPU ou
  upload para a GPU; ou KMS grab (`drmModeGetFB2` + export de DMA-BUF), que é
  zero-copy mas exige `CAP_SYS_ADMIN` (o Sunshine pede `setcap`) e não pega
  janela. Proposta: Linux só em Wayland no começo (24.04 COSMIC e GNOME
  Wayland); no X11, oferecer XShm limitado a 720p30 e mostrar o custo.
- **Alternativa curta para o spike:** o GStreamer `pipewiresrc fd=<fd>
  path=<node>` consome direto o que o ashpd devolve, sem pipewire-rs.

## 5. Encoders: opções e crates

| Caminho | SO / GPUs | Crate (versão, data) | Zero-copy | Comentário |
|---|---|---|---|---|
| **Media Foundation MFT** | Windows / AMD, NVIDIA, Intel | `windows` 0.62.2 | Sim (`IMFDXGIDeviceManager` + `MFCreateDXGISurfaceBuffer`) | Já provado no protótipo. Controle por `ICodecAPI`. Cada fabricante implementa o MFT a seu modo (filler, limites, propriedades aceitas). |
| AMF direto | Windows (e Linux com AMF/amdgpu-pro) / AMD | Nenhum crate mantido (`amf` no crates.io é outra coisa: Action Media Format). Bindgen dos headers do GPUOpen AMF, que são compatíveis com C | Sim (`AMF_SURFACE_DX11`) | Controle fino: `FILLER_DATA_ENABLE`, `USAGE_ULTRA_LOW_LATENCY`, `LOWLATENCY_MODE`, VBAQ. É o que o m3llo usa. |
| NVENC direto | Windows/Linux / NVIDIA | `nvidia-video-codec-sdk` 0.4.0 (set/2025, pouco uso) ou bindgen do `nvEncodeAPI.h` | Sim (registrar a `ID3D11Texture2D`) | Melhor latência e controle (tuning ULL, intra-refresh). Carrega `nvEncodeAPI64.dll` em tempo de execução. |
| Intel oneVPL/QSV | Windows/Linux / Intel | Sem crate mantido | Sim | No Windows o MFT da Intel é bom; no Linux, VA-API. Pular. |
| **GStreamer** | Linux (e Windows) | `gstreamer` 0.25.4 (set/2026), `gstreamer-app` 0.25.2 | Sim com `memory:DMABuf` → `memory:VAMemory` | `vah264enc`/`vah264lpenc`/`vapostproc` (plugin `va`), `nvh264enc`. No Windows existem `mfh264enc`, `nvd3d11h264enc`, `qsvh264enc` e `amfh264enc` com `d3d11`, mas o runtime pesa ~50–100 MB. |
| VA-API direto | Linux / AMD (radeonsi), Intel (iHD) | `cros-libva` 0.0.13 (dez/2024, parado), `cros-codecs` 0.0.6 (jun/2025, encoder H.264 sem estado em Rust, ChromeOS), `libva` 0.1.5 (out/2026, novo, 1,5 mil downloads) | Sim | Mais Rust e menos dependências, mas é preciso escrever SPS/PPS/slice headers e o controle de taxa (ou usar o do cros-codecs). Fase posterior. |
| Vulkan Video | Linux/Windows / AMD (RADV), Intel (ANV), NVIDIA | `gpu-video` 0.5.0 (nov/2026, Software Mansion/smelter, integra com wgpu; antes `vk-video`) | Sim | Encode H.264/H.265 no RADV desde o Mesa 24.1, mas atrás de `RADV_PERFTEST=video_encode`. Não achei confirmação de que esteja ligado por padrão em 2026 **[não verificado]**, nem se cobre VCN 2.0 (RX 5500 XT) **[não verificado]**. O Sunshine ganhou encode Vulkan em abr/2026. Interessante para a fase 3 com wgpu; não para a fase 1. |
| FFmpeg | Tudo | `ffmpeg-next` 9.1.0 (nov/2026), `rsmpeg` 0.18 (FFmpeg 8.0) | Sim com `hw_frames_ctx` (d3d11va/vaapi) | Uma API para `h264_amf/nvenc/qsv/mf/vaapi/vulkan`. Contra: build no Windows, DLLs de ~60–100 MB, LGPL (link dinâmico), e o d3d11 do FFmpeg teria de usar o nosso device. É o que o Sunshine faz (exceto NVENC). |
| **openh264** (software) | Tudo | `openh264` 0.9.10 (nov/2026) | Não | Fallback sem GPU. Ver nota de licença abaixo. Custo de CPU alto: só 720p30 ou menos. |

**Licença/patentes do OpenH264:** o crate compila o código do OpenH264 (BSD-2)
por padrão (feature `source`). A Cisco só paga os royalties MPEG-LA de H.264
para quem usa o **binário oficial baixado da Cisco** em tempo de execução
(feature `libloading` do crate; o app não pode embutir a DLL, tem de
baixá-la). Compilar da fonte e distribuir não tem essa cobertura **[não
verificado juridicamente; o README do crate não fala de patentes]**. Os
encoders de hardware (MF/AMF/NVENC/VA-API) vêm com o driver/SO, e o
licenciamento fica com o fabricante.

**Recomendação por fase**

- Fase 1 (Windows): MF MFT para todos. Spike A (6.1) decide se o AMD precisa de AMF direto.
- Fase 3 (Linux): GStreamer `pipewiresrc`/appsrc DMA-BUF → `vapostproc` → `vah264enc`, com `appsink` devolvendo os AUs ao Rust. Depois, avaliar trocar por `libva`/`cros-codecs` ou `gpu-video` para sair do GStreamer.
- GStreamer como pipeline inteiro (captura + encode + webrtcbin) em todos os SOs: **não**. Teríamos dois stacks WebRTC, o runtime é grande no Windows e é difícil controlar o device D3D11. Usar só como "caixa de encoder" no Linux.

## 6. Configuração de baixa latência por fabricante

Valores comuns (alinhados com o m3llo, que já ajustou isso em produção):

- H.264 **High** (ou Constrained High), **sem B-frames**, 1 quadro de
  referência, sem lookahead, sem pre-analysis, um slice por quadro (ou 4 para
  perda parcial).
- Controle de taxa: **VBR com teto**, `max = 1,25 × alvo`, VBV ≈ 0,5 s do
  teto (no mínimo 4 quadros) e começando pela metade. Um VBV de 1 quadro deixa
  os IDR sem bits (o m3llo mediu isso).
- GOP longo: IDR a cada 4 s (ou "infinito") **mais IDR sob demanda**
  (PLI/FIR, espectador novo, troca de captura). SPS/PPS repetidos em todo IDR.
- Bitrate ajustável em tempo real (o BWE do WebRTC manda), sem recriar o encoder.
- VUI: BT.709, faixa limitada, o mesmo que a conversão NV12 usa.

### 6.1 Media Foundation (todos os fabricantes no Windows)

- MFT **assíncrono**: `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER)`,
  `MF_TRANSFORM_ASYNC_UNLOCK = TRUE`, eventos `METransformNeedInput` e
  `METransformHaveOutput` via `IMFMediaEventGenerator`, e
  `MFT_MESSAGE_SET_D3D_MANAGER` com o `IMFDXGIDeviceManager` do device da captura.
- `MF_LOW_LATENCY = TRUE` nos atributos e `CODECAPI_AVLowLatencyMode = TRUE`.
- `CODECAPI_AVEncMPVDefaultBPictureCount = 0`, `CODECAPI_AVEncMPVGOPSize = 4×fps`,
  `CODECAPI_AVEncVideoForceKeyFrame = 1` para IDR sob demanda (por amostra).
- **Controle de taxa e o problema do filler no AMD:** a enumeração
  `eAVEncCommonRateControlMode` tem `CBR = 0`, `PeakConstrainedVBR = 1`,
  `UnconstrainedVBR = 2`, `Quality = 3`, `LowDelayVBR = 4` (Windows 8+),
  `GlobalVBR = 5` e `GlobalLowDelayVBR = 6`. Ordem de tentativa:
  1. `LowDelayVBR` + `CODECAPI_AVEncCommonMeanBitRate` + `CODECAPI_AVEncCommonMaxBitRate`
     + `CODECAPI_AVEncCommonBufferSize`. Antes, `ICodecAPI::IsSupported`/`IsModifiable`,
     porque cada MFT aceita um subconjunto.
  2. `PeakConstrainedVBR` com os mesmos três valores.
  3. Se o MFT da AMD só respeitar a taxa em CBR: manter CBR e **apagar os NAL
     units tipo 12 (filler data)** no Rust antes do RTP. É uma varredura de
     start codes no AU, custo desprezível. O controle de taxa continua o mesmo e
     a rede para de levar bytes inúteis. Pode cair na rede um pouco abaixo do
     alvo; compensar subindo o alvo.
  4. Se nada disso servir: AMF direto (6.2).
  Não achei documentação pública do comportamento do MFT da AMD sobre filler
  **[não verificado: o spike responde]**. Medir com um parser de NAL que conte
  bytes por tipo.
- `CODECAPI_AVEncCommonQualityVsSpeed` baixo (velocidade) se a GPU estiver no limite.

### 6.2 AMD AMF (direto, se preciso)

`AMF_VIDEO_ENCODER_USAGE = ULTRA_LOW_LATENCY` (primeiro: o usage reconfigura
tudo) · `LOWLATENCY_MODE = true` · `RATE_CONTROL_METHOD = PEAK_CONSTRAINED_VBR`
(o SDK novo tem também `LATENCY_CONSTRAINED_VBR` **[não verificado: nome
exato]**) · `TARGET_BITRATE`/`PEAK_BITRATE = 1,25×` · `VBV_BUFFER_SIZE` ·
**`FILLER_DATA_ENABLE = false`** · `B_PIC_PATTERN = 0` · `PREENCODE_ENABLE =
DISABLED` · `PRE_ANALYSIS_ENABLE = false` · `IDR_PERIOD` e
`HEADER_INSERTION_SPACING` = GOP · `QUALITY_PRESET = SPEED` quando faltar GPU
(o m3llo desliga em degraus: preset SPEED → VBAQ e high-motion boost
desligados). Superfície: `CreateSurfaceFromDX11Native` com a textura NV12 do
nosso device. A RX 5500 XT (VCN 2.0) codifica H.264 e HEVC; **AV1 não**.

### 6.3 NVIDIA NVENC

`preset P1–P4` + `tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY` · `rcParams.rateControlMode = VBR`
com `maxBitRate = 1,25×` e `vbvBufferSize`/`vbvInitialDelay` como acima ·
`frameIntervalP = 1` (sem B) · `zeroReorderDelay = 1` · `enableLookahead = 0` ·
`multiPass = DISABLED` ou `QUARTER_RESOLUTION` · `gopLength = NVENC_INFINITE_GOPLENGTH`
com `NV_ENC_PIC_FLAG_FORCEIDR` sob demanda · `repeatSPSPPS = 1` · opcional:
`enableIntraRefresh` (`intraRefreshPeriod` ≈ 1 s) para trocar IDRs grandes por
refresh espalhado. Mudança de bitrate: `nvEncReconfigureEncoder` sem
`resetEncoder`. O m3llo tenta P4 ULL → P1 ULL → P1 LL.

### 6.4 Intel (MFT no Windows; VA-API no Linux)

MFT da Intel: os mesmos `ICodecAPI` de 6.1. VA-API: `vah264lpenc` (VDENC,
baixo consumo) quando existir, senão `vah264enc`; `rate-control=vbr`
`target-usage=7` `b-frames=0` `ref-frames=1` `key-int-max=<gop>`. oneVPL, se um
dia: `AsyncDepth=1`, `LowPower=ON`, `TargetUsage=7`, `GopRefDist=1`,
`LowDelayBRC=ON`.

### 6.5 Linux VA-API (AMD radeonsi, Intel iHD)

A linha que o m3llo usa em produção:
`appsrc (video/x-raw(memory:DMABuf),format=DMA_DRM,drm-format=XR24:0x...) ! vapostproc ! video/x-raw(memory:VAMemory),format=NV12,width=W,height=H,colorimetry=bt709 ! vah264enc rate-control=vbr bitrate=K target-percentage=80 key-int-max=G b-frames=0 ref-frames=1 target-usage=7 ! video/x-h264,profile=high,stream-format=byte-stream,alignment=au ! appsink sync=false`.
Para IDR sob demanda: evento `GstForceKeyUnit` upstream no appsrc. Versões: os
encoders `va` e as caps `DMA_DRM` pedem GStreamer ≥ 1.22/1.24 **[não
verificado: versão mínima exata]**. Ubuntu 24.04 traz 1.24; Ubuntu/Pop 22.04
traz 1.20, que só tem o `vaapih264enc` antigo (gstreamer-vaapi, obsoleto).
Outro motivo para apontar o Linux para 24.04+.

### 6.6 Resolução, FPS e bitrate (H.264, quem assiste no navegador)

| Perfil | Resolução | FPS | Alvo (teto 1,25×) | Uso |
|---|---|---|---|---|
| Fluidez | 1280×720 | 60 | 4–6 Mb/s | jogo rápido |
| Fluidez alta | 1920×1080 | 60 | 8–12 Mb/s | só com upload sobrando (lembrar do ×N do mesh) |
| Nitidez | 1920×1080 / nativa | 30 | 5–8 Mb/s | texto, código, menus |
| Econômico | 1280×720 | 30 | 2–3 Mb/s | 4G, muitos espectadores |

O site hoje limita a 6 Mb/s (`qualityBitrate` em `static/room/compartilhar.js`).
O nativo pode passar disso, mas o gargalo vira o upload do mesh. Escalar na
GPU (VP/VPP) antes do encoder: 1440p→1080p reduz ~44% dos pixels.

**Perfis no SDP:** anunciar `profile-level-id` compatível e
`level-asymmetry-allowed=1`. Nível 3.1 (`1f`) vale só até 720p30; 1080p60
pede 4.2 (`2a`), e o m3llo usa 5.1. O Chrome aceita High (`640c1f`/`64001f`)
quando o receptor anuncia. **Firefox:** o site atual manda VP8 para quem não
tem H.264 de hardware (`preferCodecs` em `static/room/webrtc.js`). O nativo só
gera H.264, então o Firefox tem de decodificar H.264 (OpenH264 da Cisco ou o
decodificador da plataforma). Testar que perfil o Firefox aceita no WebRTC
**[não verificado em 2026]**.

### 6.7 Outros codecs para quem assiste

- **HEVC:** Chrome 136+ envia e recebe HEVC no WebRTC só com hardware; Safari 18
  também. O Edge **não envia** HEVC no WebRTC (resposta da Microsoft no Q&A);
  sobre receber, **[não verificado]**. O rascunho do IETF ainda estava em julho
  de 2026. Não vale a complexidade agora.
- **AV1:** o Chrome tem AV1 no WebRTC desde a versão 90 (libaom em software,
  muito mais rápido desde a 113). Encoder de hardware: RTX 40+, RDNA3+ (RX
  7000), Intel Arc/Meteor Lake+. Decodificação de hardware: RTX 30+, RDNA2+,
  Intel Xe. A RX 5500 XT não faz nenhum dos dois. Futuro: negociar AV1 só se o
  remetente tiver encoder e **todos** os espectadores decodificarem em hardware
  (`mediaCapabilities.decodingInfo({type:'webrtc'})`), como o m3llo planeja.
- **VP8/VP9:** sem encoder de hardware útil no nosso público; fora.

## 7. Áudio do jogo

**Windows:** `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ...)`
com `AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType = PROCESS_LOOPBACK,
ProcessLoopbackParams { TargetProcessId, ProcessLoopbackMode } }`. Mínimo:
**Windows 10 build 20348** (na prática, Windows 11). Modos:

- `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` com o **nosso PID**:
  pega tudo o que toca no PC menos o CPX Call (as vozes dos amigos não voltam).
  É o padrão recomendado para "compartilhar tela com som".
- `INCLUDE_TARGET_PROCESS_TREE` com o PID do jogo: só o jogo (some o Spotify,
  o Discord etc.). Usar quando a pessoa compartilha uma janela.
- O formato vem do mix engine; pedir float32 48 kHz com
  `AUDCLNT_STREAMFLAGS_LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM`. O sample
  oficial é o "ApplicationLoopbackAudio".
- Fallback para Windows 10 antigo: loopback clássico do dispositivo padrão
  (`eRender` + `AUDCLNT_STREAMFLAGS_LOOPBACK`), que inclui as vozes da sala.
  Nesse caso, tirar as vozes no app ou avisar.
- Crates: `windows` (direto). `wasapi` 0.27.0 (nov/2026) tem loopback de
  aplicação **[não verificado: API exata]**. `cpal` 0.18 não expõe process
  loopback.
- Codificar em Opus estéreo 48 kHz, modo música, ~128 kb/s, como o site faz
  hoje (`contentHint = 'music'`). O m3llo marca cada pacote com o relógio
  monotônico (hora do `GetBuffer` menos a duração) para sincronizar com o vídeo.

**Linux:** PipeWire. Capturar o `monitor` do sink padrão
(`stream.capture.sink = true` no pipewire-rs). Para excluir o próprio app,
tocar a sala num nó nosso e capturar os nós de saída com
`application.process.id` ≠ o nosso, ou criar um sink virtual. O portal
ScreenCast não traz áudio. O m3llo tem `capture_pipewire.cpp`, que serve de
referência.

## 8. Clipes (#103): anel de quadros já codificados → MP4

```
 encoder ──AU (Arc<[u8]>, pts_us, keyframe)──► VecDeque<Gop> (≈ 30 s + 1 GOP, limite em bytes)
 áudio jogo + voz (Opus 20 ms, pts_us) ──────► VecDeque<Packet>
 tecla de atalho ──► procurar o último IDR ≤ agora−30 s ──► copiar os Arcs (barato) ──► thread de mux ──► .mp4
```

- **Memória:** 30 s × 8 Mb/s ≈ 30 MB, mais o áudio (~1 MB). Aceitável em RAM.
  O m3llo prefere arquivo-anel em disco (60 s, aberto com delete-on-close) para
  ficar abaixo de 80 MB de RAM. Para nós a RAM basta, mas é bom ter um teto em
  bytes, com descarte por GOP inteiro.
- **GOP:** o clipe começa num IDR. Com o GOP de 4 s da transmissão, o clipe
  sai com 30–34 s. Sem transmissão ativa, o encoder roda só para o anel com
  GOP de 1–2 s e configuração de gravação. O m3llo usa preset de qualidade e
  um encoder separado de 1 s de GOP para o replay. Isso tem custo contínuo na
  GPU: medir (spike E).
- **Mux:** sem recodificar o vídeo (passthrough H.264: converter Annex-B em
  AVCC e montar `avcC` com SPS/PPS). Crates:
  `muxide` 0.5.0 (out/2026, MP4 em Rust puro feito para gravação; maturidade a
  avaliar), `mp4-atom` 0.17.1 (nov/2026, kixelated/MoQ, encoder/decoder de
  átomos, ativo), `shiguredo_mp4` 2026.5.0. O `mp4` 0.14 está parado desde
  2023. No Windows, `IMFSinkWriter` com tipo de entrada = tipo de saída também
  faz passthrough e ainda codifica AAC.
- **Áudio no clipe:** Opus em MP4 toca no Chrome, Firefox e VLC. Para tocar no
  app "Fotos"/"Filmes" do Windows e no WhatsApp, AAC é mais seguro (o MF tem
  encoder AAC; o m3llo mistura jogo + voz e grava Opus 160 kb/s).
- **Duração dos quadros:** usar o tempo de captura de cada quadro, não `1/fps`.
  A captura tem taxa variável (tela parada = menos quadros).

## 9. Projetos de referência

- **m3llo** (github.com/mollohq/m3llo, Apache-2.0, muito ativo: commit em
  22/11/2026). App de voz, transmissão e clipes para grupos de 5–50 pessoas. UI
  em Rust (Slint) e mídia em C++ (`libmello`), com libdatachannel para um SFU.
  O que estudar:
  - `specs/14-VIDEO-PIPELINE.md`: um `GraphicsDevice` só para captura, conversão
    e encoder; `CaptureSource` com DXGI (monitor), WGC (janela) e uma "escada"
    por processo (hook → WGC janela → WGC monitor → DXGI); conversão BGRA→NV12
    por compute shader, com escala no mesmo passe.
  - `libmello/src/video/encoder_{amf,nvenc,qsv,openh264}.cpp` e
    `encoder_gst_linux.cpp`: encoders diretos no Windows (AMF/NVENC/oneVPL),
    GStreamer VA-API/NVENC no Linux com DMA-BUF, OpenH264 carregado
    dinamicamente como fallback.
  - `capture_pipewire_video.cpp`: portal + PipeWire com DMA-BUF.
  - `capture_wasapi_loopback.cpp`: process loopback com include/exclude.
  - `specs/features/CLIPS.md` §15.4 e `libmello/src/replay/`: anel por GOP,
    pedido de IDR quando um GOP estoura, MP4 próprio (`mp4_write.cpp`).
  - Diferenças: o m3llo usa SFU próprio e viewer nativo. Nós temos mesh e o
    navegador assistindo, então o nosso lado de rede é outro.
- **Sunshine** (LizardByte, GPL-3.0): Windows com DXGI DD/WGC; Linux com KMS,
  X11, wlroots e, desde 2026, portal/PipeWire e KWin. NVENC direto,
  AMF/QSV/VA-API via FFmpeg e encode Vulkan desde abr/2026. Bom para ver as
  configurações de baixa latência por fabricante e as armadilhas de driver.
- **OBS** (`libobs-winrt`, `win-capture`, `obs-ffmpeg`/`jim-nvenc`,
  `obs-qsv11`, `linux-pipewire`): referência de WGC, game hook, AMF e PipeWire
  com DMA-BUF.
- **Chromium `modules/desktop_capture/linux/wayland`**: cliente de portal +
  PipeWire com negociação de modifiers, testado em produção.
- **Parsec/Moonlight:** mesma linha (captura em GPU, NVENC/AMF ULL, intra-refresh,
  FEC). Mas só o Moonlight/Sunshine é aberto.

## 10. Abstração em Rust (proposta)

```rust
/// One per process: capture, conversion and encode must share it (zero-copy).
pub enum GpuContext {
    #[cfg(windows)] D3D11 { device: ID3D11Device, context: ID3D11DeviceContext },
    #[cfg(target_os = "linux")] Drm { render_node: std::path::PathBuf }, // VA display / EGL from it
    Cpu,
}

pub enum FrameImage<'a> {
    #[cfg(windows)] D3D11 { texture: &'a ID3D11Texture2D, subresource: u32 },
    #[cfg(target_os = "linux")] DmaBuf { planes: &'a [DmaBufPlane], fourcc: u32, modifier: u64 },
    Cpu { data: &'a [u8], stride: u32, format: PixelFormat },
}

pub struct CapturedFrame<'a> {
    pub image: FrameImage<'a>,     // valid only during the callback: the pool owns it
    pub size: (u32, u32),
    pub capture_us: u64,           // monotonic clock shared with audio
    pub generation: u32,           // bumps on source change → encoder forces IDR
    pub hdr: bool,
}

pub trait Capturer: Send {
    fn start(&mut self, max_fps: u32, sink: Box<dyn FnMut(&CapturedFrame) + Send>) -> Result<()>;
    fn stop(&mut self);
    fn state(&self) -> CaptureState;   // Capturing, Paused(minimized), Lost(reason)
    fn backend(&self) -> &'static str; // "wgc-window", "dxgi", "portal-dmabuf", "xshm"
}

pub struct EncoderConfig {
    pub codec: Codec,              // H264 now; Av1 later
    pub size: (u32, u32),
    pub fps: u32,
    pub bitrate_bps: u32,          // max = 1.25 × this
    pub gop_frames: Option<u32>,   // None = infinite, IDR on demand only
    pub intent: Intent,            // Live (ULL) | Replay (quality, short GOP)
}

pub struct EncodedUnit {
    pub data: std::sync::Arc<[u8]>, // Annex-B access unit, filler NALs removed
    pub capture_us: u64,
    pub keyframe: bool,
}

pub trait Encoder: Send {
    /// Converts (scale + RGB→NV12 on the GPU) and submits; never blocks the capture thread for long.
    fn submit(&mut self, frame: &CapturedFrame, force_idr: bool) -> Result<()>;
    fn poll(&mut self) -> Option<EncodedUnit>;
    fn set_bitrate(&mut self, bps: u32);
    fn request_keyframe(&mut self); // coalesced: at most one IDR per ~1 s
    fn info(&self) -> EncoderInfo;   // backend name, hw, vendor, actual profile/level
}

/// Ordered by preference; the first that opens with the GpuContext wins.
/// Windows: [MfHardware(vendor), AmfDirect?, NvencDirect?, OpenH264]
/// Linux:   [GstVa, GstNvenc, OpenH264]
pub fn open_encoder(gpu: &GpuContext, cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>;
```

Notas: a conversão (VP/VPP/compute) fica dentro do `Encoder`, que conhece o
formato que aceita. O `Capturer` só entrega o quadro emprestado. Um "fan-out"
(`Arc<EncodedUnit>`) alimenta N empacotadores RTP e o anel de clipes. As
callbacks rodam no thread da captura; o encode async do MF tem o seu loop de
eventos. Em Rust, as interfaces COM do windows-rs podem não ser `Send` **[não verificado para `ID3D11Texture2D` na 0.62]**:
manter captura e encode no mesmo thread, ou usar um wrapper `unsafe impl Send`
documentado.

## 11. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| MFT da AMD sem VBR de baixa latência/filler | banda desperdiçada, rajadas | apagar NAL 12; AMF direto |
| Cada MFT aceita um conjunto diferente de `ICodecAPI` | configurações ignoradas em silêncio | ler de volta (`GetValue`) e registrar o que ficou |
| Tela cheia exclusiva | tela preta | aviso + "sem borda"; não injetar hook (anti-cheat) |
| GPU híbrida (notebook) | captura num adaptador, encoder no outro | criar o device no adaptador do monitor; cópia entre adaptadores medida |
| Encoder disputa a GPU com o jogo | queda de FPS no jogo | o bloco de vídeo (VCN/NVENC) é separado, mas o VP/compute usa os shaders: medir; degraus de custo como o m3llo |
| Upload do mesh | travadas para todos | teto de espectadores em alta qualidade; SFU é outra discussão |
| Linux X11 sem zero-copy | CPU alta | Wayland primeiro; X11 limitado |
| Firefox e H.264 | espectador sem imagem | teste explícito; fallback openh264 não resolve o lado do receptor |
| Portal: diálogo a cada início | atrito | `restore_token` com `persist_mode` |
| HDR | cores lavadas | tone mapping num compute shader (depois) |
| OpenH264 compilado da fonte | patentes | binário da Cisco via `libloading`, ou só hardware |

## 12. Spikes (com medição)

**Como medir com jogo rodando (vale para todos):**

- Cenário fixo: um jogo limitado por GPU (benchmark embutido, ex. Shadow of the
  Tomb Raider ou Cyberpunk) e um limitado por CPU (CS2 em 1080p baixo). 3
  rodadas de 2 min em cada condição: sem compartilhar, Edge compartilhando,
  nativo compartilhando (720p60 e 1080p60).
- **Windows:** PresentMon (FPS médio, 1% low e frametime do jogo); `typeperf
  "\GPU Engine(*engtype_VideoEncode)\Utilization Percentage" "\GPU
  Engine(*engtype_3D)\Utilization Percentage" "\Process(cpx-call*)\% Processor
  Time" -si 1`; métricas do Adrenalin para clock e VCN; WPR/WPA (GPU) para ver
  fila e preempção. Latência glass-to-glass: relógio em ms na tela (página com
  `performance.now()`) capturado e mostrado do lado do espectador, com uma foto
  dos dois monitores; mais os timestamps internos capture_us → AU pronto.
- **Linux:** MangoHud (FPS/frametime, log CSV); `amdgpu_top` (VCN, GFX),
  `intel_gpu_top`, `nvidia-smi dmon -s u` (coluna enc); `pidstat -u -p <pid> 1`;
  `perf top -p` se a CPU subir.
- Relatório: ΔFPS médio e 1% low contra o baseline, % de um núcleo, % do
  encoder, kb/s real e bytes por tipo de NAL.

| Spike | Pergunta | Pronto quando |
|---|---|---|
| A. Filler/VBR no MFT AMD | Qual `eAVEncCommonRateControlMode` o MFT aceita e respeita? Quanto filler sai em cada um? | Tabela modo × (kb/s médio, pico em 100 ms, % filler) na RX 5500 XT, com o mesmo teste numa NVIDIA e numa Intel de amigos |
| B. IDR sob demanda + bitrate dinâmico no MF | `AVEncVideoForceKeyFrame` e `MeanBitRate` em tempo real funcionam sem recriar? Latência até o IDR? | IDR em ≤ 2 quadros; mudança de taxa visível em ≤ 1 s |
| C. Ponta a ponta com navegador | AU do MFT → RTP (webrtc-rs/str0m) → Chrome, Edge e Firefox decodificam High/nível 4.2? | 1080p60 tocando nos três, latência < 150 ms em LAN |
| D. Process loopback | Excluir a nossa árvore funciona no Win11 com WebView2 (processos filhos)? | áudio do jogo sem as vozes da sala; deriva A/V < 40 ms em 10 min |
| E. Anel de clipes | Custo do encoder de replay em paralelo (ou do GOP curto) e MP4 gerado | ΔFPS < 1%, MP4 de 30 s toca no Windows e no WhatsApp |
| F. Linux Wayland | ashpd + pipewiresrc/DMA-BUF + vah264enc no COSMIC (24.04) e no GNOME, RX 5500 XT | zero cópias na CPU (`pidstat` < 5%), restore_token funcionando |
| G. Linux X11 | XShm 720p30 + VA-API: quanto de CPU? | decisão "suportar X11 ou não" |
| H. Vulkan Video (opcional) | `gpu-video` codifica H.264 no RADV/VCN 2.0 sem perftest? | sim/não + custo |

## Fontes

- m3llo: https://github.com/mollohq/m3llo (lidos `specs/14-VIDEO-PIPELINE.md`, `specs/features/CLIPS.md`, `libmello/src/video/encoder_amf.cpp`, `encoder_gst_linux.cpp`, `capture_pipewire_video.cpp`, `libmello/src/audio/capture_wasapi_loopback.cpp`)
- windows-capture: https://github.com/NiiightmareXD/windows-capture · https://crates.io/crates/windows-capture
- windows-rs: https://github.com/microsoft/windows-rs
- eAVEncCommonRateControlMode: https://learn.microsoft.com/windows/win32/api/codecapi/ne-codecapi-eavenccommonratecontrolmode
- Encoder H.264 do MF: https://learn.microsoft.com/windows/win32/medfound/h-264-video-encoder
- Process loopback: https://learn.microsoft.com/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params · sample: https://learn.microsoft.com/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
- FFmpeg AMF (opção filler_data): https://ffmpeg.org/doxygen/trunk/amfenc__h264_8c_source.html
- NVENC e filler (ffmpeg-devel, mar/2025): https://ffmpeg.org/pipermail/ffmpeg-devel/2025-March/341662.html
- AMF SDK: https://github.com/GPUOpen-LibrariesAndSDKs/AMF
- NVIDIA Video Codec SDK: https://docs.nvidia.com/video-technologies/video-codec-sdk/
- HEVC no WebRTC: https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c · https://datatracker.ietf.org/doc/html/draft-ietf-avtcore-hevc-webrtc · https://learn.microsoft.com/en-ca/answers/questions/5880331/h-265-(hevc)-not-published-sent-via-webrtc-chrome · https://datatracker.ietf.org/meeting/125/materials/slides-125-avtcore-h265-profile-for-webrtc-00
- AV1 no Chrome/WebRTC: https://developer.chrome.com/blog/av1
- RADV Vulkan Video encode: https://Phoronix.com/news/RADV-Vulkan-VIdeo-H265-H264 · https://www.vulkan.org/user/pages/09.events/vulkanised-2025/T31-Stephane-Cerveau-Igalia.pdf · https://phoronix.com/news/intel-vulkan-video-disable-new
- Sunshine: https://github.com/LizardByte/Sunshine · https://www.phoronix.com/news/Sunshine-v2026.413.143228 · https://gamingonlinux.com/2026/05/sunshine-game-streaming-tool-adds-vulkan-encoding-plus-xdg-pipewire-and-kwin-direct-screencast-capture
- xdg-desktop-portal-cosmic: https://github.com/pop-os/xdg-desktop-portal-cosmic (`src/screencast.rs`, `src/screencast_thread.rs`)
- Portal ScreenCast: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
- PipeWire DMA-BUF: https://docs.pipewire.org/page_dma_buf.html
- xdg-desktop-portal-wlr 0.6 (DMA-BUF): https://github.com/emersion/xdg-desktop-portal-wlr/releases
- Chromium captura Wayland: https://webrtc.googlesource.com/src/+/45b0781a4bd04d182a9ac8b121b911410db6f06d/modules/desktop_capture/linux/base_capturer_pipewire.cc
- openh264-rs: https://github.com/ralfbiedert/openh264-rs · binários da Cisco: https://www.openh264.org/
- Crates (versões em 23/11/2026, via API do crates.io): `windows`, `windows-capture`, `pipewire`, `ashpd`, `gstreamer`, `gstreamer-app`, `cros-libva`, `cros-codecs`, `libva`, `ffmpeg-next`, `rsmpeg`, `openh264`, `nvidia-video-codec-sdk`, `gpu-video` (https://github.com/software-mansion/smelter), `wasapi`, `cpal`, `x11rb`, `muxide`, `mp4-atom`, `shiguredo_mp4`, `mp4`, `webrtc`, `str0m`
