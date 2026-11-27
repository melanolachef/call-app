# App para Windows

O app abre a mesma sala do site numa janela própria e faz o que o navegador não
consegue: a **tecla de falar**, o **Ctrl+Shift+M** (microfone) e o **Ctrl+Shift+D** (fone) funcionam com o jogo em
primeiro plano.

- **Download:** [CPX-Call-Windows.exe](https://github.com/melanolachef/call-app/releases/latest/download/CPX-Call-Windows.exe) (sempre a versão mais nova), também no botão **Baixar app para Windows** do início, que só aparece no Windows.
- **Instalação:** só para o seu usuário, sem pedir administrador. Usa o WebView2 que já vem no Windows 10 e 11, então o instalador tem cerca de 2 MB.

## Como funciona

O app é feito em Rust com [Tauri 2](https://tauri.app), em [desktop/](../desktop/).
A janela carrega o site, então toda mudança na página chega sem atualizar o app.

Para os atalhos, a página diz ao app qual tecla vigiar (comando `set_ptt_key`).
Um gancho de teclado do Windows (`WH_KEYBOARD_LL`) **observa** só essa tecla e o
Ctrl+Shift+M e Ctrl+Shift+D, sem consumir nenhuma (o jogo continua recebendo), e descarta todas
as outras ali mesmo. Quando a própria janela do app está na frente, o gancho fica
quieto e a página cuida das teclas.

A barra de título é desenhada pela página (no fim de `static/theme.js`), para
seguir o tema e o fundo, com o nome no centro. O app começa com a barra do
Windows e só a tira quando a página pede (comando `window_control`, que também
minimiza, maximiza, fecha e arrasta). Se o site não carregar, a janela continua
com a barra normal; um app antigo não conhece o comando e a página não desenha a
dela, então nunca aparecem duas barras.

A página só pode chamar esses dois comandos do app: a permissão fica em
[desktop/capabilities/remote.json](../desktop/capabilities/remote.json), restrita
aos endereços do CPX Call.

## Desenvolver

```sh
cargo run --release                         # o servidor, em outro terminal
cd desktop
CPX_URL=http://localhost:3000 cargo run     # PowerShell: $env:CPX_URL="http://localhost:3000"; cargo run
```

Para inspecionar a página dentro do app, clique com o botão direito ›
**Inspecionar** (só no build de desenvolvimento).

Para gerar o instalador localmente:

```sh
cargo install tauri-cli --version "^2" --locked
cd desktop
cargo tauri build      # target/release/bundle/nsis/CPX Call_<versão>_x64-setup.exe
```

## Publicar uma versão

1. Suba a versão em [desktop/tauri.conf.json](../desktop/tauri.conf.json) e [desktop/Cargo.toml](../desktop/Cargo.toml).
2. Depois do merge na `main`, crie a tag:
   ```sh
   git tag -a app-v0.2.0 origin/main -m "CPX Call para Windows 0.2.0"
   git push origin app-v0.2.0
   ```
3. O workflow [app-windows.yml](../.github/workflows/app-windows.yml) compila,
   assina (quando a assinatura estiver configurada) e publica o release com
   `CPX-Call-Windows.exe`. O link de download nunca muda.

Rodar o workflow pela aba **Actions** (sem tag) só gera o instalador como
artefato, para testar antes de publicar.

## Atualização automática

Ao abrir, o app procura uma versão nova em
`releases/latest/download/latest.json`. Se tiver, a página mostra **Nova versão
do app · Reiniciar e atualizar**: o app baixa o instalador, confere a
assinatura, instala sem assistente e reabre. As páginas não dependem disso (o
app carrega o site); só a parte nativa (atalhos, barra de título, links) pede
instalador novo.

A assinatura do atualizador é **separada** da SignPath e liga cada instalador
à sua versão (`requireSignedVersion`), para ninguém empurrar uma versão antiga
como se fosse nova. Para ligar, uma vez:

1. No Windows, com o `tauri-cli`: `cargo tauri signer generate -w %USERPROFILE%\.tauri\cpx-call.key`
   (guarde o arquivo e a senha: sem eles, não dá para publicar atualizações).
2. Em **Settings › Secrets and variables › Actions** do repositório:

   | Tipo | Nome | Valor |
   |---|---|---|
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | conteúdo do arquivo `cpx-call.key` |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | a senha |
   | Variable | `TAURI_UPDATER_PUBKEY` | conteúdo do arquivo `cpx-call.key.pub` |

Sem esses três, o workflow publica o instalador como antes e o app não procura
atualização. Quem está numa versão sem atualizador baixa a próxima à mão uma
última vez; dali em diante, atualiza sozinho.

## Assinatura

O instalador é assinado gratuitamente pela [SignPath Foundation](https://signpath.org),
conforme a [política de assinatura](../CODE_SIGNING_POLICY.md). Enquanto o
projeto não for aprovado, ou a configuração abaixo não existir, o workflow
publica o instalador sem assinatura.

Configuração no repositório (**Settings › Secrets and variables › Actions**):

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | Token de API de um usuário *submitter* na SignPath |
| Variable | `SIGNPATH_ORGANIZATION_ID` | ID da organização na SignPath |
| Variable | `SIGNPATH_PROJECT_SLUG` | Slug do projeto (ex.: `call-app`) |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |

Mesmo assinado, o SmartScreen do Windows pode avisar nas primeiras versões até o
certificado ganhar reputação com os downloads.
