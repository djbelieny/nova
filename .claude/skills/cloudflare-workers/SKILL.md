---
name: cloudflare-workers
description: Cloudflare Workers, D1, KV, R2, Queues, Workflows, AI, Durable Objects, secrets, env vars, and deployments. Use when the user asks about deploying workers, managing storage (KV/R2/D1), queues, workflows, AI inference, or Cloudflare infrastructure.
---

# Cloudflare Workers & Infrastructure

## When to Use
- Deploy, update, or manage Workers
- D1 database operations
- KV store read/write
- R2 object storage
- Queue management
- Workflow creation and execution
- AI inference and embeddings
- Durable Objects
- Environment variables and secrets
- Worker versions and rollbacks
- Wrangler config management
- Templates

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

### Workers
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__worker_list` | List workers |
| `mcp__cloudflare__worker_get` | Get worker code |
| `mcp__cloudflare__worker_put` | Create/update worker |
| `mcp__cloudflare__worker_delete` | Delete worker |
| `mcp__cloudflare__worker_deploy` | Deploy worker |

### D1 Database
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__d1_list_databases` | List D1 databases |
| `mcp__cloudflare__d1_create_database` | Create D1 database |
| `mcp__cloudflare__d1_delete_database` | Delete D1 database |
| `mcp__cloudflare__d1_query` | Execute D1 SQL query |

### KV Store
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__get_kvs` | List KV namespaces |
| `mcp__cloudflare__kv_list` | List KV keys |
| `mcp__cloudflare__kv_get` | Get KV value |
| `mcp__cloudflare__kv_put` | Put KV value |
| `mcp__cloudflare__kv_delete` | Delete KV key |

### R2 Storage
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__r2_list_buckets` | List R2 buckets |
| `mcp__cloudflare__r2_create_bucket` | Create R2 bucket |
| `mcp__cloudflare__r2_delete_bucket` | Delete R2 bucket |
| `mcp__cloudflare__r2_list_objects` | List R2 objects |
| `mcp__cloudflare__r2_get_object` | Get R2 object |
| `mcp__cloudflare__r2_put_object` | Put R2 object |
| `mcp__cloudflare__r2_delete_object` | Delete R2 object |

### Queues
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__queue_list` | List queues |
| `mcp__cloudflare__queue_create` | Create queue |
| `mcp__cloudflare__queue_get` | Get queue |
| `mcp__cloudflare__queue_delete` | Delete queue |
| `mcp__cloudflare__queue_send_message` | Send message |
| `mcp__cloudflare__queue_send_batch` | Send batch |
| `mcp__cloudflare__queue_get_message` | Get message |
| `mcp__cloudflare__queue_delete_message` | Delete message |
| `mcp__cloudflare__queue_update_visibility` | Update visibility |

### Workflows
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__workflow_list` | List workflows |
| `mcp__cloudflare__workflow_get` | Get workflow |
| `mcp__cloudflare__workflow_create` | Create workflow |
| `mcp__cloudflare__workflow_update` | Update workflow |
| `mcp__cloudflare__workflow_delete` | Delete workflow |
| `mcp__cloudflare__workflow_execute` | Execute workflow |

### AI
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__ai_list_models` | List AI models |
| `mcp__cloudflare__ai_get_model` | Get model info |
| `mcp__cloudflare__ai_inference` | Run inference |
| `mcp__cloudflare__ai_text_generation` | Generate text |
| `mcp__cloudflare__ai_image_generation` | Generate image |
| `mcp__cloudflare__ai_embeddings` | Generate embeddings |

### Durable Objects
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__do_list_namespaces` | List DO namespaces |
| `mcp__cloudflare__do_create_namespace` | Create namespace |
| `mcp__cloudflare__do_delete_namespace` | Delete namespace |
| `mcp__cloudflare__do_list_objects` | List objects |
| `mcp__cloudflare__do_get_object` | Get object |
| `mcp__cloudflare__do_delete_object` | Delete object |
| `mcp__cloudflare__do_alarm_list` | List alarms |
| `mcp__cloudflare__do_alarm_set` | Set alarm |
| `mcp__cloudflare__do_alarm_delete` | Delete alarm |

### Environment & Secrets
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__env_var_list` | List env vars |
| `mcp__cloudflare__env_var_set` | Set env var |
| `mcp__cloudflare__env_var_bulk_set` | Bulk set env vars |
| `mcp__cloudflare__env_var_delete` | Delete env var |
| `mcp__cloudflare__secret_list` | List secrets |
| `mcp__cloudflare__secret_put` | Set secret |
| `mcp__cloudflare__secret_delete` | Delete secret |

### Versions & Config
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__version_list` | List versions |
| `mcp__cloudflare__version_get` | Get version |
| `mcp__cloudflare__version_rollback` | Rollback version |
| `mcp__cloudflare__wrangler_config_get` | Get wrangler config |
| `mcp__cloudflare__wrangler_config_update` | Update wrangler config |

### Templates
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__template_list` | List templates |
| `mcp__cloudflare__template_get` | Get template |
| `mcp__cloudflare__template_create_worker` | Create from template |

### Service Bindings
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__service_binding_list` | List bindings |
| `mcp__cloudflare__service_binding_create` | Create binding |
| `mcp__cloudflare__service_binding_update` | Update binding |
| `mcp__cloudflare__service_binding_delete` | Delete binding |

### Crons
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__cron_list` | List crons |
| `mcp__cloudflare__cron_create` | Create cron |
| `mcp__cloudflare__cron_update` | Update cron |
| `mcp__cloudflare__cron_delete` | Delete cron |

### Analytics
| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__workers_analytics_search` | Workers analytics |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__cloudflare__worker_deploy"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. Account ID and API token come from environment configuration
