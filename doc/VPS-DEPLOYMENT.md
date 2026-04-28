# Paperclip VPS Deployment Guide

This guide covers deploying Paperclip to a Vultr VPS using GitHub Actions for automated CI/CD.

## Overview

The deployment uses:
- **GitHub Actions** for CI/CD automation
- **Docker Compose** with `docker-compose.vps.yml` for production orchestration
- **Immutable release directories** for safe, reproducible deployments
- **`/opt/paperclip/current-release` pointer** as the source of truth for active release
- **SSH key authentication** between GitHub Actions and the VPS

Repository source of truth for VPS deploys:
- **Deploy from `origin`**: `git@github.com:viraforge/paperclip.git`
- **Track upstream separately**: `git@github.com:paperclipai/paperclip.git`
- Do not treat an older personal fork as the production deployment source

## Architecture

```
GitHub Actions          VPS (64.176.199.162)
     |                          |
     | 1. Build & Verify          |
     |--------------------------->|
     | 2. Upload ui/dist          |
     |                            |
     | 3. SSH + rsync             |
     |--------------------------->| /opt/paperclip/releases/<id>/
     |                            |
     | 4. Remote build            |
     |--------------------------->| docker compose build
     |                            |
     | 5. DB backup               |
     |--------------------------->| pg_dump
     |                            |
     | 6. Run migrations          |
     |--------------------------->| pnpm db:migrate
     |                            |
     | 7. Recreate container      |
     |--------------------------->| docker compose up -d
     |                            |
     | 8. Validate                |
     |<---------------------------| health checks
     |                            |
     | 9. Cleanup                 |
     |--------------------------->| prune old releases
```

## Required GitHub Secrets

Configure these in your GitHub repository settings (Settings > Secrets and variables > Actions):

| Secret | Description | Example |
|--------|-------------|---------|
| `VULTR_HOST` | VPS IP address | `64.176.199.162` |
| `VULTR_USER` | SSH user for deployment | `root` |
| `VULTR_SSH_PRIVATE_KEY` | SSH private key for GitHub Actions | Contents of `~/.ssh/paperclip-gha-deploy` |
| `VULTR_KNOWN_HOSTS` | Pinned host key for SSH verification | Output of `ssh-keyscan -H 64.176.199.162` |

## Required VPS Configuration

### 1. SSH Key Setup

Generate and install the deploy key:

```bash
# On your local machine:
ssh-keygen -t ed25519 -f ~/.ssh/paperclip-gha-deploy -C "paperclip-github-actions-deploy" -N ""

# Install public key on VPS:
cat ~/.ssh/paperclip-gha-deploy.pub | ssh root@64.176.199.162 'cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'

# Capture known_hosts:
ssh-keyscan -H 64.176.199.162
```

Add the private key contents and known_hosts output to GitHub secrets.

### 2. Environment File

Create `/opt/paperclip/.env` on the VPS with these required variables:

```bash
# Required for Paperclip operation (use the URL users actually open in the browser)
# Example with Cloudflare hostname + nginx edge on :80 (see "Cloudflare edge" below):
PAPERCLIP_PUBLIC_URL=https://pc.example.com
# Or direct to the app port (no Cloudflare / no edge):
# PAPERCLIP_PUBLIC_URL=http://64.176.199.162:3100
BETTER_AUTH_SECRET=$(openssl rand -base64 32)

# Required for OpenCode agent support
OPENCODE_CONFIG_CONTENT=<your_opencode_config>
ZAI_API_KEY=<your_zai_api_key>
MINIMAX_API_KEY=<your_minimax_api_key>
```

**Note:** All these variables are required. The deployment will fail if any are missing.

### 3. Cloudflare edge (Free plan) on port 80

`docker-compose.vps.yml` includes an **`edge`** service (`nginx`) that listens on **host port 80** and reverse-proxies to the Paperclip container on **3100**. That avoids Cloudflare Enterprise “origin port rewrite” (not available on Free).

