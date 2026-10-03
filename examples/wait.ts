/**
 * Ask a human before refunding, wait for the answer, and refund only on a yes.
 *
 *   QUIRNA_API_KEY=ck_… QUIRNA_KIND=refund node examples/wait.ts
 *
 * How to run it, and every variable it reads, is in examples/README.md.
 */
import { Quirna, QuirnaError } from "@quirna/sdk";

const quirna = new Quirna({ apiKey: process.env.QUIRNA_API_KEY ?? "" });

// A System's key may only request the kinds it was registered with, and the
// environment is part of how a Policy is chosen: match what the Console says.
const kind = process.env.QUIRNA_KIND ?? "refund";
const requesterId = process.env.QUIRNA_REQUESTER_ID ?? "billing-agent";
const environment = process.env.QUIRNA_ENVIRONMENT || undefined;

const refundId = `re_${Date.now()}`;

// `create` + `wait` rather than `require`, only so the id can be printed
// while a human decides. In your own code `require` is the same thing in one call.
const approval = await quirna.approvals.create({
  kind,
  // The headline on the approver's phone: the sentence they say yes to.
  message: "Refund 250.00 USD to Acme Corp",
  // The detail underneath, and what a Policy condition can match on.
  identifiers: { refund_id: refundId, amount: "250.00", currency: "USD" },
  requester_id: requesterId,
  environment,
});

console.log(`Created ${approval.id} (${approval.tier}, policy "${approval.policy.name}").`);
if (approval.status === "pending") {
  console.log("Waiting for someone to answer on their phone…");
}

let decision = approval;
try {
  decision = await quirna.approvals.wait(approval.id, { timeoutMs: 10 * 60_000 });
} catch (err) {
  if (err instanceof QuirnaError && err.code === "wait_timeout") {
    // We stopped waiting; the request did not. It is still pending, and
    // `approvals.get(id)` can pick it up later.
    console.log(`Still pending after 10 minutes. Check later: approvals.get("${approval.id}")`);
    process.exit(1);
  }
  throw err;
}

if (decision.status === "approved") {
  const who = decision.auto_approved ? "a Policy, no human needed" : decision.decided_by;
  console.log(`Approved by ${who}. Refunding ${refundId}.`);
  // await payments.refund(refundId);
} else if (decision.status === "rejected") {
  console.log(`Rejected by ${decision.decided_by}. Nothing was refunded.`);
  process.exit(1);
} else {
  // timed_out or cancelled: nobody said yes, so nothing happens.
  console.log(`No decision (${decision.status}). Nothing was refunded.`);
  process.exit(1);
}
