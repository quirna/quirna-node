/**
 * The public wire contract: every shape that crosses the boundary between a
 * caller's process and the Quirna API.
 *
 * This file is the single definition of those shapes for the whole repo —
 * `@quirna/shared` re-exports from here rather than keeping its own copy, so
 * the server and the published SDK cannot drift. Anything that does *not*
 * travel over the wire (org settings, console roles, policy authoring) stays
 * in `@quirna/shared` and must never be imported here.
 *
 * Nothing in this file may reference `node:*` or DOM-only types: the SDK ships
 * to Node, Bun, Deno, workers and browsers alike.
 */

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "timed_out",
  "cancelled",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const DECISIONS = ["approved", "rejected"] as const;
export type DecisionValue = (typeof DECISIONS)[number];

/**
 * Risk tier shown on the phone. Set by the Policy for a Kind; a caller may
 * raise it per request (never lower it).
 */
export const TIERS = ["routine", "elevated", "critical"] as const;
export type Tier = (typeof TIERS)[number];

export type Identifiers = Record<string, string>;

/** One leg of a quorum rule: `n` approvals from the named group. */
export type PolicyRequirement = { group_id: string; n: number };
export type PolicyPath = PolicyRequirement[];

/** The Policy as it stood when the request was created, frozen onto it. */
export type PolicySnapshot = {
  group_id: string;
  name: string;
  tier: Tier;
  required_approvals: number;
  requester_can_approve: boolean;
  timeout_seconds: number;
  /** Full quorum rule. Absent on rows created before the console redesign. */
  paths?: PolicyPath[];
};

export type Approval = {
  id: string;
  org_id: string;
  kind: string;
  identifiers: Identifiers;
  message: string;
  requester_id: string;
  /** Display name of who or what asked (for example "Treasury Agent"). */
  requester_name: string;
  /** Free-form deployment label (for example "Production"), or null. */
  environment: string | null;
  tier: Tier;
  status: ApprovalStatus;
  callback_url: string | null;
  created_at: string;
  timeout_at: string;
  decided_at: string | null;
  decided_by: string | null;
  approved_count: number;
  /** True when the Policy condition did not match and no human was asked. */
  auto_approved?: boolean;
  policy: PolicySnapshot;
};

export type CreateApprovalInput = {
  kind: string;
  identifiers: Identifiers;
  /** Short imperative title, shown as the request headline: "Withdraw 250,000 USDC". */
  message: string;
  requester_id: string;
  requester_name?: string;
  environment?: string;
  tier?: Tier;
  callback_url?: string;
};

/** The body Quirna POSTs to a `callback_url` once a request is decided. */
export type WebhookBody = {
  approval_id: string;
  kind: string;
  identifiers: Identifiers;
  message: string;
  requester_id: string;
  environment: string | null;
  tier: Tier;
  decision: DecisionValue;
  decided_by: string | null;
  decided_at: string;
  event_id: string;
  timestamp: string;
};

export const WEBHOOK_HEADERS = {
  signature: "x-quirna-signature",
  timestamp: "x-quirna-timestamp",
  eventId: "x-quirna-event-id",
  keyId: "x-quirna-key-id",
} as const;

/** How far a callback's timestamp may sit from our clock before we reject it. */
export const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * A JSON Web Key, as it travels in a JWKS and into `crypto.subtle.importKey`.
 *
 * Spelled out field by field rather than derived from `webcrypto.JsonWebKey`:
 * that type lives in `node:crypto`, and a published SDK cannot assume its
 * consumer has `@types/node` installed. The fields below are the spec'd ones,
 * so this stays structurally assignable to the runtime's own `JsonWebKey`.
 */
export type Jwk = {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
  /** Which key in the set this is. The spec'd type omits it; a JWKS needs it. */
  kid?: string;
};
