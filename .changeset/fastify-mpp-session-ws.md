---
"@kikis-app/kikis-app": minor
---

- [Provider] `kikisAppFastify` now supports the `mpp-session-ws` mode (#29): WebSocket upgrade handshakes are routed to the session handler and verified like any other session request, so an unpaid handshake is rejected with 402 before `@fastify/websocket` can upgrade it. Both session transports share one channel store, mode routing now uses the same `resolvePaymentMode` dispatch as the Hono/Express adapters, and the new `mppSessionWsFastifyVerified(request)` helper lets an upgrade route confirm the handshake was paid (mirrors Hono's `mppSessionWsVerified`).
