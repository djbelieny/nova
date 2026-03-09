# Nova — Deployment Guide

> Production server: `root@nova.07labs.com` (Ubuntu 24.04)
> Project directory: `/opt/nova`
> Domains: `nova.07labs.com` (voice/SMS), `dashboard.nova.07labs.com` (web/dashboard)
> Runs natively via systemd (no Docker)

## Branch Strategy

| Branch       | Purpose                                      |
|--------------|----------------------------------------------|
| `main`       | Development — push changes here first        |
| `production` | Production — only updated via merged PRs     |
| `self-edit/*`| Nova's self-modifications (auto-created)     |

## Quick Deploy (most common)

From your local machine, after making changes:

```bash
# 1. Push changes to main
git push origin main

# 2. Merge main → production and push
git checkout production
git merge main
git push origin production
git checkout main

# 3. Pull and restart on server
ssh root@your-server.com "bash /opt/nova/scripts/deploy.sh"
```

## Services

| Service          | Unit                     | Port | Description                  |
|------------------|--------------------------|------|------------------------------|
| Core             | `nova-relay.service`     | —    | Main Telegram bot            |
| Voice            | `nova-voice.service`     | 8080 | Voice/SMS server (Twilio)    |
| Dashboard        | `nova-dashboard.service` | 3033 | Web dashboard                |
| Mini App         | `nova-miniapp.service`   | 3034 | Telegram Mini App            |
| Exec - CEO       | `nova-exec-ceo.service`  | —    | CEO executive bot            |
| Exec - CFO       | `nova-exec-cfo.service`  | —    | CFO executive bot            |
| Exec - CMO       | `nova-exec-cmo.service`  | —    | CMO executive bot            |
| Exec - CTO       | `nova-exec-cto.service`  | —    | CTO executive bot            |
| Exec - COO       | `nova-exec-coo.service`  | —    | COO executive bot            |
| Exec - Research  | `nova-exec-research.service` | — | Research executive bot       |
| Exec - Critic    | `nova-exec-critic.service`   | — | Critic executive bot         |
| Scheduler        | cron (`/etc/cron.d/nova`) | —   | Periodic services            |
| Caddy            | `caddy.service`          | 80, 443 | Reverse proxy, auto HTTPS |

## Executive Board Setup

The 7 executive bots run as separate systemd services on the same VPS, each with its own `.env.{role}` file.

### First-time setup

```bash
# 1. Copy .env files to server (from local machine)
scp .env.ceo .env.cfo .env.cmo .env.cto .env.coo .env.research .env.critic root@nova.07labs.com:/opt/nova/

# 2. Fix ownership
ssh root@nova.07labs.com "chown nova:nova /opt/nova/.env.*"

# 3. Install and enable systemd services
ssh root@nova.07labs.com "bash /opt/nova/scripts/setup-execs.sh"

# 4. Start all executive services
ssh root@nova.07labs.com "systemctl start nova-exec-ceo nova-exec-cfo nova-exec-cmo nova-exec-cto nova-exec-coo nova-exec-research nova-exec-critic"
```

### Logs

```bash
# All exec services
journalctl -u 'nova-exec-*' -f

# Specific exec
journalctl -u nova-exec-ceo -f
```

### Status

```bash
systemctl status nova-exec-*
```

## Server Structure

```
/opt/nova/           — Project files (cloned from GitHub, production branch)
/opt/nova/.env       — Environment variables (server-only, in .gitignore)
/opt/nova/.mcp.json  — MCP config (server-only, in .gitignore)
/opt/nova/config/    — profile.md and other config (preserved across deploys)
/home/nova/.claude/  — Claude Code auth tokens and runtime data
/home/nova/.ssh/     — Deploy key for GitHub access
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
curl https://your-domain.com/health

# Service statuses
systemctl status nova-relay nova-voice nova-dashboard nova-miniapp
```

## Rollback

If a deploy breaks something:

```bash
# On server — revert to previous commit
ssh root@your-server.com
cd /opt/nova
sudo -u nova git log --oneline -5        # find last good commit
sudo -u nova git revert HEAD             # revert the bad commit
bun install
systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp
```

Or for an emergency rollback to a specific commit:

```bash
sudo -u nova git reset --hard <commit-hash>
bun install
systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp
```

## Nova Self-Editing

Nova can edit its own source code in production via the self-edit workflow:

1. Nova creates a `self-edit/<slug>` branch from `production`
2. Makes changes, commits
3. Merges branch into `main`, pushes
4. Merges `main` into `production`, pushes
5. Cleans up the feature branch
6. Tells you to send `/reload` to apply changes

## First-Time Server Setup

If setting up a new server from scratch:

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
2. Install Caddy: `apt install -y caddy`
3. Install Node.js 22 + Claude CLI (for Nova)
4. Create `nova` user: `useradd -r -m -s /bin/bash nova`
5. Generate SSH deploy key for nova user (see below)
6. Clone repo: `sudo -u nova git clone git@github.com:your-github-username/nova.git /opt/nova`
7. Checkout production: `cd /opt/nova && sudo -u nova git checkout production`
8. Copy `.env.example` to `.env` and fill in all values
9. Copy `config/profile.example.md` to `config/profile.md`
10. Run `bun install`
11. Create systemd unit files (see `/etc/systemd/system/nova-*.service`)
12. Install crontab: copy adapted entries to `/etc/cron.d/nova`
13. Enable services: `systemctl enable --now nova-relay nova-voice nova-dashboard nova-miniapp`
14. Point DNS for your domains to server IP
15. Caddy handles HTTPS certificates automatically

### SSH Deploy Key Setup

```bash
# As nova user
sudo -u nova ssh-keygen -t ed25519 -C "nova-deploy@your-domain.com" -f /home/nova/.ssh/id_ed25519 -N ""
sudo -u nova cat /home/nova/.ssh/id_ed25519.pub
# Add the public key as a deploy key on GitHub (Settings > Deploy keys, enable write access)

# Add GitHub to known hosts
sudo -u nova ssh-keyscan github.com >> /home/nova/.ssh/known_hosts

# Configure git user
sudo -u nova git config --global user.name "Nova Bot"
sudo -u nova git config --global user.email "nova@your-domain.com"
```
