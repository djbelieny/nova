# O que é Nova? Seu time de IA de código aberto, explicado

> Nova é um time de IA auto-hospedado de código aberto que você executa pelo Telegram: 24 agentes especialistas, um conselho executivo, aprovação humana antes de qualquer envio ou gasto, execução sandboxed e autonomia conquistada. Aqui está o que faz e como as pessoas usam.

*Source: https://mynova.space/pt-br/blog/what-is-nova/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova é uma plataforma auto-hospedada de código aberto que transforma um grupo de agentes IA especialistas em algo mais próximo a uma empresa do que a um chatbot — e pede aprovação antes de fazer qualquer coisa que envie, gaste ou comunique.

Jake Belieny · 15 de julho de 2026 · 8 min de leitura

A maioria dos "assistentes de IA" é um modelo atrás de uma caixa de texto. Você pergunta, ele responde, e cada passo consequente depende de você. Nova tem um formato diferente. É um **organograma**: duas dúzias de especialistas, um conselho executivo que raciocina sobre estratégia e uma camada de coordenação que decompõe uma solicitação em tarefas, as executa em paralelo e pausa para sua aprovação antes de tocar o mundo real.

E funciona onde você já está. Você envia mensagens para Nova no Telegram (ou WhatsApp ou Slack) da mesma forma que mandaria para um colega de trabalho — e executa em **sua** máquina, com **suas** chaves de API ou assinaturas, com seus dados mantidos no armazenamento local. É licenciado MIT, então você pode ler cada linha, alterar qualquer coisa e não deve nada a ninguém em taxa por assento.

**A versão de uma linha** Nova é staff de IA auto-hospedado: um time de agentes que planejam, rascunham e analisam por conta própria — mas conseguem sua aprovação antes de qualquer coisa sair do prédio.

## Como uma mensagem se torna trabalho

Quando você envia uma mensagem para Nova, ela primeiro **classifica** o que você está pedindo. Uma pergunta rápida recebe uma resposta direta. Uma tarefa focada é roteada para o especialista certo. Algo grande — "planejar e lançar nossa campanha de primavera" — é **decomposto** em um plano consciente de dependências e executado em vários agentes de uma vez.

Depois vem a parte que torna Nova confiável. O trabalho acontece em **duas fases**:

- **Preparar** — a metade segura. Pesquisar, escrever o conteúdo, gerar a imagem, processar os números. Nada saiu do prédio ainda.

- **Aprovar** — Nova mostra exatamente o que está prestes a fazer, com botões inline: *Aprovar*, *Revisar* ou *Cancelar*.

- **Executar** — apenas depois que você aprova é que faz o que é importante: publicar o post, enviar os e-mails, lançar a campanha, gastar o dinheiro.

## O time que você está realmente contratando

Sob o capô, Nova é **24 agentes especialistas**, cada um com seu próprio domínio, ferramentas e prompt de sistema. Você não precisa conhecer seus nomes — Nova roteia para o certo — mas ajuda ver o formato do elenco:

#### Crescimento e marketing

Helios (anúncios pagos), Pixel (redes sociais), Kai (conteúdo), Orion (e-mail), Magnus (SEO), Morpheus (vídeo), Flux (funis).

#### Estratégia e operações

Athena (estratégia empresarial), Oracle (previsão de tendências), Tesseract (pensamento sistêmico), Zen (produtividade), Bridge (parcerias).

#### Dados e engenharia

Digit (análise), Cipher (ciência de dados), Architect (desenvolvimento web), Joule (automação), Rift (segurança).

#### Voz e suporte

Aura (voz da marca), Echo (suporte ao cliente), Helia (RP), Nexus (comunidade), Quill (bolsas), Lex (legal), Cyra (otimização de site).

Acima dos especialistas fica um **Conselho Executivo** — CEO, CFO, CMO, CTO, COO, Chefe de Pesquisa e um Crítico — cada um modelado em uma forma distinta de pensar. Faça uma pergunta estratégica difícil com `/board` e eles se reúnem: análise independente, um pré-mortem do Crítico e depois uma síntese de opções com escores de confiança para você escolher.

## Construído para que você possa realmente confiar a ele as chaves

Um time de IA que pode enviar e-mails e gastar orçamento de anúncios só é útil se também for *seguro*. O lançamento mais recente de Nova é tudo sobre isso — transformar "provavelmente não fará nada burro" em garantias reais.

