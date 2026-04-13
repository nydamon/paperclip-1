import { describe, it, expect } from "vitest";
import { checkSemanticDrift, computeJaccard } from "../services/verification/semantic-drift.js";

describe("computeJaccard", () => {
  it("returns 1 when both sets are empty", () => {
    expect(computeJaccard(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(computeJaccard(new Set(["a"]), new Set())).toBe(0);
    expect(computeJaccard(new Set(), new Set(["a"]))).toBe(0);
  });

  it("returns 1 when sets are identical", () => {
    expect(computeJaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0.5 for 50% overlap", () => {
    expect(
      computeJaccard(new Set(["a", "b"]), new Set(["a", "c"])),
    ).toBeCloseTo(1 / 3, 3); // |∩|=1, |∪|=3
  });
});

describe("checkSemanticDrift", () => {
  it("skips the check when title is too short", () => {
    const result = checkSemanticDrift({
      title: "Fix bug",
      description: null,
      commentBody: "Long comment ".repeat(100),
    });
    expect(result.drift).toBe(false);
  });

  it("skips the check when comments are too short", () => {
    const result = checkSemanticDrift({
      title: "Implement the new authentication middleware for the API gateway",
      description: "Add JWT validation and refresh token rotation",
      commentBody: "Done",
    });
    expect(result.drift).toBe(false);
  });

  it("detects drift on the DLD-3047 pattern: rollup title, axios comments", () => {
    const result = checkSemanticDrift({
      title: "DLD-2796 Roll-up Bundle consolidated trial outputs and artifact index",
      description:
        "Consolidate trial outputs for the content cycle initiative: research brief, blog post, SEO validation, social packaging, short-form clips, morning review bundle.",
      commentBody: `
        PR #320 axios@1.15.0 security fix verified in production container.
        Docker image rebuilt. axios@1.15.0 confirmed via npm ls axios.
        Root package.json axios dependency updated from ^1.7.9 to ^1.15.0.
        Server package.json axios dependency updated from ^1.6.7 to ^1.15.0.
        CVE patched. Deployment successful. Container healthy.
      `.repeat(5),
    });
    expect(result.drift).toBe(true);
    expect(result.jaccard).toBeLessThan(0.15);
  });

  it("does NOT flag a normal on-topic issue", () => {
    const result = checkSemanticDrift({
      title: "Fix authentication middleware JWT validation bug",
      description: "The JWT validation middleware rejects valid tokens after refresh rotation.",
      commentBody: `
        Investigated the JWT validation middleware bug. The issue is that the refresh token
        rotation logic invalidates the previous token before the middleware caches it. Fixed by
        adding a 5-second grace period on the old token. Tests updated for the rotation case.
        JWT middleware now accepts both tokens during the grace window.
      `.repeat(3),
    });
    expect(result.drift).toBe(false);
    expect(result.jaccard).toBeGreaterThan(0.15);
  });
});
