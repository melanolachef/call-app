# Voz e atalhos no cliente nativo (Rust)

_Pesquisa de 2026-11-23. Parte do estudo do cliente nativo (fase 2: voz em
Rust; fase 3: Linux). Versões e datas conferidas no docs.rs / GitHub nesse
dia; o que não deu para confirmar está marcado com **(não verificado)**._

## Resumo

- **Áudio:** `cpal` 0.18 (WASAPI no Windows; ALSA, PulseAudio ou PipeWire
  nativo no Linux). Modo compartilhado sempre, período de 10 ms.
- **Opus:** crate `opus` 0.4 (libopus em C, MIT/Apache). O port em Rust puro
  (`opus-rs`) fica em observação.
- **Processamento (AEC/NS/AGC):** `sonora` 0.3, um port da APM do WebRTC em
  Rust puro (BSD-3). Plano B: `webrtc-audio-processing` 2.1, que é o C++ e
  precisa de meson/ninja. Supressão "forte" opcional: `nnnoiseless`
  (RNNoise). DeepFilterNet é pesado demais para quem está jogando.
- **Jitter buffer:** nem `webrtc-rs` nem `str0m` trazem um NetEQ. Escrevemos
  um buffer adaptativo simples por pessoa, usando FEC e PLC do próprio Opus.
- **PTT:** no Windows, Raw Input (com o hook atual de reserva); no X11,
  XInput2; no Wayland, o portal GlobalShortcuts (`ashpd`) onde existe (GNOME
  48+, KDE, Hyprland). No COSMIC ele **não existe**, então lá entra um
  fallback opcional via evdev (grupo `input`) ou o PTT só com a janela em foco.

## 1. Crates recomendados

| Função | Crate | Versão (data) | Licença | Situação |
|---|---|---|---|---|
| E/S de áudio | `cpal` | 0.18.2 (2026-08-16) | Apache-2.0 | Ativo (RustAudio). PipeWire nativo é uma feature opcional; o padrão no Linux é ALSA |
| Opus (libopus) | `opus` (SpaceManiac) | 0.4.0 (2026-08-23) | MIT/Apache-2.0 | Voltou a ser mantido (0.3.1 em jan/2026, 0.4.0 em ago/2026). Usa `opusic-sys`, precisa de cmake + compilador C |
| Opus (alternativa) | `opus-codec` | 0.2.0 | (não verificado) | libopus 1.5.2 embutida, com suporte a DRED |
| Opus em Rust puro | `opus-rs` / fork `opus1` | 0.1.3x / 0.3.0 | (não verificado) | Jovem (2026), port do libopus 1.6. Benchmarks só dos autores. **Não usar ainda** |
| APM em Rust puro | `sonora` | 0.3.0 (2026-11-07) | BSD-3-Clause | Port da APM do WebRTC M145 (+ correções até M156): AEC3, NS, AGC2, filtro passa-alta. A suíte C++ (2400+ testes) passa contra ele via FFI |
| APM em C++ | `webrtc-audio-processing` (tonarino) | 2.1.0 (2026-05-13) | (crate não verificado; upstream BSD-3) | Bindings do pacote do PulseAudio (WebRTC M131). Feature `bundled` compila o C++ com meson + ninja. A doc 2.1.0 falhou no docs.rs |
| Supressão por rede neural | `nnnoiseless` | 0.5.2 | BSD-3 (não verificado) | RNNoise em Rust puro, 48 kHz, quadros de 480 amostras |
| Supressão pesada | DeepFilterNet (`deep_filter`) | 0.1.9 / upstream 0.5.6 | MIT/Apache (não verificado) | RTF 0,19 num i5-8250U = ~19% de um núcleo. **Descartado** pelo princípio de leveza |
| Jitter buffer | `neteq` | 0.8.3 | MIT/Apache-2.0 | "Early preview", PLC por pitch ainda no roadmap. Serve de referência, não de dependência |
| Reamostragem | `rubato` | (não verificado) | MIT | Só se o dispositivo não abrir em 48 kHz |
| Fila entre threads | `rtrb` | (não verificado) | MIT/Apache | Ring buffer SPSC sem lock, para o callback de tempo real |
| Decodificar soundpad | `symphonia` | (não verificado) | MPL-2.0 | mp3/ogg/wav/flac em Rust puro (hoje o navegador decodifica) |
| Portal Wayland | `ashpd` | 0.14.3 (2026-11-21) | MIT (não verificado) | Módulo `desktop::global_shortcuts`; usa `zbus` com feature `tokio` (padrão) |
| X11 | `x11rb` | (não verificado) | MIT/Apache | Para XInput2 (`XI_RawKeyPress`/`XI_RawButtonPress`) |
| evdev | `evdev` | (não verificado) | Apache/MIT | Só no fallback opcional |
| Atalhos prontos | `global-hotkey` | 0.10.0 (2026-11-09) | Apache/MIT | **Só X11** no Linux; `RegisterHotKey` no Windows (sem soltar a tecla). Não serve para PTT |
| | `livesplit-hotkey` | 0.8.1 (2026-06-15) | (não verificado) | Usa x11-dl + evdev no Linux. Bom para ler o código |
| | `rdev`, `inputbot`, `device_query` | antigos | | `rdev` só pega teclas no Wayland como root; `device_query` faz polling. Evitar |