1. **DNS:** Proxied **A** (or **AAAA**) record for your hostname → VPS IP.
2. **SSL/TLS** in Cloudflare: **Flexible** (HTTPS visitor → Cloudflare, HTTP Cloudflare → origin on :80). For **Full** / **Full (strict)** you must terminate TLS on the origin (not covered by this default stack).
3. **Firewall:** Allow **TCP 80** (and **443** only if you add TLS on the box) from the internet on the VPS / cloud firewall.
4. **`PAPERCLIP_PUBLIC_URL`:** Set to **`https://<your-hostname>`** (same host users load in the browser) so auth callbacks and links are correct.

5. **`PAPERCLIP_ALLOWED_HOSTNAMES` (recommended when using a hostname):** Include the **VPS public IP** as well, e.g. `64.176.199.162`, comma-separated. Otherwise the private hostname gate may block **`Host: <ip>`** requests (including GitHub Actions deploy checks that curl `http://$VULTR_HOST/...`).

6. **Allowed hostnames are a union** of: values in **`/paperclip/instances/default/config.json`** (`server.allowedHostnames`, e.g. from `pnpm paperclipai allowed-hostname …`), **`PAPERCLIP_ALLOWED_HOSTNAMES`**, and the hostname parsed from **`PAPERCLIP_PUBLIC_URL`**. Persisting the Cloudflare hostname via **`paperclipai allowed-hostname`** inside the container (or editing `config.json` on the volume) keeps it effective across restarts even if `.env` is temporarily wrong.

Direct **`http://<ip>:3100`** remains available for debugging while **`edge`** serves **`http://<hostname>/`** through Cloudflare.

## Deployment Flow

### Trigger

The workflow runs automatically on:
- Push to `master` branch on the `viraforge/paperclip` repository
- Manual trigger via `workflow_dispatch`

Deploy execution is restricted to manual `workflow_dispatch` runs. Pushes to `master` run verification only.

### Steps

1. **Verify Job** (runs first):
   - Checkout code
   - Install dependencies (`pnpm install`)
   - Run typecheck and tests
   - Build application (`pnpm build`)
   - Verify `Dockerfile.vps` builds successfully
   - Upload `ui/dist` as artifact

2. **Deploy Job** (after verify succeeds):
   - Download `ui/dist` artifact
   - Run deploy guard (`./scripts/deploy-guard.sh --require-ref "$GITHUB_SHA" --allow-detached-head`)
   - Configure SSH with connection reuse
   - Create immutable release directory on VPS
   - Sync repository to release directory
   - Backup production database
   - Build Docker image
   - Run database migrations
   - Recreate **server** and **edge** (nginx on host `:80` → app `:3100`) containers
   - Assert runtime provenance label matches `github.sha`
   - Validate deployment (health checks, env vars, logs)
   - Atomically update `/opt/paperclip/current-release`
   - Cleanup old releases (keeps last 5)

### Immutable Releases

Each deployment creates a unique release directory:
```
/opt/paperclip/releases/
  <sha>-<run_id>-<attempt>/
    docker-compose.vps.yml
    Dockerfile.vps
    ...
```

Benefits:
- Rollback possible by referencing previous release
- No interference between deployments
- Clean separation of deployment artifacts

### Retention Policy

After successful deployment:
- **Release directories**: Keep 5 most recent
- **Database backups**: Keep 10 most recent
- **Docker cache**: Pruned to free space

## Validation

The deployment validates:

1. **Container freshness** - Server container started within last 15 minutes
2. **Health endpoints** - Localhost `:3100`, external `:3100`, and external **`:80`** (edge proxy) health checks pass
3. **Static assets** - UI assets are served correctly
4. **Environment variables** - All required vars present and non-empty:
   - `PAPERCLIP_OPENCODE_COMMAND`
   - `OPENCODE_CONFIG_CONTENT`
   - `ZAI_API_KEY`
   - `MINIMAX_API_KEY`
   - `BETTER_AUTH_SECRET`
   - `PAPERCLIP_PUBLIC_URL` (non-localhost)
