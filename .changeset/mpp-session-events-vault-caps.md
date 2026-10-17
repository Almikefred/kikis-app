---
"@kikis-app/kikis-app": minor
---

Add `session:voucher` lifecycle event and `removeAllListeners()` to SessionHandle, wire live per-voucher totals into the React `useSession` hook, and enforce vault spend caps on `record_session_settlement` via the shared `record_spend()` policy.
