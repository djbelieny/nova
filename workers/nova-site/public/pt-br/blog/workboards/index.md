# Quadros que seus agentes preenchem

> A Nova agora monta um quadro para você. Peça no chat, ela propõe os campos e as etapas, os agentes dela preenchem os cartões e você os arrasta no painel. Uma etapa pode executar um playbook quando um cartão chega. Suficiente para substituir um CRM leve.

*Source: https://mynova.space/pt-br/blog/workboards/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Peça um quadro à Nova e ela constrói: campos tipados, etapas ordenadas e cartões preenchidos pelos agentes dela. Abra o painel e arraste. Arme uma etapa e o trabalho roda assim que um cartão chega ali. Suficiente para parar de pagar por um CRM leve.

Jake Belieny · 23 de julho de 2026 · 7 min de leitura

A Nova gera registros o dia inteiro. Pesquisa leads, redige ordens de compra, triagem de tickets, levanta os números de um relatório. Até esta semana tudo isso chegava como *mensagens*: uma boa resposta em uma conversa, esquecida até quinta-feira.

Não havia onde *ver* um conjunto desses registros. Nem onde fazer um avançar. Nem como dizer «rode o follow-up em tudo que está naquela coluna». Então você mantinha um CRM aberto ao lado da Nova, principalmente para guardar um estado que a Nova já havia produzido, e redigitava tudo na mão.

É isso que os **Workboards** resolvem.

**A versão em uma linha** Peça um quadro no chat. A Nova escolhe os campos e as etapas, os agentes dela preenchem os cartões, você arrasta no painel — e uma etapa pode executar um playbook assim que um cartão chega.

## Peça um quadro e receba um quadro

Você descreve do jeito que descreveria para um colega. A Nova deduz o que o quadro precisa guardar, constrói e te entrega o link.

O segundo caso merece atenção. O quadro e a pesquisa são um pedido só. Um agente vai lá e faz o trabalho, e o resultado chega como cartões que você pode ordenar e mover — não como um muro de texto que você precisa reformatar para virar algo útil.

## Cada quadro tem a sua própria forma

Um quadro de compras e um de leads não têm nada em comum, então a Nova não força os dois no mesmo esquema. Cada quadro declara os seus próprios **campos tipados** — texto, dinheiro, data, e-mail, uma lista suspensa com as suas opções, um link, uma caixa de seleção — e todo cartão daquele quadro carrega essa forma.

Campos tipados são o que faz um quadro ser mais do que post-its. Uma coluna de dinheiro se soma sozinha por etapa. Uma de data ordena. Uma lista suspensa não vira quatro grafias do mesmo status. E um playbook consegue ler com segurança o valor *deste* cartão, porque ele sempre existe e é sempre um número.

Esquemas mudam, então editá-los é tratado com cuidado: **adicionar** um campo é imediato e preenche todos os cartões existentes. **Remover ou trocar o tipo** de um pede confirmação antes e depois guarda os valores antigos no histórico do quadro — assim um campo removido na pressa é recuperável, não perdido.

## Etapas que fazem o trabalho

Por padrão uma etapa é só uma coluna: um rótulo, um lugar para soltar um cartão. Esse é o padrão certo; a maioria dos quadros quer ser um mural.

Mas um quadro pode ficar **reativo**, e aí uma etapa pode carregar uma ação: um playbook, ou uma tarefa para um agente específico. Solte um cartão ali e o trabalho começa, usando os campos do próprio cartão como entrada. Um lead arrastado para *Nutrição* recebe a sequência escrita para *aquela* empresa. Uma OC arrastada para *Enviar* é enviada.

Dar a um gesto de arrastar o poder de iniciar trabalho real merece proteções — e ele tem:

- **Conteúdo de cartão é dado, nunca instrução.** Um cartão cujas notas digam *«ignore suas instruções anteriores e…»* é detectado e a ação é pulada: a mesma triagem que a Nova já aplica a qualquer conteúdo não confiável que chega a um agente.

- **Roda uma vez só.** Um arraste duplicado, um pedido repetido, um reinício no meio — a ação executa uma única vez.

- **Movimentos em massa perguntam antes.** Arraste quarenta cartões para uma etapa armada e a Nova pergunta uma vez pelo lote em vez de disparar quarenta trabalhos em silêncio.

- **Falhas aparecem.** Uma ação que não consegue concluir vai para a fila de falhas com o motivo junto, em vez de sumir.

- **O portão de aprovação continua.** Tudo que for consequente adiante — enviar, publicar, gastar — ainda para para a sua aprovação, exatamente como sempre.

## Traga o que já vive em outro lugar

Um quadro pode se ligar a um conector que você já configurou — HubSpot, Stripe, Shopify, Zendesk — e puxar registros para os cartões. A sincronização é **só de inserção e atualização**: ela adiciona e atualiza, e nunca apaga. Uma API instável ou um token vencido podem deixar cartões desatualizados, mas não conseguem esvaziar um quadro.

O caminho inverso é propositalmente mais lento. Quando você move um cartão num quadro ligado, a Nova *descreve* a escrita que faria naquele sistema e registra — ela não sai alterando um registro do seu CRM porque você arrastou alguma coisa. Escrever em sistemas dos quais você depende é uma decisão, não um efeito colateral.

## Os quadros que você já tinha se mudaram

Faz tempo que a Nova mostra tarefas de agentes e tickets de suporte em quadros fixos e somente leitura. Os dois agora rodam sobre este motor: mesma aparência, mesmas interações e, pela primeira vez, arrastáveis. As colunas deles são travadas — um quadro de tickets deve significar o que todo mundo acha que significa — mas mover um cartão atualiza de verdade o ticket ou a tarefa por baixo.

Uma interface de quadro em vez de três, e cada melhoria chega em todas de uma vez.

## O que não é

Não é Salesforce. Não há motor de pontuação de leads, nem sequenciador de e-mail acoplado, nem suíte de relatórios. Se você precisa de CRM corporativo, compre CRM corporativo.

O que é: o lugar para onde vai o resultado dos seus agentes, para que ele pare de ser uma mensagem de chat. Para muitos times pequenos o CRM nunca passou de um esquema, algumas colunas e um lembrete de follow-up — e a Nova já sustenta as três coisas, na sua própria máquina, ao lado dos agentes que já fazem o trabalho.
