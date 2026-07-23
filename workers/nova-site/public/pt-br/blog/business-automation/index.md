# Agora a Nova toca a operação: playbooks, automações e conectores

> O maior lançamento da Nova a torna orientada a eventos e durável em processos: playbooks (POPs reutilizáveis), automações por evento com gatilhos semânticos, processos duráveis de vários dias, extração de documentos, conectores de negócio (Stripe/Shopify/Zendesk/HubSpot), políticas de conformidade e relatórios de ROI — com cada passo consequente ainda passando pela aprovação.

*Source: https://mynova.space/pt-br/blog/business-automation/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Um chatbot responde. Um negócio precisa que o trabalho aconteça — em um cronograma, em resposta a eventos, ao longo de dias, com um rastro documentado. O maior lançamento da Nova a transforma de uma assistente que você consulta em um sistema que toca o trabalho repetível em segundo plano — e ainda pergunta antes que qualquer coisa seja publicada, gaste ou envie.

Jake Belieny · 21 de julho de 2026 · 9 min de leitura

Por um tempo, a Nova foi muito boa naquilo que você pede para ela fazer *agora mesmo*: decompor uma solicitação, roteá-la a especialistas, preparar o trabalho e esperar a sua aprovação antes que qualquer coisa entre no ar. Isso é a assistente. Mas um negócio não roda sobre solicitações — ele roda sobre **trabalho repetível** que acontece em um cronograma, reage a eventos, se estende por dias e deixa um rastro documentado.

Este lançamento fecha essa lacuna. Agora a Nova é **orientada a eventos e durável em processos** — uma camada inteira para construir, executar e observar operações automatizadas. E ela chega sobre o mesmo princípio de todo o resto: a metade segura roda livremente; a metade consequente ainda pergunta.

**A versão de uma linha** Escreva um processo uma vez e execute-o muitas vezes; dispare fluxos de trabalho a partir de eventos do mundo real; mantenha processos de vários dias em movimento; extraia dados estruturados de documentos; leia e escreva nas suas ferramentas de negócio; coloque proteções sobre gastos e conformidade; e veja o valor que tudo isso entrega — auto-hospedado, nas suas chaves.

## O que chegou

#### Playbooks

POPs reutilizáveis — escreva um processo uma vez, execute-o muitas vezes com variáveis.

#### Automações

Evento → condição → fluxo de trabalho, com deduplicação, limites de taxa e gatilhos semânticos.

#### Processos duráveis

Fluxos de vários dias que esperam por um temporizador ou um evento e então retomam — sobrevivendo a reinicializações.

#### Extração de documentos

Faturas, recibos e formulários → dados estruturados e validados.

#### Conectores

Stripe, Shopify, Zendesk, HubSpot — leitura e escrita, nos dois sentidos.

#### Políticas

Limites de gasto, matrizes de aprovação e verificações de conteúdo — proteções que só restringem.

#### Relatórios de ROI

Tarefas automatizadas, horas economizadas e valor vs. custo — por departamento e agente.

#### Operar e observar

Um feed de atividade unificado, prévias de simulação e uma fila de mensagens não entregues para falhas.

## Playbooks: seus processos, escritos e executáveis

Todo negócio tem um conjunto de processos "como fazemos X" — integrar um cliente, tratar um reembolso, lançar um produto. Um **playbook** é esse processo, tornado executável: alguns passos ordenados, cada um atribuído a um especialista, com variáveis que você preenche na hora da execução. Escreva uma vez; execute quando quiser, com entradas diferentes.

Os playbooks são pessoais ou de toda a equipe, e são versionados — editar avança uma versão, para que uma automação possa fixar aquela contra a qual foi construída. A Nova vem com uma biblioteca inicial que você pode clonar e editar.

## Automações: quando algo acontece, faça o trabalho

A maior mudança é que agora a Nova **reage**. Uma automação tem uma origem (um webhook de entrada, uma métrica cruzando um limite ou um evento de negócio como um novo pagamento no Stripe), condições opcionais e uma ação — executar um agente ou executar um playbook. Um novo lead chega, um pagamento falha, um formulário entra — a Nova capta e faz a próxima coisa, através da mesma etapa de aprovação.

- **Condições** filtram por campos (`amount > 1000`, remetentes VIP e assim por diante), com deduplicação por hora e limites de taxa para que uma origem barulhenta não te inunde.

