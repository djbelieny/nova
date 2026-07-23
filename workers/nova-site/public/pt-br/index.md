# Nova

> Nova é uma plataforma de IA auto-hospedada e de código aberto: 24 agentes especialistas, uma base de conhecimento que você alimenta, automações orientadas a eventos, playbooks, processos duráveis, conectores de negócios e aprovação humana antes de qualquer coisa ser publicada, gasta ou enviada — do Telegram ao seu terminal.

*Source: https://mynova.space/pt-br/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova são 24 agentes especialistas mais uma camada de automação que reage a eventos — webhooks, métricas, eventos de conectores — e executa em segundo plano o trabalho repetível: playbooks, processos duráveis, uma base de conhecimento que você alimenta. Acesse pelo Telegram, Slack, Discord ou seu terminal; rode nas suas próprias assinaturas de modelos e na sua própria máquina. Ela prepara livremente e depois pergunta antes de qualquer coisa ser publicada, gasta ou enviada.

## Cada requisição passa pelo mesmo pipeline honesto.

Sem roteador mágico, sem caixa preta. Seja como uma mensagem que você envia ou um evento que dispara uma automação, uma requisição é classificada, decomposta se for grande, e executada em duas fases — com a metade consequente protegida por você.

01 · classificar

### Três camadas, mais barato primeiro

Mensagens curtas passam direto para o modelo. Requisições repetidas acertam um cache de padrões de planos que funcionaram. Apenas perguntas genuinamente novas e complexas pagam pela classificação LLM.

02 · decompor

### Subtarefas com dependências

Requisições complexas viram um plano: subtarefas, ordem de dependência e um agente especialista para cada. Ramos independentes executam em paralelo.

03 · preparar → aprovar → executar

### Trabalho seguro primeiro, depois a etapa de aprovação

Pesquisa, rascunhos e imagens acontecem livremente. Publicação, envio e gastos esperam pelo cartão de aprovação — Aprovar, Revisar ou Cancelar, do seu chat.

## Construído como se lidasse com suas credenciais — porque lida.

Nova se conecta ao seu email, calendário, CRM e contas de anúncios. A postura de segurança leva isso a sério.

- aprovação →**Execução em duas fases.** Ações consequentes são separadas das seguras e protegidas por aprovação explícita, por categoria, por usuário.

- local →**Seus dados ficam em casa.** Mensagens, memória e tarefas vivem em SQLite local com isolamento por usuário. Embeddings são computados na sua máquina.

- criptografado →**Credenciais em repouso.** Tokens OAuth são criptografados com AES-256-GCM; assinaturas de webhook verificadas; sessões de dashboard autenticadas.

- seus →**Suas chaves, seus modelos.** Roteia entre CLIs Claude, Gemini e Codex em suas próprias contas, com fallback de limite de taxa.

- governado →**Proteções para um negócio.** Limites de gastos, matrizes de aprovação e verificações de PII; permissões baseadas em função; segredos criptografados; e um registro de auditoria de cada ação consequente.

## Agora ela conduz a operação, não apenas o chat.

Nova é orientada a eventos e resistente a processos: alimente-a com seu conhecimento, conecte-a às suas ferramentas e deixe-a rodar o trabalho repetível em segundo plano — cada passo consequente ainda passando pela mesma etapa de aprovação.

Segundo cérebroAlimente com PDFs, docs & URLs — recuperados com citações, incorporados na sua máquina
 PlaybooksEscreva um SOP uma vez, execute muitas vezes com variáveis
 AutomaçõesEvento → condição → fluxo de trabalho, incluindo gatilhos semânticos
 Processos duráveisFluxos de vários dias que esperam por um cronômetro ou uma assinatura, depois retomam
 Extração de documentosFaturas & formulários → dados estruturados e validados
 ConectoresStripe, Shopify, Zendesk, HubSpot — leitura & escrita, bidirecional
 PolíticasLimites de gastos, matrizes de aprovação, verificações de PII — proteções que só adicionam atrito
 Relatórios de ROITarefas automatizadas, horas economizadas, valor vs. custo — por departamento

## 24 especialistas. Um chat.

Cada agente tem seu próprio prompt de sistema, ferramentas, skills e acesso MCP — um time funcional focado em marketing e operações, e totalmente seu para editar. Adicionar um agente é escrever um arquivo markdown.

HeliosPublicidade paga
 PixelRedes sociais
 KaiRedação de conteúdo
 OrionEmail marketing
 MorpheusConteúdo de vídeo
 ArchitectDesenvolvimento web
 AthenaEstratégia empresarial
 DigitAnálise de dados
 EchoAtendimento ao cliente
 FluxEngenharia de funil
 QuillRedação de subsídios
 LexJurídico & conformidade
 HeliaRelações públicas
 BridgeParcerias
 OraclePrevisão de tendências
 CipherCiência de dados
 RiftCibersegurança
 JouleAutomação de fluxo de trabalho
 NexusConstrução de comunidade
 AuraVoz da marca
 ZenProdutividade
 TesseractPensamento sistêmico
 MagnusSEO
 CyraOtimização de site