Não usar `rodio` (feito para tocar arquivos, sem a latência controlada nem o
mixer por pessoa de que precisamos) nem `audiopus` (sem lançamento novo
desde a 0.3.0-rc de 2021, **não verificado** em 2026). Para o caminho "o
mais Rust possível" no Windows, `sonora` evita a toolchain meson/ninja que o
`webrtc-audio-processing` exige, e isso pesa no CI do Windows.

### Por que `cpal` e não `pipewire-rs` ou `wasapi` direto

- `cpal` 0.18 já tem um backend PipeWire nativo (feature `pipewire`; a doc da
  0.18.1 recomenda usá-lo em vez das pontes do ALSA). Para compilar precisa de
  `libpipewire-0.3-dev` e também dos headers do ALSA.
- No WASAPI, a 0.18.1 tem um monitor do dispositivo padrão que entrega
  `ErrorKind::DeviceChanged` ao callback de erro. Na 0.17 o stream podia
  "morrer em silêncio" quando o dispositivo sumia. Regra: ao receber
  `DeviceChanged` ou um erro de dispositivo, **recriar o stream** no novo
  padrão, como manda a Microsoft (soltar o `IAudioClient`, pegar o endpoint
  padrão de novo, reativar).
- Hotplug no Linux: com PipeWire, abrir o dispositivo "default" faz o servidor
  seguir a troca de fone sozinho. No ALSA puro, não.
- Modo exclusivo do WASAPI: **não usar**. Ele toma o dispositivo, o som do
  jogo deixa de sair e nada se ganha com um período de 10 ms. Se o `cpal`
  expõe o modo exclusivo: **(não verificado)**.
- `pipewire-rs` direto ou o crate `wasapi` só valem a pena se o spike 1
  mostrar latência ou falhas que o `cpal` não resolve.

### Fones Bluetooth

Abrir o microfone de um fone BT clássico troca o perfil de A2DP (estéreo,
qualidade boa) para HFP/HSP (mono, 16 kHz com mSBC). O som do jogo e das
pessoas piora para todo mundo. Discord e Mumble têm o mesmo problema; é
limitação do protocolo. LE Audio (LC3) melhora isso, mas o suporte depende do
sistema e do fone **(não verificado em 2026)**. O que fazer:

- Na tela de dispositivos, avisar "fone Bluetooth: usar o microfone dele
  piora o áudio; prefira o microfone do PC".
- No Windows, "Fone de ouvido" e "Viva-voz" aparecem como endpoints
  separados. Escolher o mic de outro dispositivo mantém o A2DP.
- Aceitar entrada de 16 kHz e reamostrar para 48 kHz (`rubato`) antes da APM.

## 2. Opus compatível com o navegador

O que o Chrome/Edge oferece: `opus/48000/2` com
`minptime=10;useinbandfec=1`, ptime de 20 ms. A página já reescreve o SDP
(`static/room/webrtc.js:236`) e acrescenta
`stereo=1;sprop-stereo=1;maxaveragebitrate=128000`. O cliente nativo
precisa:

- **Decodificar sempre em estéreo, 48 kHz** (`Decoder::new(48000, Stereo)`).
  O decodificador converte mono para estéreo, então vale para qualquer emissor.
- **Microfone:** `Application::Voip`, 48 kHz, 1 canal (o SDP tem `/2`, mas
  mandar mono é válido). Quadros de 20 ms (960 amostras), 32–48 kb/s VBR,
  FEC embutido ligado com `set_packet_loss_perc(10)`, complexidade 8–10
  (o custo é baixo, **medir**).
