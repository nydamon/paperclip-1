import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    delete process.env.PAPERCLIP_PI_LIST_MODELS_TIMEOUT_SEC;
    resetPiModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("falls back to stale models when discovery times out after a previous success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-stale-"));
    const commandPath = path.join(root, "pi");
    const successMarker = path.join(root, "success.marker");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env bash
if [[ "$1" == "--list-models" ]]; then
  if [[ -f "${successMarker}" ]]; then
    echo "provider  model"
    echo "openai    gpt-4.1-mini"
    exit 0
  fi
  echo "discovery got slow" >&2
  sleep 1
  exit 0
fi
exit 1
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    process.env.PAPERCLIP_PI_COMMAND = commandPath;
    process.env.PAPERCLIP_PI_LIST_MODELS_TIMEOUT_SEC = "0.2";

    await fs.writeFile(successMarker, "ok", "utf8");
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "openai/gpt-4.1-mini",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-4.1-mini", label: "openai/gpt-4.1-mini" }]);

    await fs.rm(successMarker, { force: true });
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 120_000);

    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "openai/gpt-4.1-mini",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-4.1-mini", label: "openai/gpt-4.1-mini" }]);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces discovery failure classification with stderr/stdout excerpts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-error-"));
    const commandPath = path.join(root, "pi");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env bash
if [[ "$1" == "--list-models" ]]; then
  echo "stdout-line: failed to contact provider"
  echo "stderr-line: auth missing" >&2
  exit 1
fi
exit 1
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    process.env.PAPERCLIP_PI_COMMAND = commandPath;

    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "openai/gpt-4.1-mini",
      }),
    ).rejects.toThrow(/classification=config_or_infra/);
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "openai/gpt-4.1-mini",
      }),
    ).rejects.toThrow(/stderr_excerpt=stderr-line: auth missing/);
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "openai/gpt-4.1-mini",
      }),
    ).rejects.toThrow(/stdout_excerpt=stdout-line: failed to contact provider/);

    await fs.rm(root, { recursive: true, force: true });
  });
});
