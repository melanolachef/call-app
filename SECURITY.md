# Segurança

## Como reportar

**Não abra uma issue pública.** Use **[Report a vulnerability](https://github.com/melanolachef/call-app/security/advisories/new)**
na aba *Security* do repositório. O reporte fica privado entre você e o mantenedor
até a correção sair.

Conte o que encontrou, como reproduzir e o impacto que você imagina. A resposta
inicial costuma sair em alguns dias.

## Versões cobertas

Só a versão em produção ([cpx-call.fly.dev](https://cpx-call.fly.dev)) e o
[release mais recente](https://github.com/melanolachef/call-app/releases/latest)
do app para Windows recebem correções.

## O que está no escopo

- O servidor (`src/`): sinalização, salas, `/api/*`.
- As páginas (`static/`): por exemplo, conteúdo de outra pessoa (nick, foto,
  chat) executando código ou vazando dados.
- O app para Windows (`desktop/`): o gancho de teclado e a ponte entre a página
  e o app.

Problemas das redes de cada pessoa (NAT, VPN) e do WebRTC dos navegadores estão
fora do escopo.
