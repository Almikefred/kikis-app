---
"@kikis-app/kikis-app": patch
"@kikis-app/mcp-server": patch
---

- [MPP Session] Added configurable Soroban RPC URL and base fee overrides in `MppSessionClient.close` (#51).
- [MPP Session] Persist verified voucher cumulative amounts, signatures, and counts to prevent fraud upon Durable Object eviction (#52).
- [MPP Session] Handle already-closed on-chain channels gracefully in `SessionReconciler` (#53).
- [MPP Session] Implement async iterator cleanup (`return()`) in `streamWebSocket` and MCP stream handlers (#54).
