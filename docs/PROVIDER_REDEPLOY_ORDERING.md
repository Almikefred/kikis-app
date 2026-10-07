# Provider redeploy ordering (v1 → v2 manifest signing)

`main` and the two live providers (`api-a.kikis-app.xyz`, `api-b.kikis-app.xyz`)
have diverged on the manifest signing protocol. This is currently safe — do not
redeploy either provider until the steps below are followed in order, or every
published npm client will reject them.

## Current state

- Live providers emit `signature_version` absent (v1).
- `@kikis-app/kikis-app@0.1.2` on npm verifies v1 manifests.
- `main` produces v2 manifests (`signManifest` now emits `signature_version: '2'`,
  and the client rejects v1 outright — #133/PR #240) and provider-b's manifest
  on `main` advertises `mpp-session-ws`, a mode `0.1.2` does not know (#78/PR #227).

As long as live providers stay on v1 and npm stays on `0.1.2`, agents work. A
partial deploy — either provider redeployed from `main` before the SDK
publishes — breaks every existing client on both counts.

## Required order

1. Add the `NPM_TOKEN` repository secret. The repo currently has zero secrets,
   so publishing cannot happen without it.
2. Merge the pending release PR (regenerated to cover all changesets).
3. Confirm `@kikis-app/kikis-app@0.2.0` is live on npm.
4. Redeploy **both** providers together:
   ```bash
   pnpm --filter provider-a deploy
   pnpm --filter provider-b deploy
   ```
5. Verify both serve `signature_version: '2'` and that a `0.2.0` client can pay
   each provider.

Steps 3 and 4 are the window where 0.2.0 clients exist but providers still
serve v1 — keep it as short as possible.

## Also blocked on this

- Provider registration (#210) landed, but the on-chain registry stays empty
  until the providers redeploy and take first traffic.
- Migration `003_settlement_idempotency.sql` is not yet applied, so
  provider-a currently runs without settlement idempotency — a retried
  payment can settle twice on-chain. This needs database access; unrelated to
  the deploy ordering but worth doing in the same maintenance window.