- **DTX:** desligado no início. Com PTT, o silêncio já não é enviado. Ligar
  DTX muda o comportamento do jitter buffer, que vê buracos sem pacote.
- **Soundpad / música (opcional):** se tocar o som pelo mic, subir para
  64–96 kb/s enquanto toca. Estéreo só se o arquivo for estéreo.
- **SDP do nativo:** responder com
  `a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1` para o
  Chrome mandar estéreo (o áudio da tela compartilhada) e FEC.
- **Codificar uma vez, enviar N vezes:** na malha, o mesmo pacote Opus vai
  para todas as conexões (só SSRC, seq e timestamp mudam por conexão). Isso é
  a maior economia de CPU em salas de 12 pessoas.
- **Nível de áudio:** a extensão RTP `ssrc-audio-level` (RFC 6464), que o
  Chrome envia, dá o nível sem decodificar. Fica como reserva para o "quem
  fala"; nós decodificamos de qualquer jeito.

## 3. Pipeline de áudio

```
CAPTURA (thread de tempo real do cpal, 10 ms)
  mic ──► [rtrb SPSC] ──► THREAD "voz-tx"
                             │ reamostrar para 48k (se preciso)
                             │ APM.process_capture (AEC3 + NS + AGC2, quadros de 10 ms)
                             │ VAD/nível local (anel verde próprio)
                             │ porta PTT/mudo (rampa de 5 ms, sem estalo)
                             │ + soundpad (mixado DEPOIS da APM)
                             │ junta 2×10 ms ──► Opus encode (20 ms)
                             ▼
                     [canal] ──► tarefa de rede (tokio): empacota RTP
                                 e manda o MESMO payload a cada peer (SRTP)

RECEPÇÃO
 rede ──► por peer: depacketize ──► JitterBuffer(seq, ts)
                                       │
THREAD "voz-rx" (a cada 10 ms, puxada pela saída)
   para cada peer: pop() ─► Opus decode | decode_fec(próximo) | PLC
                  ─► nível RMS (quem fala) ─► × volume da pessoa
   soma + limitador suave ─► APM.process_render (referência do AEC)
                          ─► [rtrb SPSC] ──► SAÍDA (callback do cpal)
   soundpad local (ouvir o próprio som) entra na soma também
```

Decisões:

- **Mixar o soundpad depois da APM.** Senão a supressão de ruído come o
  efeito sonoro e o AGC "abaixa" o mic quando ele toca. O soundpad só manda
  com o PTT apertado? Hoje a página decide isso; manter a mesma regra.
- **O AEC precisa da referência:** tudo o que sai no alto-falante (vozes e
  soundpad local) vai para `process_render`. Com fone de ouvido o AEC quase
  não trabalha; deixar ligado mesmo assim (é barato) e permitir desligar.
- **Quem fala:** RMS por quadro de 10 ms; liga acima de ~-45 dBFS em 2
  quadros seguidos e desliga depois de 300 ms abaixo (histerese, para o anel
  não piscar). Para o nosso anel, usar o nível depois da APM e da porta PTT,
  como o navegador faz hoje com o `AnalyserNode` em `static/room/voz.js`.
- **Volume por pessoa:** ganho linear de 0 a 2 aplicado antes da soma, com
  rampa de 10 ms quando mudar. Limitador (`tanh` ou pico com release) depois
  da soma, porque 12 vozes somadas estouram.
- **Latência-alvo boca-ouvido na LAN/Brasil:** captura 10 + APM ~0 + quadro 20
  + rede 20–60 + jitter 40–60 + saída 10–20 ≈ 100–170 ms. Igual ou melhor
  que o navegador.

### Jitter buffer (o que falta nas pilhas Rust)

`webrtc-rs` (0.20, agora sans-IO sobre o crate `rtc`) e `str0m` (0.20 conferido aqui; o 02 usa a 0.26.0) entregam
pacotes RTP ou quadros Opus, no máximo com reordenação. Nenhum tem playout
adaptativo nem PLC como o NetEQ do libwebrtc **(conferido só pela ausência
na documentação; ver o `samplebuilder` do webrtc-rs no spike 3)**. Então
escrevemos um buffer pequeno, ~200 linhas:

