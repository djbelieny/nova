# Agora a Nova fala todos os modelos

> Um lote de melhorias: execute qualquer modelo compatível com OpenAI ao lado das CLIs da sua assinatura, um comando nova de verdade com nova connect, canais no terminal + Discord e convites de equipe self-service — sem tocar no modelo de confiança auto-hospedado e com etapas de aprovação.

*Source: https://mynova.space/pt-br/blog/whats-new/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Um lote de melhorias torna a Nova mais flexível e mais fácil de conviver — qualquer modelo, uma CLI de verdade, mais lugares para conversar com ela e acesso de equipe self-service — sem mudar o que ela é.

Jake Belieny · 20 de julho de 2026 · 6 min de leitura

A Nova sempre foi um time de IA auto-hospedado e com etapas de aprovação que você executa na sua própria máquina. Este lançamento não mexe em nada disso. O que ele faz é alargar as portas: mais modelos podem conduzir seus agentes, finalmente há um comando de verdade para executá-los, você pode conversar com a Nova a partir de mais lugares, e adicionar um colega de equipe não significa mais editar arquivos de configuração.

Quatro temas: **qualquer modelo**, **uma CLI de verdade**, **mais lugares para conversar com ela**, e **configuração e acesso de equipe mais fáceis**. Nada disso muda o modelo de confiança — a Nova ainda pergunta antes de qualquer coisa ser enviada ou gasta.

## Use qualquer modelo — sem perder a vantagem da assinatura

A Nova já roda nas suas **assinaturas** do Claude, Gemini e Codex conduzindo as CLIs deles diretamente. Esse é todo o truque por trás da sua economia: um custo mensal fixo em vez de uma conta de API medida, e uso agêntico completo de ferramentas — o mesmo plano que você já paga, posto para trabalhar por um time de agentes.

Agora você pode adicionar **qualquer modelo compatível com OpenAI** ao lado deles — uma rota do [OpenRouter](https://openrouter.ai), um modelo da OpenAI, ou uma máquina local com `Ollama` ou `vLLM` na sua própria rede. Adicione um com uma única entrada em `config/providers.json`, com `nova providers add`, ou com um clique no painel Models do dashboard. As CLIs de assinatura continuam sendo o padrão e continuam em primeiro lugar; novos modelos se encaixam ao lado delas.

E modelos de API não são cidadãos de segunda classe. Eles também podem usar suas ferramentas — conduzindo o mesmíssimo sandbox e a mesma ponte MCP que as CLIs usam — então um agente em um modelo local ainda pode navegar, escrever arquivos e chamar integrações sob as mesmas etapas de aprovação.

**Uma linha de princípio** A Nova continua **conduzindo as CLIs oficiais** em vez de coletar tokens da assinatura para acessar endpoints privados. É isso que mantém sua assinatura solidamente dentro dos termos — e qualquer novo modelo que você adiciona usa sua própria chave de API adequada, não uma emprestada.

## Um comando `nova` de verdade

Chega de lembrar `bun run isto, bun run aquilo`. Agora existe uma única CLI `nova`, instalada no seu PATH, que é a porta de entrada para tudo:

- `nova start` — sobe a sua Nova.

- `nova doctor` — verificação de saúde e diagnósticos copiáveis.

- `nova update` — baixa a versão mais recente e reinstala.

- `nova providers add` — conecta um novo modelo.

- `nova invite` — gera um código para adicionar um colega de equipe.

O destaque é **`nova connect`** — um cliente de terminal que se conecta à sua Nova *em execução*, esteja ela neste laptop ou no seu VPS. Você tem uma visão ao vivo do que seus agentes estão fazendo neste exato momento, e pode **aprovar, alterar ou cancelar** de forma embutida sem sair do terminal. Como a Nova roda sempre ativa, você pode entrar nela a partir de qualquer terminal, em qualquer lugar, e retomar exatamente de onde as coisas estão.

## Novos lugares para conversar com a Nova

A Nova já era multicanal — Telegram, WhatsApp e Slack alimentam todos o mesmo pipeline. Este lançamento adiciona mais dois:

- Seu **terminal** — `nova chat` te dá uma conversa completa com a Nova direto no shell.

- **Discord** — execute a Nova como um bot do Discord para você ou sua comunidade.

Ambos são apenas novos adaptadores sobre o padrão existente: o mesmo pipeline de mensagens, a mesma classificação, a mesma execução em duas fases, as mesmas etapas de aprovação. Uma solicitação que você faz no Discord é tratada exatamente como uma que você enviaria no Telegram — nada sobre como a Nova decide ou age muda com a superfície.

## Configuração mais fácil, e adicionar sua equipe

Agora você pode gerenciar modelos, canais e convites a partir do **dashboard** ou da **CLI** — sem editar configuração à mão para ativar algo. Ligue um canal, adicione um modelo, emita um convite, tudo a partir de uma tela ou de um único comando.

Adicionar um colega de equipe costumava significar caçar um ID de usuário numérico e colá-lo em um arquivo. Agora você gera um **código de convite** com `nova invite`, entrega à pessoa, e ela o resgata no Telegram ou no Discord — você aprova com um toque. Os papéis vêm junto: `nova invite member` ou `nova invite admin`.

**Os segredos ficam no lugar** Nada disso move suas credenciais para fora do seu servidor. As telas de gerenciamento mostram apenas quais chaves estão *definidas* — nunca seus valores. Suas chaves nunca saem da máquina em que você executa a Nova.

## Ainda a mesma Nova

Tudo que fazia a Nova digna de confiança permanece intocado. Ela continua auto-hospedada e licenciada sob MIT. Ela ainda roda nas suas chaves e na sua máquina. E ela ainda pede sua aprovação antes de qualquer coisa ser publicada, enviada ou gasta.

Essas melhorias adicionam alcance e acabamento — mais modelos, um comando de verdade, mais canais, convites self-service — sem tocar no modelo de confiança por baixo. O mesmo time, mais portas.
