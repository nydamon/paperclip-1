import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(
  import.meta.dirname,
  "../../../scripts/capture-restart-forensics.sh",
);

describe("capture-restart-forensics.sh", () => {
  it("captures restart summary and classifies OOM restarts", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-capture-restart-forensics-"),
    );
    const fakeDocker = path.join(tempDir, "fake-docker.sh");

    try {
      await fs.writeFile(
        fakeDocker,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "if [ \"$1\" = \"inspect\" ]; then",
          "  format=\"$3\"",
          "  case \"$format\" in",
          "    '{{.State.Status}}') echo running ;;",
          "    '{{.State.StartedAt}}') echo 2026-03-30T12:00:00Z ;;",
          "    '{{.State.FinishedAt}}') echo 0001-01-01T00:00:00Z ;;",
          "    '{{.State.ExitCode}}') echo 137 ;;",
          "    '{{.State.OOMKilled}}') echo true ;;",
          "    '{{.State.Error}}') echo '' ;;",
          "    '{{.RestartCount}}') echo 4 ;;",
          "    '{{.Id}}') echo test-container-id ;;",
          "    *) echo '' ;;",
          "  esac",
          "  exit 0",
          "fi",
          "if [ \"$1\" = \"events\" ]; then",
          "  echo '{\"status\":\"die\"}'",
          "  exit 0",
          "fi",
          "if [ \"$1\" = \"logs\" ]; then",
          "  echo '2026-03-30T12:01:00Z server started'",
          "  exit 0",
          "fi",
          "echo \"unexpected fake docker call: $*\" >&2",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakeDocker, 0o755);

      const { stdout } = await execFileAsync(scriptPath, [], {
        env: {
          ...process.env,
          DOCKER_BIN: fakeDocker,
          FORENSICS_ROOT: tempDir,
          EVENT_WINDOW: "10m",
          MAX_LOG_LINES: "20",
          RETENTION_DAYS: "7",
        },
      });

      const captureDir = stdout
        .split("\n")
        .find((line) => line.startsWith("FORENSICS_CAPTURE_DIR="))
        ?.replace("FORENSICS_CAPTURE_DIR=", "");

      expect(captureDir).toBeTruthy();

      const summaryRaw = await fs.readFile(path.join(captureDir!, "summary.json"), "utf8");
      expect(summaryRaw).toContain('"restartReason": "oom_killed"');
      expect(summaryRaw).toContain('"oomKilled": "true"');

      const eventsRaw = await fs.readFile(path.join(captureDir!, "events.jsonl"), "utf8");
      expect(eventsRaw).toContain('"status":"die"');

      const logsRaw = await fs.readFile(path.join(captureDir!, "server.log"), "utf8");
      expect(logsRaw).toContain("server started");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
