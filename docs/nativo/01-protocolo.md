# 01 · Protocolo do CPX Call (contrato para o cliente nativo)

_Levantado do código em 2026-11-23 (branch `development`, depois do #139)._
_Fonte da verdade: `src/*.rs` e `static/room/*.js`. Quando este documento e o
código discordarem, vale o código; corrija este arquivo._

Este documento descreve **exatamente** o que um participante precisa fazer para
entrar numa sala do CPX Call e conversar com os navegadores que já estão lá:
HTTP, WebSocket, as mensagens que vão "dentro" do relay e a negociação WebRTC.
Identificadores e JSON ficam em inglês, como no código. As referências são
`arquivo:linha`.

Sumário:

1. [Visão geral](#1-visão-geral)
2. [Endpoints HTTP](#2-endpoints-http)
3. [WebSocket de sinalização](#3-websocket-de-sinalização)
4. [Mensagens entre participantes (dentro do relay)](#4-mensagens-entre-participantes-dentro-do-relay)
5. [Negociação WebRTC](#5-negociação-webrtc)
6. [Como ser um bom cidadão na sala](#6-como-ser-um-bom-cidadão-na-sala)
7. [Armadilhas para uma implementação fora do navegador](#7-armadilhas-para-uma-implementação-fora-do-navegador)

---

## 1. Visão geral

```
 cliente A ──WS /ws/{sala}──┐                ┌──WS──  cliente B
                            ▼                ▼
                  servidor (axum): só repassa {to,data}
                            │
 cliente A ◀════ WebRTC P2P (mesh, 1 RTCPeerConnection por par) ════▶ cliente B
               4 transceivers: tela (vídeo), som da tela, voz, câmera
               sem data channel: chat e estado vão pelo WebSocket
```

- O servidor não entende nada do que repassa: cada mensagem do cliente é
  `{"to": <id>, "data": <qualquer JSON>}` e chega ao destino como
  `{"type":"signal","from":<id>,"data":<o mesmo JSON>}` (`src/rooms.rs:112-122`).
- Tudo o que não é mídia (perfil, chat, GIF, reações, "quem assiste quem",
  estado de voz/câmera, pedidos de assistir) viaja **por esse relay**, uma cópia
  por destinatário. Não existe `RTCDataChannel` em lugar nenhum.
- A mídia é mesh: cada par tem a sua `RTCPeerConnection`, negociada **uma vez**
  com quatro transceivers fixos; começar/parar tela, voz e câmera é só
  `replaceTrack()`, sem renegociar (`static/room/webrtc.js:44-56`).

---

## 2. Endpoints HTTP

Todas as rotas estão em `src/main.rs:144-211`. O servidor fala só HTTP/1
(`Cargo.toml`: `axum` com `http1`). Não há autenticação, cookies nem checagem de
`Origin`; o único controle de acesso é o ID da sala ser difícil de adivinhar.

| Rota | Método | Usado por | Resposta | Ref. |
|---|---|---|---|---|
| `/api/ice` | GET | sala, antes de entrar | `{"iceServers":[...]}` | `src/main.rs:378-389`, `src/ice.rs` |
| `/api/rooms?ids=a,b` | GET | lobby e barra lateral | `{"a":3,"b":0}` | `src/main.rs:248-272` |
| `/api/friends?codes=X,Y` | GET | lobby e barra lateral (amigos) | `{"X":{...},"Y":null}` | `src/main.rs:274-322` |
| `/api/gifs?q=&pos=` | GET/HEAD | chat, foto/banner de perfil | `{"results":[...],"next":"..."}` | `src/main.rs:324-353`, `src/gifs.rs` |
| `/ws/{room}` | GET (upgrade) | sala | WebSocket | `src/main.rs:202`, `src/signaling.rs:47-58` |
| `/room/{id}` | GET | navegador | HTML (ou 303 para `/` se ID inválido) | `src/main.rs:213-219` |
| `/health` | GET | Fly.io | `ok` | `src/main.rs:204` |

Todas as respostas `/api/*` têm `Content-Type: application/json` e
`Cache-Control: no-store`.

### 2.1 ID de sala

`[A-Za-z0-9_-]{1,64}` (`src/rooms.rs:165-171`; igual no JS em
`static/common.js:763-765`). IDs gerados pelo site: `slug-xxxxxx` (6 chars
`[a-z0-9]`) ou 16 hex aleatórios (`static/common.js:809-814`); a sala fixa
("Block") é `block-de-<slug>-xxxxxx` (`static/common.js:837-849`). Para o
servidor, todos são iguais.

### 2.2 `GET /api/ice`

```json
{ "iceServers": [ { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] } ] }
```

- Sem `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` (produção hoje): só a lista acima
  (`src/ice.rs:103-105`).
- Com a chave: a resposta da Cloudflare (`POST .../generate-ice-servers`,
  `ttl` 86400 s) é repassada, com entradas `turn:`/`turns:` contendo
  `username` e `credential`; URLs na porta 53 são removidas
  (`src/ice.rs:125-160`). Fica em cache por 12 h no servidor (`src/ice.rs:19`).
  Se a Cloudflare falhar, volta ao STUN (`src/ice.rs:93-98`).
- Exemplo com TURN:

```json
{ "iceServers": [
  { "urls": ["stun:stun.cloudflare.com:3478"] },
  { "urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
    "username": "…", "credential": "…" } ] }
```

- O navegador começa com `[{urls:'stun:stun.l.google.com:19302'}]`, busca
  `/api/ice` antes de cada `join()` e só refaz a busca se passaram 6 h
  (`static/room/estado.js:5-21`, `static/room/sessao.js:120`). Se a resposta
  vier vazia ou com erro, mantém o STUN.
- `urls` é **sempre um array** aqui (o formato `RTCIceServer` aceita string ou
  array; o cliente nativo deve aceitar os dois).

### 2.3 `GET /api/rooms?ids=a,b,c`

- Só o parâmetro `ids=` (pode repetir), separado por vírgula, **sem
  percent-decoding**; IDs inválidos são descartados, no máximo 30
  (`src/main.rs:100`, `250-258`).
- Resposta: `{"a":3,"b":0,"c":0}` (sala inexistente conta 0).

### 2.4 `GET /api/friends?codes=7K3F9X2A,QW12ER34`

- Códigos normalizados (tira `-`, maiúsculas, 8 chars do alfabeto Crockford
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), máximo 64 (`src/presence.rs:43-50`,
  `src/main.rs:102`, `283-291`).
- Resposta:

```json
{ "7K3F9X2A": { "nick": "Rafa", "room": "churrasco-k3f9x2", "count": 3, "secs": 420 },
  "QW12ER34": null }
```

  `null` = fora de sala ou invisível. Se a pessoa estiver em várias salas, vale
  a entrada mais recente (`src/presence.rs:112-128`).
- Código de amigo = primeiros 40 bits de `SHA-256(secret)` (secret = 64 hex
  minúsculos, 32 bytes aleatórios guardados em `localStorage.friendSecret`) em
  base32 Crockford (`src/presence.rs:26-35`, `static/amigos.js:20-38`). Exibido
  como `XXXX-XXXX`.

### 2.5 `GET /api/gifs?q=gato&pos=24`

- `q` (opcional, percent/form-decoded, `trim`, até 50 chars, minúsculas) e
  `pos` (cursor da página seguinte, até 64 chars). Sem `q`: "em alta"
  (`src/gifs.rs:74-111`, `src/main.rs:327-336`).
- 200:

```json
{ "results": [
    { "id": "1", "title": "gato dançando",
      "preview": { "url": "https://static.klipy.com/a-small.gif", "w": 220, "h": 124 },
      "gif":     { "url": "https://static.klipy.com/a.gif",       "w": 480, "h": 270 } } ],
  "next": "24" }
```

  Só URLs `https://` com até 500 chars; `title` até 80 chars; 24 por página
  (`src/gifs.rs:23`, `156-197`).
- 404 `{"error":"off"}` quando o servidor não tem `GIF_API_KEY`; 503
  `{"error":"unavailable"}` quando a KLIPY não responde.
- A página descobre se GIFs existem com `HEAD /api/gifs?probe=1` e
  `status !== 404` (`static/common.js:471-479`). O axum responde HEAD com o
  mesmo handler do GET, então o "probe" faz de fato uma busca de "em alta"
  (que fica em cache 10 min).

---

## 3. WebSocket de sinalização

### 3.1 Conexão

- URL: `ws(s)://<host>/ws/<roomId>` (`static/room/sessao.js:121`). **Não há
  parâmetros de query**; nick, perfil etc. vão depois, pelo relay.
- ID de sala inválido → HTTP 400 `ID de sala inválido`, sem upgrade
  (`src/signaling.rs:53-55`).
- Tamanho máximo de uma mensagem: **64 KiB** (`src/signaling.rs:21`, `56`).
  Passar disso **derruba a conexão** (o `recv()` devolve erro, o servidor sai
  do loop e todos recebem `peer-left`; `src/signaling.rs:107`, `71-73`).
- Só frames de **texto** contam; binário, ping e pong são ignorados
  (`src/signaling.rs:108`).
- O servidor manda um **Ping a cada 25 s** (o primeiro tick é descartado;
  `src/signaling.rs:24`, `90-91`, `111`). O cliente precisa responder Pong
  (navegadores e tungstenite fazem sozinhos). O servidor não confere o Pong:
  o ping serve para os proxies (Fly.io) não matarem o socket ocioso.

### 3.2 Servidor → cliente

| `type` | Quando | Campos | Ref. |
|---|---|---|---|
| `welcome` | logo após entrar | `id` (seu número), `peers` (IDs já presentes), `max` | `src/signaling.rs:87-88` |
| `peer-joined` | alguém entrou depois de você | `id` | `src/rooms.rs:90` |
| `peer-left` | alguém saiu/caiu | `id` | `src/rooms.rs:143` |
| `signal` | outro participante mandou algo para você | `from`, `data` | `src/rooms.rs:119-121` |
| `full` | sala cheia (seguido de Close) | `max` | `src/signaling.rs:63-68` |

```json
{"type":"welcome","id":4,"peers":[1,3],"max":12}
{"type":"peer-joined","id":5}
{"type":"peer-left","id":3}
{"type":"signal","from":1,"data":{"chat":"bora"}}
{"type":"full","max":12}
```

- **IDs**: inteiros `u32` por sala, começando em 1 e sempre crescentes
  enquanto a sala existe; quando a sala esvazia ela é apagada e a numeração
  recomeça (`src/rooms.rs:77`, `137-139`). **O ID não é estável**: quem
  reconecta volta com um número novo.
- **Ordem garantida**: o `peer-joined` é enviado aos outros antes de o recém
  chegado receber o `welcome`, logo antes de qualquer oferta dele
  (`src/rooms.rs:88-90`). Por isso quem já estava sempre conhece o ID antes de
  receber um `signal` dele.
- A ordem de `peers` no `welcome` é a de iteração de um `HashMap`: **não é
  ordenada** (`src/rooms.rs:79-84`).
- Não existe mensagem de erro do servidor além de `full`; destinatário
  desconhecido é ignorado em silêncio (`src/rooms.rs:112-122`).
- Limite de pessoas: `MAX_PEERS` (padrão 12, mínimo 2; `src/rooms.rs:13`,
  `src/main.rs:112-119`). A página usa `max` para desenhar as "cadeiras".

### 3.3 Cliente → servidor

O servidor tenta, nesta ordem (`src/signaling.rs:95-104`):

1. **Relay** `{"to": <u32>, "data": <JSON>}` → entregue a `to` como `signal`.
2. **Presença** `{"presence": {"secret": "<64 hex>", "nick": "Rafa"}}` ou
   `{"presence": null}` (invisível / sem nick).
3. Qualquer outra coisa que não seja objeto JSON (ex.: `"texto"`) é ignorada.

```json
{"to":1,"data":{"description":{"type":"offer","sdp":"v=0..."}}}
{"presence":{"secret":"0123…cdef","nick":"Rafa"}}
{"presence":null}
```

Presença (`src/presence.rs`, `static/room/sessao.js:24-32`):

- Enviada no `welcome`, ao mudar o perfil e no evento `friends-changed`
  (amigos/invisível mudaram) (`static/room/sessao.js:20`, `32`, `201`).
- `null` quando invisível (`localStorage.invisible === '1'`) ou sem nick
  (`static/room/sessao.js:29`). Só é mandada se `crypto.subtle` existe
  (`static/amigos.js:16`).
- O servidor descarta `secret` que não seja 64 hex, limpa o nick (espaços
  colapsados, sem controle, **24 chars**) e guarda só em memória enquanto
  aquele socket estiver aberto (`src/presence.rs:38-60`, `84-109`).
- Nunca é repassada aos outros participantes.

### 3.4 Saída e reconexão (como o navegador faz)

- Sair: fecha o WebSocket; o servidor manda `peer-left` aos outros
  (`static/room/chat.js:147-156`, `src/signaling.rs:72-73`).
- Queda (`onclose` sem ter saído, `static/room/sessao.js:124-144`):
  1. Fecha **todas** as `RTCPeerConnection` (o servidor já mandou `peer-left`
     aos outros e eles fecharam as deles).
  2. `myId = null`; tenta de novo após `retryDelay`, que começa em 1 s e
     dobra até 30 s (`RETRY_MAX_MS`). O `welcome` zera o atraso.
  3. Volta como **participante novo** (ID novo, novas conexões com todos).
  4. O evento `online` do navegador e o botão "Tentar agora" tentam na hora
     com atraso 1 s (`static/room/sessao.js:175-190`).
- Sala cheia: o `onclose` vê `roomFull` e **não** reconecta
  (`static/room/sessao.js:127-132`).
- Estado local que sobrevive à reconexão: compartilhamento de tela, voz,
  câmera. Como `createPeer()` reenvia tudo para cada par novo
  (seção 4.1), os outros reaprendem o estado sozinhos. Quem assistia precisa
  clicar "Assistir" de novo (o `watch` não é reenviado).
- Uma aba por sala: Web Lock `friends-call-room:<roomId>`; a aba nova pode
  "roubar" e a antiga sai (`static/room/sessao.js:68-105`). O cliente nativo
  deve evitar entrar duas vezes na mesma sala (você apareceria duplicado).

---

## 4. Mensagens entre participantes (dentro do relay)

Tudo abaixo é o campo `data` de um `{"to":…, "data":…}`. Sempre um **objeto
JSON**, e o tipo é decidido pela **presença de uma chave**, não por um campo
`type`.

### 4.1 Despacho no receptor (a ordem importa)

`static/room/sessao.js:226-233` e `static/room/webrtc.js:140-220`:

1. Se `data` é objeto e tem a chave `nick` → **perfil**, tratado na hora (fora
   da fila).
2. Senão, entra na **fila por participante** (uma promise encadeada; cada
   passo espera o anterior, erros só vão para o console;
   `static/room/sessao.js:245-250`) e é tratado pelo **primeiro** teste que
   bater, nesta ordem:

| # | Chave testada | Teste | Tipo |
|---|---|---|---|
| 1 | `description` | truthy | SDP |
| 2 | `candidate` | truthy | ICE |
| 3 | `sharing` | `'sharing' in data` | estado da tela |
| 4 | `chat` | `in` | texto do chat |
| 5 | `reaction` | `in` | reação |
| 6 | `gif` | `in` | GIF no chat |
| 7 | `sound` | `in` | aviso de soundpad |
| 8 | `voice` | `in` | estado de voz |
| 9 | `bannerImage` | `in` | imagem do banner |
| 10 | `camera` | `in` | câmera ligada/desligada |
| 11 | `camWatch` | `in` | "quero/não quero sua câmera" |
| 12 | `restart` | `in` | pedido de ICE restart |
| 13 | `watching` | `in` | quem eu assisto (para a sala) |
| 14 | `watch` | `in` | "quero/não quero assistir sua tela" |

Consequências: **uma chave por mensagem** (as demais são ignoradas); nenhuma
mensagem que não seja perfil pode ter `nick`; chave desconhecida é ignorada
em silêncio (bom para extensões futuras).

Se chegar `signal` de um ID que o navegador não conhece, ele cria o par como
não iniciador (`static/room/sessao.js:227`).

### 4.2 Ao criar um par (os dois lados)

`createPeer()` (`static/room/webrtc.js:11-76`) roda para cada ID do `welcome`
(como **iniciador**) e para cada `peer-joined` (como **não iniciador**) e manda,
nesta ordem:

1. perfil (`profileMsg()`);
2. `bannerImage`, só se houver imagem;
3. `shareInfo()` se você está compartilhando;
4. `{watching:[...]}` se você assiste alguém;
5. `{voice:{...}}` se você está na voz;
6. `{camera:true}` se a câmera está ligada.

Ou seja: o estado é sempre "empurrado" para quem chega; ninguém pede.

### 4.3 Catálogo

#### Perfil — `{nick, photo, hwH264, banner}`

```json
{"nick":"Rafa","photo":"data:image/jpeg;base64,/9j/4AAQ…","hwH264":true,"banner":"#5E5CE6"}
```

| Campo | Envio | Validação no receptor |
|---|---|---|
| `nick` | string, já limpa (trim, até 32 code points) | `cleanNick`: `String(v).trim()`, 32 code points (`static/common.js:35-37`). Vazio → mostrado como "Participante N" (`static/room/sessao.js:34-36`) |
| `photo` | `''`, data URL ou URL de GIF | `validPhoto` (`static/common.js:59-64`): `data:image/(jpeg\|png\|webp);base64,…` com até **40 000** chars, ou GIF da KLIPY (`profileGif`: `https://<host klipy>/[A-Za-z0-9._~/-]+\.gif`, até 300 chars, host `klipy.com`/`klipy.co` ou subdomínio; `static/common.js:40-56`), ou GIF próprio (`ownGif`: `data:image/gif;base64,…` até 60 000 chars, GIF bem formado até 640×640 e 300 quadros). Senão `''` |
| `hwH264` | boolean | só `=== true` conta (`static/room/webrtc.js:255`) |
| `banner` | `''` ou cor | `validBannerColor`: `#rrggbb` (`static/common.js:90-92`) |

- Quem envia: `createPeer()` (`webrtc.js:67`) e `broadcastProfile()` ao editar o
  perfil (`static/room/sessao.js:15-22`; também quando outra aba edita,
  `sessao.js:60-66`).
- Efeitos no receptor: resolve `peer.profileKnown` (libera a oferta, seção 5.2)
  e, na primeira vez, escreve "Fulano entrou" no chat
  (`static/room/webrtc.js:252-263`).

#### Imagem do banner — `{bannerImage}`

```json
{"bannerImage":"data:image/jpeg;base64,/9j/…"}
{"bannerImage":""}
```

- Separada do perfil para foto + banner não passarem de 64 KB
  (`static/room/sessao.js:7-13`). `''` limpa (enviado sempre no
  `broadcastProfile`, só quando existe no `createPeer`).
- Validação: `validBannerImage` → `data:image/jpeg;base64,…` até **30 000**
  chars, ou GIF da KLIPY (`static/common.js:94-99`).

#### Tela — `{sharing, audio, mode, height, fps}` / `{sharing:false}`

```json
{"sharing":true,"audio":true,"mode":"jogo","height":720,"fps":30}
{"sharing":false}
```

- Enviado a **todos** ao começar (`compartilhar.js:491-492`), ao parar
  (`compartilhar.js:529-533`), quando o som da tela acaba
  (`compartilhar.js:475-481`) e a cada mudança de qualidade/ajuste automático,
  deduplicado (`broadcastShareInfo`, `compartilhar.js:84-95`).
- `height`/`fps` são os **limites atuais** do encoder (já com o ajuste
  automático e o degrau de 3+ espectadores), não a captura.
- `mode`: `"jogo"` (prioridade Fluidez) ou `"texto"` (Nitidez).
- Receptor (`webrtc.js:161-171`, `cleanShareInfo` em `webrtc.js:4-9`):
  `height` inteiro 1–4320, `fps` inteiro 1–240, `mode` mapeado para
  "Fluidez"/"Nitidez", senão `null`. `audio` só conta com `sharing` verdadeiro.
  `sharing:false` zera `iWatch` do receptor (uma nova transmissão começa sem
  ninguém assistindo). Transição falso→verdadeiro gera linha no chat e
  notificação.

#### Assistir — `{watch}` (espectador → quem compartilha)

```json
{"watch":true}
{"watch":false}
```

- Enviado ao clicar "Assistir"/"Parar de assistir" (`compartilhar.js:382-393`).
- Quem compartilha: `watchesMe = !!watch && !!localTrack` (pedido que cruzou
  com o fim da transmissão é ignorado) e faz `replaceTrack` do vídeo **e** do
  som da tela só para esse par (`webrtc.js:211-219`, `265-281`). Cruzar a
  marca de 3 espectadores muda os limites de todos (`retune`).
- Ao parar de compartilhar, o próprio sharer zera `watchesMe` de todos
  (`compartilhar.js:529-533`); não chega `watch:false`.

#### Quem eu assisto — `{watching:[ids]}` (para a sala toda)

```json
{"watching":[1,4]}
{"watching":[]}
```

- Lista ordenada dos IDs que você assiste **e** que estão compartilhando
  (`compartilhar.js:398-408`). Enviada a todos quando muda (é chamada em todo
  `refresh()`, `interface.js:383`) e no `createPeer` se não vazia.
- Receptor: só inteiros, no máximo 16 (`webrtc.js:206-210`). Serve para
  "assistindo Rafa" e as carinhas de quem assiste cada tela
  (`interface.js:84-87`, `361`).

#### Chat — `{chat}`

```json
{"chat":"alguém joga hoje? https://exemplo.com"}
```

- Mandado individualmente a cada par; o remetente mostra a própria mensagem
  localmente (`chat.js:118-126`).
- Validação: string, `trim`, até **500** code points; vazio é descartado
  (`chat.js:15-17`). Links `http(s)` viram âncoras; nunca HTML
  (`chat.js:44-58`). Só emoji (até `JUMBO_MAX`) aparece grande
  (`emojis.js:104-111`).
- Como vai pelo WebSocket, funciona mesmo quando o P2P falha.

#### GIF — `{gif:{url,w,h,title}}`

```json
{"gif":{"url":"https://static.klipy.com/a.gif","w":480,"h":270,"title":"gato dançando"}}
```

- `cleanGif` nos dois lados (`gifs.js:12-17`): `url` string ≤ 500 chars em
  host KLIPY via `https`; `w`/`h` inteiros 1–4096 (senão 0); `title` com
  espaços colapsados, até 80 chars. Inválido é descartado.
- O receptor carrega a imagem direto do CDN com `referrerPolicy: no-referrer`
  (`chat.js:89-97`).

#### Reação — `{reaction}`

```json
{"reaction":"🔥"}
```

- Só uma destas 12: `👍 👎 ❤️ 😂 😮 😢 👏 🔥 🎉 🙏 👀 🤔` (comparação exata de
  string, `❤️` inclui o U+FE0F) (`reacoes.js:7`).
- Remetente: no máximo uma a cada 250 ms. Receptor: ignora quem manda mais de
  uma a cada 150 ms (`reacoes.js:8-9`, `27-41`). Nada vai para o chat; só
  flutua na tela.

#### Soundpad — `{sound}`

```json
{"sound":"risada"}
```

- **Só um aviso**: o áudio em si vai misturado na faixa de voz
  (`soundpad.js:2-8`, `109-137`; mistura em `voz.js:70-87`). Enviado a todos
  ao tocar (exige estar na voz e não estar com "Fone" desligado).
- Receptor: string, espaços colapsados, até 24 chars; ignora quem manda mais
  de um a cada 400 ms; mostra como reação `🔊` com "Fulano: nome"
  (`soundpad.js:147-155`).

#### Voz — `{voice:{in, muted}}`

```json
{"voice":{"in":true,"muted":false}}
{"voice":{"in":false,"muted":false}}
```

- `in`: está no canal de voz. `muted`: mudo **ou** "Fone" desligado
  (`voz.js:62-64`). Push-to-talk **não** muda `muted` (só liga/desliga a
  faixa; `ptt.js`).
- Enviado a todos ao entrar/sair da voz, ao mutar e ao "ensurdecer"
  (`voz.js:66-68`, `165`, `183`, `201`, `211`) e no `createPeer` se na voz.
- Receptor (`webrtc.js:181-193`): `!!state.in`, `!!state.muted`; recalcula se
  manda a própria voz para esse par (`sendVoiceTo`) e se toca a dele.

#### Câmera — `{camera}` e `{camWatch}`

```json
{"camera":true}
{"camWatch":true}
```

- `camera` (dono → todos): ligou/desligou (`camera.js:78-81`, `91-94`; e no
  `createPeer`). O receptor guarda `camOn` e recalcula se quer ver
  (`webrtc.js:197-200`).
- `camWatch` (espectador → dono): "o seu cartão está visível na minha tela"
  (`camera.js:151-158`). Verdadeiro só se `camOn` **e** a aba está visível
  **e** o cartão está na tela (IntersectionObserver; desconhecido conta como
  visível). Enviado só quando muda.
- O dono faz `replaceTrack(câmera)` só para quem mandou `camWatch:true`
  (`camera.js:102-110`, `webrtc.js:201-203`).

#### ICE restart — `{restart:true}`

- Pedido do lado de **ID menor** para o de ID maior refazer a conexão
  (`compartilhar.js:263-274`). Quem recebe só age se `myId > peer.id`
  (`webrtc.js:204-205`).

#### SDP e ICE — `{description}` e `{candidate}`

```json
{"description":{"type":"offer","sdp":"v=0\r\no=- 46117… 2 IN IP4 127.0.0.1\r\n…"}}
{"description":{"type":"answer","sdp":"v=0\r\n…"}}
{"candidate":{"candidate":"candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag Ab3d network-cost 999","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"Ab3d"}}
```

- `description` é o `toJSON()` de `RTCSessionDescription` (`{type, sdp}`).
- `candidate` é o `toJSON()` de `RTCIceCandidate`
  (`{candidate, sdpMid, sdpMLineIndex, usernameFragment}`), passado direto a
  `addIceCandidate` (`webrtc.js:159-160`). Fim de candidatos (`null`) **não**
  é enviado (`webrtc.js:32-34`).

### 4.4 Resumo de quem manda o quê

| Mensagem | De → para | Gatilho |
|---|---|---|
| perfil | todos → todos | criar par, editar perfil |
| `bannerImage` | todos → todos | criar par (se houver), editar perfil |
| `description` offer | ID maior → ID menor | criar par como iniciador, ICE restart |
| `description` answer | ID menor → ID maior | ao receber oferta |
| `candidate` | ambos | trickle ICE |
| `sharing` | quem compartilha → todos | início, fim, mudança de limites/som |
| `watch` | espectador → quem compartilha | clicar Assistir/Parar |
| `watching` | todos → todos | lista mudou |
| `chat`, `gif`, `reaction`, `sound` | remetente → todos | ação do usuário |
| `voice` | todos → todos | entrar/sair/mutar/fone |
| `camera` | dono → todos | ligar/desligar câmera |
| `camWatch` | espectador → dono | cartão aparece/some |
| `restart` | ID menor → ID maior | "Tentar de novo" em conexão falha |

---

## 5. Negociação WebRTC

### 5.1 Uma conexão por par, configuração

- `new RTCPeerConnection({ iceServers })`, **sem** outras opções: bundle
  policy padrão (`balanced` no Chrome, mas o Chrome sempre oferece BUNDLE de
  todas as m-lines), `rtcpMuxPolicy` `require`, sem certificados próprios
  (`webrtc.js:12`).
- Sem data channel (nenhuma m-line `application`).

### 5.2 Quem oferece (não é perfect negotiation)

- **Quem chega oferece**: para cada ID do `welcome`, `createPeer(id, true)`;
  para `peer-joined`, `createPeer(id, false)` (`sessao.js:208`, `218`).
  Como os IDs só crescem, **o ofertante sempre tem o ID maior**.
- O não iniciador **nunca** cria oferta, a não ser num ICE restart, que também
  só é feito pelo ID maior (`compartilhar.js:272`, `webrtc.js:205`). Não há
  tratamento de colisão (sem `onnegotiationneeded`, sem rollback, sem
  polite/impolite). Uma oferta do lado errado quebraria a conexão.
- O iniciador **espera o perfil do outro** (para saber `hwH264`) até 3 s antes
  de ofertar (`webrtc.js:57-64`). Por isso o perfil é tratado fora da fila.
- `setLocalDescription()` sem argumento (oferta/resposta implícita) e o envio
  de `pc.localDescription`; candidatos vão depois, por trickle.

### 5.3 Transceivers: ordem e papéis

Criados pelo iniciador, todos `sendrecv`, **nesta ordem** (`webrtc.js:50-55`):

| m-line (mid no Chrome) | kind | Papel | Preenchido com |
|---|---|---|---|
| 0 | video | tela | `replaceTrack(tela)` só para quem mandou `watch:true` |
| 1 | audio | som da tela | `replaceTrack(som)` junto com a tela |
| 2 | audio | voz (mic + soundpad mixados) | só se **os dois** estão na voz |
| 3 | video | câmera | só para quem mandou `camWatch:true` |

- O respondente **não usa mid**: depois de aplicar a oferta, pega
  `getTransceivers()` e separa por `receiver.track.kind`, na ordem:
  1º vídeo = tela, 2º vídeo = câmera, 1º áudio = som da tela, 2º áudio = voz
  (`webrtc.js:144-158`). Também muda todos para `sendrecv` (transceivers
  criados por oferta remota nascem `recvonly`).
- Clientes antigos podem ter só 3 m-lines (sem câmera); o código tolera
  `camTransceiver` ausente (`webrtc.js:137`).
- Sem faixa, cada sender fica com `track = null` (m-line `sendrecv`, mas sem
  RTP). O receptor só vê o vídeo "mutado".
- No lado receptor, a tela e o som da tela vão no mesmo `MediaStream` de um
  `<video>` (`webrtc.js:133-135`); a voz vai num `<audio>` escondido por pessoa
  (`webrtc.js:122-130`). `msid`/stream IDs **não** são usados para nada.

### 5.4 Codecs

- Cada lado ordena a **sua** lista de preferências (`setCodecPreferences`)
  pelo que **o outro** codifica bem; o remetente usa o primeiro codec da lista
  do outro lado (`webrtc.js:78-116`):
  - H.264 primeiro só se o par anunciou `hwH264: true` e eu não sou Firefox;
    então VP8, depois o resto.
  - Senão VP8 primeiro, depois VP9/AV1/rtx/red/ulpfec, H.264 por último.
- Aplicado à tela e à câmera (as duas m-lines de vídeo), no iniciador antes da
  oferta e no respondente antes da resposta (`webrtc.js:60-61`, `153-154`).
- `hwH264` (`webrtc.js:85-99`): `mediaCapabilities.encodingInfo({type:'webrtc',
  video:{contentType:'video/H264', 1920x1080, 2.5 Mb/s, 30 fps}})` com
  `supported && powerEfficient`; Firefox sempre `false`. Calculado antes do
  primeiro `join()` (`sessao.js:120`).
- Áudio: Opus padrão do navegador (sem `setCodecPreferences`).

### 5.5 Mexidas no SDP recebido (`tuneDescription`)

Toda descrição **remota** é alterada antes do `setRemoteDescription`
(`webrtc.js:222-250`); isso só muda o que **nós** enviamos:

1. Opus: para cada `a=rtpmap:<pt> opus/48000/2`, a **primeira** linha
   `a=fmtp:<pt>` do SDP inteiro ganha `stereo=1;sprop-stereo=1;maxaveragebitrate=128000`
   (substituindo valores anteriores). Como o Chrome usa o mesmo PT (111) nas
   duas m-lines de áudio, na prática só o som da tela (a primeira) vira
   estéreo 128 kb/s; a voz fica mono padrão.
2. Vídeo: todo PT de `VP8|VP9|H264|AV1/90000` ganha
   `x-google-start-bitrate=1500` no `fmtp` (ou uma linha `fmtp` nova), para a
   imagem abrir nítida.

### 5.6 Parâmetros do encoder

**Tela** (`compartilhar.js:1-176`):

| Item | Valor |
|---|---|
| Qualidade escolhida | altura ∈ {480, 720, 1080, 1440}, FPS ∈ {15, 30, 60}, prioridade `motion` (Fluidez) ou `text` (Nitidez); presets Jogo 720p30, Jogo liso 1080p60, Texto 1080p15 |
| `contentHint` | `motion` ou `text` (vídeo); `music` no som da tela |
| `degradationPreference` | `maintain-framerate` (Fluidez) ou `maintain-resolution` (Nitidez), em `RTCRtpSendParameters`; se o navegador recusar, refaz sem |
| `encodings[0].maxBitrate` | `min(6 Mb/s, max(0,8 Mb/s, (h·16/9)·h·fps·0,09))` (720p30 ≈ 2,5 Mb/s) |
| `encodings[0].maxFramerate` | FPS atual |
| `encodings[0].scaleResolutionDownBy` | `max(1, alturaCapturada / alturaLimite)` |
| Captura | `getDisplayMedia({video:{frameRate:{ideal,max}, height:{max}}, audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, restrictOwnAudio:true, suppressLocalAudioPlayback:false}, systemAudio:'include'})` |
| Uma encoding | sem simulcast, sem SVC |

- Os parâmetros são aplicados em `tuneSender` ao conectar
  (`connectionState === 'connected'`, `webrtc.js:37-40`) e após cada
  `replaceTrack` com faixa.
- **Ajuste automático** (`compartilhar.js:42-143`): a cada 5 s lê
  `outbound-rtp.qualityLimitationReason` dos senders com faixa; 3 leituras
  seguidas com `cpu` (~15 s) descem um nível; 24 leituras calmas (~2 min)
  sobem um, no máximo enquanto houve menos de 2 quedas. Níveis
  (altura×, fps×): Fluidez `[1,1] [1,0.8] [0.75,0.8] [0.66,0.66]`, Nitidez
  `[1,1] [1,0.8] [1,0.66] [0.75,0.5]`; FPS mínimo 5.
- **3+ espectadores**: começa um nível abaixo (`currentCaps`,
  `compartilhar.js:76-80`).
- Toda mudança de limites é anunciada com um novo `sharing` (seção 4.3).

**Câmera** (`camera.js:10-130`):

| Perfil | Altura | FPS | `maxBitrate` |
|---|---|---|---|
| normal | 360 | 15 | 400 kb/s |
| leve (enquanto você compartilha a tela) | 240 | 12 | 250 kb/s |

`contentHint = 'motion'`, `scaleResolutionDownBy = max(1, capturada/alvo)`,
sem `degradationPreference`. Captura ideal 640x360@15.

**Voz** (`voz.js:38-87`): `getUserMedia` com `echoCancellation`,
`autoGainControl` e `noiseSuppression` (configurável); a faixa enviada é a
saída de um `MediaStreamDestination` (mic + soundpad), `contentHint='speech'`.
Mudo/PTT = `track.enabled = false` no mic (continua mandando silêncio; o
soundpad toca mesmo mudo).

### 5.7 Renegociação e ICE restart

- **Nada renegocia** depois da primeira oferta/resposta. Tela, som, voz e
  câmera entram e saem por `replaceTrack`; os parâmetros por `setParameters`.
- ICE restart: botão "Tentar de novo" num par com `connectionState ===
  'failed'`. ID maior: `createOffer({iceRestart:true})` →
  `setLocalDescription` → manda `description`. ID menor: manda
  `{restart:true}` e espera (`compartilhar.js:260-281`). Ao receber a nova
  oferta, o respondente refaz o caminho de resposta (inclusive
  `attachTransceiver`, que é idempotente para a câmera).
- Não há restart automático; não há timeout de conexão. Queda do WebSocket =
  recomeçar do zero (seção 3.4).

### 5.8 Estatísticas usadas na interface

| O quê | De onde | Frequência | Ref. |
|---|---|---|---|
| Ping (RTT) e barrinhas | `candidate-pair` com `selected` (ou `nominated && state==='succeeded'`) → `currentRoundTripTime`; 3 barras < 80 ms, 2 < 200 ms, 1 acima | 2 s com aba visível; 10 s enquanto compartilha (salvo tooltip aberto) | `rede.js:13-71` |
| "relay" vs "direto" | `report.get(pair.localCandidateId).candidateType === 'relay'` (só o candidato **local**) | junto com o ping | `rede.js:24`, `interface.js:188-191` |
| "sem P2P" / "falha na conexão" | `pc.connectionState === 'failed'` | a cada `refresh` | `interface.js:79-80`, `313` |
| "1080p · 30 fps" na tela assistida | `inbound-rtp.frameHeight` e `framesPerSecond` do receiver da tela | 2 s, só telas assistidas | `interface.js:398-410` |
| PC no limite | `outbound-rtp.qualityLimitationReason === 'cpu'` | 5 s, só enquanto compartilha | `compartilhar.js:131-143` |

Status textual por pessoa (`interface.js:78-93`): `failed` → "falha na
conexão", `disconnected` → "conexão instável", `connected` → compartilhando /
assistindo X / na voz / na sala, outros → "conectando…".

"Falando" (anel verde) é **local**: RMS > 0,02 do áudio recebido, segurando
300 ms; não há mensagem para isso (`voz.js:16-17`, `235-258`).

---

## 6. Como ser um bom cidadão na sala

O que o cliente nativo precisa replicar para os navegadores o enxergarem
igual a qualquer outro:

1. **Entrar**: `GET /api/ice` → abrir `/ws/<sala>` → no `welcome`, mandar a
   presença (se o usuário não estiver invisível) e criar um par como
   iniciador para cada ID; em `peer-joined`, criar como não iniciador.
2. **Ao criar cada par**, mandar o pacote completo (seção 4.2): perfil
   (com `hwH264` verdadeiro se o encoder for de hardware), `bannerImage`
   se houver, `sharing` se compartilhando, `watching`, `voice`, `camera`.
3. **Só o ID maior oferece**, com 4 m-lines na ordem vídeo/áudio/áudio/vídeo,
   todas `sendrecv`, depois de receber o perfil do outro (ou 3 s).
4. **Tela só para quem pediu**: anunciar `sharing` para todos, mas só
   codificar e enviar vídeo+som para quem mandou `watch:true`. Ninguém
   assistindo = zero encode (é o princípio "leve para quem joga").
5. **Respeitar os limites anunciados**: o `height`/`fps` do `sharing` deve
   bater com o que sai do encoder; reduzir com 3+ espectadores e quando a
   CPU/GPU não dá conta, e reanunciar.
6. **Voz só entre quem está na voz**: preencher a 3ª m-line só se você e o
   par têm `in: true`; mudo = silêncio na mesma faixa, não remover.
7. **Câmera sob demanda**: anunciar `camera`, enviar só para quem mandou
   `camWatch:true`; ao exibir câmeras dos outros, mandar `camWatch` só quando
   o cartão estiver visível e a janela não estiver minimizada.
8. **Avisar quem você assiste** (`watching`) sempre que a lista mudar, e
   `watch:true/false` para quem compartilha.
9. **Chat/GIF/reação**: um `send` por par; mostrar a própria mensagem
   localmente; validar tudo o que chega como o navegador valida (seção 4.3),
   inclusive só aceitar imagens `data:` ou GIFs da KLIPY (qualquer outra URL
   remota vazaria o IP de quem vê).
10. **Áudio da tela em estéreo 128 kb/s** e vídeo começando em ~1,5 Mb/s (o
    navegador faz isso mexendo no SDP; o nativo pode configurar direto).
11. **Reconectar** com backoff 1 s → 30 s, recomeçando todas as conexões, e
    não reconectar depois de `full`.
12. **Não entrar duas vezes** na mesma sala no mesmo aparelho.

---

## 7. Armadilhas para uma implementação fora do navegador

1. **Não há `type` nas mensagens P2P**: o tipo é a primeira chave conhecida
   na ordem da seção 4.1. Mandar `{"chat":"oi","nick":"x"}` vira perfil;
   `{"watching":[1],"watch":true}` só trata `watching`.
2. **Perfil = qualquer objeto com a chave `nick`**, e é tratado fora da fila.
   O resto respeita a ordem de chegada por par; se uma etapa falhar, só loga.
3. **Mandar `candidate` antes da `description`** faz o `addIceCandidate` do
   navegador falhar (sem descrição remota) e o candidato se perde. Sempre
   oferta/resposta primeiro, candidatos depois. Inclua `sdpMid` e/ou
   `sdpMLineIndex`: só `candidate` como string gera `TypeError`.
4. **O respondente mapeia transceivers pela ordem de kind**, não por `mid`
   nem `msid`. Se o nativo oferecer outra ordem (ex.: áudio antes de vídeo),
   ou m-lines a mais do mesmo kind, a voz vira som da tela e a câmera vira
   tela. Data channel extra não atrapalha o mapeamento, mas não é usado.
5. **Sem perfect negotiation**: oferta vinda do ID menor, ou duas ofertas ao
   mesmo tempo, não tem rollback. O nativo nunca deve renegociar (nada de
   `onnegotiationneeded`); adicionar uma faixa é `replaceTrack` no
   transceiver já negociado. Em webrtc-rs, cuidado para `add_track` não criar
   m-lines novas.
6. **Transceivers criados por oferta remota nascem `recvonly`**: o respondente
   precisa mudá-los para `sendrecv` antes da resposta, senão nunca poderá
   enviar tela/voz de volta sem renegociar.
7. **SDP remoto é editado pelo navegador**: o navegador vai mexer no SDP do
   nativo (stereo no primeiro `fmtp` de cada PT Opus;
   `x-google-start-bitrate` em todo PT de vídeo). Se o nativo usar **PTs
   diferentes** para Opus nas duas m-lines de áudio, as duas ficam estéreo
   128 kb/s, inclusive a voz. O SDP do nativo precisa ter linhas `a=rtpmap`
   no formato `opus/48000/2` e `VP8/90000` etc. para as regex baterem.
8. **Codecs**: o navegador põe H.264 em primeiro só se o perfil do nativo
   disser `hwH264: true` (exatamente `true`). Sem isso o nativo vai receber
   pedido de VP8 (e deveria mandar VP8 para os navegadores, que só preferem
   H.264 quando o **outro** lado anunciou hardware). Para H.264 vale o
   `profile-level-id`/`packetization-mode` que o navegador oferecer; o
   encoder nativo precisa produzir algo compatível (baseline/constrained
   baseline, packetization-mode 1 é o usual no Chrome).
9. **Perfil antes da oferta**: o navegador iniciador espera até 3 s pelo
   perfil. Se o nativo mandar o perfil tarde, a negociação atrasa e o codec
   pode sair errado (VP8 por falta de `hwH264`).
10. **64 KiB por mensagem derruba a conexão**, não só a mensagem: foto
    (≤ 40 000 chars) e banner (≤ 30 000) vão separados; um SDP com muitos
    codecs/extensões também conta. Validar antes de mandar.
11. **Qualquer JSON objeto que não seja um relay válido é lido como presença**
    (`src/signaling.rs:97-103`): `{}` ou `{"to":"1","data":…}` (to como
    string) ou `{"to":1}` sem `data` caem em `PresenceMsg` com
    `presence = None` e o servidor **apaga sua presença** (você fica
    invisível para os amigos). Sempre `to` numérico e `data` presente.
12. **Erros são silenciosos**: destinatário inexistente, mensagem malformada,
    JSON inválido. Não espere resposta do servidor para nada além de
    `welcome`/`full`.
13. **IDs não sobrevivem a reconexão** e voltam a 1 quando a sala esvazia.
    Preferências por pessoa (volume) são guardadas pelo **nick** em
    minúsculas, não pelo ID (`mixagem.js:18-26`).
14. **`peers` do `welcome` vem desordenado**; ordene se precisar.
15. **Ping a cada 25 s**: o cliente WebSocket precisa responder Pong (a maioria
    das bibliotecas faz sozinha); o servidor não derruba quem não responde,
    mas o proxy da Fly derruba sockets que ficam mudos.
16. **Sem `Origin`/cookies**: o servidor não exige nada no upgrade; mas o
    WebSocket é por sala e o ID da sala é o "segredo".
17. **"relay" olha só o candidato local**: se o outro lado está no TURN e você
    não, a interface mostra "direto". Replicar igual ou melhorar (olhar os dois
    candidatos) é decisão do nativo; não é protocolo.
18. **`sharing:false` encerra o "assistir"** dos dois lados sem mensagem
    `watch:false`; o sharer zera os espectadores sozinho. Uma nova transmissão
    começa sem ninguém assistindo, e o espectador precisa mandar `watch:true`
    de novo.
19. **`watch:true` com o sharer não compartilhando é ignorado**
    (`watchesMe = !!watch && !!localTrack`). Não reenviar automaticamente.
20. **A tela e o som da tela andam juntos**: o sharer troca as duas faixas ao
    mesmo tempo para o mesmo espectador. Som da tela que acaba antes da tela
    gera um novo `sharing` com `audio:false`.
21. **Câmera receptora "mutada"** (sem frames) é o sinal para mostrar o avatar;
    o nativo receptor deve tratar ausência de RTP como "câmera não está vindo",
    não como erro.
22. **Mudo continua enviando** (silêncio, faixa desabilitada): o navegador
    espera RTP contínuo na voz e decide "falando" pelo nível do áudio.
    Não use DTX/parar a faixa como sinal de mudo; o sinal é `voice.muted`.
23. **Limites de nick diferentes**: 32 code points no perfil P2P, 24 chars na
    presença do servidor.
24. **Presença exige nick**: sem nick a página manda `presence: null`.
25. **O soundpad não tem mídia própria**: o áudio vai misturado na faixa de
    voz; `{sound}` é só o aviso visual.
26. **Clientes antigos com 3 m-lines** (sem câmera) ainda são aceitos pelo
    código do navegador; um nativo respondente deve tolerar ofertas sem a 4ª
    m-line.
