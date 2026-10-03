# Examples

Two complete programs, one per integration shape from the
[main README](../README.md#usage):

| | |
| --- | --- |
| [`wait.ts`](./wait.ts) | Asks before a refund, waits for the answer, refunds only on a yes |
| [`webhook.ts`](./webhook.ts) | A deploy endpoint that answers `202` right away, and the callback endpoint that receives and verifies the decision |

Both only import `@quirna/sdk`. To use one in your own project, copy it and
replace the commented-out line that does the real work.

## Before you run them

In the [Console](https://console.quirna.com):

1. Under **Systems**, register one and copy its key (`ck_…`). It is shown once.
2. Note the **kinds** you allowed it to request: the key is refused for any
   other kind, so pass one of them as `QUIRNA_KIND`.
3. Make sure a **Policy** covers that kind, or the org's default Policy does,
   and that you are enrolled as an approver on the phone app.
4. For `webhook.ts` only: under **Webhooks**, allowlist the public URL that
   Quirna will call (see below).

## Running

From a clone of this repository, build the package once. The examples import
it by name, and Node resolves that to the build:

```sh
npm install
npm run build
```

Node 22.18 or later runs TypeScript directly. On Node 20, use
`npx tsx examples/wait.ts` instead of `node examples/wait.ts`. With Bun no build
step is needed: `bun examples/wait.ts`.

### Wait for the decision

```sh
QUIRNA_API_KEY=ck_… QUIRNA_KIND=refund node examples/wait.ts
```

It prints the request's id, then waits up to ten minutes for someone to
answer on their phone.

### Get a webhook callback

Quirna's servers deliver the decision, so they need to reach this process
over public `https`. While developing, a tunnel does that, for example
`cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`. Allowlist
the tunnel's URL in the Console under **Webhooks**, then:

```sh
QUIRNA_API_KEY=ck_… QUIRNA_KIND=deploy \
QUIRNA_CALLBACK_URL=https://<your-tunnel>/hooks/quirna \
node examples/webhook.ts
```

In another terminal, start a deploy:

```sh
curl -X POST http://localhost:8787/deploys
```

It answers `202` straight away. When someone answers on their phone, the server
logs the verified decision.

## Variables

| Variable | Used by | Default | |
| --- | --- | --- | --- |
| `QUIRNA_API_KEY` | both | (none) | The System's key. Required |
| `QUIRNA_KIND` | both | `refund` / `deploy` | One of the kinds the System may request |
| `QUIRNA_REQUESTER_ID` | both | `billing-agent` / `ci` | Who is asking, as approvers will see it |
| `QUIRNA_ENVIRONMENT` | both | (none) | E.g. `Production`; Policies can be scoped to one |
| `QUIRNA_CALLBACK_URL` | `webhook.ts` | (none) | Public `https` URL of the callback path. Required |
| `PORT` | `webhook.ts` | `8787` | Local port to listen on |
| `QUIRNA_BASE_URL` | both | `https://api.quirna.com` | Only to point at another API |
