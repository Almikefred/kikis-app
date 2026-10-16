---
"@kikis-app/kikis-app": patch
---

- [#5] Support configurable Soroban RPC URL and timeout across SDK clients (`KikisAppClientConfig`, `SessionOptions`, `MppChargeClientOptions`, `NulthVaultConfig`, `MppSessionSettlementOverrides`); `rpcUrl` is forwarded to `MppSessionClient`, `NulthVault` ledger lookups, and `MppChargeClient` (`stellar.charge`).
- [#6] Cost-optimized mode selection now compares `mpp-session` voucher rates alongside per-request amounts when `sustained`, and honors endpoint-specific `price`/`amount`/`rate` overrides from `manifest.endpoints[endpoint]` via the new `endpoint` option.
- [#8] `withRetry` honors `Retry-After` (`retryAfterMs`) from facilitator 429/503 responses with jittered backoff, reusing the signed payment payload across retries.
- [#9] `MppChargeClient` accepts a `Keypair` or `ClientStellarSigner` (Nulth ZK accounts, smart accounts, HSMs) and gains `withSigner()`; `KikisAppClient._payWithNulthVault` now allows `mpp-charge` and settles discrete payments through the Nulth vault signer (with #34).
