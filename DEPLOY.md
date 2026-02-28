# Nova — Deployment Guide

> Production server: `root@nova.07labs.com` (Ubuntu 24.04)
> Project directory: `/opt/nova`
> Domains: `nova.1osm.com` (voice/SMS), `csm.07labs.com` (web/dashboard)
> Runs natively via systemd (no Docker)

## Quick Deploy (most common)

From your local machine, after making changes:

```bash
# 1. Sync files to server
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='.mcp.json' \
  ./ root@nova.07labs.com:/opt/nova/

# 2. SSH in and restart the changed service(s)
ssh root@nova.07labs.com

cd /opt/nova && bun install

# Restart a specific service:
systemctl restart nova-relay
systemctl restart nova-voice
systemctl restart nova-dashboard
systemctl restart nova-miniapp

# Or restart everything:
systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp
```

## Services

| Service          | Unit                     | Port | Description                  |
|------------------|--------------------------|------|------------------------------|
| Relay            | `nova-relay.service`     | —    | Main Telegram bot            |
| Voice            | `nova-voice.service`     | 8080 | Voice/SMS server (Twilio)    |
| Dashboard        | `nova-dashboard.service` | 3033 | Web dashboard                |
| Mini App         | `nova-miniapp.service`   | 3034 | Telegram Mini App            |
| Scheduler        | cron (`/etc/cron.d/nova`) | —   | Periodic services            |
| Caddy            | `caddy.service`          | 80, 443 | Reverse proxy, auto HTTPS |

## Server Structure

```
/opt/nova/           — Project files (synced from local via rsync)
/opt/nova/.env       — Environment variables (server-only, never synced)
/opt/nova/config/    — profile.md and other config (preserved across deploys)
/home/nova/.claude/  — Claude Code auth tokens and runtime data
```

## Logs

```bash
# Tail logs for a specific service
journalctl -u nova-relay -f
journalctl -u nova-voice -f
journalctl -u nova-dashboard -f
journalctl -u nova-miniapp -f

# All nova services
journalctl -u 'nova-*' -f

# Scheduler (cron) logs
grep nova /var/log/syslog
```

## Health Checks

```bash
# Voice server
curl https://nova.1osm.com/health

# Service statuses
systemctl status nova-relay nova-voice nova-dashboard nova-miniapp
```

## Rollback

If a deploy breaks something:

```bash
# Check the git log locally for the last known good commit
git log --oneline -10

# Checkout that commit locally, then re-sync
git checkout <commit-hash>
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='.mcp.json' \
  ./ root@nova.07labs.com:/opt/nova/
ssh root@nova.07labs.com "cd /opt/nova && bun install && systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp"

# Don't forget to go back to master
git checkout master
```

## First-Time Server Setup

If setting up a new server from scratch:

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
2. Install Caddy: `apt install -y caddy`
3. Install Node.js 22 + Claude CLI (for relay)
4. Create `nova` user: `useradd -r -m -s /bin/bash nova`
5. Copy Claude auth: `cp -r /root/.claude /home/nova/.claude && chown -R nova:nova /home/nova/.claude`
6. Rsync project to `/opt/nova`, run `bun install`
7. Copy `.env.example` to `.env` and fill in all values
8. Copy `config/profile.example.md` to `config/profile.md`
9. Create systemd unit files (see `/etc/systemd/system/nova-*.service`)
10. Install crontab: copy adapted entries to `/etc/cron.d/nova`
11. Enable services: `systemctl enable --now nova-relay nova-voice nova-dashboard nova-miniapp`
12. Point DNS for `nova.1osm.com` and `csm.07labs.com` to server IP
13. Caddy handles HTTPS certificates automatically
