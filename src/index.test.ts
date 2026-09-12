import { expect, test } from "bun:test";
import { type Approval, Quirna, QuirnaError, VERSION, verifyCallback } from "./index";

function approval(status: Approval["status"]): Approval {
  return {
    id: "apr_wait",
    org_id: "org_1",
    kind: "refund",
    identifiers: { refund_id: "re_1" },
    message: "Refund",
    requester_id: "support@example.com",
    requester_name: "Support",
    environment: "Production",
    tier: "elevated",
    status,
    callback_url: "http://127.0.0.1/hooks/quirna",
    created_at: new Date().toISOString(),
    timeout_at: new Date(Date.now() + 60_000).toISOString(),
    decided_at: status === "pending" ? null : new Date().toISOString(),
    decided_by: status === "pending" ? null : "usr_1",
    approved_count: status === "approved" ? 2 : 0,
    policy: {
      group_id: "grp_1",
      name: "Refunds",
      tier: "elevated",
      required_approvals: 2,
      requester_can_approve: false,
      timeout_seconds: 60,
    },
  };
}

/** Set env vars for one test, returning a function that puts them back. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("QuirnaError is thrown on HTTP errors", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  try {
    await client.approvals.get("apr_missing");
    throw new Error("expected QuirnaError");
  } catch (err) {
    expect(err).toBeInstanceOf(QuirnaError);
    expect((err as QuirnaError).status).toBe(401);
  } finally {
    server.stop();
  }
});

test("wait returns when the approval is no longer pending", async () => {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      n += 1;
      return Response.json(approval(n < 2 ? "pending" : "approved"));
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  const done = await client.approvals.wait("apr_wait", {
    intervalMs: 10,
    timeoutMs: 1000,
  });
  expect(done.status).toBe("approved");
  server.stop();
});

test("wait times out while still pending", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(approval("pending"));
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  try {
    await client.approvals.wait("apr_wait", { intervalMs: 5, timeoutMs: 20 });
    throw new Error("expected timeout");
  } catch (err) {
    expect(err).toBeInstanceOf(QuirnaError);
    expect((err as QuirnaError).code).toBe("wait_timeout");
  } finally {
    server.stop();
  }
});

test("verifyCallback is fail-closed without signed headers", async () => {
  await expect(verifyCallback("{}", new Headers(), { keys: [] })).rejects.toBeInstanceOf(
    QuirnaError,
  );
});

test("the base URL comes from the environment when not passed", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return Response.json({ ...approval("approved"), id: new URL(req.url).pathname });
    },
  });
  const restore = withEnv({ QUIRNA_BASE_URL: `http://127.0.0.1:${server.port}` });
  try {
    const decided = await new Quirna({ apiKey: "ck_test" }).approvals.get("apr_env");
    expect(decided.id).toBe("/v1/approvals/apr_env");
  } finally {
    restore();
    server.stop();
  }
});

test("an empty key fails at construction, not as a 401 on the first request", () => {
  // What `process.env.QUIRNA_API_KEY ?? ""` yields when the var is unset.
  // The key is never read from the environment for us; it is always passed.
  const restore = withEnv({ QUIRNA_API_KEY: "ck_should_be_ignored" });
  try {
    expect(() => new Quirna({ apiKey: "" })).toThrow(QuirnaError);
  } finally {
    restore();
  }
});

test("require creates then waits for a human decision", async () => {
  let created = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST") {
        created = true;
        return Response.json(approval("pending"));
      }
      return Response.json(approval("rejected"));
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  const decided = await client.approvals.require(
    { kind: "refund", identifiers: {}, message: "Refund", requester_id: "svc" },
    { intervalMs: 5, timeoutMs: 500 },
  );
  expect(created).toBe(true);
  expect(decided.status).toBe("rejected");
  server.stop();
});

test("require skips the wait when a policy auto-approved the request", async () => {
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST") return Response.json(approval("approved"));
      polls += 1;
      return Response.json(approval("approved"));
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  const decided = await client.approvals.require({
    kind: "refund",
    identifiers: {},
    message: "Refund",
    requester_id: "svc",
  });
  expect(decided.status).toBe("approved");
  expect(polls).toBe(0);
  server.stop();
});

test("VERSION matches package.json, since it is sent as the User-Agent", async () => {
  const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as { version: string };
  expect(VERSION).toBe(pkg.version);
});

test("requests identify themselves with a versioned User-Agent", async () => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("user-agent"));
      return Response.json(approval("approved"));
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  await client.approvals.get("apr_1");
  expect(seen).toEqual([`quirna-sdk/${VERSION}`]);
  server.stop();
});

test("an HTML error page becomes a QuirnaError, not a JSON parse error", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
    maxRetries: 0,
  });
  try {
    await client.approvals.get("apr_1");
    throw new Error("expected QuirnaError");
  } catch (err) {
    expect(err).toBeInstanceOf(QuirnaError);
    expect((err as QuirnaError).status).toBe(502);
    expect((err as QuirnaError).message).toContain("502");
  } finally {
    server.stop();
  }
});

test("a transient 503 on a GET is retried", async () => {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      if (hits < 3) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json(approval("approved"));
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  const decided = await client.approvals.get("apr_1");
  expect(decided.status).toBe("approved");
  expect(hits).toBe(3);
  server.stop();
});

test("a failed create is never retried, so nobody is asked to approve twice", async () => {
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      posts += 1;
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  await expect(
    client.approvals.create({ kind: "k", identifiers: {}, message: "m", requester_id: "r" }),
  ).rejects.toBeInstanceOf(QuirnaError);
  expect(posts).toBe(1);
  server.stop();
});

test("a 401 is not retried — repeating a bad key changes nothing", async () => {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    },
  });
  const client = new Quirna({ apiKey: "ck_bad", baseUrl: `http://127.0.0.1:${server.port}` });
  await expect(client.approvals.get("apr_1")).rejects.toBeInstanceOf(QuirnaError);
  expect(hits).toBe(1);
  server.stop();
});

test("a 429 surfaces the server's retry-after", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "7" },
      });
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
    maxRetries: 0,
  });
  try {
    await client.approvals.get("apr_1");
    throw new Error("expected QuirnaError");
  } catch (err) {
    expect((err as QuirnaError).status).toBe(429);
    expect((err as QuirnaError).retryAfterSeconds).toBe(7);
  } finally {
    server.stop();
  }
});

test("a hung server trips the request timeout instead of blocking forever", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 5000));
      return Response.json(approval("approved"));
    },
  });
  const client = new Quirna({
    apiKey: "ck_test",
    baseUrl: `http://127.0.0.1:${server.port}`,
    timeoutMs: 50,
    maxRetries: 0,
  });
  try {
    await client.approvals.get("apr_1");
    throw new Error("expected a timeout");
  } catch (err) {
    expect(err).toBeInstanceOf(QuirnaError);
    expect((err as QuirnaError).code).toBe("request_timeout");
  } finally {
    server.stop();
  }
});

test("an abort signal ends a wait early", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(approval("pending"));
    },
  });
  const client = new Quirna({ apiKey: "ck_test", baseUrl: `http://127.0.0.1:${server.port}` });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await expect(
    client.approvals.wait("apr_1", {
      intervalMs: 10,
      timeoutMs: 60_000,
      signal: controller.signal,
    }),
  ).rejects.toBeDefined();
  server.stop();
});

test("a JavaScript caller with no options gets the real reason, not a TypeError", () => {
  // `new Quirna()` cannot compile in TypeScript, but nothing stops plain JS.
  const construct = Quirna as unknown as new () => Quirna;
  expect(() => new construct()).toThrow(QuirnaError);
});
