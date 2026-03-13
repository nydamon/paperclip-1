# Paperclip Upgrade Checklist

Use this checklist for every Paperclip version upgrade. The goal is to make upgrades simple, repeatable, and proportional to the actual upstream changes.

## Core Principles

1. **Upstream-first** - Use Paperclip exactly as released, no product code modifications
2. **Configuration outside code** - All environment-specific values live in `.env` and GitHub secrets
3. **Single supported path** - Use only the tracked deployment files in this repo
4. **No drift** - Untracked server behavior is not part of the supported system

## Four-Question Checklist

### 1. What changed upstream?

- [ ] Review release notes at https://github.com/paperclipai/paperclip/releases
- [ ] Check for breaking changes in API or configuration
- [ ] Note any new features that might require environment variables
- [ ] Read migration guides if provided

### 2. Did any required environment variables or secrets change?

- [ ] Compare `docker-compose.vps.yml` from old vs new version
- [ ] Check if new required variables were added
- [ ] Update `/opt/paperclip/.env` on VPS if needed:
  ```bash
  ssh root@64.176.199.162
  vi /opt/paperclip/.env
  ```
- [ ] Update GitHub repository secrets if needed
- [ ] Verify all required variables are still present:
  - `PAPERCLIP_PUBLIC_URL`
  - `BETTER_AUTH_SECRET`
  - `OPENCODE_CONFIG_CONTENT`
  - `ZAI_API_KEY`
  - `MINIMAX_API_KEY`

### 3. Does the standardized VPS path still build and deploy?

Create a clean worktree for testing:

```bash
# Fetch the new release
cd /Users/damondecrescenzo/paperclip
git fetch origin
git worktree add .worktrees/upgrade-test <release-tag>
cd .worktrees/upgrade-test

# Run verification
pnpm install
pnpm -r typecheck
pnpm test:run
pnpm build

# Verify VPS image builds
docker build -f Dockerfile.vps -t paperclip-upgrade-test .
```

- [ ] All checks pass
- [ ] Docker image builds successfully
- [ ] No new warnings or errors

### 4. Did post-deploy validation succeed?

After merging to `master` and triggering the GitHub Actions workflow:

- [ ] Workflow run shows green checkmark
- [ ] Verify job passed (build, typecheck, tests)
- [ ] Deploy job completed without errors
- [ ] Health endpoint responds: `curl http://64.176.199.162:3100/api/health`
- [ ] OpenCode runtime env validated in logs
- [ ] Database migrations ran successfully (if any)
- [ ] Application is fully operational

## Deployment Files Reference

These files constitute the **only** supported production deployment path:

| File | Purpose |
|------|---------|
| `.github/workflows/deploy-vultr.yml` | GitHub Actions CI/CD workflow |
| `docker-compose.vps.yml` | Production Docker Compose configuration |
| `Dockerfile.vps` | Fast-build image (expects prebuilt `ui/dist`) |
| `scripts/docker-entrypoint.sh` | Container startup bootstrap |

**Do not modify these files unless:**
1. The upstream release requires it, OR
2. You are intentionally changing the standardized deployment behavior

## Rollback Procedure

If a deploy fails validation:

1. **Check GitHub Actions logs** for specific failure reason
2. **Verify the previous release still works** by checking health endpoint
3. **Database backups** are in `/opt/paperclip/db-backups/` if needed
4. **Manual recovery** - see [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md) recovery procedures

## When to Stop and Ask

Stop and document before proceeding if you encounter:
- Deployment behavior that exists only on the server (not in repo)
- Required changes to product code (not just configuration)
- New assumptions about VPS state that aren't documented
- Alternative deployment paths that "also work"

## Quick Reference

**Required GitHub Secrets:**
- `VULTR_HOST` - VPS IP
- `VULTR_USER` - SSH user
- `VULTR_SSH_PRIVATE_KEY` - Deploy key
- `VULTR_KNOWN_HOSTS` - Host key verification

**Required VPS Environment Variables:**
- `PAPERCLIP_PUBLIC_URL` - External URL
- `BETTER_AUTH_SECRET` - Auth signing key
- `OPENCODE_CONFIG_CONTENT` - OpenCode configuration
- `ZAI_API_KEY` - Z.AI provider key
- `MINIMAX_API_KEY` - MiniMax provider key

**Documentation:**
- [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md) - Full deployment guide
- [DOCKER.md](DOCKER.md) - Local development setup
