/**
 * Config deliverable runner.
 *
 * Validates a configuration file by:
 *   1. Reading the file at a spec-declared path relative to the Paperclip repo root
 *   2. Parsing it according to its declared format (json | yaml | env)
 *   3. Asserting its shape against an ajv JSON schema (for json/yaml) or checking
 *      required keys (for env)
 *
 * This runner is useful for migration-validating workflow YAML, docker-compose, env files,
 * and static config JSON. For actionlint-style workflow-specific validation, we shell out
 * to actionlint from cli-runner.
 *
 * Spec format (JSON):
 *   {
 *     "configPath": "docker-compose.vps.yml",
 *     "format": "yaml",
 *     "expectedSchema": {
 *       "type": "object",
 *       "required": ["services"],
 *       "properties": {
 *         "services": {
 *           "type": "object",
 *           "required": ["server", "db"]
 *         }
 *       }
 *     },
 *     "notContains": ["TODO", "FIXME"]
 *   }
 *
 * For env files:
 *   {
 *     "configPath": ".env.example",
 *     "format": "env",
 *     "requiredKeys": ["DATABASE_URL", "BETTER_AUTH_SECRET"],
 *     "notContains": ["password123"]
 *   }
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

const requireCjs = createRequire(import.meta.url);
const AjvClass: new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
} = requireCjs("ajv");

export interface RunConfigSpecInput {
  issueId: string;
  specPath: string;
  repoRoot?: string;
  readFileImpl?: typeof readFile;
}

export type RunConfigSpecResult =
  | { status: "passed"; durationMs: number }
  | { status: "failed"; durationMs: number; failureSummary: string }
  | { status: "unavailable"; unavailableReason: string };

interface JsonOrYamlConfigSpec {
  configPath: string;
  format: "json" | "yaml";
  expectedSchema?: Record<string, unknown>;
  notContains?: string[];
}

interface EnvConfigSpec {
  configPath: string;
  format: "env";
  requiredKeys: string[];
  notContains?: string[];
}

type ConfigSpec = JsonOrYamlConfigSpec | EnvConfigSpec;

function validateSpec(parsed: unknown): { ok: true; spec: ConfigSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (typeof s.configPath !== "string" || s.configPath.trim() === "") {
    return { ok: false, reason: "spec.configPath must be a non-empty string" };
  }
  // Prevent path traversal. The config file must live under the repo root.
  if (s.configPath.includes("..") || s.configPath.startsWith("/")) {
    return { ok: false, reason: "spec.configPath must be a relative path without .. segments" };
  }
  if (s.format !== "json" && s.format !== "yaml" && s.format !== "env") {
    return { ok: false, reason: "spec.format must be one of json/yaml/env" };
  }
  if (s.format === "env") {
    if (!Array.isArray(s.requiredKeys) || !s.requiredKeys.every((x) => typeof x === "string")) {
      return { ok: false, reason: "env spec requires requiredKeys: string[]" };
    }
  }
  if (s.notContains !== undefined) {
    if (!Array.isArray(s.notContains) || !(s.notContains as unknown[]).every((x) => typeof x === "string")) {
      return { ok: false, reason: "spec.notContains must be string[] if present" };
    }
  }
  return { ok: true, spec: parsed as ConfigSpec };
}

function parseEnvLines(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

function parseYaml(body: string): unknown {
  // js-yaml is a transitive dep resolvable at runtime via createRequire. Typed as `unknown`
  // because TypeScript can't see the package types (not a direct dep) but runtime lookup works.
  const jsYaml = requireCjs("js-yaml") as {
    load?: (body: string) => unknown;
  };
  if (!jsYaml.load) throw new Error("js-yaml module does not export load");
  return jsYaml.load(body);
}

export async function runConfigSpec(input: RunConfigSpecInput): Promise<RunConfigSpecResult> {
  const { specPath, repoRoot = "/app", readFileImpl = readFile } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.config\.spec\.(json|yaml|yml)$/.test(specPath)
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for config runner: ${specPath}`,
    };
  }

  const absSpec = resolve(join(repoRoot, specPath));
  let rawSpec: string;
  try {
    rawSpec = await readFileImpl(absSpec, "utf8");
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsedSpec: unknown;
  try {
    parsedSpec = JSON.parse(rawSpec);
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const check = validateSpec(parsedSpec);
  if (!check.ok) return { status: "unavailable", unavailableReason: check.reason };
  const spec = check.spec;

  const started = Date.now();
  const absConfig = resolve(join(repoRoot, spec.configPath));
  // Double-check the resolved path is still inside the repo root (defense against regex bypass)
  if (!absConfig.startsWith(repoRoot)) {
    return {
      status: "unavailable",
      unavailableReason: `configPath resolved outside repoRoot: ${absConfig}`,
    };
  }

  let configBody: string;
  try {
    configBody = await readFileImpl(absConfig, "utf8");
  } catch (err) {
    return {
      status: "failed",
      durationMs: Math.floor(Date.now() - started),
      failureSummary: `config file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // notContains checks run on raw body for all formats
  if (spec.notContains && spec.notContains.length > 0) {
    for (const forbidden of spec.notContains) {
      if (configBody.includes(forbidden)) {
        return {
          status: "failed",
          durationMs: Math.floor(Date.now() - started),
          failureSummary: `config file contains forbidden substring: "${forbidden.slice(0, 80)}"`,
        };
      }
    }
  }

  // Format-specific parse + schema validation
  if (spec.format === "env") {
    const parsed = parseEnvLines(configBody);
    const missing = spec.requiredKeys.filter((k) => parsed[k] === undefined);
    if (missing.length > 0) {
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `env file missing required keys: ${missing.join(", ")}`,
      };
    }
    return { status: "passed", durationMs: Math.floor(Date.now() - started) };
  }

  let parsedConfig: unknown;
  if (spec.format === "json") {
    try {
      parsedConfig = JSON.parse(configBody);
    } catch (err) {
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `config file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    // yaml
    try {
      parsedConfig = parseYaml(configBody);
    } catch (err) {
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `config file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (spec.expectedSchema) {
    const ajv = new AjvClass({ allErrors: true, strict: false });
    let validate;
    try {
      validate = ajv.compile(spec.expectedSchema);
    } catch (err) {
      return {
        status: "unavailable",
        unavailableReason: `expectedSchema did not compile: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!validate(parsedConfig)) {
      const errs: ErrorObject[] = validate.errors ?? [];
      const summary = errs
        .slice(0, 3)
        .map((e) => `${e.instancePath || "$"}: ${e.message}`)
        .join("; ");
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `config file schema validation failed: ${summary}`,
      };
    }
  }

  return { status: "passed", durationMs: Math.floor(Date.now() - started) };
}
