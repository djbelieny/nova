# Por que Nova é construído assim

> A filosofia por trás da arquitetura do Nova: por que um organograma em vez de um chatbot, por que confiança é engineered, por que autonomia deve ser conquistada, e por que sandbox e auditabilidade são não-negociáveis.

*Source: https://mynova.space/pt-br/blog/design-decisions/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Oito decisões de design que tornam Nova confiável, autônomo e verdadeiramente seu. A filosofia por trás de cada escolha, desde arquitetura até autonomia até auditabilidade.

Jake Belieny · 15 de julho de 2026 · 12 min de leitura

Construir um sistema que pode agir em seu nome não é a mesma coisa que construir um sistema que funciona bem. A forma do Nova vem de sete anos pensando sobre a diferença. Este ensaio descreve por que cada peça está lá e que problema resolve — e onde escolhi um bom design sobre outro melhor, porque "melhor" teria tornado a plataforma inutilizável.

## Um organograma, não um chatbot

A primeira decisão: Nova não é um modelo jogando o papel de todo trabalho. São 24 especialistas, cada um com um domínio, um playbook e ferramentas dedicadas. Algumas pessoas vêem e perguntam: isso não é só roteamento? Você não ainda precisa do motor de raciocínio geral embaixo?

Não. Cada especialista é. Helios conhece anúncios pagos porque todo seu contexto, treinamento e acesso a ferramentas é estruturado em volta disso. Cipher sabe como raciocinar sobre dados porque essa é a forma inteira do seu prompt de sistema. Lex não é um assistente geral lendo linguagem jurídica; ele é um advogado.

A alternativa — um modelo roteando para diferentes conjuntos de ferramentas — parece mais simples. Te poupa de gerenciar 24 prompts. Mas perde algo crucial: profundidade. Um modelo geral raciocinando sobre suas campanhas Meta pela primeira vez faz tradeoffs diferentes de um especialista que raciocinou sobre 10.000 campanhas. Eles priorizam diferente. Perguntam questões que você não pensou em perguntar. Detectam riscos porque é tudo que eles monitoram.

O tradeoff é complexidade de roteamento. Você tem que classificar cada requisição chegando (heurística → cache de padrão → LLM) e escolher o agente certo. São três camadas de classificação para evitar chamar o caro toda vez. Vale a pena, porque a resposta do especialista é melhor.

Acima dos especialistas senta um **Conselho Executivo** — sete papéis, cada um modelado em um jeito diferente de pensar. O CEO pensa em termos de loops de flywheel e questões Dia-1. O CFO pensa em unit economics. O Crítico faz pré-análises. Quando você pergunta algo difícil — "devemos expandir para um novo mercado?" — eles não apenas debatem; raciocinam de seus diferentes primeiros princípios e você consegue sete perspectivas mais uma síntese. Não consenso, mas suporte de decisão.

**Decisão de design** Especialistas ganham de generalistas em profundidade. Um motor de raciocínio único perde o rigor que vem da expertise.

## Confiança é o produto

Você não confia em um sistema porque é confiante. Confia nele porque pergunta antes de fazer qualquer coisa que importa. Execução duas-fases é onde isso vive.

Fase um: preparar. Pesquisar, escrever, gerar imagens, rodar análise. Tudo que é seguro e reversível. Nada saiu do prédio. Você consegue ver exatamente o que está prestes a acontecer.

Fase dois: executar. Publicar o post. Enviar o email. Gastar o dinheiro. Criar a campanha. Só depois que você toca *Aprovar* no Telegram.

É isso. Esse é o núcleo do mecanismo de confiança. Não "Nova é inteligente o suficiente que não vai fazer nada burro" — isso não é verdade, e não é o ponto. Em vez disso: "Nova faz o trabalho seguro, te mostra o plano, e para até você dizer sim." Nada consequente acontece sem um humano no loop. Nada.

A alternativa é autonomia por nível de confiança — algumas ações rodam sem perguntar se Nova tem um histórico limpo. Nova tem isso (autonomia conquistada, descrito abaixo), mas é um power-up. O piso é sempre: pergunte antes de executar.

O que faz isso realmente funcionar é que a etapa de aprovação vive em seu app de messaging (Telegram, Slack, WhatsApp). Você não tem que navegar para um dashboard ou lembrar uma senha. Você recebe uma notificação. Lê. Toca um botão. Aprovação sem fricção faz valer a pena: você realmente faz em vez de descartar avisos.

