`# CEO Instructions For Agent SSH Access

Update the `AGENTS.md` files for all agents that legitimately need server access.

Do not add SSH instructions to non-technical roles unless explicitly required.

For each eligible agent, add a short `## SSH Access` section that does all of the following:

- states the agent may use SSH only for explicitly assigned servers
- requires key-based SSH
- requires explicit `-i` key usage
- requires:
  - `-o BatchMode=yes`
  - `-o StrictHostKeyChecking=yes`
  - `-o UserKnownHostsFile=<known_hosts_path>`
  - `-o ConnectTimeout=10`
- tells the agent to rely on environment variables for host, user, key path, and known_hosts path
- forbids assuming access to unassigned servers
- requires exact stdout/stderr to be pasted into task comments when validating access
- requires blocked status if SSH access is missing or not configured

Use the following environment variable naming convention per server:

- `<SERVER>_VPS_HOST`
- `<SERVER>_VPS_USER`
- `<SERVER>_SSH_KEY_PATH`
- `<SERVER>_KNOWN_HOSTS_PATH`

For Railway-hosted infrastructure targets such as `RTAA`, only add SSH instructions if there is an actual reachable SSH host for that environment. Do not assume every Railway service supports direct SSH like a traditional VPS.

If `RTAA` has SSH access, standardize on:

- `RTAA_VPS_HOST`
- `RTAA_VPS_USER`
- `RTAA_SSH_KEY_PATH`
- `RTAA_KNOWN_HOSTS_PATH`

If `RTAA` is managed only through Railway and has no direct SSH endpoint, do not add SSH validation steps for it. Instead, instruct the relevant agents to manage it through Railway tooling and environment-specific operational docs.

Include this command pattern in the instructions:

```bash
ssh -i "$SERVER_SSH_KEY_PATH" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$SERVER_KNOWN_HOSTS_PATH" \
  -o ConnectTimeout=10 \
  "$SERVER_VPS_USER@$SERVER_VPS_HOST"
```

Also include a per-server validation command and expected output template:

```bash
ssh -i "$SERVER_SSH_KEY_PATH" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$SERVER_KNOWN_HOSTS_PATH" \
  -o ConnectTimeout=10 \
  "$SERVER_VPS_USER@$SERVER_VPS_HOST" \
  "echo SSH_OK && hostname && whoami"
```

Expected output:

```text
SSH_OK
<hostname>
<user>
```

Apply this only to the agents that should actually have infrastructure access.
`