1. Indexar por `seq` (u16 com wrap), guardar até ~300 ms.
2. Começar a tocar quando houver `alvo` ms (começa em 40 ms).
3. A cada 20 ms, `pop()`:
   - tem o pacote: `decode`;
   - faltou, mas o próximo chegou: `decode_fec` com o próximo (o FEC do
     Opus reconstrói o quadro perdido);
   - faltou tudo: PLC (`decode` com payload vazio). Depois de ~100 ms de PLC,
     silêncio com fade.
4. Adaptar o `alvo`: medir o jitter entre chegadas (EWMA, como o RFC 3550)
   e definir alvo ≈ 2–3 × jitter, entre 20 e 200 ms. Encolher descartando um
   quadro só durante silêncio (nível baixo) e crescer repetindo PLC. É menos
   elegante que o time-stretch do NetEQ, mas inaudível em voz com pausas.
5. Ao detectar um salto de timestamp ou de SSRC (a pessoa reconectou),
   reiniciar.

O crate `neteq` serve de leitura. Se ele amadurecer (PLC e time-stretch),
avaliar a troca.

## 4. Esboço das threads em Rust

```rust
// Sketch only: error handling, device selection and resampling omitted.
use rtrb::RingBuffer;
use std::sync::{atomic::{AtomicBool, Ordering::Relaxed}, Arc};

const RATE: u32 = 48_000;
const F10: usize = 480; // 10 ms mono at 48 kHz

pub struct VoiceShared {
    pub ptt_open: AtomicBool,      // set by the shortcut backend
    pub muted: AtomicBool,
    pub peers: parking_lot::RwLock<Vec<Arc<RemotePeer>>>,
}

pub fn start(shared: Arc<VoiceShared>, net_tx: tokio::sync::mpsc::Sender<Vec<u8>>) {
    let host = cpal::default_host();
    let (mut mic_prod, mut mic_cons) = RingBuffer::<f32>::new(F10 * 20);
    let (mut out_prod, mut out_cons) = RingBuffer::<f32>::new(F10 * 2 * 20);

    // 1. Capture callback: real time, no locks, no allocation.
    let input = host.default_input_device().unwrap();
    let in_stream = input.build_input_stream(
        &cpal::StreamConfig { channels: 1, sample_rate: cpal::SampleRate(RATE),
                              buffer_size: cpal::BufferSize::Fixed(F10 as u32) },
        move |data: &[f32], _| { let _ = mic_prod.push_slice(data); },
        |e| tracing::warn!(?e, "input error, rebuild stream"), None).unwrap();

    // 2. voz-tx: APM, PTT gate, soundpad, encode once.
    let s = shared.clone();
    std::thread::Builder::new().name("voz-tx".into()).spawn(move || {
        let mut apm = sonora::AudioProcessing::new(/* aec3, ns, agc2 */);
        let mut enc = opus::Encoder::new(RATE, opus::Channels::Mono,
                                         opus::Application::Voip).unwrap();
        enc.set_inband_fec(true).unwrap();
        enc.set_packet_loss_perc(10).unwrap();
        let (mut frame, mut pair) = ([0f32; F10], Vec::with_capacity(2 * F10));
        let mut gate = Ramp::new(); // 5 ms fade in/out
        loop {
            if !pop_exact(&mut mic_cons, &mut frame) { park_ms(2); continue; }
            apm.process_capture_frame(&mut frame);
            let open = s.ptt_open.load(Relaxed) && !s.muted.load(Relaxed);
            gate.apply(&mut frame, open);
            soundpad::mix_into(&mut frame);              // after APM on purpose
            pair.extend_from_slice(&frame);
            if pair.len() == 2 * F10 {
                if open || gate.tail() {                 // send nothing while closed
                    let mut pkt = vec![0u8; 400];
                    let n = enc.encode_float(&pair, &mut pkt).unwrap();
                    pkt.truncate(n);
                    let _ = net_tx.blocking_send(pkt);   // network fans out to N peers
                }
                pair.clear();
            }
        }
    }).unwrap();

    // 3. voz-rx: pull 10 ms from every peer, mix, feed AEC, hand to output.
    let s = shared.clone();
    std::thread::Builder::new().name("voz-rx".into()).spawn(move || {
        let mut mix = [0f32; 2 * F10];
        loop {
            if out_prod.slots() < mix.len() { park_ms(2); continue; }
            mix.fill(0.0);
            for p in s.peers.read().iter() {
                let pcm = p.jitter.lock().pull_10ms(&mut p.decoder.lock()); // decode/FEC/PLC
                p.level.update(pcm);                      // green ring, with hysteresis
                let g = p.volume();                       // per-person volume, ramped
                for (m, x) in mix.iter_mut().zip(pcm) { *m += x * g; }
            }
            soundpad::mix_local_monitor(&mut mix);
            limiter(&mut mix);
            apm_render_reference(&mix);                   // shared with voz-tx's APM
            let _ = out_prod.push_slice(&mix);
        }
    }).unwrap();

    // 4. Output callback: copy only; play silence on underrun.
    let output = host.default_output_device().unwrap();
    let out_stream = output.build_output_stream(
        &cpal::StreamConfig { channels: 2, sample_rate: cpal::SampleRate(RATE),
                              buffer_size: cpal::BufferSize::Fixed(F10 as u32) },
        move |data: &mut [f32], _| {
            let n = out_cons.pop_slice(data);
            data[n..].fill(0.0);
        },
        |e| tracing::warn!(?e, "output error, rebuild stream"), None).unwrap();
    in_stream.play().unwrap();
    out_stream.play().unwrap();
}
```

