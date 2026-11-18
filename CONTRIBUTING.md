# Como contribuir

Obrigado pelo interesse! O projeto aceita contribuições, mas **toda mudança passa
pela revisão e aprovação do mantenedor** antes de entrar.

## Fluxo

1. **Comece por uma issue.** Escolha uma aberta ou abra uma nova (há modelos para
   [problema](.github/ISSUE_TEMPLATE/problema.yml) e [ideia](.github/ISSUE_TEMPLATE/ideia.yml)).
   Para mudanças grandes, espere um "ok" na issue antes de programar.
2. **Faça um fork** e crie a sua branch a partir de `development`:
   - `feat/<nome>` para funcionalidades
   - `fix/<nome>` para correções
   - `chore/<nome>` para manutenção, documentação e CI
3. **Abra o PR para `development`** (nunca para `main`), citando a issue (`Closes #N`).
4. O mantenedor revisa. O PR só é mergeado depois da aprovação dele. Ninguém faz
   push direto em `main` ou `development`.
5. A `main` só recebe código por PR vindo da `development`, também aprovado pelo mantenedor.

## Ambiente

- **Rust** estável ([rustup.rs](https://rustup.rs)). No Windows, também as
  *Build Tools* do Visual Studio com C++.
- **Node** (opcional), só para checar a sintaxe dos scripts: `node --check static/room/*.js`.

```sh
cargo run --release      # servidor em http://localhost:3000
```

O código está explicado em [docs/ARQUITETURA.md](docs/ARQUITETURA.md), com o
mapa de arquivos, o protocolo e as decisões técnicas. O app para Windows tem o
seu próprio guia em [docs/APP-WINDOWS.md](docs/APP-WINDOWS.md).

## Antes de abrir o PR

```sh
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Mexeu no app para Windows? Rode os mesmos três comandos dentro de `desktop/`.
O [CI](.github/workflows/ci.yml) roda tudo isso em todo PR.

Teste no navegador também: rode `cargo run --release`, abra a mesma sala em dois
navegadores (ou numa janela anônima) e confira o que você mudou, também numa
tela estreita (celular). Conte no PR como testou.

## Princípios do projeto

- **Simples e leve:** HTML e JavaScript puros, sem framework nem bundler, e o
  mínimo de dependências em Rust. Uma dependência nova precisa de justificativa no PR.
- **O servidor não guarda nada:** ele só repassa a sinalização e o chat. Nada de
  banco de dados, logs com dados pessoais ou mídia passando pelo servidor sem
  discussão prévia numa issue.
- **Leve para quem joga:** mudanças que aumentem o uso de CPU ou GPU de quem
  compartilha precisam de cuidado extra.
- **Visual:** siga o design em [docs/design/](docs/design/) e os tokens de
  [static/common.css](static/common.css).

## Segurança

Achou uma vulnerabilidade? **Não abra uma issue pública.** Veja o [SECURITY.md](SECURITY.md).
