# Dê à Nova um segundo cérebro: alimente-a com seus documentos via RAG

> Agora a Nova tem uma base de conhecimento com escopo — um segundo cérebro. Solte PDFs, documentos, notas ou URLs e a Nova os aprende: divididos em trechos, incorporados localmente e recuperados em todos os agentes com citação de fontes. Escopos pessoal, de equipe e por agente. Quatro formas de alimentá-la.

*Source: https://mynova.space/pt-br/blog/second-brain/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Agora a Nova tem uma base de conhecimento que você mesmo alimenta. Solte um PDF, um documento, uma nota ou uma URL e a Nova a aprende — dividida em trechos, incorporada na sua própria máquina e trazida de volta para a resposta de qualquer agente com uma citação. Pessoal, para toda a equipe ou vinculada a um único especialista.

Jake Belieny · 21 de julho de 2026 · 7 min de leitura

A Nova sempre teve memória — ela lembra fatos sobre você e seu trabalho e os traz para uma conversa quando são relevantes. Mas a memória é para as coisas que a Nova *aprende* de passagem. Nunca foi um lugar para colocar as coisas que você já *tem*: o contrato, o guia de marca, a especificação do produto, o relatório de pesquisa de 40 páginas em que você quer que toda resposta esteja fundamentada.

É isso que chegou esta semana. Agora a Nova tem uma **base de conhecimento** de verdade — um segundo cérebro que você alimenta de propósito. Entregue a ela um documento e ele vira algo que a Nova pode citar, sobre o qual pode raciocinar e ao qual pode fazer referência, em todos os agentes, em todos os canais.

**A versão de uma linha** Solte um PDF, documento, nota ou URL. A Nova o divide em passagens, as incorpora localmente e as armazena. A partir daí seus agentes respondem *a partir do seu material* — e dizem de qual documento cada fato veio.

## Como funciona de verdade

Quando um documento chega, a Nova o passa por um pipeline pequeno, sem graça e confiável — do tipo que você quer cuidando dos seus dados:

- **Extrair** — o texto é retirado de PDFs, documentos do Word, Markdown, texto simples ou de uma página web.

- **Dividir** — o texto é fatiado em passagens sobrepostas de algumas centenas de palavras, para que uma correspondência retorne um trecho focado e citável em vez de um arquivo inteiro.

- **Incorporar** — cada passagem é transformada em um vetor por um modelo que roda **na sua própria máquina** (all-MiniLM, o mesmo incorporador local que a Nova já usa). Nenhum documento jamais sai para uma API de incorporação de terceiros.

- **Armazenar e recuperar** — as passagens ficam no armazenamento vetorial local da Nova. Quando você pergunta algo, a Nova incorpora sua pergunta, encontra as passagens mais próximas e as insere na resposta.

A recuperação é **híbrida**, que é a parte que a faz parecer sem esforço. A passagem ou duas mais relevantes são injetadas automaticamente na conversa — você não pede à Nova para "buscar na base de conhecimento", ela simplesmente sabe. E quando um agente precisa se aprofundar, ele pode consultar a base diretamente. De qualquer forma, o que volta carrega sua fonte, então a Nova pode dizer *"(de contract-v3.pdf)"* em vez de pedir que você acredite na palavra dela.

## Pessoal, de equipe e por agente — uma base, três escopos

Nem todo documento pertence a todos. A base de conhecimento da Nova tem três escopos, e eles se combinam:

#### Pessoal

Só seu. Suas notas, seus rascunhos, a pesquisa que só você deveria ver. Vive no seu próprio banco de dados local e nenhum colega de equipe pode recuperá-la.

#### Equipe

Compartilhado com todos na sua Nova. O manual, o guia de marca, os preços — as coisas que você quer que toda resposta respeite.

#### Por agente

Um pacote vinculado a um especialista. Contratos para a Lex, a voz da marca para a Aura, os docs da API para a Architect — para que o especialista certo carregue o material certo e ninguém mais fique atulhado com ele.

Quando um agente responde, ele recorre aos seus documentos pessoais, à base da equipe *e* ao seu próprio pacote — mas nunca ao pacote de outro agente. Um especialista permanece especializado.

## Quatro formas de alimentá-la

A melhor base de conhecimento é aquela que você realmente mantém atualizada, então a Nova te dá quatro portas — use a que couber ao momento:

### 1 · Solte um arquivo no Telegram

Envie à Nova um documento com uma legenda como *"adicionar ao conhecimento"* — ou *"adicionar ao conhecimento da equipe"*, ou *"para o pacote da Lex"* — e ele é incorporado na hora, com escopo e tudo. `/knowledge` lista tudo o que a Nova conhece no momento, agrupado por escopo.

### 2 · O painel

O painel web tem um bloco **Conhecimento**: arraste arquivos para dentro, defina o escopo de cada um, busque em tudo e apague o que estiver desatualizado. É o lugar confortável para gerenciar uma base em crescimento.

### 3 · O comando `nova kb`

Prefere o terminal? A CLI unificada cobre todo o ciclo de vida:

- `nova kb add report.pdf --scope team`

- `nova kb add https://example.com/spec --agent architect`

- `nova kb list` · `nova kb search "refund window"` · `nova kb reindex --all`

### 4 · Uma pasta monitorada

Solte e esqueça: qualquer coisa que você coloque em `~/.nova/knowledge/` é incorporada automaticamente, e as subpastas definem o escopo — `team/` para equipe, `agents/lex/` para um pacote de agente. Apague um arquivo e suas passagens saem da base. Isso transforma sua base de conhecimento em uma pasta que você já sabe usar.

## Construído no mesmo padrão do resto da Nova

Um segundo cérebro só vale a pena ter se você puder confiar no que ele devolve. Então a base de conhecimento herda as proteções da Nova:

- **Escaneado contra injeção.** Um documento que tenta contrabandear instruções — *"ignore suas regras anteriores…"* escondido em um parágrafo — é detectado e descartado antes que possa chegar a um prompt. Seus arquivos são tratados como *dados*, nunca como comandos.

- **Local e privado.** A extração e as incorporações rodam na sua máquina. Seus documentos não são enviados para a API de ninguém para serem indexados.

- **Reincorporações limpas.** Adicione de novo um arquivo que você editou e a Nova substitui a versão antiga no lugar — sem duplicatas, sem passagens obsoletas persistindo.

Ela também reaproveita a maquinaria que a Nova já tinha — o mesmo incorporador local, o mesmo armazenamento vetorial, os mesmos parsers de documentos — em vez de acoplar um sistema paralelo. Menos para quebrar, e se comporta como a Nova que você já conhece.

## Para onde isso vai

Uma base de conhecimento muda o que você pode entregar à Nova. Em vez de colar o parágrafo relevante em cada solicitação, você carrega a fonte uma vez e todo agente fica fundamentado nela dali em diante. As respostas de suporte batem com suas políticas reais. O jurídico lê seus contratos reais. A voz da sua marca é *o seu* guia de marca, não um palpite genérico. A equipe para de reexplicar o mesmo contexto e começa a construir sobre ele.

É a diferença entre um assistente que é esperto em geral e um time que é esperto sobre o *seu* negócio.