## Autonomia conquistada, não um cheque em branco

O momento que um sistema nunca pergunta é o momento que você não pode confiar nele. E o momento que pergunta para tudo é o momento que vira um incômodo e você para de pagar atenção.

Autonomia conquistada vive no meio. Todo tipo de ação (enviar newsletters, publicar posts nas redes, criar campanhas de anúncios) começa em *sempre pergunte*. Se um agente constrói um histórico limpo — digamos, três envios de newsletter bem-sucedidos em seguida sem rejeições — se gradua: primeiro para *notifique depois que acontece*, depois para *completamente autônomo dentro de um limite de gasto*. Uma falha ou uma rejeição e volta a perguntar imediatamente.

Você define as regras. Você decide quanto rope cada agente consegue, por tipo de ação. Você pode ver e mudar no dashboard. O sistema aprende e defere ao seu histórico, mas nunca silenciosamente. Se um agente falha bastante, conquistou sua demissão.

Isso resolve o problema real, que não é "a IA deveria ser autônoma?" É "em qual base ela consegue ser autônoma?" A base é confiança conquistada — um histórico naquele tipo de ação específico. Não confiança global. Não um toggle. Não uma prece.

## Auto-hospedado e local-first

Nova roda na sua máquina. Lê suas mensagens Telegram do seu bot. Armazena seus dados em bancos de dados SQLite locais no seu disco. Suas chaves de API ficam no seu arquivo `.env`. Você nunca envia seus dados para a nuvem a menos que explicitamente peça a um agente Nova, e mesmo assim só o que é necessário para essa tarefa.

Isso não foi a escolha mais fácil. Um serviço hospedado é mais simples de construir, mais simples de escalar e muito mais simples de cobrar. Hospedá-lo significa que viro o controlador de dados — coleo a informação, sou responsável pela segurança, sou processado quando algo quebra. Auto-hospedagem empurra aquela responsabilidade para você. Se Nova vaza seus dados, é porque você não securizou seu VPS adequadamente, não porque tive um incidente de segurança no meu data center.

Mas esse é exatamente o ponto. Seus dados deveriam ser sua responsabilidade. Suas mensagens Telegram não deveriam transitar por um servidor que controlo. Seu gasto em anúncios não deveria exigir me dar chaves de API. Você deveria conseguir ler cada linha de código, fazer fork do tudo, e não me dever nada.

Auto-hospedagem também torna Nova radicalmente mais barato. Você não está me pagando por-mensagem ou por-mês-por-assento. Está pagando por sua assinatura Claude (ou Gemini ou OpenAI). É isso. Nova apenas usa o que você já tem. Isso só funciona porque Nova é de código aberto e licenciado MIT — você pode pegar, mudar, rodar para sempre.

## Roteamento subscription-first

Quando Nova classifica uma requisição ou decompõe uma tarefa complexa, tem que chamar um modelo de IA. Três escolhas: use sua assinatura Claude/Gemini/OpenAI existente, ou mude você para faturamento por-token, ou negocie uma taxa wholesale com o provedor.

Nova escolhe sua assinatura. Sempre. Se você tem um plano Claude Pro, Nova prefere. Se você tem um plano de negócios Gemini, prefere aquele. Só se você explicitamente configurou uma preferência diferente — ou sua assinatura atinge seu rate limit — Nova recua para um provedor diferente.

Esta é uma pequena decisão com consequências grandes. Significa que o custo de rodar Nova não te surpreende. Não aparece em uma fatura separada. Não requer que você configure OAuth e confie uma terceira parte com suas credenciais de API. Você apenas usa o que já está pagando.

O tradeoff é que Nova não pode otimizar puramente em custo ou latência. Se você está em Gemini mas Claude seria mais rápido, Nova ainda prefere Gemini porque essa é sua assinatura. Aquela é uma perda deliberada de otimização em troca de transparência e previsibilidade.

## Sandbox é o bilhete para autonomia real

Um agente que pode enviar emails ou gastar orçamento de anúncios é aceitável só se não conseguir de alguma forma ler suas chaves SSH, exfiltrar seu banco de dados ou pivotar para outros sistemas. Sandbox é como isso funciona.

