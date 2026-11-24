# Contas (opcionais) e amizades

Plano das issues #156 a #159. Conta é **opcional**: quem só recebeu um link
entra como sempre, sem login. A conta dá um @usuário, a lista de amigos em
qualquer aparelho e, nas próximas fases, presença (online, em call, invisível).

## O que muda no princípio "o servidor não guarda nada"

Com contas ligadas, o servidor guarda num SQLite (`DATABASE_PATH`, num volume
do Fly):

| Tabela | O que tem | O que **não** tem |
|---|---|---|
| `users` | id interno, identificador opaco da conta Google (`sub`), @usuário, nome que aparece, data de criação | e-mail, nome do Google, foto do Google, IP |
| `sessions` | hash SHA-256 do token de sessão, a quem pertence, criação, último uso | o token em si |

Continua sem guardar: mensagens, salas, quem esteve em qual sala, vídeo, voz.
"Apagar conta" apaga a linha do usuário e, em cascata, sessões (e, na fase 2,
amizades). Sessões sem uso por um ano são apagadas ao iniciar o servidor.

## Login com Google (fase 1)

Fluxo de código no servidor, escopo só `openid`:

1. `GET /auth/google?volta=/room/x` guarda um `state` aleatório em cookie e
   manda para o seletor de contas do Google.
2. O Google volta em `/auth/google/callback?code&state`. O servidor confere o
   `state`, troca o código no endpoint de token do Google (HTTPS, com o
   segredo do cliente) e lê o `sub` do ID token, conferindo emissor,
   audiência e validade. A assinatura não precisa ser checada porque o token
   veio direto do Google por TLS (OpenID Connect Core, 3.1.3.7).
3. Cria a conta se for a primeira vez, cria a sessão (cookie `cpx_sessao`,
   HttpOnly, SameSite=Lax, Secure em produção) e volta para a página.
4. Sem @usuário ainda, a página abre "Escolha seu @usuário".

APIs: `GET /api/me` (404 com contas desligadas, 401 sem sessão),
`POST /api/me {username?, nick?}`, `DELETE /api/me`, `POST /auth/sair {todos?}`.
POST/DELETE só aceitam JSON: um formulário de outro site não consegue mandar
isso sem o navegador perguntar antes (proteção contra CSRF), e o cookie é
SameSite=Lax.

@usuário: 3 a 20 caracteres, letras minúsculas, números e `_`, começando com
letra; único sem diferenciar maiúsculas; alguns nomes reservados.

## Próximas fases

- **2 (#157) Amizades:** pedido por @usuário (busca exata, ninguém é listado),
  aceitar, recusar, remover, link de convite. Os códigos de amigo atuais
  continuam para quem não tem conta.
- **3 (#158) Presença:** uma conexão leve aberta também no Início; amigos veem
  online, em qual sala, ou nada (invisível). Só em memória.
- **4 (#159) Perfil na conta:** foto, banner e nick sincronizados entre aparelhos.

Antes de abrir para o público: limites contra abuso (#149) e as páginas de
termos e privacidade (#152), que precisam dizer exatamente o que está acima.

## Configurar

1. **Google Cloud Console** › APIs e serviços › Tela de consentimento OAuth:
   tipo Externo, nome "CPX Call", escopos só `openid`. Depois em Credenciais ›
   Criar credenciais › ID do cliente OAuth › Aplicativo da Web, com os URIs de
   redirecionamento autorizados:
   - `https://cpx-call.fly.dev/auth/google/callback`
   - `http://localhost:3001/auth/google/callback` (para testar local)
2. **Fly:** criar o volume antes do deploy que traz o `[mounts]` do `fly.toml`:
   `fly volumes create dados --size 1 --region gru`
3. **Segredos:** `fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...`
   (`DATABASE_PATH` e `PUBLIC_URL` já estão no `fly.toml`).
4. **Backup:** o Fly tira snapshots diários do volume (guardados por 5 dias);
   `fly volumes snapshots list`.

Local: `DATABASE_PATH=./contas.db GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
PUBLIC_URL=http://localhost:3001 PORT=3001 cargo run`.
