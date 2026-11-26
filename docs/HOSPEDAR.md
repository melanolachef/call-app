# Hospedar o CPX Call

O servidor é um binário só, sem banco de dados. Ele precisa de quase nada:
256 MB de RAM bastam, porque o vídeo não passa por ele.

## No seu computador

Precisa do Rust ([rustup.rs](https://rustup.rs)).

```sh
cargo run --release
```

Abra http://localhost:3000.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `MAX_PEERS` | `12` | Pessoas por sala |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | (vazias) | TURN da Cloudflare, veja abaixo |
| `GIF_API_KEY` | (vazia) | Busca de GIFs no chat (KLIPY), veja abaixo |
| `GIF_API_BASE` | `https://api.klipy.com` | Outro serviço com a API no formato do Tenor |

Exemplo: `PORT=8080 MAX_PEERS=20 cargo run --release`. O arquivo
[.env.example](../.env.example) lista todas.

## Testar com mais gente

**No mesmo computador:** crie uma sala, clique em **Copiar convite** e abra o
link em outro navegador ou numa janela anônima (duas abas do mesmo navegador não
entram na mesma sala). Compartilhe *outra* janela ou aba para não criar o efeito
de espelho infinito.

**Em outros computadores:** o servidor escuta em `0.0.0.0`, então na mesma rede
dá para abrir `http://<IP-do-servidor>:3000/room/<id>`. Mas **os navegadores só
liberam compartilhar a tela, microfone e câmera em HTTPS ou `localhost`**: por
HTTP pela rede, a pessoa só consegue assistir. Opções:

- **Túnel HTTPS** (funciona também pela internet): `cloudflared tunnel --url http://localhost:3000` (ou ngrok). Use o link `https://…` que ele mostrar.
- **Só para teste na rede local, no Chrome:** em `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, adicione `http://<IP>:3000` e reinicie o navegador.

## No Fly.io

O projeto já vem com [Dockerfile](../Dockerfile) e [fly.toml](../fly.toml)
(região São Paulo, uma máquina sempre ligada, porque as salas ficam em memória).
O Fly.io dá um endereço `https://<nome>.fly.dev` com HTTPS, então não precisa de
domínio para começar.

```sh
fly auth signup                      # ou: fly auth login
fly apps create <nome-unico>         # e troque `app = "..."` no fly.toml por esse nome
fly deploy
```

Para mudar o limite de pessoas: `fly secrets set MAX_PEERS=20` (ou edite `[env]`
no `fly.toml`). Logs: `fly logs`.

## TURN (recomendado)

Sem TURN, quem está em VPN, 4G ou rede de empresa pode não conseguir conectar.
Crie uma chave em **Cloudflare › Realtime › TURN Server** (1.000 GB/mês grátis) e
configure:

```sh
fly secrets set TURN_KEY_ID=<id da chave> TURN_KEY_API_TOKEN=<token da chave>
```

O servidor gera credenciais temporárias (24 h) pela API da Cloudflare e as
entrega só para quem entrou numa sala, na mensagem de boas-vindas do
WebSocket (`GET /api/ice` responde só STUN); a chave nunca vai para o
navegador. Rodando localmente, as mesmas variáveis funcionam.

Mesmo assim, quem entra numa sala recebe uma credencial que vale 24 h e poderia
usá-la fora do app. Para não ter surpresa na conta, crie um **alerta de
gastos** na Cloudflare (Notifications, billing/usage) antes de pôr a chave.

## GIFs no chat (opcional)

O painel de emojis ganha uma aba **GIFs** quando o servidor tem uma chave do
[KLIPY](https://klipy.com/developers) (o Tenor encerrou a API pública em junho de
2026). Crie a chave no painel de parceiros do KLIPY (a de teste permite 100
chamadas por hora; para mais, peça a de produção no mesmo painel) e configure:

```sh
fly secrets set GIF_API_KEY=<sua chave>
```

As buscas passam pelo servidor (`GET /api/gifs?q=…`): a chave fica nele, o
serviço de GIFs não vê quem busca, e as respostas ficam alguns minutos na
memória para gastar pouco da cota. Os GIFs em si carregam do CDN do KLIPY.
Sem a chave, a aba simplesmente não aparece.

## App para Windows apontando para o seu servidor

O app abre `https://cpx-call.fly.dev` por padrão. Para outro endereço, rode-o
com `CPX_URL` (veja [APP-WINDOWS.md](APP-WINDOWS.md)) ou troque `frontendDist`
e a lista `remote.urls` em [desktop/](../desktop/) e gere o seu instalador.
