# Changelog

Notable changes to `@quirna/sdk`. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
[semver](https://semver.org/), with the usual 0.x caveat that a minor bump may
still move a type.

Releases are cut with the *SDK* workflow — see
[ADR-0020](../../docs/adr/0020-sdk-release.md). Every entry here should be
readable by someone who has our package installed and none of our context.

## [0.2.0] — 2026-09-20

### Added

- **`status` on `WebhookBody`.** A callback said `decision: "approved"` or
  `decision: "rejected"`, and everything that was not an approval — a human
  rejecting, the request expiring, someone cancelling it — arrived as
  `rejected`. That default is deliberate and unchanged: a handler that branches
  on `decision` fails closed. But it meant a webhook consumer could not tell
  "an approver said no" from "nobody answered", which the polling path
  (`approvals.get`) has always been able to say.

  `status` now carries the request's real terminal status in that same
  vocabulary — `approved`, `rejected`, `timed_out` or `cancelled` — and never
  `pending`, since a callback only fires once the request is terminal.

  Additive: existing handlers keep working untouched.

  ```ts
  if (body.decision === "approved") {
    await deploy(body.identifiers.sha);
  } else if (body.status === "timed_out") {
    await nudge("nobody answered before the window closed");
  }
  ```

### Fixed

- **The README no longer claims device attestation.** 0.1.0 opened with "a
  named human approves it on a device Quirna can attest". There is no
  attestation, and that sentence has been live on npm since 0.1.0 shipped. The
  real claim is Face ID: the API refuses a decision without a fresh biometric
  challenge, and that is what it says now.

### Note for TypeScript consumers

`status` is a required property of `WebhookBody`, so code that *constructs* one
— a hand-built fixture in a test, most likely — will fail to typecheck until it
adds the field. Code that only *reads* the body, which is every real handler
and everything `verifyCallback` returns, is unaffected.

## [0.1.0] — 2026-09-18

First published release.

### Added

- **`Quirna`** client: `approvals.create`, `approvals.get`, `approvals.wait`
  and `approvals.require` (create and block until a human answers), with
  per-request timeouts, retries on idempotent calls only, and `AbortSignal`
  support throughout.
- **`verifyCallback`** — verifies a webhook's Ed25519 signature, its timestamp
  window and its event id against our JWKS, which it caches and refetches on an
  unseen `kid` so a key rotation needs nothing from you.
- **`verifyExport`** — verifies a signed evidence export end to end: that the
  file matches its manifest hash, that the manifest's signature holds, and that
  every decision's own signature covers the record it sits under. Needs only
  WebCrypto, so an auditor can run it under Node, Bun, Deno or a browser
  without trusting us or installing our stack.
- **`fetchJwks`**, the wire types (`Approval`, `CreateApprovalInput`,
  `WebhookBody`, `PolicySnapshot`, …) and the status/tier vocabularies.
- `QuirnaError` carries `status`, a stable `code`, and `retryAfterSeconds` when
  the server sent one.

[0.2.0]: https://github.com/quirna/quirna-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/quirna/quirna-node/releases/tag/v0.1.0