### Execução sandboxed

As tarefas do agente podem ser executadas dentro de um container endurecido — sistema somente leitura, sem acesso aos seus arquivos de host além de um workspace por tarefa, sem caminho para suas credenciais — portanto, uma página da web que tenta sequestrar um agente por meio de um parágrafo bem redigido não pode atingir nada importante. E permanece em sua **assinatura**: Nova compartilha seu plano Claude, OpenAI ou Gemini no sandbox em vez de silenciosamente alternar você para cobrança por token.

### Autonomia conquistada, não um cheque em branco

Todo tipo de ação começa em **sempre perguntar**. Conforme um agente constrói um histórico limpo em uma tarefa determinada — digamos, "enviar o boletim semanal" — ele se gradua: primeiro para *notificá-lo depois*, depois para *totalmente autônomo dentro de um limite de gasto*. Uma falha ou uma rejeição e ele volta direto a perguntar. Você decide quanto de corda cada agente recebe e pode ver e alterar isso a partir de um painel.

### Uma trilha de auditoria para tudo

Cada ação consequente é gravada em um registro — o que foi executado, qual agente, quanto custou, se funcionou. Depois de cada tarefa, um agente até mesmo **verifica seu próprio trabalho** ("o e-mail foi realmente enviado? a página é renderizada?") antes de relatar conclusão. Nível empresarial significa principalmente *respondível após o fato*, e Nova é.

## Para o que as pessoas a usam

Porque Nova é um time em vez de uma ferramenta única, as solicitações úteis tendem a ser as que você entregaria a um funcionário capaz. Alguns formatos reais:

### Execute o marketing que funciona conforme agendado

Boletins informativos, calendários de redes sociais, relatórios de anúncios. "Poste três vezes esta semana sobre o lançamento", "resuma o desempenho do gasto com anúncios do mês passado", "transforme este post de blog em um thread do LinkedIn e um carrossel". Nova rascunha, você aprova, publica — e quando você confia em uma tarefa recorrente, deixa funcionar sozinha.

### Transforme um objetivo permanente em trabalho contínuo

Diga a Nova um objetivo — "crescer o boletim para 5.000 assinantes" — e ela não apenas acena. Ela divide o objetivo em tarefas concretas, as agenda, executa por dias e semanas e relata progresso. É a diferença entre uma ferramenta que você opera e staff que persegue um resultado.

### Faça as grandes chamadas com um board ao seu lado

Para as decisões que merecem mais de uma opinião, o conselho executivo é um parceiro de pensamento genuíno. "Devemos expandir para a UE?" convoca sete perspectivas, expõe os modos de falha que você não pensou e coloca opções avaliadas em suas mãos — não um único palpite confiante.

#### Fundadores solo

Um time inteiro de marketing, dados e operações que você pode pagar — em suas próprias contas, pedindo antes de gastar.

#### Pequenos times

Transfira o trabalho repetitivo (relatórios, rascunhos, agendamento) com uma trilha de papel e portas de aprovação que todo o time pode ver.

#### Construtores e curiosos

Licenciado MIT e auto-hospedado. Leia, faça fork, adicione seus próprios agentes, acople suas próprias ferramentas.

#### Preocupados com privacidade

Seus dados vivem no armazenamento local em sua máquina. Suas chaves, sua assinatura, suas regras.

## Primeiros passos

Nova é projetada para levá-lo do clone à primeira mensagem com quase nenhuma fricção. Um único comando — `bash bootstrap.sh` — instala qualquer coisa que esteja faltando ([Bun](https://bun.sh), a CLI do Claude Code) e abre um assistente guiado que solicita um token de bot do Telegram e um provedor de IA, configura alguns agentes iniciais e verifica a conexão. Ele até detecta seu ID de usuário do Telegram automaticamente, e é retomável caso você precise se ausentar. O resto (o conselho executivo, integrações extras) você pode ligar quando quiser.

- Clone o repo e execute `bash bootstrap.sh`.

- Envie uma mensagem para seu bot no Telegram — a Nova te cumprimenta com ideias iniciais tocáveis, e `/team` apresenta seus especialistas em linguagem simples.

- Ative sandbox, autonomia e o board auto-hospedado conforme crescem — tudo opcional, nada forçado.
