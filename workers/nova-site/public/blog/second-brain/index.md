# Give Nova a second brain: feed it your documents with RAG

> Nova now has a scoped knowledge base — a second brain. Drop in PDFs, docs, notes, or URLs and Nova learns them: chunked, embedded locally, and retrieved across every agent with source citations. Personal, team, and per-agent scopes. Four ways to feed it.

*Source: https://mynova.space/blog/second-brain/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova now has a knowledge base you feed yourself. Drop in a PDF, a doc, a note, or a URL and Nova learns it — chunked, embedded on your own machine, and pulled back into any agent's answer with a citation. Personal, team-wide, or tied to one specialist.

Jake Belieny · 21 July 2026 · 7 min read

Nova has always had a memory — it remembers facts about you and your work and pulls them into a conversation when they're relevant. But memory is for the things Nova *learns* in passing. It was never a place to put the things you already *have*: the contract, the brand guide, the product spec, the 40-page research report you want every answer to be grounded in.

That's what shipped this week. Nova now has a proper **knowledge base** — a second brain you feed on purpose. Hand it a document and it becomes something Nova can quote, reason over, and cite, across every agent, on every channel.

**The one-line version** Drop in a PDF, doc, note, or URL. Nova splits it into passages, embeds them locally, and stores them. From then on your agents answer *from your material* — and tell you which document each fact came from.

## How it actually works

When a document arrives, Nova runs it through a small, boring, reliable pipeline — the kind you want handling your data:

- **Extract** — text is pulled out of PDFs, Word docs, Markdown, plain text, or a web page.

- **Chunk** — the text is split into overlapping passages of a few hundred words, so a match returns a focused, quotable snippet rather than a whole file.

- **Embed** — each passage is turned into a vector by a model that runs **on your own machine** (all-MiniLM, the same local embedder Nova already uses). No document ever leaves for a third-party embedding API.

- **Store & retrieve** — passages live in Nova's local vector store. When you ask something, Nova embeds your question, finds the closest passages, and folds them into the answer.

Retrieval is **hybrid**, which is the part that makes it feel effortless. The most relevant passage or two is injected automatically into the conversation — you don't ask Nova to "search the knowledge base," it just knows. And when an agent needs to dig deeper, it can query the base directly. Either way, what comes back carries its source, so Nova can say *"(from contract-v3.pdf)"* instead of asking you to take its word for it.

## Personal, team, and per-agent — one base, three scopes

Not every document belongs to everyone. Nova's knowledge base has three scopes, and they compose:

#### Personal

Yours alone. Your notes, your drafts, the research only you should see. It lives in your own local database and no teammate can retrieve it.

#### Team

Shared across everyone on your Nova. The handbook, the brand guide, the pricing — the things you want every answer to respect.

#### Per-agent

A pack tied to one specialist. Contracts for Lex, the brand voice for Aura, the API docs for Architect — so the right expert carries the right material and no one else is cluttered by it.

When an agent answers, it draws on your personal docs, the team base, *and* its own pack — but never another agent's pack. A specialist stays specialized.

## Four ways to feed it

The best knowledge base is the one you actually keep current, so Nova gives you four doors — use whichever fits the moment:

### 1 · Drop a file in Telegram

Send Nova a document with a caption like *"add to knowledge"* — or *"add to team knowledge"*, or *"for Lex's pack"* — and it's ingested on the spot, scope and all. `/knowledge` lists everything Nova currently knows, grouped by scope.

### 2 · The dashboard

The web dashboard has a **Knowledge** panel: drag files in, set each one's scope, search across everything, and delete what's stale. It's the comfortable place to manage a growing base.

### 3 · The `nova kb` command

Prefer the terminal? The unified CLI covers the whole lifecycle:

- `nova kb add report.pdf --scope team`

- `nova kb add https://example.com/spec --agent architect`

- `nova kb list` · `nova kb search "refund window"` · `nova kb reindex --all`

### 4 · A watched folder

Point-and-forget: anything you drop into `~/.nova/knowledge/` is ingested automatically, and subfolders set the scope — `team/` for team, `agents/lex/` for an agent pack. Delete a file and its passages leave the base. It turns your knowledge base into a folder you already know how to use.

## Built to the same standard as the rest of Nova

A second brain is only worth having if you can trust what it feeds back. So the knowledge base inherits Nova's guardrails:

- **Injection-scanned.** A document that tries to smuggle in instructions — *"ignore your previous rules…"* hidden in a paragraph — is caught and dropped before it can reach a prompt. Your files are treated as *data*, never as commands.

- **Local and private.** Extraction and embeddings run on your machine. Your documents don't get shipped to anyone's API to be indexed.

- **Clean re-ingests.** Re-add a file you've edited and Nova replaces the old version in place — no duplicates, no stale passages lingering.

It also reuses the machinery Nova already had — the same local embedder, the same vector store, the same document parsers — rather than bolting on a parallel system. Less to break, and it behaves like the Nova you already know.

## Where this goes

A knowledge base changes what you can hand Nova. Instead of pasting the relevant paragraph into every request, you load the source once and every agent is grounded in it from then on. Support answers match your real policies. Legal reads your real contracts. Your brand voice is *your* brand guide, not a generic guess. The team stops re-explaining the same context and starts building on it.

It's the difference between an assistant that's smart in general and a team that's smart about *your* business.
