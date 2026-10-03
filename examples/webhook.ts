/**
 * The webhook shape: a deploy endpoint that answers 202 straight away, and a
 * callback endpoint where Quirna POSTs the decision once a human makes it.
 *
 *   QUIRNA_API_KEY=ck_… QUIRNA_KIND=deploy \
 *   QUIRNA_CALLBACK_URL=https://<your-tunnel>/hooks/quirna node examples/webhook.ts
 *
 *   curl -X POST http://localhost:8787/deploys
 *
 * How to run it, and every variable it reads, is in examples/README.md.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Quirna, verifyCallback, type WebhookBody } from "@quirna/sdk";

const quirna = new Quirna({ apiKey: process.env.QUIRNA_API_KEY ?? "" });

const kind = process.env.QUIRNA_KIND ?? "deploy";
const requesterId = process.env.QUIRNA_REQUESTER_ID ?? "ci";
const environment = process.env.QUIRNA_ENVIRONMENT || undefined;
const port = Number(process.env.PORT ?? 8787);

// Quirna's servers call this, so it must be a public https URL that reaches
// this process, and an Org admin must have allowlisted it (Console → Webhooks).
const callbackUrl = process.env.QUIRNA_CALLBACK_URL ?? "";
if (!callbackUrl) {
  console.error("Set QUIRNA_CALLBACK_URL to the public https URL of /hooks/quirna.");
  process.exit(1);
}
const callbackPath = new URL(callbackUrl).pathname;

// The same decision can be delivered more than once; `event_id` is stable per
// decision. A real service keeps this in its database, not in memory.
const handled = new Set<string>();

async function startDeploy(res: ServerResponse): Promise<void> {
  const sha = Math.random().toString(16).slice(2, 9);
  const approval = await quirna.approvals.create({
    kind,
    message: `Deploy payments-api ${sha} to production`,
    identifiers: { service: "payments-api", sha },
    requester_id: requesterId,
    environment,
    callback_url: callbackUrl,
  });
  // Nothing is decided yet. Whoever called us is not kept waiting for a human.
  console.log(`Created ${approval.id} for ${sha}; the decision will arrive at ${callbackPath}.`);
  send(res, 202, { approval_id: approval.id, status: approval.status });
}

async function receiveDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The raw bytes, exactly as sent: parsing and re-serializing the JSON
  // changes them, and the signature stops matching.
  const raw = await readBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }

  let body: WebhookBody;
  try {
    body = await verifyCallback(raw, headers);
  } catch (err) {
    // Fail closed: anything that does not verify is not a decision.
    console.error(`Rejected a callback: ${err instanceof Error ? err.message : err}`);
    send(res, 401, { error: "invalid signature" });
    return;
  }

  // Answer 2xx as soon as the event is recorded; slow work goes after it, or
  // Quirna counts the delivery as failed and sends it again.
  send(res, 200, { ok: true });
  if (handled.has(body.event_id)) return;
  handled.add(body.event_id);

  // `decision` is go or no-go; `status` says which kind of no it was.
  if (body.decision === "approved") {
    console.log(`Approved by ${body.decided_by}. Deploying ${body.identifiers.sha}.`);
    // await deploy(body.identifiers.sha);
  } else {
    console.log(`Not deploying ${body.identifiers.sha}: ${body.status}.`);
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/deploys") return await startDeploy(res);
    if (req.method === "POST" && req.url === callbackPath) return await receiveDecision(req, res);
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err instanceof Error ? err.message : "failed" });
  }
}).listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`Start a deploy: curl -X POST http://localhost:${port}/deploys`);
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
