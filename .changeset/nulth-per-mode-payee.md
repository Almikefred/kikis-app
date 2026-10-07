---
"@kikis-app/nulth-sdk": patch
"@kikis-app/kikis-app": patch
---

Fix `paymentContextFromManifest` in both the SDK and `@kikis-app/nulth-sdk` ignoring a per-mode payee override. Both helpers always returned the top-level `manifest.payee`, while providers pay out to `resolvePayee(manifest, mode)` (`pricing.<mode>.payee ?? manifest.payee`). For any manifest using treasury separation the Nulth allowlist therefore checked an address that never received the payment: an agent allowlisting the real recipient was rejected with `payee_not_allowed`, while one allowlisting only the top-level payee got a signature for funds sent elsewhere. Each helper's parameter type now accepts an optional `payee` and returns `pricing.payee ?? manifest.payee`, mirroring `resolvePayee`.