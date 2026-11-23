# Nativo 02 · Qual WebRTC usar no cliente Rust

_Pesquisa de 2026-11-23. Versões e datas conferidas no crates.io, no GitHub e
nos blogs dos projetos nesse dia. O que não deu para confirmar está marcado com
**(não verificado)**._

## Resumo

- **Recomendação:** [str0m](https://github.com/algesten/str0m) (0.26.0, Rust
  puro, *sans-IO*) para a fase 1 (mandar a tela já codificada na GPU para os
  navegadores). O BWE (estimativa de banda) é o GCC do libwebrtc portado e
  ajustado a ele, com pacer, TWCC, NACK/RTX, PLI/FIR e H.264. Não traz threads,
  runtime nem I/O, então se encaixa no nosso laço de captura sem nada a mais.
- **Plano B:** o `libwebrtc` da LiveKit (bindings do libwebrtc do Google). Desde
  outubro de 2026 ele tem **entrada de quadros já codificados**
  (`NativeVideoSource::new_encoded`) que repassa ao app o alvo de bitrate e os
  pedidos de quadro-chave. É a mesma pilha do Chrome (interoperabilidade
  garantida), mas é um binário C++ pré-compilado de ~114 MB para baixar no
  build, com clang/MSVC no caminho.
- **Não recomendo agora:** webrtc-rs (acabou de reescrever tudo; GCC e pacer
  chegaram em set/2026 e ainda não têm uso real) e GStreamer `webrtcbin`
  (runtime LGPL de dezenas de MB no Windows, contra "mínimo de dependências").
