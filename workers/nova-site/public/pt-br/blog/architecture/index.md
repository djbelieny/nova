# Como Nova funciona: a arquitetura sob o capô

> Uma análise técnica profunda da arquitetura de Nova: classificação de mensagens em 3 camadas, decomposição de tarefas com resolução de dependências, execução paralela, portas de aprovação em duas fases, SQLite dividido com busca de vetores e roteamento inteligente de IA entre Claude, Gemini e Codex.

*Source: https://mynova.space/pt-br/blog/architecture/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

O poder de Nova vem de como ela pensa, não apenas do que pode fazer. Aqui está um passo a passo técnico do pipeline que transforma uma mensagem do Telegram em trabalho coordenado entre 24 agentes especialistas, como ela aprende com padrões e por que pede antes de agir.

Jake Belieny · 15 de julho de 2026 · 13 min de leitura

Um chatbot tradicional pega sua mensagem e a passa direto para um LLM. Nova toma uma rota mais longa e inteligente. Cada mensagem é **classificada** em um de três buckets, cada um tratado de forma diferente. As coisas simples permanecem rápidas. O trabalho focado é roteado para um especialista. Problemas grandes e decomponíveis são divididos em subtarefas e executados em paralelo. E nada consequente acontece até você dizer.

É um pipeline, não uma caixa preta. Em cada estágio — classificação, decomposição, execução — o sistema toma uma decisão deliberada. Você pode ler o código. Pode alterá-lo.

## Como Nova decide o que fazer com sua mensagem

Quando você envia uma mensagem, Nova não imediatamente pede ao Claude para raciocinar sobre ela. Em vez disso, usa um **sistema de classificação de 3 camadas** projetado para manter o máximo de solicitações possível fora do LLM totalmente.

### Camada 1: A heurística (instantânea, custo zero)

Mensagens com menos de 15 palavras sem verbos de ação recebem uma resposta direta do Claude. "Que horas são?" permanece instantâneo. Isso captura buscas rápidas, verificações de status e perguntas casuais — o tipo onde a sobrecarga de roteamento seria tola.

### Camada 2: Correspondência de padrão e roteamento de agente único

Nova lembra decomposições de tarefas bem-sucedidas. Se você pediu "rascunhe um boletim" semana passada e obteve um plano que funcionou, e você pede algo semelhante hoje, Nova reutiliza esse mesmo plano sem re-executar o LLM. Para novas solicitações, Nova faz correspondência de padrão contra templates de tarefas conhecidas — coisas como "post em redes sociais", "campanha de e-mail", "artigo de blog", "criatividade de anúncio" — e as roteia direto para o agente especialista certo.

### Camada 3: Classificação de LLM (apenas quando necessário)

Tudo o mais vai para Claude Sonnet, que a classifica como simples (resposta direta), roteada (agente único) ou complexa (decompor e paralelizar). Isso acontece uma vez por tipo único de solicitação e depois é armazenado em cache.

**O resultado** Mensagens simples são respondidas sem uma chamada LLM. Tarefas repetidas reutilizam um plano armazenado em cache. Apenas solicitações genuinamente novas pagam por uma chamada de classificação — e cada uma se torna um padrão que torna a próxima solicitação semelhante mais rápida.

## Dividindo trabalho complexo em pedaços independentes

Quando você pede a Nova algo grande — "planeje e lance nossa campanha Q3" — o planejador assume. Ele divide a solicitação em subtarefas, descobre dependências e executa tudo que pode acontecer em paralelo.

Alguns dos fluxos de trabalho mais complexos de Nova são **pipelines determinísticos**, não gerados por LLM a cada vez. Uma campanha de redes sociais sempre segue o mesmo formato: pesquisa → conteúdo → imagem → visualização → publicar. Um post de blog é sempre pesquisa → escrever → imagem principal → visualização → publicar. Isso significa que você obtém um processo previsível e reproduzível para trabalho que faz repetidamente.

Para solicitações verdadeiramente novas, o LLM decompõe a tarefa. Retorna JSON: uma matriz de subtarefas, cada uma com uma descrição, qual agente deve tratá-la e quais outras tarefas depende. As dependências são resolvidas e depois as subtarefas independentes são executadas ao mesmo tempo.

## Duas fases: preparar primeiro, pedir permissão e depois executar

O momento em que uma tarefa toca o mundo real — publicar um post, enviar um e-mail, gastar dinheiro — precisa de aprovação. Nova implementa isso como duas fases distintas.

**Preparar** é a metade segura. Pesquisar, escrever o conteúdo, gerar imagens, executar análise. Os artefatos fluem de subtarefa para subtarefa. Tudo é reversível ou pelo menos reembolsável. Esta fase produz um resumo e artefatos, enviados a você no Telegram com três botões: Aprovar, Revisar ou Cancelar.

**Executar** só funciona depois que você toca Aprovar. Publica, envia, cria, gasta — tudo o que é irreversível. Mas executa com contexto completo da preparação: o conteúdo já está escrito, a imagem já está gerada, o tempo já está planejado.

Usuários que executam a mesma tarefa semanalmente podem eventualmente **conquistar autonomia**. Depois de poucas execuções limpas de "enviar o boletim", o sistema pode promovê-la: primeiro para "enviar e notificá-lo depois", depois para "enviar autonomamente até um orçamento de $50". Uma rejeição e volta a pedir. Você está sempre no controle de quanto de corda cada tarefa recebe.

## Como Nova armazena o que sabe

Nova usa uma **arquitetura SQLite dividida**: um banco de dados compartilhado para o próprio estado de Nova e um banco de dados por usuário para tudo privado a esse usuário.

#### Banco de dados compartilhado

