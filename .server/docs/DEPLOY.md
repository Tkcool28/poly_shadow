# Polymarket Copy Trade — Deployment Guide

## Architecture

```
┌─────────────────────────┐
│   GitHub Repository     │
│   push to main          │
│         ↓               │
│   [build.yml]           │
│   typecheck, test       │
│         ↓               │
│   → GHCR: :latest       │
│   → GHCR: :sha-xxxxx   │
└─────────────────────────┘
              ↓
    ┌─────────────────────┐
    │ Manual Trigger      │
    │ deploy-runner.yml   │
    │ image_tag: latest   │
    │ profiles: arb,scalp │
    └─────────────────────┘
              ↓
    ┌─────────────────────────────────────────────┐
    │ Self-hosted Runner (polymarket-copytrade)    │
    │                                             │
    │  polymarket_postgres       (127.0.0.1:5438) │
    │  polymarket_migrate        (one-shot)       │
    │  polymarket_copy_trader    (daemon)          │
    │  polymarket_trade_monitor  (daemon)          │
    │  polymarket_history_backfiller (daemon, 8GB) │
    │  polymarket_leaderboard_scanner (cron 12h)   │
    │  polymarket_score_calculator    (cron 6h)    │
    │  polymarket_arb_worker    (opt-in profile)   │
    │  polymarket_scalp_worker  (opt-in profile)   │
    │                                             │
    │  Network: polymarket-network (isolated)      │
    └─────────────────────────────────────────────┘
```

No worker containers expose host ports — only PostgreSQL (5438) for debug/psql access.

## GitHub Secrets

Configure in repository **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Required | Description |
|--------|----------|-------------|
| `ENV_FILE` | Yes | Full `.env` contents (all 70+ vars). See `.env.example` for template. `DATABASE_URL` must be: `postgresql://polymarket:<PG_PASSWORD>@polymarket_postgres:5432/polymarket_copytrade` |
| `PG_PASSWORD` | Yes | PostgreSQL password (use `openssl rand -base64 32`) |

`GITHUB_TOKEN` is automatic — handles GHCR image push/pull.

## Server Setup (One-Time)

### 1. Add Runner Label

The self-hosted runner already exists. Add the `polymarket-copytrade` label:

**Via GitHub UI:** Settings → Actions → Runners → (select runner) → edit labels → add `polymarket-copytrade`

**Via CLI:**
```bash
cd ~/actions-runner
./config.sh --url https://github.com/mantotan/polymarket-copy-trade \
  --token YOUR_TOKEN \
  --labels polymarket-copytrade
```

### 2. Enable Lingering (if not already)

Keeps user services running after logout:
```bash
sudo loginctl enable-linger $(whoami)
```

### 3. Install Systemd Service

```bash
mkdir -p ~/.config/systemd/user
cp .server/systemd/polymarket-copytrade.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable polymarket-copytrade
```

### 4. Setup Health Check Cron

```bash
crontab -e
# Add:
*/5 * * * * ~/polymarket-copytrade/.server/scripts/health-check.sh
```

## Deployment

### Normal Deploy (latest)

1. Push to `main` → `build.yml` builds and pushes image to GHCR
2. Go to **Actions → Deploy to Production → Run workflow**
3. Click **Run workflow** (defaults: `image_tag=latest`, no profiles)

### Deploy Specific SHA

In the Deploy workflow dispatch, enter the tag (e.g., `sha-abc1234`) in the `image_tag` field.

### Enable Optional Workers

To enable arb-worker or scalp-worker:

1. Ensure `ARB_ENABLED=true` (or `SCALP_ENABLED=true`) is in the `ENV_FILE` secret
2. In the Deploy workflow, enter `arb` or `arb,scalp` in the `profiles` field

## PostgreSQL

New instance on host port **5438** (distinct from 5432, 5433-5436, 6437 used by other projects).

```bash
# Connect from host
psql -h localhost -p 5438 -U polymarket -d polymarket_copytrade

# Connect via Docker
docker exec -it polymarket_postgres psql -U polymarket -d polymarket_copytrade

# Check SystemHealth heartbeats
docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -c \
  "SELECT \"jobName\", \"lastRunAt\", \"lastRunResult\" FROM \"SystemHealth\" ORDER BY \"lastRunAt\" DESC;"
```

## Logs

All workers log to `/app/logs/` inside containers, mounted to Docker volume `polymarket_logs`.

```bash
cd ~/polymarket-copytrade

# Stream all workers
docker compose -f docker-compose.ghcr.yml logs -f

# Single worker
docker compose -f docker-compose.ghcr.yml logs -f copy-trader

# Container status
docker compose -f docker-compose.ghcr.yml ps
```

## Rollback

### Automatic Rollback

The deploy workflow automatically rolls back to the previous image tag if deployment fails.

### Manual Application Rollback

```bash
cd ~/polymarket-copytrade

# Roll back to specific tag
IMAGE_TAG=sha-previous docker compose -f docker-compose.ghcr.yml up -d \
  copy-trader trade-monitor history-backfiller leaderboard-scanner score-calculator
```

### Database Rollback

```bash
# List available backups
ls -la ~/polymarket-copytrade/backups/

# Restore from backup
gunzip -c ~/polymarket-copytrade/backups/pre-deploy-YYYYMMDD-HHMMSS.sql.gz | \
  docker exec -i polymarket_postgres psql -U polymarket polymarket_copytrade
```

## Migration from Native PM2

### Data Migration

```bash
# 1. Dump existing native PostgreSQL
pg_dump -h localhost -p 5432 polymarket_copytrade > /tmp/copytrade_dump.sql

# 2. Deploy Docker stack (creates new PG on port 5438)
# (trigger deploy workflow)

# 3. Restore into Docker PostgreSQL
docker exec -i polymarket_postgres psql -U polymarket -d polymarket_copytrade < /tmp/copytrade_dump.sql
```

### Cutover

```bash
# 1. Stop PM2 processes
pm2 stop all

# 2. Deploy Docker stack via GitHub Actions
# 3. Verify all containers healthy
docker compose -f docker-compose.ghcr.yml ps

# 4. Monitor for 30 minutes
docker compose -f docker-compose.ghcr.yml logs -f

# 5. Once stable, clean up PM2
pm2 delete all && pm2 save
```

## Troubleshooting

### Container Won't Start

```bash
docker logs polymarket_copy_trader
docker compose -f docker-compose.ghcr.yml logs --tail=50 copy-trader
```

### Migration Failures

```bash
docker compose -f docker-compose.ghcr.yml logs migrate
```

### Runner Not Picking Up Jobs

```bash
cd ~/actions-runner
./run.sh
# Or if installed as service:
sudo ./svc.sh status
```

### Health Check

```bash
# Run manually
~/polymarket-copytrade/.server/scripts/health-check.sh

# View health check log
tail -f ~/polymarket-copytrade/health-check.log
```

## File Structure (on runner)

```
~/polymarket-copytrade/
├── docker-compose.ghcr.yml    # Production compose file
├── prisma.config.ts            # Prisma config
├── package.json                # For prisma CLI
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── secrets/                   # Persistent secret files (chmod 600)
│   ├── env.txt                # All env vars
│   └── pg_password.txt        # PostgreSQL password
├── backups/                   # Pre-deploy database backups
│   └── pre-deploy-*.sql.gz
├── health-check.log           # Health check output
└── .server/
    └── scripts/
        └── health-check.sh
```
