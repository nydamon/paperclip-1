import { describe, it, expect, vi } from "vitest";
import { runDataSpec } from "../services/verification/runners/data-runner.js";

function makeMockDb(execResults: Array<Array<unknown> | { throw: string }> = []) {
  let callIndex = 0;
  return {
    execute: vi.fn(async () => {
      const result = execResults[callIndex];
      callIndex += 1;
      if (result && "throw" in result) throw new Error(result.throw);
      return result ?? [];
    }),
  };
}

const readFileFrom = (body: string) => vi.fn(async () => body);
const validSpecPath = "skills/acceptance-data-ops/tests/DLD-1.data.spec.json";

describe("runDataSpec", () => {
  it("rejects invalid spec path", async () => {
    const db = makeMockDb();
    const result = await runDataSpec({
      issueId: "i",
      specPath: "not-valid",
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom("{}"),
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects spec without SCHEMA placeholder in fixtureSql", async () => {
    const spec = {
      fixtureSql: "CREATE TABLE foo (id int);",
      operationSql: "UPDATE SCHEMA.foo SET id = 1;",
      postAssertSql: "SELECT count(*) FROM SCHEMA.foo;",
      postAssertExpected: 1,
    };
    const db = makeMockDb();
    const result = await runDataSpec({
      issueId: "i",
      specPath: validSpecPath,
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects unqualified UPDATE in operationSql", async () => {
    const spec = {
      fixtureSql: "CREATE TABLE SCHEMA.foo (id int);",
      operationSql: "UPDATE users SET status = 'x';",
      postAssertSql: "SELECT count(*) FROM SCHEMA.foo;",
      postAssertExpected: 1,
    };
    const db = makeMockDb();
    const result = await runDataSpec({
      issueId: "i",
      specPath: validSpecPath,
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("unavailable");
  });

  it("passes on correct postAssertCount", async () => {
    const spec = {
      fixtureSql: "CREATE TABLE SCHEMA.users (id int, status text);",
      operationSql: "UPDATE SCHEMA.users SET status = 'active';",
      postAssertSql: "SELECT count(*) FROM SCHEMA.users WHERE status = 'active';",
      postAssertExpected: 5,
    };
    // Call sequence: CREATE SCHEMA, fixture, operation, postAssert (returns [{count:5}]), DROP
    const db = makeMockDb([
      [], // CREATE SCHEMA
      [], // fixture
      [], // operation
      [{ count: 5 }], // postAssert
      [], // DROP
    ]);
    const result = await runDataSpec({
      issueId: "i",
      specPath: validSpecPath,
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("passed");
  });

  it("fails on wrong postAssertCount", async () => {
    const spec = {
      fixtureSql: "CREATE TABLE SCHEMA.users (id int);",
      operationSql: "UPDATE SCHEMA.users SET id = 1;",
      postAssertSql: "SELECT count(*) FROM SCHEMA.users;",
      postAssertExpected: 5,
    };
    const db = makeMockDb([
      [], // CREATE SCHEMA
      [], // fixture
      [], // operation
      [{ count: 3 }], // postAssert — wrong count
      [], // DROP
    ]);
    const result = await runDataSpec({
      issueId: "i",
      specPath: validSpecPath,
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("failed");
  });

  it("runs operation twice when idempotent flag set", async () => {
    const spec = {
      fixtureSql: "CREATE TABLE SCHEMA.users (id int);",
      operationSql: "INSERT INTO SCHEMA.users (id) VALUES (1) ON CONFLICT DO NOTHING;",
      postAssertSql: "SELECT count(*) FROM SCHEMA.users;",
      postAssertExpected: 1,
      idempotent: true,
    };
    const db = makeMockDb([
      [], // CREATE SCHEMA
      [], // fixture
      [], // first operation
      [{ count: 1 }], // first postAssert
      [], // second operation (idempotency re-run)
      [{ count: 1 }], // second postAssert
      [], // DROP
    ]);
    const result = await runDataSpec({
      issueId: "i",
      specPath: validSpecPath,
      db: db as unknown as Parameters<typeof runDataSpec>[0]["db"],
      readFileImpl: readFileFrom(JSON.stringify(spec)),
    });
    expect(result.status).toBe("passed");
    if (result.status === "passed") expect(result.assertionsChecked).toBe(2);
  });
});