Contas de usuário, rastreamento de custos, logs, fatos globais, estado de serviço. Uma instância por implantação de Nova.

#### Banco de dados por usuário

Mensagens, memória pessoal, tarefas de agentes, aprovações, trabalho agendado, padrões de execução. Fica em sua máquina.

Ambos usam `sqlite-vec` para busca de vetores. Todo fato, toda memória, toda mensagem é incorporada com `all-MiniLM-L6-v2` (384 dimensões). Quando o planejador precisa de contexto — "o que sabemos sobre estratégia de preço?" — faz uma busca semântica em vez de correspondência de palavras-chave. Isso significa que Nova pode encontrar contexto relevante mesmo quando você não usa as mesmas palavras exatas.

Embeddings são baratos para calcular localmente e os resultados de pesquisa são armazenados em cache. Seus dados nunca saem de sua máquina. Suas chaves, sua assinatura, seu banco de dados.

## Escolhendo a IA certa para o trabalho

Nova pode rotear trabalho para Claude, Gemini, Codex ou Groq. A decisão acontece automaticamente usando **roteamento inteligente**: força de substituição (você prefixar com `/claude` ou `/gemini`) vence seu padrão. Seu padrão vence roteamento baseado em dicas. Baseado em dicas vence fallback de limite de taxa.

A lógica de roteamento considera o tipo de tarefa. Trabalho pesado de MCP (gerenciar docs do Notion, eventos do Calendário, Gmail) roteia para Claude por causa de seu suporte MCP nativo. Pesquisa e síntese web vão para Gemini por causa de seu nível gratuito e síntese forte. Classificação rápida vai para qualquer provedor que tenha o modelo rápido mais barato.

Cada provedor tem três camadas: `fast` (classificação, barato), `standard` (execução de tarefas, equilibrado) e `premium` (raciocínio crítico, melhor qualidade). O roteador escolhe a camada com base na criticidade da tarefa.

## Os blocos de construção: padrões, memória e integrações

### Aprendizado de padrão

Cada execução de tarefa bem-sucedida é registrada como um padrão. Na próxima vez que você pedir algo semelhante, Nova pontua sua solicitação contra esses padrões por sobreposição de palavras-chave. Quando uma solicitação corresponde muito bem a um plano anterior que já tem duas ou mais execuções limpas, Nova o reutiliza. Isso transforma tarefas repetidas em ações de uma etapa — e um padrão que continua tendo sucesso é eventualmente promovido a uma habilidade reutilizável.

### Memória persistente

Nova incorpora tudo que você pede para lembrar. Use `[REMEMBER: fact]` em uma resposta e ela salva o fato, desduplicando contra a memória existente e o disponibiliza para busca semântica em todas as futuras solicitações. Você também pode definir `[GOAL: text | DEADLINE: date]` para rastrear objetivos e Nova o lembrará do progresso e impedimentos.

### 12 integrações de MCP

Nova é fornecida pré-configurada com Notion, Google Workspace (Gmail, Calendário, Drive, Docs, Sheets), Playwright, Cloudflare Workers, Zoom, Square, ClickUp, GoHighLevel, Firecrawl, Tavily, Exa e Browserbase. Cada agente pode acessar os relevantes para seu domínio. Você fornece as credenciais uma vez durante a configuração e elas ficam em sua máquina.

### Trabalho agendado e proativo

Nova pode executar tarefas conforme agendado: briefings diários, relatórios semanais, auditorias mensais. Ela aprende seus padrões — quando você tem mais probabilidade de querer notícias, quais relatórios são mais importantes, quais membros da equipe incluir — e toma iniciativa. Um briefing matinal não é apenas "aqui está seu calendário", é "aqui está seu calendário mais os três e-mails mais importantes mais sua prioridade principal para hoje com base em seus objetivos".

## O conselho executivo: estratégia em escala

Para as maiores decisões, Nova executa uma **reunião do conselho**. Sete executivos — CEO, CFO, CMO, CTO, COO, Chefe de Pesquisa e Crítico — cada um com uma persona distinta e agentes prioritários, convocam sua questão estratégica.

A reunião segue um fluxo estruturado: cada executivo analisa independentemente a questão, o Crítico identifica modos de falha e dá um GO/NÃO VÁ, depois Nova sintetiza 3–5 opções classificadas por confiança. Você escolhe uma, a decisão é registrada no registro e o time executivo delega trabalho autônomo com base na decisão através do orquestrador principal de Nova.

Os executivos usam diferentes provedores de IA (Claude para estratégia, Gemini para análise, Codex para profundidade técnica) e coordenam através de um banco de dados compartilhado. Cada nó executivo funciona independentemente em seu próprio VPS, permitindo escalar através de trabalho ilimitado sem um gargalo central.

## Por que essa arquitetura?

O design de Nova torna cinco coisas possíveis:

- **Velocidade** — muitas mensagens nunca tocam um LLM. Heurísticas e padrões em cache mantêm o caminho rápido rápido.

- **Eficiência de custo** — Cada rota escolhe o modelo mais barato adequado para a tarefa. Camadas rápidas para classificação, padrão para execução, premium apenas quando o raciocínio é importante.

- **Paralelismo** — Subtarefas independentes são executadas simultaneamente. Uma campanha de 10 etapas não leva 10 vezes o tempo; muitas etapas desabam em 2–3 lotes.

- **Auditabilidade** — Cada decisão é registrada. Você pode ver por que Nova roteou para um agente, quais foram as dependências, se usou um padrão em cache ou chamou o LLM.

- **Controle** — Execução em duas fases significa que o trabalho consequente para pela aprovação. Padrões e escalada de autonomia significam que você gradualmente confia em mais trabalho para executar sem supervisão conforme o sistema se prova.