- **Gatilhos semânticos** vão além: disparam pelo *significado*, não por correspondências exatas. "Quando um e-mail soa como uma reclamação" ou "parece um cancelamento" — reconhecido com as mesmas incorporações locais que alimentam a base de conhecimento.

## Processos: para o trabalho que se estende por dias

Algumas coisas não terminam em uma execução: *envie o contrato → espere por uma assinatura → fature → espere pelo pagamento → cumpra.* Um **processo durável** é uma sequência de passos de ação e espera que sobrevive a reinicializações e retoma em um temporizador vencido ou em um evento nomeado. A Nova guarda o estado, espera pacientemente e retoma exatamente de onde parou — sem emaranhado de cron, sem fios perdidos.

## Extração: transforme documentos em dados

A base de conhecimento era sobre *recuperação* — pergunte e a Nova responde a partir do seu material. A extração é a imagem espelhada: **captura**. Defina os campos que te importam e a Nova extrai um JSON limpo e com tipos verificados de um PDF, um DOCX ou um formulário digitalizado — número da fatura, total, data de vencimento, itens de linha — validado e pronto para enviar a uma planilha ou ao seu CRM. Solte um documento no chat com "extract as invoice", ou conecte-o a uma automação para que toda fatura que chega se arquive sozinha.

## Conectores: Nova, conheça a sua stack

A automação tem que viver onde o seu negócio já roda. Agora a Nova conversa com sistemas externos através de uma camada de **conectores** fina e uniforme, com quatro embutidos e bidirecionais: **Stripe** (cobranças, clientes, reembolsos), **Shopify** (pedidos), **Zendesk** (tickets) e **HubSpot** (contatos). Cada um traz ações de leitura e escrita além de um gatilho que alimenta automações — então `stripe.payment` ou `shopify.order` pode iniciar um fluxo de trabalho. Adicionar o seu próprio é um único arquivo.

## Políticas: proteções que só apertam

Entregar trabalho a um sistema autônomo só é confortável se você puder delimitá-lo. As políticas ficam sobre a escada de autonomia conquistada da Nova e são **apenas restritivas** — elas podem exigir aprovação, bloquear ou avisar, mas nunca conceder mais liberdade do que a escada já permite. Defina um limite mensal de gasto por departamento, roteie certas ações para um aprovador nomeado com um tempo limite de escalonamento, ou escaneie conteúdo de saída em busca de PII antes que ele seja enviado. Sem nenhuma política definida, nada muda.

## ROI: prove que está funcionando

Uma automação que você não consegue medir é uma automação que você eventualmente vai desligar. Quando um agente conclui algo quantificável, ele marca o resultado; a Nova consolida isso contra o seu próprio registro de custos nos números que importam — **tarefas automatizadas, horas economizadas e dólares influenciados versus o que a IA custou**, detalhados por departamento e agente. Um resumo semanal chega no seu chat, e o painel mostra a tendência.

## Feita para ficar rodando

Reagir ao mundo sem supervisão eleva o padrão de operabilidade, então este lançamento também traz as partes chatas e essenciais:

- **Simulação (dry-run).** Veja exatamente o que uma automação faria contra um evento de amostra antes de ativá-la. Ela não executa nada — você apenas vê a decisão.

- **Um feed de atividade unificado.** Todo disparo de automação, transição de processo e execução de playbook em uma única linha do tempo — no chat, na CLI ou no painel.

- **Retentativas + uma fila de mensagens não entregues.** Um envio que falhou é retentado com espera progressiva; se ainda assim falhar, ele vai para uma fila que você pode inspecionar e retentar, em vez de desaparecer.

E os próprios agentes agora podem usar essas capacidades enquanto trabalham — buscando na sua base de conhecimento, extraindo um documento, executando um conector configurado — usando ações de leitura livremente e **propondo qualquer coisa consequente para a sua aprovação** em vez de fazê-la por conta própria.

## Ainda a mesma promessa

Nada disso afrouxa o modelo de confiança — ele o estende. Todo passo consequente que uma automação, processo ou playbook dá ainda flui por preparar → aprovar → executar. A diferença é que agora o *gatilho* pode ser um evento, um cronograma ou uma assinatura, em vez de apenas uma mensagem que você digitou. A Nova cresceu de algo com que você conversa para algo que toca a sua operação — e ainda pergunta primeiro.