Quando um agente Nova executa uma tarefa que envolve entrada não confiável — scraping de página web, análise de arquivo que um cliente fez upload, rodando código que alguém te passou — aquela execução acontece dentro de um container hardened. Sistema read-only, sem acesso ao filesystem além de um diretório de staging por-tarefa, sem caminho para suas credenciais. Uma página maliciosa não consegue sequestrar o agente e usá-lo como degrau para sua máquina.

Sem sandbox, você não consegue seguramente delegar trabalho consequente a um agente. Um atacante que encontrou um jailbreak no raciocínio da IA poderia potencialmente comprometer seu sistema inteiro. Sandbox não previne o jailbreak, mas limita o raio de explosão: o agente roda em uma gaiola.

Isto é não-negociável para qualquer sistema que você está confiando com trabalho real. E é caro — containerização tem overhead, latência de rede, custos de recursos. Mas a alternativa é: não confie o agente com trabalho consequente. Escolhi o caminho caro.

## Um conselho executivo com personas distintas

Pensamento single-source-of-truth é o que mata empresas. Você toma uma decisão baseado em uma perspectiva, perde o risco e a empresa absorve o golpe. O conselho executivo é a forma do Nova de prevenir isso.

Em vez de uma resposta confiante, você consegue sete. O CEO pensa em termos de alavancagem e efeitos de flywheel. O CFO pensa em unit economics. A CMO pensa em tribos e permissão. O CTO pensa em sistemas falhando. O Crítico pensa em o que poderia dar errado. Eles raciocinam de primeiros princípios diferentes. Detectam riscos diferentes. Nenhum é mais inteligente que os outros; eles estão apenas pensando em direções diferentes.

Quando você pergunta ao conselho uma questão difícil, volta com três a cinco opções scored, cada uma com um nível de confiança e uma rationale. Você escolhe uma. A decisão é registrada. Importa.

O tradeoff é latência e custo — você está rodando sete sessões de raciocínio em vez de uma. E você tem que escolher uma opção você mesmo em vez de conseguir uma recomendação. Mas aquela segunda parte é o ponto inteiro. Para decisões que importam, você deveria ver o raciocínio, pesar as opções e escolher. O conselho te dá a matéria-prima para pensar.

## Um rastro de auditoria para tudo

Depois que um agente Nova roda uma tarefa, você tem um log do que aconteceu: qual agente, o que fez, quanto tempo levou, quanto custou, se funcionou. Depois que a tarefa completa, o agente até verifica seu próprio trabalho — "o email realmente foi enviado?" "a página renderiza?" — antes de reportar feito. Se verificação falha, a tarefa fica aberta até você decidir o que fazer.

Isso não é teatro de segurança. É a fundação da IA de grade comercial. Você não consegue ser responsável por algo que não consegue explicar. Não consegue fazer debug de algo que não mediu. Não consegue defender algo que não consegue descrever.

O custo é que cada decisão, cada ação, é escrita em um registro. Mais armazenamento, mais I/O, mais dados para gerenciar. Mais importante, significa que você tem que encarar o que o sistema realmente fez, não o que esperava que fizesse. Isso é desconfortável às vezes. É também a única forma de rodar isso responsavelmente.

**Decisão de design** "Grade comercial" principalmente significa respondível depois dos fatos. Auditabilidade não é um recurso; é o requisito.

## Os tradeoffs são reais

Cada uma dessas decisões custa algo. Especialistas ganham de generalistas mas adicionam complexidade de roteamento. Etapas de aprovação constroem confiança mas adicionam fricção. Autonomia conquistada previne cheques em branco mas requer rastreamento de estado. Sandbox bloqueia ataques mas adiciona latência. Auto-hospedagem é barato mas coloca carga operacional em você. Um conselho executivo previne groupthink mas desacelera decisões. Auditabilidade constrói responsabilidade mas requer logar tudo.

Escolhi cada tradeoff porque a alternativa — um sistema de IA confiante, autônomo, alta-velocidade que ninguém realmente confia com nada importante — parecia pior.

Nova é mais lenta do que poderia ser. É mais complexo do que poderia ser. Custa mais rodar (na sua infraestrutura, não na minha). Pergunta mais questões do que um sistema otimizado perguntaria. Tudo isso é deliberado. O objetivo não é construir uma IA que se mova rápido. O objetivo é construir um time de IA que realmente funcione, que você possa entregar um problema real, que você confiaria rodar algo importante, e que você possa explicar e defender quando algo der errado.

Isso é mais duro. Leva mais tempo. Mas é o único tipo de sistema autônomo que vale a pena construir.
