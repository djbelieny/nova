# Nova landing page

The static site served at [mynova.space](https://mynova.space) — a single HTML file deployed as a Cloudflare Worker with static assets.

```bash
bunx wrangler deploy
```

Custom domains are attached at the Cloudflare account level (Workers → nova-site → Domains & Routes), not declared in `wrangler.jsonc`.
