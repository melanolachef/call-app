# Política de assinatura de código

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## O que é assinado

Só o instalador do app para Windows, `CPX-Call-Windows.exe`, publicado nos
[releases](https://github.com/melanolachef/call-app/releases) deste repositório.

## Como os binários são gerados

- Todo binário assinado é compilado pelo GitHub Actions, no workflow
  [app-windows.yml](.github/workflows/app-windows.yml), a partir do código
  público deste repositório. Nenhum binário compilado em máquina pessoal é assinado.
- Só tags `app-v*` criadas na branch `main` geram releases assinados.

## Papéis

| Papel | Quem |
|---|---|
| Committers e revisores | [Colaboradores do repositório](https://github.com/melanolachef/call-app/graphs/contributors); toda mudança entra por PR revisado ([CONTRIBUTING.md](CONTRIBUTING.md)) |
| Aprovadores | [@melanolachef](https://github.com/melanolachef) (mantenedor), que aprova cada pedido de assinatura |

Todo membro com acesso de escrita precisa usar autenticação em dois fatores no GitHub.

## Privacidade

O app não envia nenhuma informação para outros sistemas além do servidor do
CPX Call que a pessoa escolhe usar (por padrão, [cpx-call.fly.dev](https://cpx-call.fly.dev)),
e do STUN/TURN usado para conectar as chamadas. O servidor não guarda contas,
mensagens nem registros de quem entrou; veja [O servidor não guarda nada](README.md#o-servidor-não-guarda-nada).