5. **Startup logs** - No fatal errors, success signal present

## Recovery Procedures

**Policy:** Never edit source files directly on the VPS. All changes must be committed, reviewed, pass required checks, and be deployed through CI.

### If CI Deploy Fails

1. **Check GitHub Actions logs** for specific failure reason
2. **Verify VPS is reachable**: `ssh root@64.176.199.162`
3. **Identify the active release directory**:
   ```bash
   if [ -f /opt/paperclip/current-release ]; then
     CURRENT_RELEASE=$(cat /opt/paperclip/current-release)
   else
     CURRENT_RELEASE=$(ls -td /opt/paperclip/releases/* | head -1)
   fi
   printf 'CURRENT_RELEASE=%s\n' "$CURRENT_RELEASE"
   ```
4. **Check container status**:
   ```bash
   docker compose --project-name paperclip --env-file /opt/paperclip/.env -f "$CURRENT_RELEASE/docker-compose.vps.yml" ps
   docker logs paperclip-server-1
   ```
5. **Database is backed up** before each deploy in `/opt/paperclip/db-backups/`

### Manual Recovery

If the automated deploy leaves the system in a bad state:

```bash
# SSH to VPS
ssh root@64.176.199.162

if [ -f /opt/paperclip/current-release ]; then
  CURRENT_RELEASE=$(cat /opt/paperclip/current-release)
else
  CURRENT_RELEASE=$(ls -td /opt/paperclip/releases/* | head -1)
fi
printf 'CURRENT_RELEASE=%s\n' "$CURRENT_RELEASE"
cd "$CURRENT_RELEASE"

# Check status
docker compose --project-name paperclip --env-file /opt/paperclip/.env -f "$CURRENT_RELEASE/docker-compose.vps.yml" ps

# View logs
docker logs paperclip-server-1

# Restart services
docker compose --project-name paperclip --env-file /opt/paperclip/.env -f "$CURRENT_RELEASE/docker-compose.vps.yml" restart

# Or recreate from last known good release
# (set TARGET_RELEASE to a prior directory under /opt/paperclip/releases/)
# TARGET_RELEASE=/opt/paperclip/releases/<sha>-<run_id>-<attempt>
# docker compose --project-name paperclip --env-file /opt/paperclip/.env -f "$TARGET_RELEASE/docker-compose.vps.yml" up -d --force-recreate --no-deps server
```

### Manual Deploy Preflight (Required)

If you run a manual deploy from a local checkout, always run:

```bash
./scripts/deploy-guard.sh --require-ref "$(git rev-parse HEAD)"
```

This blocks deployments from dirty worktrees (including untracked files), which prevents hidden VPS-only customizations from drifting away from git history.

### Restoring from Backup

```bash
# List available backups
ls -la /opt/paperclip/db-backups/

# Restore (replace <timestamp> with actual backup)
docker exec -i paperclip-db-1 pg_restore -U paperclip -d paperclip --clean < /opt/paperclip/db-backups/pre-deploy-<timestamp>.dump
```

## Files Reference

| File | Purpose |
|------|---------|
| `.github/workflows/deploy-vultr.yml` | GitHub Actions workflow |
| `docker-compose.vps.yml` | Production Docker Compose configuration |
| `Dockerfile.vps` | Fast-build image for VPS (expects prebuilt `ui/dist`) |
| `scripts/docker-entrypoint.sh` | Container startup script |

## Differences from Local Development

| Aspect | Local (`docker-compose.quickstart.yml`) | Production (`docker-compose.vps.yml`) |
|--------|----------------------------------------|--------------------------------------|
| Database | Exposed on port 5432 | Not exposed externally |
| OpenCode | Optional | Required (with API keys) |
| Public URL | Defaults to localhost | Must be explicit external URL |
| Build | Full build in container | Uses prebuilt `ui/dist` |
| Persistence | `./data/docker-paperclip` | Named Docker volumes |

See [DOCKER.md](DOCKER.md) for local development setup.
