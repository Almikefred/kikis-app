---
"@kikis-app/kikis-app": patch
---

- [Nulth] Enable `mpp-charge` payment mode in `KikisAppClient._payWithNulthVault` with signer swap via `MppChargeClient.withSigner` (#34).
- [Examples] Forward `method`, `headers`, and `body` through `ModeSelectOptions` in `X402Client` and `MppChargeClient` so POST examples pay correctly (#35, #36).
- [RPC] Add configurable `horizonRpcUrl` / `rpcTimeoutMs` to trustline preflight and `sorobanRpcUrl` / `rpcTimeoutMs` to Nulth ledger lookups (#3, #9).
- [Types] Add missing `VAULT_CONFIG` error code, make `SpendCap.decimals` and `DailySpend.pendingReserves` backward compatible, and fix `exactOptionalPropertyTypes` violations.