A API do `sonora`, a forma exata do `push_slice` do `rtrb` e a assinatura do
`build_input_stream` na 0.18 **não foram conferidas**: o esboço mostra a
forma, não compila como está. O ponto importante: uma APM só, compartilhada
entre tx e rx (a referência de render precisa chegar à mesma instância), e
nada de lock nos callbacks do `cpal`.

CPU esperada (meta: menos de 1% de um núcleo com 12 pessoas): APM 48 kHz mono
≈ 13 µs por quadro de 10 ms (benchmark do `sonora` num M4 Max, ≈0,13% de um
núcleo); RNNoise e Opus a medir no spike 2. Decodificar 11 vozes de 20 ms é
barato, mas **medir** numa máquina modesta com jogo rodando.

## 5. Atalhos globais (PTT, Ctrl+Shift+M, soundpad)

Requisitos do PTT: ver **apertar e soltar**, funcionar com o jogo em foco,
**não engolir a tecla** (o jogo também a recebe), aceitar **botões laterais
do mouse** e não virar um keylogger.

### Windows

| Mecanismo | Solta? | Mouse | Engole a tecla? | Notas |
|---|---|---|---|---|
| `WH_KEYBOARD_LL` (hoje, `desktop/src/keys.rs`) | sim | com `WH_MOUSE_LL` | não (se não retornar 1) | Funciona hoje. Fica no caminho de **toda** tecla do sistema; o Windows remove o hook em silêncio se o callback passar do `LowLevelHooksTimeout`. Padrão que EDRs vigiam |
| Raw Input com `RIDEV_INPUTSINK` | sim | sim (`RI_MOUSE_BUTTON_4/5_DOWN`) | não | O que a Microsoft recomenda no lugar dos hooks. Não atrasa a entrada do jogo; precisa de uma janela (de mensagens) para receber `WM_INPUT` |
| `RegisterHotKey` | **não** (só `WM_HOTKEY` ao apertar) | não | **sim** | Serve para Ctrl+Shift+M e atalhos do soundpad, não para PTT |

Recomendação: Raw Input no app nativo, com o hook LL atual de reserva (atrás
de uma opção) se algum jogo atrapalhar. Pontos a medir no spike 4:
- jogo rodando **como administrador** (UIPI): processo sem elevação recebe
  Raw Input / hook LL com a janela elevada em foco? **(não verificado)**;
- anti-cheat (Vanguard, EAC, BattlEye): não achei nenhuma declaração pública
  sobre hook LL ou Raw Input em apps de voz. Na prática, Discord e TeamSpeak
  usam isso há anos sem banimento, mas é evidência indireta **(não
  verificado)**. Não injetamos nada no processo do jogo e não lemos a memória
  dele, que é o que os anti-cheats procuram.

### Linux X11 (Pop!_OS 22.04 GNOME 42 X11, qualquer sessão X11)

XInput2 com `XISelectEvents` na janela raiz pedindo `XI_RawKeyPress`,
`XI_RawKeyRelease`, `XI_RawButtonPress` e `XI_RawButtonRelease`: recebe tudo,
apertar e soltar, mouse incluso, **sem pegar a tecla** (diferente do
`XGrabKey`) e sem permissão especial. Crate `x11rb`. O XRecord também
funciona, mas é mais velho. É o que Mumble e Discord fazem no X11 **(Discord
no X11: não verificado)**.

