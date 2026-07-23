# Nova, robustecida para produção: governança, exatamente-uma-vez e dados conectados

> O lançamento de robustez: políticas de conformidade com bloqueio absoluto, permissões por papel, delegação de ausência, idempotência durável exatamente-uma-vez, travas de exclusão, segredos de conectores criptografados, conectores que os agentes descobrem como ferramentas MCP e uma camada de dados conectados — tudo o que você precisa para deixar a Nova rodando sem supervisão, para uma equipe.

*Source: https://mynova.space/pt-br/blog/governance-hardening/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Construir automações é uma coisa; deixá-las rodando — para uma equipe, com dinheiro de verdade — é outra. Este lançamento é sobre essa segunda coisa: limites rígidos que se mantêm mesmo quando você aprova, permissões e delegação, garantias de exatamente-uma-vez, segredos criptografados e um jeito de a Nova ler os dados sobre os quais o seu negócio de fato roda.

Jake Belieny · 22 de julho de 2026 · 8 min de leitura

Os últimos lançamentos deram alcance à Nova: uma base de conhecimento, automações orientadas a eventos, playbooks, processos duráveis, conectores, ROI. Este dá a ela **contenção e rigor** — as garantias sem glamour que transformam "demo impressionante" em "você pode deixar rodando para a sua equipe". Cada peça é aditiva: sem nada configurado, a Nova se comporta exatamente como antes.

**A versão de uma linha** Limites rígidos que se mantêm mesmo quando você aprova, permissões por papel, delegação de ausência, idempotência exatamente-uma-vez, travas contra disparo duplo, segredos criptografados, conectores que os agentes descobrem como ferramentas MCP e uma camada de dados somente leitura para os sistemas sobre os quais o seu negócio roda.

## Limites rígidos que se mantêm — mesmo quando você aprova

A etapa de aprovação da Nova sempre foi a âncora de confiança: o trabalho consequente espera pelo seu sim. Mas algumas regras não deveriam poder ser dispensadas por uma pessoa. Se a política diz que os dados pessoais (PII) de clientes nunca saem de casa, um aprovador clicando em "aprovar" rápido demais não deveria poder passar por cima disso.

Então agora as políticas de conformidade têm um **bloqueio absoluto** de verdade. Uma verificação de conteúdo configurada para *bloquear* é imposta na fronteira de execução contra a saída realmente preparada — depois da aprovação, no caminho do piloto automático, em todo lugar. Se ela dispara, nada é enviado, e a Nova te diz o porquê. *Avisar* ainda só sinaliza; *bloquear* genuinamente interrompe.

## Quem pode fazer o quê — e quem te cobre quando você está fora

Uma Nova de uma pessoa e uma Nova de equipe precisam de controles diferentes. Dois chegam aqui:

#### Permissões por papel

Admins podem fazer tudo. Membros recebem capacidades delimitadas — gerenciar automações, políticas, conectores, playbooks — para que você decida quem pode mudar o quê. Concedidas com `nova access grant @teammate automation.manage` ou `/access`.

#### Delegação de ausência

Vai viajar? `/ooo @teammate` e as suas atribuições e aprovações são roteadas para essa pessoa até você voltar — uma cadeia protegida contra ciclos, encerrada com `/ooo off`.

## As garantias chatas que importam

Automação que reage ao mundo sem supervisão vive ou morre por três propriedades sem glamour:

- **Exatamente-uma-vez.** Webhooks são retentados; um evento de pagamento pode chegar duas vezes. Uma automação pode optar por idempotência durável (`--idempotent`) para que dispare uma vez e apenas uma — não de novo uma hora depois quando o remetente retenta.

- **Sem disparo duplo.** Travas de exclusão (advisory locks) agora envolvem o poller de automações e o despachante de tarefas, para que dois ticks sobrepostos — ou duas instâncias em duas máquinas — nunca processem o mesmo trabalho duas vezes.

- **Segredos criptografados.** As credenciais de conectores são armazenadas criptografadas em repouso com `AES-256-GCM` e definidas com `nova connector set stripe STRIPE_API_KEY=…`, com uma auditoria de rotação — chega de chaves de API vivas paradas em um `.env` em texto puro.

## Conectores que os agentes conseguem de fato usar — sem o inchaço

A Nova conduz suas integrações através do **mcp2cli**, uma escolha deliberada: em vez de enfiar o esquema completo de cada ferramenta no prompt de um agente (o que infla o contexto e o custo), os agentes *descobrem* as ferramentas em tempo de execução — listam, perguntam pelos parâmetros de uma ferramenta e então a chamam. Isso mantém o prompt enxuto por mais ferramentas que existam.

Os conectores agora seguem exatamente esse idioma. Um agente roda `nova connector describe stripe` para conhecer suas ações e parâmetros sob demanda, e então `nova connector run …` para chamar uma delas — lendo livremente, e propondo qualquer escrita (um reembolso, um novo registro) para a sua aprovação em vez de fazê-la sozinho. Adicionar um conector não faz o prompt crescer; a descoberta faz o trabalho. É a diferença entre entregar a alguém um manual de 200 páginas e dizer onde o manual está.

## Ler os dados sobre os quais o seu negócio roda

A análise é só tão boa quanto os dados que ela consegue alcançar. A nova **camada de dados conectados** deixa você registrar as fontes onde os seus números de fato vivem e consultá-las — somente leitura, por definição:

#### HTTP

Qualquer endpoint JSON ou CSV — a URL de um relatório, uma API interna.

#### SQLite

Um `SELECT` somente leitura contra um arquivo de banco de dados — analytics, exportações, um data warehouse local.

#### Conector

Uma ação de leitura de conector — puxe pedidos, cobranças ou tickets direto.

Registre uma vez com `nova data add`, e então consulte a partir do terminal, do chat (`/data query sales`), de um agente no meio de uma tarefa, ou em um cronograma para um relatório recorrente. Sem novas dependências, sem warehouse necessário.

## Ainda a mesma promessa, só que mais robusta

Nada disso muda o que a Nova é — torna-a algo em que você pode confiar com mais. A etapa de aprovação continua de pé; agora há limites que nem ela pode cruzar, permissões sobre quem os define, garantias de que o trabalho roda uma vez e de forma limpa, e alcance sobre os dados e sistemas dos quais o seu negócio depende. A demo cresceu e virou algo que você pode de fato deixar rodando.
