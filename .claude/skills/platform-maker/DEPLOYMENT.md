# Deployment Guide

This guide covers deploying the generated SaaS platform to production environments.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Database Setup](#database-setup)
4. [Local Development](#local-development)
5. [Docker Deployment](#docker-deployment)
6. [Manual VPS Deployment](#manual-vps-deployment)
7. [Nginx Configuration](#nginx-configuration)
8. [SSL/TLS Setup](#ssltls-setup)
9. [Square Integration](#square-integration)
10. [Monitoring & Logging](#monitoring--logging)
11. [Backup & Recovery](#backup--recovery)
12. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 1 core | 2+ cores |
| RAM | 1 GB | 2+ GB |
| Storage | 10 GB | 20+ GB SSD |
| Node.js | 20.x | 22.x LTS |
| PostgreSQL | 14.x | 16.x |

### Required Software

```bash
# Node.js (using nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22

# pnpm
npm install -g pnpm

# PostgreSQL (Ubuntu/Debian)
sudo apt update
sudo apt install postgresql postgresql-contrib

# PostgreSQL (macOS)
brew install postgresql@16
brew services start postgresql@16

# Docker (optional)
curl -fsSL https://get.docker.com | sh
```

---

## Environment Variables

### Required Variables

Create a `.env` file in the project root:

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/platform_db"

# Authentication
JWT_SECRET="your-secure-random-string-at-least-32-chars"

# Square Payment (Production)
SQUARE_ENVIRONMENT="production"
SQUARE_ACCESS_TOKEN="your-square-access-token"
SQUARE_APPLICATION_ID="your-square-application-id"
SQUARE_LOCATION_ID="your-square-location-id"
SQUARE_WEBHOOK_SIGNATURE_KEY="your-webhook-signature-key"
```

### Optional Variables

```bash
# Email (Resend)
RESEND_API_KEY="re_your_api_key"
RESEND_FROM_EMAIL="noreply@yourdomain.com"

# File Storage (AWS S3)
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_REGION="us-east-1"
AWS_S3_BUCKET="your-bucket-name"

# Server Configuration
PORT=5000
HOST="0.0.0.0"
NODE_ENV="production"

# Exchange Rates (optional, for multi-currency)
EXCHANGE_RATE_API_KEY="your-api-key"

# OAuth (optional)
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
```

### Generating Secrets

```bash
# Generate JWT_SECRET
openssl rand -base64 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## Database Setup

### PostgreSQL Setup

```bash
# Connect to PostgreSQL
sudo -u postgres psql

# Create database and user
CREATE DATABASE platform_db;
CREATE USER platform_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE platform_db TO platform_user;
\c platform_db
GRANT ALL ON SCHEMA public TO platform_user;
\q
```

### Connection String Format

```
postgresql://[user]:[password]@[host]:[port]/[database]?sslmode=require
```

Examples:
```bash
# Local development
DATABASE_URL="postgresql://platform_user:password@localhost:5432/platform_db"

# Remote with SSL
DATABASE_URL="postgresql://user:pass@db.example.com:5432/mydb?sslmode=require"

# Neon (serverless Postgres)
DATABASE_URL="postgresql://user:pass@ep-cool-name.us-east-2.aws.neon.tech/neondb?sslmode=require"

# Supabase
DATABASE_URL="postgresql://postgres:pass@db.project.supabase.co:5432/postgres"
```

### Running Migrations

```bash
# Generate migrations from schema changes
pnpm drizzle-kit generate --config=drizzle.config.postgres.ts

# Push schema directly (development)
pnpm drizzle-kit push --config=drizzle.config.postgres.ts

# Run migrations (production)
pnpm drizzle-kit migrate --config=drizzle.config.postgres.ts
```

### Seeding Data

```bash
# Run seed script
pnpm seed

# Or manually
npx tsx drizzle/seed.ts
```

---

## Local Development

### Quick Start

```bash
# Clone and install
git clone https://github.com/your-org/your-platform.git
cd your-platform
pnpm install

# Set up environment
cp .env.example .env.development
# Edit .env.development with your values

# Set up database (SQLite for development)
pnpm drizzle-kit push --config=drizzle.config.sqlite.ts
pnpm seed

# Start development server
pnpm dev
```

### Development URLs

- **Frontend**: http://localhost:3000
- **API**: http://localhost:5000/api
- **tRPC Playground**: http://localhost:5000/api/trpc-playground

### Testing

```bash
# Type checking
pnpm check

# Run tests
pnpm test

# Run specific test file
pnpm test server/payment/square.test.ts
```

---

## Docker Deployment

### Dockerfile

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN pnpm build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Set environment
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/health || exit 1

# Start application
CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "5000:5000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - JWT_SECRET=${JWT_SECRET}
      - SQUARE_ACCESS_TOKEN=${SQUARE_ACCESS_TOKEN}
      - SQUARE_APPLICATION_ID=${SQUARE_APPLICATION_ID}
      - SQUARE_LOCATION_ID=${SQUARE_LOCATION_ID}
      - SQUARE_WEBHOOK_SIGNATURE_KEY=${SQUARE_WEBHOOK_SIGNATURE_KEY}
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=platform_user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=platform_db
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U platform_user -d platform_db"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app
    restart: unless-stopped

volumes:
  postgres_data:
```

### Building and Running

```bash
# Build image
docker build -t your-platform:latest .

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f app

# Run migrations inside container
docker-compose exec app pnpm drizzle-kit migrate --config=drizzle.config.postgres.ts

# Seed database
docker-compose exec app pnpm seed
```

---

## Manual VPS Deployment

### Server Setup (Ubuntu 22.04+)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
sudo npm install -g pnpm

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install nginx
sudo apt install -y nginx

# Install certbot for SSL
sudo apt install -y certbot python3-certbot-nginx

# Create app user
sudo useradd -m -s /bin/bash platform
sudo usermod -aG sudo platform
```

### Application Setup

```bash
# Switch to app user
sudo su - platform

# Clone repository
git clone https://github.com/your-org/your-platform.git ~/app
cd ~/app

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
nano .env  # Edit with production values

# Build application
pnpm build

# Run migrations
pnpm drizzle-kit migrate --config=drizzle.config.postgres.ts

# Seed database
pnpm seed
```

### PM2 Process Manager

```bash
# Install PM2
sudo npm install -g pm2

# Create ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'platform',
    script: 'dist/index.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    env_file: '.env'
  }]
};
EOF

# Start application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Set up PM2 to start on boot
pm2 startup systemd -u platform --hp /home/platform
```

### Systemd Service (Alternative to PM2)

```bash
# Create service file
sudo nano /etc/systemd/system/platform.service
```

```ini
[Unit]
Description=Platform Application
After=network.target postgresql.service

[Service]
Type=simple
User=platform
WorkingDirectory=/home/platform/app
EnvironmentFile=/home/platform/app/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=platform

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable platform
sudo systemctl start platform

# Check status
sudo systemctl status platform
```

---

## Nginx Configuration

### Basic Configuration

```nginx
# /etc/nginx/sites-available/platform
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # SSL certificates (managed by certbot)
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1000;

    # Static files (built frontend)
    location / {
        root /home/platform/app/dist/public;
        try_files $uri $uri/ /index.html;

        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # API proxy
    location /api {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # Square webhooks (no rate limiting)
    location /api/square/webhook {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Enable Site

```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/platform /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

---

## SSL/TLS Setup

### Let's Encrypt with Certbot

```bash
# Obtain certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Test auto-renewal
sudo certbot renew --dry-run

# Certificates auto-renew via systemd timer
sudo systemctl status certbot.timer
```

### Certificate Files Location

```
/etc/letsencrypt/live/yourdomain.com/
├── fullchain.pem   # Certificate + intermediates
├── privkey.pem     # Private key
├── cert.pem        # Certificate only
└── chain.pem       # Intermediate certificates
```

---

## Square Integration

### Production Setup

1. **Create Square Application**
   - Go to [Square Developer Dashboard](https://developer.squareup.com/apps)
   - Create new application
   - Note the Application ID

2. **Get Access Token**
   - In your app, go to "Credentials"
   - Copy the "Production Access Token"

3. **Get Location ID**
   - Go to "Locations" in Square Dashboard
   - Copy the Location ID for your business

4. **Configure Webhooks**
   - Go to "Webhooks" in your app
   - Add endpoint: `https://yourdomain.com/api/square/webhook`
   - Subscribe to events:
     - `payment.completed`
     - `payment.canceled`
     - `payment.failed`
   - Copy the "Signature Key"

### Environment Variables

```bash
SQUARE_ENVIRONMENT="production"
SQUARE_ACCESS_TOKEN="EAAAxxxxxxxxxxxxxxxxxxxxxxxx"
SQUARE_APPLICATION_ID="sq0idp-xxxxxxxxxxxxxxxxxx"
SQUARE_LOCATION_ID="Lxxxxxxxxxxxxxxxxx"
SQUARE_WEBHOOK_SIGNATURE_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### Testing Webhooks Locally

```bash
# Install Square CLI
npm install -g @square/cli

# Forward webhooks to localhost
square sandbox webhook listen --webhook-url http://localhost:5000/api/square/webhook
```

---

## Monitoring & Logging

### Application Logs

```bash
# PM2 logs
pm2 logs platform

# Systemd logs
journalctl -u platform -f

# Docker logs
docker-compose logs -f app
```

### Health Check Endpoint

The application exposes `/api/health` for monitoring:

```bash
curl https://yourdomain.com/api/health
# {"status":"ok","timestamp":"2024-01-15T12:00:00Z","version":"1.0.0"}
```

### Uptime Monitoring

Recommended services:
- [UptimeRobot](https://uptimerobot.com/) (free tier available)
- [Better Uptime](https://betteruptime.com/)
- [Pingdom](https://www.pingdom.com/)

Configure monitors for:
- `https://yourdomain.com` (homepage)
- `https://yourdomain.com/api/health` (API health)

### Error Tracking

Consider adding:
- [Sentry](https://sentry.io/) for error tracking
- [LogRocket](https://logrocket.com/) for session replay

```bash
# Add Sentry (optional)
pnpm add @sentry/node @sentry/react
```

---

## Backup & Recovery

### Database Backups

```bash
# Create backup script
cat > /home/platform/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/home/platform/backups"
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="platform_backup_${DATE}.sql.gz"

mkdir -p $BACKUP_DIR
pg_dump $DATABASE_URL | gzip > $BACKUP_DIR/$FILENAME

# Keep only last 7 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete
EOF

chmod +x /home/platform/backup.sh

# Add to crontab (daily at 2 AM)
crontab -e
# Add: 0 2 * * * /home/platform/backup.sh
```

### Restore from Backup

```bash
# Restore database
gunzip -c backup_file.sql.gz | psql $DATABASE_URL
```

### S3 Backup (Optional)

```bash
# Install AWS CLI
sudo apt install awscli

# Configure credentials
aws configure

# Sync backups to S3
aws s3 sync /home/platform/backups s3://your-bucket/backups/
```

---

## Troubleshooting

### Common Issues

#### Database Connection Failed

```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check firewall
sudo ufw allow 5432/tcp
```

#### Application Won't Start

```bash
# Check Node.js version
node -v

# Check for missing dependencies
pnpm install

# Check environment variables
cat .env

# Check for port conflicts
sudo lsof -i :5000
```

#### Nginx 502 Bad Gateway

```bash
# Check if app is running
pm2 status
# or
sudo systemctl status platform

# Check app logs
pm2 logs platform --err

# Check nginx error logs
sudo tail -f /var/log/nginx/error.log
```

#### SSL Certificate Issues

```bash
# Check certificate expiry
sudo certbot certificates

# Renew certificate manually
sudo certbot renew

# Test SSL configuration
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com
```

#### Square Webhook Not Receiving

1. Verify webhook URL is publicly accessible
2. Check webhook signature key matches
3. Verify events are subscribed in Square Dashboard
4. Check server logs for incoming requests:
   ```bash
   pm2 logs platform | grep webhook
   ```

### Performance Tuning

#### Node.js Memory

```bash
# Increase memory limit (in ecosystem.config.js)
node_args: '--max-old-space-size=2048'
```

#### PostgreSQL Tuning

```sql
-- In postgresql.conf
shared_buffers = 256MB
effective_cache_size = 768MB
maintenance_work_mem = 64MB
work_mem = 16MB
```

#### Nginx Worker Processes

```nginx
# In nginx.conf
worker_processes auto;
worker_connections 1024;
```

---

## Deployment Checklist

- [ ] PostgreSQL database created and configured
- [ ] Environment variables set in `.env`
- [ ] Database migrations run successfully
- [ ] Database seeded with initial data
- [ ] Application builds without errors (`pnpm build`)
- [ ] Type checking passes (`pnpm check`)
- [ ] Application starts and responds to health check
- [ ] Nginx configured and SSL certificate installed
- [ ] Square webhook URL configured and verified
- [ ] DNS records pointing to server
- [ ] Firewall configured (80, 443 open; 5432, 5000 closed)
- [ ] Backup script configured and tested
- [ ] Monitoring/uptime alerts configured
- [ ] First admin user created (first signup becomes admin)

---

## Next Steps

After successful deployment:

1. **Test the checkout flow** end-to-end with Square sandbox
2. **Switch to production** Square credentials
3. **Set up custom domain** email for transactional emails
4. **Configure analytics** (Google Analytics, Plausible, etc.)
5. **Set up CI/CD** for automated deployments

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system overview.
