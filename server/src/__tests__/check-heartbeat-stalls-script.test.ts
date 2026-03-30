import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(import.meta.dirname, "../../../scripts/check-heartbeat-stalls.sh");

describe("check-heartbeat-stalls.sh", () => {
  it("emits an alert and exits 2 when stale running agents are detected", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-check-heartbeat-stalls-"));
    const fakeDocker = path.join(tempDir, "fake-docker.sh");
    const fakeCapture = path.join(tempDir, "fake-capture.sh");

    try {
      await fs.writeFile(
        fakeDocker,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "if [ \"$1\" = \"exec\" ]; then",
          "  # Simulate one stale running agent row from psql -At output.",
          "  echo 'agent-1\tSenior Platform Engineer\trunning\t2026-03-30T12:00:00Z'",
          "  exit 0",
          "fi",
          "echo \"unexpected fake docker call: $*\" >&2",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakeDocker, 0o755);

      await fs.writeFile(
        fakeCapture,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "mkdir -p \"$FORENSICS_ROOT/restarts/fake-capture\"",
          "printf 'FORENSICS_CAPTURE_DIR=%s\\n' \"$FORENSICS_ROOT/restarts/fake-capture\"",
          "printf 'RESTART_REASON=restart_after_failure\\n'",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakeCapture, 0o755);

      let exitCode = 0;
      let stdout = "";
      try {
        const result = await execFileAsync(scriptPath, [], {
          env: {
            ...process.env,
            DOCKER_BIN: fakeDocker,
            CAPTURE_SCRIPT: fakeCapture,
            FORENSICS_ROOT: tempDir,
            STALL_MINUTES: "15",
          },
        });
        stdout = result.stdout;
      } catch (error) {
        const err = error as { code?: number; stdout?: string };
        exitCode = Number(err.code ?? 1);
        stdout = String(err.stdout ?? "");
      }

      expect(exitCode).toBe(2);
      expect(stdout).toContain("HEARTBEAT_STALLS=1");

      const alertsDir = path.join(tempDir, "alerts");
      const alertFiles = await fs.readdir(alertsDir);
      expect(alertFiles.length).toBe(1);

      const alertRaw = await fs.readFile(path.join(alertsDir, alertFiles[0]), "utf8");
      expect(alertRaw).toContain("Heartbeat Stall Alert");
      expect(alertRaw).toContain("Senior Platform Engineer");
      expect(alertRaw).toContain("forensicsCaptureDir:");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
