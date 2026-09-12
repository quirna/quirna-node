# @quirna/sdk

Human approval for anything your code is about to do. Official client for the
[Quirna](https://quirna.com) API.

Your code asks for permission before it does something consequential — a
refund, a withdrawal, a production deploy, a destructive migration. A named
human approves it on a device Quirna can attest. The decision comes back
signed, and every request keeps an audit trail.

- **Site** — [quirna.com](https://quirna.com)
- **Console** — [console.quirna.com](https://console.quirna.com) (policies,
  approver groups, activity, API keys)
- **API** — `https://api.quirna.com`

## Install

```sh
npm install @quirna/sdk
```

```sh
bun add @quirna/sdk   # or: pnpm add / yarn add
```

## Get an API key

In the [Console](https://console.quirna.com), open **Systems** and create one
for the service that will be asking. A System is an API key with a face — a
name, an environment, and the kinds of request it is allowed to make, so an
approver sees *who* asked, not just *what*.

The key (`ck_…`) is shown once. Store it wherever you keep the rest of your
secrets and pass it to the client explicitly — the SDK never goes looking for
it in the environment on its own.

You will also want at least one **Policy**, which decides who approves a given
kind of request and how many of them are needed.

## Usage

Every integration takes one of two shapes. Which one you want depends on a
single question: can the code that is asking afford to sit and wait?

**1. Wait for the decision.** Your code stops until a human answers, then
carries on. One call, no endpoint to host. Use it in a script, a queue worker,
a cron job, or an agent acting on someone's behalf.

**2. Get a webhook callback.** Your code creates the request and returns right
away; Quirna POSTs the decision to a URL you host. Use it when something is
waiting on the other end — an HTTP request, a user staring at a spinner.

Both examples below are complete: copy one and fill in your own values.

### 1. Wait for the decision

```ts
import { Quirna } from "@quirna/sdk";

const quirna = new Quirna({ apiKey: process.env.QUIRNA_API_KEY ?? "" });

const decision = await quirna.approvals.require({
  kind: "refund",
  identifiers: { refund_id: "re_123", amount: "250.00", currency: "USD" },
  message: "Refund 250.00 USD to Acme Corp",
  requester_id: "billing-agent",
});

if (decision.status !== "approved") {
  throw new Error(`refund not approved: ${decision.status}`);
}

await stripe.refunds.create({ charge: "ch_123" });
```

`message` is the headline a human reads on their phone, so write it as the
sentence you would want someone to approve at 2am. `identifiers` is the
structured detail shown underneath — and what your Policy conditions match on,
so a refund over $500 can need two approvers while smaller ones need one.

`require` blocks until someone answers, up to 15 minutes by default:

```ts
await quirna.approvals.require(input, { timeoutMs: 60_000 });
```

### 2. Get a webhook callback

```ts
import { Quirna } from "@quirna/sdk";

const quirna = new Quirna({ apiKey: process.env.QUIRNA_API_KEY ?? "" });

await quirna.approvals.create({
  kind: "deploy",
  identifiers: { service: "payments-api", sha: "a1b2c3d" },
  message: "Deploy payments-api to production",
  requester_id: "ci",
  environment: "Production",
  callback_url: "https://api.example.com/hooks/quirna",
});
```

That returns immediately — nothing is decided yet. Quirna POSTs to
`callback_url` once someone answers, which may be seconds or minutes later.

So you also host the other half. Verify the callback before acting on it — the signature is what makes the decision trustworthy:

```ts
import { verifyCallback } from "@quirna/sdk";

export const POST = async (req: Request) => {
  const raw = await req.text(); // the raw body, before any JSON parsing

  let body;
  try {
    body = await verifyCallback(raw, req.headers);
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  if (body.decision === "approved") {
    await deploy(body.identifiers.sha);
  }

  return Response.json({ ok: true });
};
```

Three things matter here. Pass the **raw** body — parsing and re-serializing
JSON changes the bytes and the signature will not match. Treat a thrown error
as a rejection: `verifyCallback` fails closed on anything it cannot verify. And
note it wants a `Headers` object, so on a framework that hands you a plain
object of headers (Express, Fastify), wrap it: `new Headers(req.headers)`.

It checks the Ed25519 signature against Quirna's published JWKS, rejects a
timestamp more than five minutes from your clock, and confirms the body's own
`event_id` matches the signed header. The key set is cached and refetched only
when a key id turns up that it has not seen, so key rotation needs nothing from
you.

Callbacks can be delivered more than once. `event_id` is stable per decision —
use it to make your handler idempotent.

## Handling the other outcomes

`status` is not a boolean. A request can come back `rejected` (someone said
no), `timed_out` (nobody answered before the Policy's deadline), or `cancelled`
(the requester withdrew it). Only `approved` means go.

```ts
if (decision.status === "approved") {
  await execute();
} else if (decision.status === "rejected") {
  await notifyRequester(`declined by ${decision.decided_by}`);
} else {
  // timed_out or cancelled — nobody decided, so nothing happens
  await notifyRequester(`no decision: ${decision.status}`);
}
```

`decision.auto_approved` is `true` when a Policy's condition did not match and
no human was asked — the request was below the threshold that needs one.

## Configuration

```ts
const quirna = new Quirna({ apiKey: "ck_…" });
```

An empty `apiKey` throws at construction.

## API

| | |
| --- | --- |
| `approvals.create(input)` | Create a request, return immediately |
| `approvals.get(id)` | Fetch its current state |
| `approvals.wait(id, options?)` | Poll until it leaves `pending` |
| `approvals.require(input, options?)` | `create` + `wait` |
| `verifyCallback(rawBody, headers, jwksOrUrl?)` | Verify a signed callback |
| `fetchJwks(baseUrl?)` | Fetch the signing key set |

Every failure throws a `QuirnaError` with an HTTP `status` and a stable `code`:

```ts
import { QuirnaError } from "@quirna/sdk";

try {
  await quirna.approvals.require(input);
} catch (err) {
  if (err instanceof QuirnaError && err.code === "wait_timeout") {
    // still pending — the request outlived our patience, not the Policy's
  }
  throw err;
}
```

Codes include `wait_timeout`, `request_timeout`, `missing_api_key`,
`bad_signature`, `timestamp_skew`, `unknown_key`, `missing_signature`. On a
429, `err.retryAfterSeconds` carries what the server asked for.

## Reliability

Sensible defaults, no configuration:

- **Requests time out** after 30 seconds, so a dropped connection cannot hang
  your process. This is unrelated to how long a human has to decide, which is
  the Policy's business and `wait`'s `timeoutMs`.
- **Transient failures are retried** — a 429, a 5xx, a reset socket — with
  exponential backoff that never fires sooner than a `retry-after` header asks.
- **`create` is never retried**, so a human is never asked twice for the same
  thing. Only reads are.
- **Waits are abortable.** Pass an `AbortSignal` to stop polling when the
  caller disconnects or the worker is shutting down.

```ts
const controller = new AbortController();
req.on("close", () => controller.abort());

await quirna.approvals.require(input, { signal: controller.signal });
```

## Runtimes

**Node 20+**, Bun, Deno and edge workers. No dependencies; types included.

Run it on a server: the client holds your API key.

## License

MIT