- **Quem ajusta o bitrate:** sempre **nós**. A biblioteca estima a banda de
  cada pessoa que assiste; o app junta as estimativas e muda o bitrate do
  encoder AMF/Media Foundation. Com um encode para N pessoas, uma conexão ruim
  não pode derrubar a qualidade de todo mundo (ver [Bitrate em
  mesh](#bitrate-em-mesh-um-encode-n-conexões)).

## Como a negociação funciona hoje (o que precisa caber)

Lido em `src/signaling.rs`, `static/room/webrtc.js` e `docs/ARQUITETURA.md`:

- O servidor só repassa `{ "to": id, "data": <json> }`; tudo o que é WebRTC vive
  dentro de `data` (`description`, `candidate`, `restart`, ...).
- Cada par de navegadores tem **um** `RTCPeerConnection` com quatro
  transceivers `sendrecv` fixos (tela, som da tela, voz, câmera). Quem entra
  depois faz a oferta; compartilhar é só `replaceTrack()`, sem renegociar.
- O codec é escolhido por `setCodecPreferences`: H.264 primeiro só se o outro
  lado declarou `hwH264` no perfil e ninguém é Firefox; senão VP8.
- ICE com trickle (`onicecandidate` → `send(id, { candidate })`), STUN do
  Google e TURN da Cloudflare só se `fly secrets` tiver a chave (hoje não tem).

**Encaixe proposto para a fase 1:** a conexão nativa é **extra e separada** da
conexão do WebView. O app nativo é sempre quem oferece (só `sendonly`: vídeo da
tela e, depois, som da tela); o navegador de quem assiste responde. Isso evita
colisão de ofertas sem "perfect negotiation". Uma chave nova dentro de `data`,
por exemplo `{ native: { description } }` e `{ native: { candidate } }`, separa
esta conexão da de sempre; o `webrtc.js` cria um segundo `RTCPeerConnection`
quando recebe a oferta e põe a faixa recebida no mesmo `<video>` da tela. O
servidor não muda (continua repassando JSON opaco).

## Comparação

Legenda: ✅ pronto e usado; 🟡 existe mas novo, parcial ou com ressalva; ❌ não tem.

| | **str0m 0.26** | **webrtc-rs 0.21 (`webrtc`/`rtc`)** | **LiveKit `libwebrtc` 0.4 / `webrtc-sys` 0.3.55** | **GStreamer `webrtcbin` (gstreamer-rs 0.25, GStreamer 1.28)** |
|---|---|---|---|---|
| Linguagem / modelo | Rust puro, sans-IO, sem threads | Rust puro; núcleo sans-IO (`rtc`) + camada async (`webrtc`) com runtime plugável | C++ (libwebrtc do Google, commit `a545de4`) via cxx; precisa de tokio | C (GLib) + plugins Rust; pipeline com threads próprias |
| Última versão | 0.26.0 em 2026-11-22; ~1 release a cada 2–3 semanas | 0.21.1 em 2026-10-11 ("1.0-rc"); 0.17.x só correções | `libwebrtc` 0.4.2 e `livekit` 0.12.0 em 2026-11-18 | gstreamer-webrtc 0.25.4 (2026-09); GStreamer 1.28.x |
| Licença | MIT/Apache-2.0 | MIT/Apache-2.0 | Apache-2.0 + BSD (libwebrtc) | LGPL-2.1 (GStreamer); plugins-rs MPL/MIT/Apache |
| DTLS/SRTP | ✅ DTLS próprio (`dimpl`); cripto `aws-lc-rs` (padrão), `rust-crypto`, `wincrypto` (CNG, Windows), `openssl`, Apple | ✅ DTLS próprio; `ring` ou `aws-lc-rs` ou provedor próprio | ✅ BoringSSL embutido | ✅ OpenSSL + libsrtp |
| ICE / STUN | ✅ agente ICE (UDP e TCP); **não coleta** candidatos: o app enumera interfaces e consulta STUN | ✅ completo, com coleta, mDNS, ICE-TCP | ✅ igual ao Chrome | ✅ libnice |
| TURN (UDP/TCP/TLS) | ❌ por fora: o app aloca e embrulha os pacotes (ex.: `turn-client-proto`, sans-IO, **maturidade não verificada**) | 🟡 TURN UDP sim; TURN sobre TCP na camada async está como "trabalho futuro" no blog de ago/2026; TLS não citado | ✅ UDP, TCP, TLS | ✅ UDP, TCP, TLS (libnice) |
| H.264: `profile-level-id`, `packetization-mode=1` | ✅ empacotador FU-A/STAP-A; 0.22 corrigiu negociação com Safari (níveis rebaixáveis, Constrained High) | ✅ empacotador H.264 (herdado do Pion) | ✅ o do Chrome; o encoder de repasse declara `packetization-mode=1` | ✅ `rtph264pay`; perfil/nível negociado pelo caps |
| Opus | ✅ (inclui RED) | ✅ | ✅ + NetEQ + APM (AEC/NS/AGC) | ✅ |
| NACK / RTX | ✅ (reenvio limitado a 1× por RTT desde 0.26) | ✅; RTX só passou a ser negociado por padrão em jul/2026 (rtc#119) | ✅ | ✅ |
| PLI/FIR → pedir quadro-chave | ✅ `Event::KeyframeRequest` | ✅ | ✅ `take_keyframe_request()` | ✅ evento `GstForceKeyUnit` upstream |
| TWCC + BWE + pacer | ✅ GCC alinhado ao libwebrtc (atraso + perda + probing + ALR), pacer; estimativa em `Event::EgressBitrateEstimate` | 🟡 GCC + pacer + jitter buffer novos na 0.21 (set/2026); até ago/2026 o blog dizia "não temos estimador nem pacer" | ✅ GoogCC do Chrome; alvo entregue ao app em `take_rate_control_request()` | 🟡 `rtpgccbwe` (gst-plugins-rs) só com `webrtcsink`, que quer vídeo cru para codificar ele mesmo |
| Simulcast | ✅ envio e recepção (feito para SFU) | ✅ | ❌ com quadros pré-codificados (uma camada só) | 🟡 |
| Empurrar H.264 já codificado | ✅ `Writer::write(pt, wallclock, rtp_time, access_unit)` | ✅ `TrackLocalStaticSample` / escrita de amostra | ✅ `capture_encoded_frame()` (Annex B, SPS/PPS em todo IDR) | ✅ `appsrc` → `h264parse` → `rtph264pay` |
| Data channels | ✅ (sctp-proto) | ✅ (issue aberta #938: travadas de segundos mandando rajadas ao Chrome) | ✅ | ✅ |
| Receber/decodificar (fases 2–3) | ❌ só despacota; jitter buffer fixo; decoders por nossa conta | 🟡 jitter buffer novo; decoders por nossa conta | ✅ jitter buffer, NetEQ, decoders VP8/VP9/H.264/AV1, áudio do SO | ✅ tudo, via plugins |
| Build Windows (MSVC) | `cargo build`; com `wincrypto` nem precisa de aws-lc (sem cmake/NASM) | `cargo build` (ring) | Baixa zip pré-compilado de **114 MB** (win-x64) do GitHub no build; issue #1070 (conflito `/MT` × `/MD`, LNK2038) fechada como "não planejado" | Instalar o SDK MSVC do GStreamer; distribuir as DLLs |
| Build Linux | `cargo build` | `cargo build` | zip de 156 MB (linux-x64); **exige clang++** | pacotes da distro (versão varia) |
| Tamanho no binário | pequeno (estimo 2–4 MB; **não medido**) | pequeno a médio (**não medido**) | grande (estimo +15–30 MB; **não medido**) | runtime de dezenas de MB fora do exe (**não medido**) |
| CPU para mandar | só empacotar + SRTP; sem cópias extras | parecido | baixo, mas threads de rede/worker/sinalização do libwebrtc | moderado (elementos GStreamer por quadro) |
| Atividade | 663 ★; commit hoje; usado em produção como SFU (Lookback); P2P "menos testado" (README) | 5,2 k ★; muito ativo em 2026, mas reescrito do zero | 518 ★, 196 issues abertas; produto da LiveKit | projeto grande e estável |

### webrtc-rs (`webrtc` crate)

- **Estado em 2026:** em jan/2026 a linha 0.17 (presa ao tokio) entrou em
  *feature freeze*; o núcleo foi refeito sans-IO no crate `rtc` e a camada async
  `webrtc` 0.20 saiu em 2026-07-31. A 0.21.0 (2026-09-19) é tratada como
  "1.0.0-rc.1": API estável dali em diante. 1.0.0 ainda não saiu (0.21.1 em
  2026-10-11).
- **Congestionamento:** o post "The Path to webrtc 1.0" (ago/2026) dizia
  literalmente que não havia estimador de banda nem pacer. A 0.21 trouxe GCC,
  pacer, FlexFEC, jitter buffer e feedback RFC 8888 de uma vez. Código com dois
  meses e sem relatos de uso.
- **Interop:** o mesmo post dizia que não havia teste com navegador real no CI;
  a issue #842 ("Live-browser interop in CI") foi fechada como concluída em
  ago/2026, mas não confirmei o que roda. Issues antigas (ICE com Firefox #271,
  latência #281) foram fechadas todas em 2026-01-31, data do *freeze*:
  **parece fechamento em massa, não correção (inferência)**. Aberta: #938,
  data channel com travadas de 1–13 s mandando rajadas ao Chrome.
- **Prós:** API parecida com a do navegador (`RTCPeerConnection`), TURN e coleta
  de candidatos prontos, crate `sfu` próprio (sans-IO) e post sobre passar de
  P2P para SFU automaticamente.
- **Contras:** maturidade justamente nas partes que importam para nós (BWE,
  pacer, RTX por padrão só em jul/2026).

### str0m

- **Modelo:** um `Rtc` por conexão; o app entrega pacotes e horário
  (`handle_input`) e drena `poll_output` (pacotes a enviar, eventos, próximo
  timeout). Nenhuma thread ou async. Encaixa direto no laço da captura: o mesmo
  thread pode atender todas as conexões de quem assiste.
- **BWE:** `RtcConfig::enable_bwe(Some(initial))`; eventos
  `Event::EgressBitrateEstimate(BweKind::Twcc { estimate, can_probe })`;
  `rtc.bwe().set_bitrate(minimum, desired)` diz quanto queremos chegar a usar
  (probing). Os changelogs 0.24–0.26 (set–nov/2026) são quase todos
  "alinhar com o libwebrtc" (probing, ALR, limites da perda, rajadas do pacer).
  Issue aberta #1127: uma queda por atraso logo no início pode derrubar a
  estimativa muito abaixo do link quando o emissor ainda manda pouco. Para
  tela compartilhada (que começa devagar e cresce) isso importa: testar.
- **H.264:** negociação revisada contra Safari em ago/2026 (#1015). A 0.25
  passou a **preservar NAL de preenchimento (tipo 12)**: o nosso AMF em CBR gera
  muito disso, então **removemos NAL 12 antes de `write`** (ou trocamos para
  VBR de baixa latência, que já é pendência).
- **O que falta:** TURN (fazemos por fora), coleta de candidatos (enumerar
  interfaces + uma consulta STUN; é pouco código), jitter buffer adaptativo e
  qualquer coisa de áudio/vídeo cru (por design).
- **Risco declarado:** o README diz que P2P funciona mas foi menos testado que
  o uso como SFU.

### LiveKit `libwebrtc` / `webrtc-sys` (e libwebrtc direto)

- Bindings seguros (`libwebrtc`) sobre `webrtc-sys` (cxx) sobre um libwebrtc
  pré-compilado pela LiveKit (tag `webrtc-a545de4`, 2026-10-23). O crate
  `libwebrtc` dá `PeerConnectionFactory`/`PeerConnection` sem precisar do
  servidor da LiveKit (só a camada `livekit` exige o servidor).
- **Pré-codificado:** `NativeVideoSource::new_encoded(resolution)` +
  `capture_encoded_frame(&EncodedVideoFrame)` com um *passthrough encoder*
  dentro do libwebrtc. O libwebrtc continua fazendo GoogCC, pacer, RTX, FEC; o
  alvo de bitrate chega ao app em `take_rate_control_request()` e o PLI/FIR em
  `take_keyframe_request()`. Exige um *access unit* completo por quadro, Annex B,
  SPS/PPS em todo quadro-chave; sem simulcast. Documentado pela LiveKit a partir
  do `livekit` 0.7.53.
- **Ponto forte para depois:** nas fases 2–3 (voz e interface nativa) o
  libwebrtc já traz o que é mais difícil: NetEQ (jitter buffer de áudio),
  AEC/NS/AGC, decodificadores VP8/VP9/H.264/AV1 (os navegadores mandam VP8 para
  quem não tem `hwH264`) e acesso ao áudio do sistema.
- **Contras:** download de 114–156 MB a cada build limpo (CI do Windows e
  Linux), clang obrigatório no Linux, conflito de CRT no MSVC sem correção
  planejada (#1070), muitas threads internas, binário grande, e a API segue o
  ritmo da LiveKit (0.3 → 0.4 em nov/2026). Usar o libwebrtc "puro" (sem
  LiveKit) significaria compilar com `gn`/`ninja`/depot_tools nós mesmos: fora
  de questão para um mantenedor só.

### GStreamer `webrtcbin` via gstreamer-rs

- Funciona e interopera (libnice, OpenSSL, libsrtp; TURN TCP/TLS). Para H.264
  pronto: `appsrc ! h264parse ! rtph264pay ! webrtcbin`.
- O controle de congestionamento bom (`rtpgccbwe`) está no `webrtcsink`, que
  quer **vídeo cru** para escolher e controlar o encoder dele. Com `appsrc` de
  H.264 pronto, o BWE ficaria por nossa conta (ler TWCC das estatísticas).
- Windows: instalar e distribuir o runtime do GStreamer (DLLs LGPL). Vai
  contra "mínimo de dependências" e "leve".

### Outros

- **`datachannel` (bindings do libdatachannel, C++, MPL-2.0):** pequeno e
  estável (libdatachannel v0.24.8 em 2026-11-22), tem empacotador H.264,
  respondedor de NACK e PLI, mas **não tem BWE/TWCC** (pelo que conheço;
  **não reverificado agora**). Seria preciso escrever o controle de banda.
- **Pion (Go) / aiortc (Python) como processo auxiliar:** descartados (outra
  linguagem e outro runtime no PC de quem joga).

## Interop com navegadores: o que testar em qualquer escolha

- **H.264:** o Chrome/Edge oferece Constrained Baseline (`42e01f`, `42001f`),
  Main (`4d001f`) e High/Constrained High (`640c1f`, `64001f`) com
  `packetization-mode` 0 e 1 e `level-asymmetry-allowed=1`. O Safari oferece H.264
  de hardware. O **Firefox** depende do plugin OpenH264, que pode não estar
  baixado e que decodifica com segurança só Constrained Baseline
  (**não reverificado em 2026**). Proposta: começar com **Constrained Baseline,
  `packetization-mode=1`**, sem B-frames, Annex B, SPS/PPS repetidos em todo
  IDR; testar High depois. Se o navegador não aceitar H.264 na resposta, cair de
  volta no compartilhamento pelo WebView (o caminho de hoje) para essa pessoa.
- **Nível:** 720p30 cabe em 3.1; 1080p60 precisa 4.2. Com
  `level-asymmetry-allowed=1` o navegador aceita nível maior que o oferecido.
- **Feedback:** TWCC (`transport-cc` + extensão `transport-wide-cc`) é o que o
  Chrome usa; REMB é legado. Garantir que a oferta nativa inclua
  `a=rtcp-fb:<pt> transport-cc`, `nack`, `nack pli`, `ccm fir` e RTX
  (`apt=<pt>`).
- **Opus (fase 2):** `minptime=10;useinbandfec=1`; stereo para o som da tela.
- **TURN:** hoje produção não tem TURN; quando a chave da Cloudflare existir,
  o nativo precisa usar as mesmas credenciais de `/api/ice` (UDP 3478,
  TCP 3478, TLS 443).

## Bitrate em mesh: um encode, N conexões

**Como fica:** o encoder de hardware roda **uma vez**; cada pessoa que assiste
tem o seu `Rtc` (ou `PeerConnection`) que só empacota, cifra (SRTP) e manda.
Hoje o Chrome/Edge cria **um encoder por `RTCRtpSender`**, isto é, um por
pessoa que assiste (comportamento do libwebrtc; é parte do motivo dos 28,8% de
CPU medidos). No nativo, o custo extra por pessoa é empacotar e cifrar:
estimativa de bem menos de 1% de um núcleo por pessoa a 4 Mbit/s (AES com
AES-NI) (**estimativa, medir no spike**).

**Quem adapta:** cada conexão dá uma estimativa `e_i`. O app calcula o alvo e
reconfigura o encoder (AMF/MF aceitam mudar bitrate em tempo real, sem IDR):

```text
alvo = clamp(min(e_i) * 0.85, piso, teto_da_caixa_de_qualidade)
```

- Subir devagar (ex.: no máx. +10% a cada 1 s) e descer na hora; ignorar
  estimativas com `can_probe = false`.
- **Uma pessoa ruim não pode puxar todo mundo para baixo.** Se `e_i` de alguém
  ficar abaixo de ~50% da mediana: (a) mandar só a camada base temporal para ela
  (se o AMF codificar H.264 com camadas temporais: P-quadros descartáveis;
  **suporte do AMF a camadas temporais em AVC não verificado**), ou (b) abrir
  uma segunda sessão do encoder em resolução menor só para quem está mal (a RX
  5500 XT tem várias sessões de VCN; custo a medir), ou (c) avisar "conexão
  fraca" para essa pessoa e deixar o NACK/PLI segurar. Começar com (c) + mínimo,
  medir, depois (a)/(b).
- **Quadros-chave:** todo PLI/FIR de qualquer pessoa vira um IDR para todas.
  Limitar a 1 IDR a cada ~500 ms, juntar pedidos. Alternativa: *intra refresh*
  do AMF (sem picos de bitrate; a avaliar).
- **Pacing:** cada `Rtc` tem o próprio pacer; as N filas somadas dividem o
  upload. Para N pequeno isso basta.
- **Simulcast:** não serve em mesh (cada conexão é uma só); passa a valer com
  SFU.

### Quando um SFU (issue #25) passa a valer

O upload de quem compartilha é `N_assistindo × bitrate`:

| Qualidade | Bitrate típico | 3 assistindo | 6 | 11 |
|---|---|---|---|---|
| 720p30 Fluidez | 2,5 Mbit/s | 7,5 | 15 | 27,5 Mbit/s |
| 1080p60 | 6 Mbit/s | 18 | 36 | 66 Mbit/s |

- Com fibra de upload ≥ 100 Mbit/s, mesh aguenta a sala cheia em 720p; em 1080p60
  ou com upload de 10–30 Mbit/s (cabo/4G), passa de ~4–5 pessoas assistindo.
- Um SFU vale a pena quando: (1) aparecer gente com upload pequeno compartilhando
  para muitos; (2) houver mistura de redes que peça simulcast (2–3 camadas
  codificadas na GPU, o SFU escolhe por pessoa); (3) o TURN entrar em produção e
  o tráfego relayado multiplicar por N.
- **Afinidade com a escolha:** o str0m nasceu para SFU (é o uso em produção dele).
  O mesmo crate serviria para um SFU dentro do nosso binário axum, que só repassa
  pacotes (não guarda nada), se um dia valer a pena. Custo: banda no fly.io.

## Recomendação

1. **Fase 1 com str0m.** Motivos: Rust puro e pequeno (bate com "mínimo de
   dependências"), sans-IO (cabe no laço da captura, sem tokio, sem threads
   escondidas, CPU previsível para quem está jogando), BWE com GCC em uso real e
   sendo afinado contra o libwebrtc a cada release, pedido de quadro-chave e
   estimativa expostos como eventos. Build igual a qualquer crate no Windows
   (feature `wincrypto`, sem cmake/NASM) e no Linux.
2. **Esconder a pilha atrás de um trait nosso** (`ScreenSender`:
   `offer() / on_answer() / on_candidate() / push_access_unit() / poll_events()`)
   para poder trocar por `libwebrtc` da LiveKit se o spike mostrar problema de
   interop ou de BWE.
3. **Reavaliar na fase 2 (voz):** com str0m teremos de juntar `opus` +
   `webrtc-audio-processing` (AEC/NS/AGC) + um jitter buffer nosso; com
   libwebrtc isso vem pronto. Se a fase 3 (receber vídeo dos navegadores, VP8) se
   aproximar, o libwebrtc ganha peso. Decidir com números, não agora.
4. **Não usar** webrtc-rs até a 1.0 sair e o GCC dele ter uso real; não usar
   GStreamer.

### Riscos

- **P2P com str0m é menos testado** que o uso SFU (palavras do README); bugs de
  ICE com navegador aparecem no changelog até nov/2026 (nomeação após NAT
  rebinding, #1168).
- **TURN fica por nossa conta**; sem TURN, quem está em CGNAT/4G já não conecta
  hoje, e o nativo herdaria isso. Avaliar `turn-client-proto` (sans-IO, UDP/TCP;
  pouca adoção) ou aceitar a limitação na fase 1.
- **API do str0m muda a cada minor** (0.25 e 0.26 quebraram API de BWE e SDP).
  Fixar versão exata e atualizar de propósito.
- **Firefox e H.264**: quem assiste pelo Firefox sem OpenH264 não consegue ver a
  tela nativa; precisa do caminho de volta pelo WebView.
- **Uma estimativa só manda no encoder**: sem camadas temporais ou segunda
  sessão, a pior conexão define a qualidade de todos.

## Esboço: H.264 pré-codificado para um navegador com str0m

API conferida no código-fonte do str0m 0.26.0 (`Rtc`, `sdp_api`, `writer`,
`Event`, `Receive::new`); a cola (sinalização, STUN, encoder) é pseudocódigo.
Uma thread atende todas as pessoas que assistem.

```rust
use std::{net::{SocketAddr, UdpSocket}, sync::Arc, time::{Duration, Instant}};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};

struct Viewer {
    peer_id: u64,              // id in the room (signaling "to")
    rtc: Rtc,
    socket: UdpSocket,         // one socket per viewer keeps demux trivial
    mid: Mid,
    pending: Option<SdpPendingOffer>,
    estimate: Option<Bitrate>,
    connected: bool,
}

impl Viewer {
    fn new(peer_id: u64, local: SocketAddr) -> std::io::Result<(Self, String)> {
        let socket = UdpSocket::bind(local)?;
        socket.set_nonblocking(true)?;
        let mut rtc = Rtc::builder()
            .clear_codecs()
            .enable_h264(true)                           // advertise only H.264
            .enable_bwe(Some(Bitrate::kbps(2_500)))      // TWCC + GCC + pacer
            .build(Instant::now());
        rtc.add_local_candidate(Candidate::host(socket.local_addr()?, "udp").unwrap());
        // + srflx candidate from our own STUN query (str0m does not gather).

        let mut api = rtc.sdp_api();
        let mid = api.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        let (offer, pending) = api.apply().expect("has changes");
        // TODO spike: restrict H.264 to profile-level-id 42e01f, packetization-mode=1.
        let sdp = offer.to_sdp_string();                 // -> send(peer_id, {native:{description}})
        Ok((Viewer { peer_id, rtc, socket, mid, pending: Some(pending), estimate: None, connected: false }, sdp))
    }

    fn on_answer(&mut self, sdp: &str) {
        let answer = SdpAnswer::from_sdp_string(sdp).unwrap();
        self.rtc.sdp_api().accept_answer(self.pending.take().unwrap(), answer).unwrap();
    }

    fn on_remote_candidate(&mut self, cand: &str) {
        if let Ok(c) = Candidate::from_sdp_string(cand) { self.rtc.add_remote_candidate(c); }
    }

    /// One complete Annex B access unit from AMF/MF (filler NALs already stripped).
    fn push(&mut self, au: &Arc<[u8]>, captured: Instant, ts90k: u64) {
        if !self.connected { return; }                   // str0m drops media before ICE connects
        let Some(writer) = self.rtc.writer(self.mid) else { return };
        let Some(pt) = writer.payload_params().find(|p| p.spec().codec == Codec::H264).map(|p| p.pt())
            else { return };                             // browser refused H.264: fall back to WebView path
        let _ = writer.write(pt, captured, MediaTime::from_90khz(ts90k), au.clone());
    }

    /// Drain str0m; returns when it wants to be woken again.
    fn drive(&mut self, keyframe: &mut bool) -> Instant {
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Transmit(t)) => { let _ = self.socket.send_to(&t.contents, t.destination); }
                Ok(Output::Timeout(t)) => return t,
                Ok(Output::Event(e)) => match e {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => self.connected = false,
                    Event::Connected => self.connected = true,
                    Event::KeyframeRequest(_) => *keyframe = true,   // PLI/FIR -> one IDR for everyone
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, can_probe: true }) => {
                        self.estimate = Some(estimate)
                    }
                    _ => {}
                },
                Err(e) => { eprintln!("viewer {}: {e:?}", self.peer_id); return Instant::now() + Duration::from_millis(50); }
            }
        }
    }

    fn read_socket(&mut self, buf: &mut [u8]) {
        while let Ok((n, source)) = self.socket.recv_from(buf) {
            let dest = self.socket.local_addr().unwrap();
            if let Ok(r) = Receive::new(Protocol::Udp, source, dest, &buf[..n]) {
                let _ = self.rtc.handle_input(Input::Receive(Instant::now(), r));
            }
        }
    }
}

// Main loop (same thread as the encoder callback, or fed by a channel):
//   for each encoded frame: strip NAL type 12, then v.push(..) for every viewer
//   for each viewer: v.read_socket(); v.rtc.handle_input(Input::Timeout(now)); v.drive(&mut kf)
//   if kf (rate-limited to ~1 per 500 ms): encoder.force_idr()
//   every 1 s: target = clamp(min(v.estimate) * 0.85, floor, quality_box_cap); encoder.set_bitrate(target)
//   wait until min(next timeouts), a socket is readable (mio/polling) or a new frame arrives
```

Lado do navegador (rascunho, em `webrtc.js`): ao receber
`{ native: { description } }` do tipo `offer`, criar `nativePc` com o mesmo
`iceServers`, `setRemoteDescription`, `setLocalDescription()` e responder com
`{ native: { description: nativePc.localDescription } }`; `ontrack` põe a
faixa no `<video>` da tela dessa pessoa; candidatos vão com `{ native: { candidate } }`.

## Perguntas para o spike

1. Chrome, Edge, Firefox (com e sem OpenH264) e Safari aceitam a oferta do
   str0m com só H.264 Constrained Baseline? E com Constrained High (`640c1f`)?
2. O GCC do str0m sobe de ~300 kbit/s até 4–6 Mbit/s em quanto tempo numa LAN e
   em Wi-Fi? Reproduz o problema da #1127 com tela parada (bitrate baixo)?
   Comparar com o que o Chrome alcança mandando a mesma tela.
3. Custo de CPU por pessoa assistindo (1, 3, 6, 11 conexões, 720p30 e 1080p60)
   no notebook e na máquina com a RX 5500 XT, com jogo rodando.
4. O AMF muda o bitrate em tempo real sem IDR e sem engasgo? VBR de baixa
   latência remove o preenchimento? Suporta camadas temporais em AVC?
5. Quanto o binário cresce com str0m + `wincrypto` (Windows) e `aws-lc-rs` ou
   `rust-crypto` (Linux)?
6. ICE: só candidato host + srflx próprio conecta através do NAT de casa típico
   (roteador da operadora)? Quanto trabalho é TURN com `turn-client-proto`?
7. Mesmo teste com `libwebrtc` da LiveKit (`new_encoded`) como linha de base:
   tempo de build limpo no Windows, tamanho do exe, CPU, e se o
   `take_rate_control_request()` dá números parecidos com o str0m.
8. PLI em rajada (3 pessoas entrando juntas) gera quantos IDRs? O limite de
   500 ms segura a imagem de quem já estava vendo?

## Fontes

- webrtc-rs, blog (lista de posts, 2026): https://webrtc.rs/blog/
- webrtc-rs, "The Path to webrtc 1.0" (2026-08-01): https://webrtc.rs/blog/2026/08/01/the-path-to-webrtc-1.0.html
- webrtc-rs, feature freeze da 0.17 (2026-01-31): https://webrtc.rs/blog/2026/01/31/webrtc-v0.17.0-feature-freeze-sansio-shift.html
- webrtc-rs, anúncio da 0.20.0 (2026-07-31): https://webrtc.rs/blog/2026/07/31/announcing-webrtc-v0.20.0.html
- crate `rtc` 0.21.1: https://docs.rs/crate/rtc/0.21.1
- crate `webrtc` (versões): https://crates.io/crates/webrtc
- webrtc-rs issues: https://github.com/webrtc-rs/webrtc/issues/842 , https://github.com/webrtc-rs/webrtc/issues/938 , https://github.com/webrtc-rs/rtc/issues/119
- str0m, README: https://github.com/algesten/str0m
- str0m, CHANGELOG: https://github.com/algesten/str0m/blob/main/CHANGELOG.md
- str0m, docs 0.26.0: https://docs.rs/str0m/latest/str0m/ e https://docs.rs/str0m/latest/str0m/enum.Event.html
- str0m issues: https://github.com/algesten/str0m/issues/1127 , https://github.com/algesten/str0m/issues/911 , https://github.com/algesten/str0m/issues/1015
- LiveKit, vídeo pré-codificado: https://docs.livekit.io/transport/media/pre-encoded/
- LiveKit rust-sdks (crates `libwebrtc`, `webrtc-sys`, `webrtc-sys-build`): https://github.com/livekit/rust-sdks
- libwebrtc pré-compilado `webrtc-a545de4` (tamanhos dos zips): https://github.com/livekit/rust-sdks/releases/tag/webrtc-a545de4
- LiveKit issue de CRT no MSVC: https://github.com/livekit/rust-sdks/issues/1070
- GStreamer 1.28: https://gstreamer.freedesktop.org/releases/1.28/ e https://discourse.gstreamer.org/t/gstreamer-1-28-0-new-major-feature-release/5700
- turn-proto (TURN sans-IO): https://github.com/ystreet/turn-proto
- libdatachannel: https://github.com/paullouisageneau/libdatachannel
- libwebrtc, pacing: https://webrtc.googlesource.com/src/+/HEAD/modules/pacing/g3doc/index.md
- `webrtc-audio-processing` (para a fase 2): https://github.com/tonarino/webrtc-audio-processing

Conferido direto no código publicado no crates.io (2026-11-23): `str0m` 0.26.0
(`src/bwe/api.rs`, `src/config.rs`, `src/media/writer.rs`, `src/io/mod.rs`),
`libwebrtc` 0.4.2 (`src/native/video_source.rs`), `webrtc-sys` 0.3.55
(`src/passthrough_video_encoder.cpp`, `libwebrtc/build_*.{sh,cmd}`),
`webrtc-sys-build` 0.3.21 (URL e tag do download).