### Linux Wayland

O Wayland não deixa um app ler teclas fora do foco. O caminho oficial é o
portal `org.freedesktop.portal.GlobalShortcuts` (versão 2): `CreateSession`,
`BindShortcuts` (o sistema mostra um diálogo para a pessoa escolher a
tecla), sinais `Activated`/`Deactivated` e `ConfigureShortcuts` (v2). Em
Rust: `ashpd::desktop::global_shortcuts`. O Discord passou a usá-lo para o
PTT no Wayland em nov/2026 (com a Igalia), o que valida o caminho.

| Ambiente | GlobalShortcuts | Solta (PTT segurando) | Mouse | Fallback |
|---|---|---|---|---|
| Windows 10/11 | n/a | sim (Raw Input / hook LL) | sim | hook LL |
| X11 (Pop 22.04, GNOME 42 X11) | n/a | sim (XInput2 raw) | sim | — |
| GNOME Wayland ≥ 48 (Fedora 42+, Ubuntu 25.04+; Ubuntu 26.04 LTS com GNOME 50 **conferir**) | **sim** (GNOME 48 em diante) | `Deactivated` deve chegar ao soltar **(não verificado no GNOME, testar)** | **(não verificado)** | evdev opcional |
| GNOME Wayland 46 (Ubuntu 24.04 LTS) | **não** | — | — | evdev opcional / só em foco |
| KDE Plasma 6 | sim (kglobalacceld) | sim (o próprio Plasma 6.7 usa press/release para o PTT do sistema) | **não** (relato no PR do Mumble) | evdev |
| Hyprland | sim (xdg-desktop-portal-hyprland) | **(não verificado)** | **(não verificado)** | binds do próprio Hyprland |
| **COSMIC (Pop 24.04)** | **não**: `cosmic.portal` não lista a interface e a issue #4 ("feature request: GlobalShortcuts portal") está aberta em 2026-11-23 | — | — | evdev opcional; atalho personalizado do COSMIC chamando `cpx-call --toggle-mute` (só alterna, não segura) |
| Sway / wlroots | não | — | — | evdev / `bindsym` com comando |
| App rodando no XWayland | XInput2 só vê teclas quando uma janela X está em foco (o KDE tem a opção "Legacy X11 App Support" para repassar) | | | não confiar |

Problemas conhecidos com o portal:

- **Tecla sem modificador vira do app:** no KDE, uma letra usada como atalho
  global deixa de digitar nos outros apps; com o Discord, relatos de
  nov/2026 no Plasma 6.8 dizem que o PTT "trava" a tecla e há um MR pendente
  no kglobalacceld. Sugerir ao usuário F13–F24, botões laterais (onde
  funcionarem) ou combinações.
- **O usuário escolhe a tecla no diálogo do sistema**, não na nossa tela.
  Nossa UI mostra o `trigger_description` devolvido e um botão "Mudar
  atalho" que chama `ConfigureShortcuts`.
- O app só pode chamar `BindShortcuts` uma vez por sessão; nas próximas
  vezes, `ListShortcuts` devolve o que já foi aceito.
- Plasma 6.7 (jun/2026) tem PTT **do sistema**, que muta todos os mics. Se a
  pessoa usar isso, o nosso PTT é redundante; detectar não é possível, então
  só documentar.

### Fallback evdev (`/dev/input/event*`)

Funciona em qualquer compositor, mouse incluso, apertar e soltar. É o
"motor por eventos" do Mumble. Custo: o usuário precisa entrar no grupo
`input` (`sudo usermod -aG input $USER` e sair da sessão), e com isso
**qualquer processo dele passa a poder ler o teclado inteiro**, inclusive
senhas. Por isso: só opcional, desligado por padrão, com um aviso claro.
Abrir só os dispositivos que têm a tecla escolhida e descartar o resto no
próprio loop, como o `keys.rs` já faz. Nunca usar `EVIOCGRAB` (engoliria a
tecla). Alternativa mais segura **(não verificado)**: um helper pequeno com
regra udev `uaccess` só para os dispositivos certos. Isso exige empacotamento
.deb, então fica para depois.

### Sempre disponível

PTT e atalhos com a janela do app em foco (eventos normais da UI), igual à
página hoje. É o mínimo garantido em qualquer sistema.

### Como os outros fazem

