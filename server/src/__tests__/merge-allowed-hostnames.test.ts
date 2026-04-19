import { describe, expect, it } from "vitest";
import { mergeAllowedHostnamesForConfig } from "../config.js";

describe("mergeAllowedHostnamesForConfig", () => {
  it("merges file, env CSV, and public URL hostname", () => {
    const out = mergeAllowedHostnamesForConfig({
      fileAllowed: ["pc.example.com"],
      envCsv: "10.0.0.1,OTHER.example.COM",
      publicBaseUrl: "https://pc.example.com/",
    });
    expect(new Set(out)).toEqual(
      new Set(["10.0.0.1", "other.example.com", "pc.example.com"]),
    );
  });

  it("does not drop file hosts when env is set (persisted config + deploy env)", () => {
    const out = mergeAllowedHostnamesForConfig({
      fileAllowed: ["pc.viraforgelabs.com"],
      envCsv: "64.176.199.162",
      publicBaseUrl: "http://64.176.199.162:3100",
    });
    expect(new Set(out)).toEqual(new Set(["pc.viraforgelabs.com", "64.176.199.162"]));
  });

  it("uses file and public URL when env var is unset", () => {
    const out = mergeAllowedHostnamesForConfig({
      fileAllowed: ["a.example"],
      envCsv: undefined,
      publicBaseUrl: "https://b.example",
    });
    expect(new Set(out)).toEqual(new Set(["a.example", "b.example"]));
  });

  it("treats empty env CSV as no extra hosts from env", () => {
    const out = mergeAllowedHostnamesForConfig({
      fileAllowed: ["only.file"],
      envCsv: "  ,  ,",
      publicBaseUrl: undefined,
    });
    expect(out).toEqual(["only.file"]);
  });
});