## Convoque uma reunião do conselho quando a pergunta é grande o suficiente.

Uma camada distribuída opcional: sete nós executivos, cada um com sua própria persona de raciocínio, deliberando sobre um banco de dados compartilhado. Análise independente, uma pré-morte adversarial, então opções sintetizadas com pontuações de confiança — você escolhe, ela executa.

/board devemos mudar para precificação baseada em uso?

CEOPensamento Day-1, flywheels, obsessão pelo clientevisão de longo prazo
 CFOEconomia unitária e disciplina de preçoseficiência de capital
 CMONotável sobre incremental; tribos sobre funispúblico & marca
 CTOTudo falha; projete para issoarquitetura & confiabilidade
 COORastreamento de execução, caça a gargalostransforma decisões em trabalho
 ResearchTeoria de agregação, economia de plataformainteligência de mercado
 CriticInversão e pré-morte; análise apenasmantém todos honestos

## Baterias incluídas, nada trancado.

### Qualquer modelo, sem aprisionamento

Rode nas suas assinaturas do Claude, Gemini ou Codex via suas CLIs, ou adicione qualquer modelo compatível com OpenAI — OpenRouter, OpenAI, Ollama ou vLLM local — com um único comando. Assinatura primeiro, suas chaves.

### Uma CLI nova de verdade

Um único comando `nova` roda tudo, e `nova connect` te coloca dentro da sua Nova em execução a partir de qualquer terminal — local ou VPS — com atividade dos agentes ao vivo e aprovações inline.

### Base de conhecimento (RAG)

Alimente com PDFs, docs e URLs — fragmentados e incorporados na sua máquina, recuperados por todos os agentes com citações de fontes. Pessoal, de equipe ou por agente.

### Memória persistente

Fatos, metas e tarefas com busca de vetor local — Nova se lembra entre conversas e injeta o contexto certo.

### Aprendizado & cache de padrões

Planos bem-sucedidos são cacheados e reutilizados; vitórias comprovadas são promovidas a skills aprendidas ao longo do tempo.

### Agendador & serviços proativos

Briefings matinais, check-ins inteligentes, tarefas recorrentes e condicionais — funciona enquanto você não.

### Integrações & conectores

Servidores MCP (Notion, Google Workspace, Playwright, Cloudflare, GoHighLevel) mais conectores de negócios bidirecionais — Stripe, Shopify, Zendesk, HubSpot — com credenciais por usuário.

### mcp2cli — ferramentas sem o imposto de contexto

Os agentes descobrem ferramentas sob demanda a partir do shell em vez de carregar cada schema no prompt, então o conjunto de ferramentas cresce sem inchar o contexto. As próprias capacidades da Nova funcionam da mesma forma.

### Dados conectados

Consulte os sistemas onde seus números vivem — um endpoint HTTP, um arquivo SQLite somente leitura ou um conector — para relatórios e para os agentes no meio de uma tarefa.

### Governança & auditoria

Escada de autonomia conquistada, limites de gastos e matrizes de aprovação, permissões baseadas em função, segredos criptografados e um registro completo de ações com relatórios de ROI.

### 45 skills

Geração de imagem, criação de DOCX/XLSX/PPTX/PDF, redação de pesquisa, extração de anúncios — invocados por agentes conforme necessário.

### Voz

Chamadas de entrada e saída via Twilio; mensagens de voz transcritas com Groq ou Whisper local.

## Funcionando em uma linha.

$ curl -fsSL https://mynova.space/install | bash

Uma linha clona o Nova, configura o [Bun](https://bun.sh) e a CLI do [Claude Code](https://claude.ai/claude-code) para você e, em seguida, um assistente guiado conecta o Telegram e seu provedor de IA — sem editar arquivos, e ele detecta seu ID de usuário do Telegram automaticamente. Tudo o que você precisa antes é um token de bot do @BotFather. Prefere cloná-lo você mesmo? `git clone https://github.com/djbelieny/nova && cd nova && bash bootstrap.sh`. Todo o resto é opcional e está documentado no repositório.

## Quer o Nova — sem a configuração?

Nem todo mundo tem tempo — ou um engenheiro de sobra — para montar o próprio time de IA. Se você quer o Nova funcionando no seu negócio mas não quer construí-lo por conta própria, trabalhe diretamente comigo: **configuração feita para você**, **consultoria & assessoria** e **agentes & integrações personalizados** construídos em torno de como você realmente trabalha. Trabalhos pagos, dimensionados ao que você precisa.

Agendado diretamente comigo, Jake Belieny.