- **Discord:** Windows com hooks; X11 lendo teclas globais; Wayland com o
  portal GlobalShortcuts desde nov/2026 (antes, só no XWayland). Atalhos de
  mouse no Wayland continuam frágeis.
- **Mumble:** Linux com um motor por polling (sem permissão, gasta mais CPU)
  ou por eventos (evdev, grupo `input`). No Wayland, `mumble rpc
  starttalking`/`stoptalking` (desde a 1.4) para ligar a binds do compositor,
  e um PR do portal (#5976) cujo merge **não confirmei**.
- **TeamSpeak 5/6:** há relatos de PTT quebrado no Wayland/Ubuntu; o estado
  atual **não foi verificado**.

## 6. Soundpad no nativo

- Decodificar os arquivos uma vez (`symphonia`) para PCM f32 48 kHz e guardar
  em memória. Mesmo limite de tamanho/duração da página atual.
- Um `Soundpad` com uma lista de "vozes" tocando (índice + ganho). O
  `mix_into(frame)` soma no quadro do mic **depois da APM** e
  `mix_local_monitor` soma na saída para a pessoa ouvir o próprio som.
- Atalhos por som (próximo passo 3 do CLAUDE.md): no Windows, `RegisterHotKey`
  resolve (não precisa saber quando solta). No Wayland, mais IDs no mesmo
  `BindShortcuts` do portal.
- Interop: quem está no navegador recebe o som misturado na voz, como hoje.

## 7. Riscos

1. **COSMIC sem portal de atalhos** (é o desktop do Pop 24.04): o PTT fora do
   foco depende do evdev opcional. Acompanhar a issue #4 do
   xdg-desktop-portal-cosmic.
2. **Ubuntu 24.04 LTS (GNOME 46) também sem portal.** Uma parte grande dos
   usuários de Linux cai no evdev ou no PTT só com a janela em foco.
3. **Jitter buffer próprio:** é o maior código novo da fase 2. Um erro
   aparece como robô/picote, que é exatamente a queixa que importa.
4. **AEC com fone BT e com som do jogo:** o som do jogo não passa pelo nosso
   mixer, então não é referência do AEC. Com caixas de som, o jogo vaza para
   o mic. A NS reduz, mas não elimina.
5. **`sonora` é novo** (0.1 em fev/2026): sem usuários conhecidos. Manter a
   troca por `webrtc-audio-processing` atrás de uma trait `Apm`.
6. **Anti-cheat e UIPI no Windows:** comportamento com jogos elevados ou
   anti-cheat em kernel não foi confirmado.
7. **Mudança de dispositivo** (fone plugado/desplugado no meio da partida):
   precisa recriar os streams sem derrubar a chamada.
8. **cmake + C** para o libopus no CI do Windows/Linux. Aceitável, já que o
   app usa toolchain C++ para outras coisas.

## 8. Spikes (em ordem)

1. **Loopback de áudio com `cpal`** (Windows + Pop 22.04 + COSMIC): mic → 
   saída com 10 ms, medir a latência de ida e volta, trocar o fone durante a
   execução (WASAPI `DeviceChanged`, PipeWire default), testar um fone BT.
2. **APM e codec:** gravar 30 s de voz com teclado mecânico e ventoinha;
   passar por `sonora`, `webrtc-audio-processing` e `nnnoiseless`; comparar
   de ouvido com o `noiseSuppression` do Edge; medir CPU por quadro na
   máquina mais fraca do grupo. Medir `opus` complexidade 5/8/10.
3. **Interop com o navegador:** nativo ↔ Edge por `webrtc-rs`/`str0m`,
   conferir a negociação `opus/48000/2` com FEC e estéreo, simular 5–10% de
   perda e 40 ms de jitter (`tc netem` no Linux, clumsy no Windows) e ouvir
   o jitter buffer + FEC + PLC. Ler o `samplebuilder` do webrtc-rs.
4. **PTT no Windows por Raw Input:** comparar com o hook atual; testar com um
   jogo elevado, um com EAC e um com Vanguard; botões laterais do mouse.
5. **Portal GlobalShortcuts com `ashpd`:** GNOME 48+/50 (VM com Fedora ou
   Ubuntu 26.04) e KDE: `Deactivated` chega ao soltar? Tecla única? Botão de
   mouse? Latência entre apertar e o sinal chegar.
6. **XInput2 raw no Pop 22.04 (X11)** e **evdev no COSMIC**, com o fluxo de
   permissão explicado na UI.

## Fontes

- cpal 0.18.2 (backends, datas, PipeWire): https://docs.rs/crate/cpal/latest
- cpal WASAPI `DeviceChanged` (0.18.1): https://docs.rs/crate/cpal/0.18.1/source/src/host/wasapi/stream.rs
- cpal PR #754 (roteamento automático, fechado): https://github.com/RustAudio/cpal/pull/754
- Microsoft, recuperar de dispositivo inválido: https://learn.microsoft.com/en-us/windows/win32/coreaudio/recovering-from-an-invalid-device-error
- Microsoft, stream routing: https://learn.microsoft.com/en-us/windows/win32/coreaudio/stream-routing
- opus 0.4.0: https://docs.rs/crate/opus/latest
- opus-codec: https://lib.rs/crates/opus-codec
- opus-rs (Rust puro): https://docs.rs/crate/opus-rs/latest — fork opus1: https://docs.rs/crate/opus1/0.3.0
- sonora: https://docs.rs/crate/sonora/latest e https://github.com/dignifiedquire/sonora
- webrtc-audio-processing (tonarino): https://docs.rs/crate/webrtc-audio-processing/latest e https://github.com/tonarino/webrtc-audio-processing
- Anúncio WebRTC AudioProcessing v2.0 (PulseAudio): https://lists.freedesktop.org/archives/pulseaudio-discuss/2025-January/032489.html
- nnnoiseless: https://github.com/jneem/nnnoiseless
- DeepFilterNet (RTF 0,19): https://github.com/rikorose/deepfilternet e https://arxiv.org/pdf/2305.08227.pdf
- neteq (Rust): https://docs.rs/neteq — NetEQ do WebRTC: https://webrtc.googlesource.com/src/+/HEAD/modules/audio_coding/neteq/g3doc/index.md
- webrtc-rs 0.20 (sans-IO): https://docs.rs/crate/webrtc/0.20.3 — rtc: https://docs.rs/crate/rtc/0.20.1
- str0m 0.20: https://docs.rs/crate/str0m/0.20.0/source/src/lib.rs
- Portal GlobalShortcuts (spec): https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html
- GNOME 48 para devs (atalhos globais): https://release.gnome.org/48/developers/
- TWIG #189 Global Shortcuts: https://thisweek.gnome.org/posts/2025/02/twig-189
- ashpd 0.14.3: https://docs.rs/crate/ashpd/latest
- xdg-desktop-portal-cosmic (cosmic.portal e issue #4): https://github.com/pop-os/xdg-desktop-portal-cosmic e https://github.com/pop-os/xdg-desktop-portal-cosmic/issues/4
- xfwl4 #93 (quais portais suportam): https://gitlab.xfce.org/xfce/xfwl4/-/issues/93
- xdg-desktop-portal-hyprland: https://wiki.hyprland.org/Hypr-Ecosystem/xdg-desktop-portal-hyprland
- Plasma 6.7 PTT global: https://blogs.kde.org/2026/01/17/this-week-in-plasma-dark-mode-switch-and-global-push-to-talk/ e https://kde.org/announcements/plasma/6/6.7.0/
- Discord Linux/Wayland (nov/2026): https://www.omgubuntu.co.uk/2026/11/discord-linux-app-wayland-updates e https://www.gamingonlinux.com/2026/11/discord-go-into-more-detail-on-their-linux-upgrades-with-more-to-come/
- Discord PTT x KDE (nov/2026): https://discourse.nixos.org/t/kde-global-shortcuts-discord-push-to-talk-conflict/80905
- CachyOS, PTT no Wayland e botão do meio: https://discuss.cachyos.org/t/wayland-global-hotkeys-for-ptt-and-the-middle-mouse-button/13437
- Mumble, atalhos globais (evdev, grupo input): https://www.mumble.info/documentation/user/global-shortcuts/
- Mumble PR #5976 (portal): https://github.com/mumble-voip/mumble/pull/5976
- TeamSpeak 5 PTT no Wayland: https://community.teamspeak.com/t/teamspeak-5-push-to-talk-issue-on-wayland-linux-ubuntu/34471
- LowLevelKeyboardProc (recomenda Raw Input): https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc
- global-hotkey 0.10.0: https://docs.rs/crate/global-hotkey/latest
- livesplit-hotkey 0.8.1: https://docs.rs/crate/livesplit-hotkey/latest
- hotkey-listener (evdev): https://docs.rs/crate/hotkey-listener/0.3.2
