import { expect, test } from "@playwright/test";

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const RUN_ID = process.env.PAPERCLIP_RUN_ID ?? `manual-${Date.now()}`;

test.describe("QA gate operational bypass", () => {
  test.skip(!API_URL || !API_KEY, "Requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY");

  test("keeps stale operational cleanup tickets in done", async ({ request }) => {
    const authHeaders = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    };

    const meRes = await request.get(`${API_URL}/api/agents/me`, { headers: authHeaders });
    expect(meRes.ok()).toBe(true);
    const me = await meRes.json();
    const companyId: string = me.companyId;

    const createRes = await request.post(`${API_URL}/api/companies/${companyId}/issues`, {
      headers: {
        ...authHeaders,
        "X-Paperclip-Run-Id": RUN_ID,
      },
      data: {
        title: `Stale CI/CD duplicate cleanup ${Date.now()}`,
        description: "Operational incident RCA cleanup ticket",
        status: "todo",
      },
    });
    expect(createRes.ok()).toBe(true);
    const created = await createRes.json();

    const doneRes = await request.patch(`${API_URL}/api/issues/${created.id}`, {
      headers: {
        ...authHeaders,
        "X-Paperclip-Run-Id": RUN_ID,
      },
      data: {
        status: "done",
      },
    });
    expect(doneRes.ok()).toBe(true);

    await expect
      .poll(
        async () => {
          const issueRes = await request.get(`${API_URL}/api/issues/${created.id}`, { headers: authHeaders });
          const issue = await issueRes.json();
          return issue.status as string;
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBe("done");
  });

  test("reverts code-delivery tickets to in_review without QA PASS", async ({ request }) => {
    const authHeaders = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    };

    const meRes = await request.get(`${API_URL}/api/agents/me`, { headers: authHeaders });
    expect(meRes.ok()).toBe(true);
    const me = await meRes.json();
    const companyId: string = me.companyId;

    const createRes = await request.post(`${API_URL}/api/companies/${companyId}/issues`, {
      headers: {
        ...authHeaders,
        "X-Paperclip-Run-Id": RUN_ID,
      },
      data: {
        title: `Code delivery QA gate check ${Date.now()}`,
        description: "Implement code change and close without QA PASS",
        status: "todo",
      },
    });
    expect(createRes.ok()).toBe(true);
    const created = await createRes.json();

    const doneRes = await request.patch(`${API_URL}/api/issues/${created.id}`, {
      headers: {
        ...authHeaders,
        "X-Paperclip-Run-Id": RUN_ID,
      },
      data: {
        status: "done",
      },
    });
    expect(doneRes.ok()).toBe(true);

    await expect
      .poll(
        async () => {
          const issueRes = await request.get(`${API_URL}/api/issues/${created.id}`, { headers: authHeaders });
          const issue = await issueRes.json();
          return issue.status as string;
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBe("in_review");

    await expect
      .poll(
        async () => {
          const commentsRes = await request.get(`${API_URL}/api/issues/${created.id}/comments`, {
            headers: authHeaders,
          });
          const comments = await commentsRes.json();
          return comments.some((c: { body?: string }) => c.body?.includes("**QA gate:**"));
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
  });
});

