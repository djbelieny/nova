# Nova — Deployment Guide

> Production server: `root@nova.07labs.com`
> Project directory: `/opt/nova`
> Domain: `nova.1osm.com` (voice/SMS), `csm.07labs.com` (web/dashboard)

## Quick Deploy (most common)

From your local machine, after pushing changes to `master`:

```bash
# 1. Sync files to server
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  ./ root@nova.07labs.com:/opt/nova/

# 2. SSH in and rebuild + restart the changed service(s)
ssh root@nova.07labs.com
cd /opt/nova

# Rebuild and restart a specific service:
docker compose build voice && docker compose --profile voice up -d voice
docker compose build relay && docker compose up -d relay
docker compose build scheduler && docker compose up -d scheduler
docker compose build dashboard && docker compose --profile web up -d dashboard
docker compose build miniapp && docker compose --profile web up -d miniapp

# Or rebuild and restart everything:
docker compose build && docker compose --profile all up -d
```

## Services & Profiles

| Service     | Container        | Profile  | Port (internal) | Description                    |
|-------------|------------------|----------|-----------------|--------------------------------|
| `relay`     | `nova-relay`     | (always) | —               | Main Telegram bot              |
| `scheduler` | `nova-scheduler` | (always) | —               | Cron-based periodic services   |
| `caddy`     | `nova-caddy`     | `web`    | 80, 443         | Reverse proxy, auto HTTPS      |
| `dashboard` | `nova-dashboard` | `web`    | 3033            | Web dashboard                  |
| `miniapp`   | `nova-miniapp`   | `web`    | 3034            | Telegram Mini App              |
| `voice`     | `nova-voice`     | `voice`  | 8080            | Voice call server (Twilio)     |

**Profile shortcuts:**
- `docker compose up -d` — relay + scheduler only
- `docker compose --profile web up -d` — + caddy, dashboard, miniapp
- `docker compose --profile voice up -d` — + voice server
- `docker compose --profile all up -d` — everything

## Server Structure

```
/opt/nova/           — Project files (synced from local via rsync)
/opt/nova/.env       — Environment variables (server-only, never synced)
/opt/nova/config/    — profile.md and other config (preserved across deploys)
~/.claude/           — Claude Code auth tokens (mounted into containers)
```

## Environment

The `.env` file on the server is **not** tracked in git and is excluded from rsync. If you need to update env vars, edit `/opt/nova/.env` directly on the server and restart the affected service.

## Logs

```bash
# Tail logs for a specific service
docker logs -f nova-voice
docker logs -f nova-relay
docker logs -f nova-scheduler

# All services
docker compose --profile all logs -f
```

## Health Checks

```bash
# Voice server
curl https://nova.1osm.com/health

# All container statuses
docker compose --profile all ps
```

## Rollback

If a deploy breaks something:

```bash
# Check the git log locally for the last known good commit
git log --oneline -10

# Checkout that commit locally, then re-sync
git checkout <commit-hash>
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  ./ root@nova.07labs.com:/opt/nova/
ssh root@nova.07labs.com "cd /opt/nova && docker compose build && docker compose --profile all up -d"

# Don't forget to go back to master
git checkout master
```

## First-Time Server Setup

If setting up a new server from scratch:

1. Install Docker and Docker Compose
2. Clone or rsync the project to `/opt/nova`
3. Copy `.env.example` to `.env` and fill in all values
4. Copy `config/profile.example.md` to `config/profile.md`
5. Set up Claude Code auth: `mkdir -p ~/.claude` and configure tokens
6. Start services: `docker compose --profile all up -d`
7. Point DNS records for `nova.1osm.com` and `csm.07labs.com` to the server IP
8. Caddy handles HTTPS certificates automatically
