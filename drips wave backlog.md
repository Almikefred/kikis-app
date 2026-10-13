# RouteDock / KikisApp — Drips Wave Engineering Issue Backlog

> **Backlog & Publication Status (Reconciled 2026-10-13)**:
> - **Total Issues Researched & Tracked**: **134 issues**.
> - **Total Successfully Published to GitHub**: **134 issues** (Batch 1: Issues `#3`–`#32` [30]; Batch 2: Issues `#34`–`#83` [50]; Batch 3: Issues `#84`–`#127` [44]; Batch 4: Issues `#128`–`#137` [10]).
> - **Duplicate Draft Records Retained**: **0 records** (All 6 historical duplicate draft records permanently removed).
> - **Remaining Active Unpublished Drafts**: **0 drafts**.

## 1. Project Overview & Purpose

RouteDock (maintained locally within this repository as `kikis-app`) is a unified, autonomous payment execution and settlement layer for AI agents operating on the Stellar network and Soroban smart contract platform. Autonomous agents require sub-cent, low-latency, and policy-governed transaction rails to discover API services, negotiate payment requirements, execute discrete or continuous payments, and settle transactions without manual human intervention.

RouteDock unifies four distinct payment execution modes under a single client abstraction:
1. **x402**: HTTP 402 Payment Required flows with signed payment headers settled via payment facilitators (such as OpenZeppelin Channels).
2. **mpp-charge**: Discrete, single-request pull payments leveraging the Metered Payment Protocol (MPP) and Stellar Asset Contracts (SAC).
3. **mpp-session**: Streaming, continuous payment sessions built on Soroban state channels (`stellar-experimental/one-way-channel`), issuing monotonic cumulative vouchers over Server-Sent Events (SSE).
4. **mpp-session-ws**: High-performance WebSocket variant of MPP sessions, opening channels and negotiating vouchers over HTTP before upgrading to persistent WebSockets for bidirectional and streaming AI workloads.

In addition to routing, the architecture integrates:
- **Soroban Agent Vault Contract (`contracts/agent-vault`)**: On-chain smart account enforcing daily USDC spend caps, payee allowlists with per-payee sub-caps, session-key ledger expiration, lifetime spend caps, and timelocked Wasm upgrades.
- **Nulth Zero-Knowledge Vault (`@kikis-app/nulth-sdk`)**: Off-chain ZK proof generation and verification for privacy-preserving agent spend authorization.
- **Model Context Protocol (MCP) Server (`@kikis-app/mcp-server`)**: Standardized tool interface allowing LLMs and autonomous agents (e.g., Claude Desktop, autonomous runners) to discover providers, check wallet balances, execute payments, and manage streaming sessions.
- **Edge Provider Infrastructure (`apps/provider-a`, `apps/provider-b`)**: Cloudflare Workers and Durable Object implementations for provider data feeds, settlement deduplication, and automated abandoned-session reconciliation.
- **Next.js Operator Dashboard (`apps/web`)**: Web UI for monitoring provider registries, real-time transaction activity, open session collateral, and settlement dispute status.

---

## 2. Investigation Summary & Codebase Architecture

A comprehensive investigation of the RouteDock / KikisApp codebase was conducted across all workspace packages, applications, contracts, database migrations, configuration files, examples, and tests.

### Package & Workspace Inventory
- `packages/sdk` (`@kikis-app/kikis-app`): The core TypeScript SDK containing `KikisAppClient`, `ModeRouter`, `X402Client`, `MppChargeClient`, `MppSessionClient`, `NulthVault`, in-memory and file spend stores, provider middleware adapters (`hono`, `fastify`, `express`), and on-chain/Supabase provider registries.
- `packages/nulth-sdk` (`@kikis-app/nulth-sdk`): Cryptographic proof builder, witness commitment generators, and mock prover interfaces for Nulth smart accounts.
- `packages/mcp-server` (`@kikis-app/mcp-server`): Model Context Protocol server exposing `pay_for_data`, `open_session`, `stream_session`, `close_session`, `check_balance`, and `list_providers`.
- `contracts/agent-vault`: Rust Soroban contract implementation (`contracts/agent-vault/src/lib.rs`) adhering to `CustomAccountInterface` with timelocked Wasm upgrades and ledger-based TTL management.
- `apps/provider-a`: Cloudflare Worker delivering XLM/USDC orderbook data via `x402` and `mpp-charge` with Supabase settlement deduplication.
- `apps/provider-b`: Cloudflare Worker and Durable Object (`ChannelSession.ts`) delivering streaming orderbook updates via `mpp-session` (SSE) and `mpp-session-ws` (WebSocket) with cron-based abandoned-session reconciliation.
- `apps/web`: Next.js 15 application displaying registry providers, network health, session metrics, and on-chain transaction logs.
- `agent`: Reference autonomous agent runner, stress testing harness (`agent/src/stress.ts`), and abandoned-session recovery script.
- `examples`: Integration examples demonstrating agent-to-agent task delegation, mock LLM inference, price oracle consumption, and streaming orderbook ingestion.
- `supabase`: Schema definitions and SQL migrations (001 through 006) managing `providers`, `sessions`, `tx_log`, `settlements`, and dashboard statistics.

### Architectural Gaps & Risks Discovered
1. **Discrete Payment Request Body & Method Gaps**: `KikisAppClient.pay()`, `X402Client`, and `MppChargeClient` currently only execute HTTP `GET` requests without request bodies or custom headers. This prevents agents from calling standard AI endpoints (e.g., POST `/v1/chat/completions` or `/infer`).
2. **WebSocket Streaming Protocol Deadlock**: In `MppSessionClient.streamWebSocket()`, the client opens a WebSocket connection and passively waits for messages from the server. However, `apps/provider-b/src/ChannelSession.ts` only starts pushing orderbook frames upon receiving an initial client message (`onMessage`). Because `WebSocketLike` does not support client sending, connections hang indefinitely.
3. **MCP Tool Validation Disconnects**: `pay_for_data` in `@kikis-app/mcp-server` lists `mpp-session` and `mpp-session-ws` as selectable options in its schema and description, yet `client.pay()` throws an explicit rejection when passed session modes, crashing agents that follow the tool description.
4. **Smart Contract Settlement Accounting Boundary**: `AgentVault.record_session_settlement` verifies allowlisted payees and emits an event, but does not verify the `payer` parameter or deduct the settled amount from `day_spend`, `payee_spend`, or `lifetime_spend`, allowing channel spending to bypass on-chain caps.
5. **Hardcoded Public RPC Endpoints**: Core SDK clients hardcode public Horizon and Soroban RPC endpoints (`https://soroban-testnet.stellar.org`, `https://soroban.stellar.org`) without allowing custom RPC URLs, API keys, or timeout/retry overrides.
6. **Code Duplication in Nulth Integration**: `packages/sdk/src/client/NulthVault.ts` inlines hundreds of lines of proof generation and signing logic already published in `@kikis-app/nulth-sdk`, causing synchronization drift and error type mismatches.
7. **Examples Syntax & Protocol Failures**: Example agents in `examples/agent-to-agent` and `examples/inference-agent` contain unquoted hyphenated object properties (`kikis-app: '1.0'`) and attempt to call `client.pay()` against POST endpoints.

---

## 3. Backlog Organization & Label Conventions

The backlog is organized into 11 cohesive engineering domains:
- **Domain 1**: Core SDK Architecture & Payment Execution
- **Domain 2**: x402 Protocol & Facilitator Integration
- **Domain 3**: MPP Charge Protocol & SAC Interactions
- **Domain 4**: MPP Session Streaming & WebSocket Channels
- **Domain 5**: Soroban Smart Contracts & Agent Vault
- **Domain 6**: Nulth Vault & Cryptographic Signing
- **Domain 7**: MCP Server Tools & Agent Runtime
- **Domain 8**: Provider Infrastructure & Cloudflare Workers
- **Domain 9**: Database, Storage & Settlement Deduplication
- **Domain 10**: Web Dashboard & Monitoring
- **Domain 11**: Developer Experience, Tooling & CI/CD

### GitHub Label Taxonomy
- `sdk`: Core TypeScript SDK (`packages/sdk`)
- `x402`: HTTP 402 payment flow and facilitator integration
- `mpp-charge`: MPP discrete charge flows and SAC transfers
- `mpp-session`: MPP streaming sessions, channels, and WebSockets
- `smart-contracts`: Rust Soroban contracts (`contracts/agent-vault`)
- `mcp`: Model Context Protocol server (`packages/mcp-server`)
- `provider`: Provider infrastructure and Cloudflare Workers (`apps/provider-*`)
- `dashboard`: Next.js web application and operator dashboard (`apps/web`)
- `database`: PostgreSQL / Supabase schema, migrations, and indexing
- `security`: Cryptographic checks, spend caps, auth contexts, replay protection
- `performance`: RPC efficiency, caching, connection pooling, latency
- `bug`: Correction of existing runtime defects or functional bugs
- `enhancement`: Feature improvements and architectural capabilities
- `testing`: Unit, behavioral, invariant, or end-to-end test coverage
- `developer-experience`: Documentation, examples, and typing ergonomics
- `infrastructure`: CI/CD workflows, build scripts, and linting

---

## 4. Priority Legend

### Priority Legend
- **P0**: Critical correctness or security issue that causes funds loss, cap bypass, system crash, or unrecoverable deadlock.
- **P1**: High-impact functional defect, broken protocol flow, major performance bottleneck, or severe DX roadblock.
- **P2**: Meaningful improvement to reliability, edge-case recovery, testing depth, or operational maintainability.
- **P3**: Non-blocking enhancement, architectural cleanup, UI polish, or developer experience refinement.


---

---

## Published Issue Register (134 Issues Verified on GitHub)

This register records all 134 GitHub issues successfully created and verified on repository [`dev-kiki0/kikis-app`](https://github.com/dev-kiki0/kikis-app), mapping each remote issue to its local backlog identifier.

### Batch 1: Previously Published Issues (30 Issues — GitHub #3 to #32)

| Local ID | GitHub Issue | Title | Priority | Labels | Canonical GitHub URL |
|---|---|---|---|---|---|
| 1 | [#3](https://github.com/dev-kiki0/kikis-app/issues/3) | [SDK] Support Request Payload and Method Forwarding in `KikisAppClient.pay()` | P0 | `sdk`, `bug`, `api` | https://github.com/dev-kiki0/kikis-app/issues/3 |
| 2 | [#4](https://github.com/dev-kiki0/kikis-app/issues/4) | [SDK] Prevent Cache-Stampede on Concurrent Manifest Fetches | P2 | `sdk`, `performance` | https://github.com/dev-kiki0/kikis-app/issues/4 |
| 3 | [#5](https://github.com/dev-kiki0/kikis-app/issues/5) | [SDK] Allow Configurable Soroban RPC URL Instead of Hardcoded Horizon Endpoints | P1 | `sdk`, `configuration`, `soroban` | https://github.com/dev-kiki0/kikis-app/issues/5 |
| 4 | [#6](https://github.com/dev-kiki0/kikis-app/issues/6) | [SDK] Incorporate Session Mode Cost Amortization in `CostOptimal` Strategy | P2 | `sdk`, `routing`, `enhancement` | https://github.com/dev-kiki0/kikis-app/issues/6 |
| 8 | [#7](https://github.com/dev-kiki0/kikis-app/issues/7) | [x402] Validate Expiration Ledger in Payment Requirements Challenge | P1 | `x402`, `security`, `validation` | https://github.com/dev-kiki0/kikis-app/issues/7 |
| 10 | [#8](https://github.com/dev-kiki0/kikis-app/issues/8) | [x402] Recover from Facilitator Network Disconnects During Settlement | P1 | `x402`, `reliability`, `networking` | https://github.com/dev-kiki0/kikis-app/issues/8 |
| 11 | [#9](https://github.com/dev-kiki0/kikis-app/issues/9) | [MPP Charge] Support Custom Signers in `MppChargeClient` for Smart Account Vaults | P1 | `mpp-charge`, `smart-contracts`, `sdk` | https://github.com/dev-kiki0/kikis-app/issues/9 |
| 13 | [#10](https://github.com/dev-kiki0/kikis-app/issues/10) | [MPP Charge] Support Arbitrary SAC Asset Contracts in Pull-Payment Flows | P2 | `mpp-charge`, `sac`, `enhancement` | https://github.com/dev-kiki0/kikis-app/issues/10 |
| 14 | [#11](https://github.com/dev-kiki0/kikis-app/issues/11) | [MPP Charge] Standardize Error Wrapping for Aborted Pull-Payment Credential Creations | P2 | `mpp-charge`, `errors`, `developer-experience` | https://github.com/dev-kiki0/kikis-app/issues/11 |
| 15 | [#12](https://github.com/dev-kiki0/kikis-app/issues/12) | [MPP Session] Fix WebSocket Handshake Deadlock Between Client and Provider B | P0 | `mpp-session`, `websocket`, `deadlock` | https://github.com/dev-kiki0/kikis-app/issues/12 |
| 17 | [#13](https://github.com/dev-kiki0/kikis-app/issues/13) | [MPP Session] Re-query Channel State on Dispute Settlement Transaction Drop | P1 | `mpp-session`, `dispute`, `blockchain` | https://github.com/dev-kiki0/kikis-app/issues/13 |
| 18 | [#14](https://github.com/dev-kiki0/kikis-app/issues/14) | [MPP Session] Remove Leaked Event Listeners on SSE Stream Disconnects | P2 | `mpp-session`, `memory-leak`, `reliability` | https://github.com/dev-kiki0/kikis-app/issues/14 |
| 19 | [#15](https://github.com/dev-kiki0/kikis-app/issues/15) | [MPP Session] Fix React `useSession` Hook Voucher Counting and State Synchronization | P1 | `mpp-session`, `react`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/15 |
| 21 | [#16](https://github.com/dev-kiki0/kikis-app/issues/16) | [Smart Contract] Enforce Payer Parameter Validation in `record_session_settlement` | P0 | `smart-contracts`, `security`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/16 |
| 22 | [#17](https://github.com/dev-kiki0/kikis-app/issues/17) | [Smart Contract] Add Batch Settlement Execution in Agent Vault Contract | P2 | `smart-contracts`, `performance`, `soroban` | https://github.com/dev-kiki0/kikis-app/issues/17 |
| 26 | [#18](https://github.com/dev-kiki0/kikis-app/issues/18) | [Smart Contract] Enforce Sequence Number Granularity to Prevent Sub-Sequence Replays | P1 | `smart-contracts`, `security`, `soroban` | https://github.com/dev-kiki0/kikis-app/issues/18 |
| 27 | [#19](https://github.com/dev-kiki0/kikis-app/issues/19) | [Nulth Vault] Eliminate Duplicate Proof Construction Logic Between SDK and Nulth SDK | P1 | `nulth`, `refactoring`, `code-quality` | https://github.com/dev-kiki0/kikis-app/issues/19 |
| 29 | [#20](https://github.com/dev-kiki0/kikis-app/issues/20) | [Nulth Vault] Throw Specific `KikisAppVaultConfigError` Instead of `KikisAppManifestError` | P2 | `nulth`, `errors`, `developer-experience` | https://github.com/dev-kiki0/kikis-app/issues/20 |
| 31 | [#21](https://github.com/dev-kiki0/kikis-app/issues/21) | [Nulth Vault] Validate Ed25519 Session Key Signature Format Before Proof Generation | P2 | `nulth`, `security`, `validation` | https://github.com/dev-kiki0/kikis-app/issues/21 |
| 32 | [#22](https://github.com/dev-kiki0/kikis-app/issues/22) | [MCP Server] Prevent Crash in `pay_for_data` Tool When Provider Uses `mpp-session` | P0 | `mcp`, `bug`, `crash` | https://github.com/dev-kiki0/kikis-app/issues/22 |
| 33 | [#23](https://github.com/dev-kiki0/kikis-app/issues/23) | [MCP Server] Forward `commitmentSecret` to `openSession()` in `open_session` Tool | P1 | `mcp`, `mpp-session`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/23 |
| 34 | [#24](https://github.com/dev-kiki0/kikis-app/issues/24) | [MCP Server] Expose `check_spend_cap` and `get_vault_status` MCP Tools | P2 | `mcp`, `enhancement`, `agent-tools` | https://github.com/dev-kiki0/kikis-app/issues/24 |
| 35 | [#25](https://github.com/dev-kiki0/kikis-app/issues/25) | [MCP Server] Restrict Allowed URL Protocols to Prevent SSRF via MCP Tools | P1 | `mcp`, `security`, `ssrf` | https://github.com/dev-kiki0/kikis-app/issues/25 |
| 37 | [#26](https://github.com/dev-kiki0/kikis-app/issues/26) | [Provider] Handle Horizon 429 Rate Limits Gracefully in Cloudflare Worker Provider A | P1 | `provider`, `cloudflare`, `reliability` | https://github.com/dev-kiki0/kikis-app/issues/26 |
| 38 | [#27](https://github.com/dev-kiki0/kikis-app/issues/27) | [Provider] Clear Interval Timer on WebSocket Abnormal Close in Provider B Worker | P1 | `provider`, `memory-leak`, `cloudflare` | https://github.com/dev-kiki0/kikis-app/issues/27 |
| 39 | [#28](https://github.com/dev-kiki0/kikis-app/issues/28) | [Provider] Add Distributed Lock to Provider Scheduled Settlement Cron Workers | P1 | `provider`, `concurrency`, `database` | https://github.com/dev-kiki0/kikis-app/issues/28 |
| 40 | [#29](https://github.com/dev-kiki0/kikis-app/issues/29) | [Provider] Implement Fastify WebSocket Transport Middleware for `mpp-session-ws` | P2 | `provider`, `mpp-session`, `enhancement` | https://github.com/dev-kiki0/kikis-app/issues/29 |
| 41 | [#30](https://github.com/dev-kiki0/kikis-app/issues/30) | [Store] Add File-Locking Mechanism to `FileSpendStore` for Concurrent Agent Processes | P1 | `sdk`, `security`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/30 |
| 42 | [#31](https://github.com/dev-kiki0/kikis-app/issues/31) | [Store] Handle Database Connection Failures Gracefully in `SupabaseSeenTxStore` Idempotency Checks | P1 | `sdk`, `provider`, `reliability` | https://github.com/dev-kiki0/kikis-app/issues/31 |
| 43 | [#32](https://github.com/dev-kiki0/kikis-app/issues/32) | [Database] Add Missing Composite Indexes to `tx_log` and `sessions` Migration Schema | P2 | `database`, `performance`, `infrastructure` | https://github.com/dev-kiki0/kikis-app/issues/32 |

### Batch 2: Newly Published Issues (50 Issues — GitHub #34 to #83)

| Local ID | GitHub Issue | Title | Verification | Canonical GitHub URL |
|---|---|---|---|---|
| 28 | [#34](https://github.com/dev-kiki0/kikis-app/issues/34) | [Nulth] Enable `mpp-charge` Payment Mode in `KikisAppClient._payWithNulthVault` | Verified | [#34](https://github.com/dev-kiki0/kikis-app/issues/34) |
| 48 | [#35](https://github.com/dev-kiki0/kikis-app/issues/35) | [Examples] Fix Unquoted Property Syntax Error and Missing Request Body in `agent-to-agent` Example | Verified | [#35](https://github.com/dev-kiki0/kikis-app/issues/35) |
| 49 | [#36](https://github.com/dev-kiki0/kikis-app/issues/36) | [Examples] Fix Unquoted Property Syntax Error and HTTP Method Mismatch in `inference-agent` Example | Verified | [#36](https://github.com/dev-kiki0/kikis-app/issues/36) |
| 51 | [#37](https://github.com/dev-kiki0/kikis-app/issues/37) | [SDK] Inject Configurable Horizon RPC URL and Timeout into `_checkTrustline` | Verified | [#37](https://github.com/dev-kiki0/kikis-app/issues/37) |
| 52 | [#38](https://github.com/dev-kiki0/kikis-app/issues/38) | [SDK] Enforce Strict Issuer Matching for Non-USDC Assets in Trustline Preflight | Verified | [#38](https://github.com/dev-kiki0/kikis-app/issues/38) |
| 53 | [#39](https://github.com/dev-kiki0/kikis-app/issues/39) | [SDK] Convert Spend Limits and Accumulators Using Asset-Specific Decimals Instead of Hardcoded USDC Stroops | Verified | [#39](https://github.com/dev-kiki0/kikis-app/issues/39) |
| 54 | [#40](https://github.com/dev-kiki0/kikis-app/issues/40) | [SDK] Persist In-Flight Reservation Records to Prevent Phantom Spend Cap Leaks Across Process Crashes | Verified | [#40](https://github.com/dev-kiki0/kikis-app/issues/40) |
| 55 | [#41](https://github.com/dev-kiki0/kikis-app/issues/41) | [SDK] Support Non-JSON Response Formats (Text, Blob, Buffer) in `X402Client` and `MppChargeClient` | Verified | [#41](https://github.com/dev-kiki0/kikis-app/issues/41) |
| 56 | [#42](https://github.com/dev-kiki0/kikis-app/issues/42) | [SDK] Propagate `AbortSignal` Through `withRetry` and Retry Delay Timers | Verified | [#42](https://github.com/dev-kiki0/kikis-app/issues/42) |
| 57 | [#43](https://github.com/dev-kiki0/kikis-app/issues/43) | [Router] Fix Multi-Mode Routing in `kikisAppHono` to Prevent Skipping `mpp-charge` When Session Modes Are Enabled | Verified | [#43](https://github.com/dev-kiki0/kikis-app/issues/43) |
| 58 | [#44](https://github.com/dev-kiki0/kikis-app/issues/44) | [Router] Fix Mode Precedence in Express `kikisAppMiddleware` to Allow Explicit `mpp-charge` Dispatching | Verified | [#44](https://github.com/dev-kiki0/kikis-app/issues/44) |
| 59 | [#45](https://github.com/dev-kiki0/kikis-app/issues/45) | [Router] Respect Developer-Specified `explicitContract` in `resolveAssetContract` When Multi-Asset Config is Present | Verified | [#45](https://github.com/dev-kiki0/kikis-app/issues/45) |
| 60 | [#46](https://github.com/dev-kiki0/kikis-app/issues/46) | [Router] Validate Multi-Asset Challenge Payee and Currency in `checkX402Accept` and `checkChargeChallenge` | Verified | [#46](https://github.com/dev-kiki0/kikis-app/issues/46) |
| 63 | [#47](https://github.com/dev-kiki0/kikis-app/issues/47) | [Facilitator] Catch Network and Abort Errors in `withRetry` Instead of Bypassing Retry Loop | Verified | [#47](https://github.com/dev-kiki0/kikis-app/issues/47) |
| 64 | [#48](https://github.com/dev-kiki0/kikis-app/issues/48) | [Facilitator] Support Dynamic Base Fee Bumping During Stellar Network Fee Surges in `MppChargeClient` | Verified | [#48](https://github.com/dev-kiki0/kikis-app/issues/48) |
| 66 | [#49](https://github.com/dev-kiki0/kikis-app/issues/49) | [Facilitator] Validate OpenZeppelin Facilitator Response Schema and Signature Nonce Alignment | Verified | [#49](https://github.com/dev-kiki0/kikis-app/issues/49) |
| 68 | [#50](https://github.com/dev-kiki0/kikis-app/issues/50) | [MPP Session] Prevent Permanent Channel Orphan Lock by Delaying `closed = true` Until Settlement Simulation Succeeds | Verified | [#50](https://github.com/dev-kiki0/kikis-app/issues/50) |
| 69 | [#51](https://github.com/dev-kiki0/kikis-app/issues/51) | [MPP Session] Add Configurable Soroban RPC URL and Base Fee Overrides in `MppSessionClient.close` | Verified | [#51](https://github.com/dev-kiki0/kikis-app/issues/51) |
| 70 | [#52](https://github.com/dev-kiki0/kikis-app/issues/52) | [MPP Session] Reconcile Cloudflare Durable Object Session Eviction with Closure-Scoped Voucher Counters | Verified | [#52](https://github.com/dev-kiki0/kikis-app/issues/52) |
| 72 | [#53](https://github.com/dev-kiki0/kikis-app/issues/53) | [MPP Session] Handle Already-Closed On-Chain Channels Gracefully in `SessionReconciler` | Verified | [#53](https://github.com/dev-kiki0/kikis-app/issues/53) |
| 73 | [#54](https://github.com/dev-kiki0/kikis-app/issues/54) | [MPP Session] Implement Proper Async Iterator Cleanup (`return()`) in `streamWebSocket` and MCP Stream Handlers | Verified | [#54](https://github.com/dev-kiki0/kikis-app/issues/54) |
| 74 | [#55](https://github.com/dev-kiki0/kikis-app/issues/55) | [Voucher] Replace IEEE 754 `parseFloat` with Stroop `BigInt` Arithmetic in `SupabaseSessionStore` | Verified | [#55](https://github.com/dev-kiki0/kikis-app/issues/55) |
| 75 | [#56](https://github.com/dev-kiki0/kikis-app/issues/56) | [Voucher] Eliminate TOCTOU Race Condition in `SupabaseSessionStore.upsert` with Atomic SQL Updates | Verified | [#56](https://github.com/dev-kiki0/kikis-app/issues/56) |
| 76 | [#57](https://github.com/dev-kiki0/kikis-app/issues/57) | [Voucher] Trigger `onSettled` Callback in `MppChargeHandler` When Receipt Header Uses Alternative Formats | Verified | [#57](https://github.com/dev-kiki0/kikis-app/issues/57) |
| 77 | [#58](https://github.com/dev-kiki0/kikis-app/issues/58) | [Voucher] Scope In-Memory Voucher and Session Records Per-Channel to Prevent Multi-Tenant Session Cross-Talk | Verified | [#58](https://github.com/dev-kiki0/kikis-app/issues/58) |
| 78 | [#59](https://github.com/dev-kiki0/kikis-app/issues/59) | [Voucher] Enforce Hard Replay Cap Directly in `claim_settlement_replay` SQL Migration | Verified | [#59](https://github.com/dev-kiki0/kikis-app/issues/59) |
| 79 | [#60](https://github.com/dev-kiki0/kikis-app/issues/60) | [Contracts] Enforce Emergency Freeze Check in `record_session_settlement` Entrypoint | Verified | [#60](https://github.com/dev-kiki0/kikis-app/issues/60) |
| 80 | [#61](https://github.com/dev-kiki0/kikis-app/issues/61) | [Contracts] Refresh Instance Storage TTL via `bump_instance` in `record_session_settlement` | Verified | [#61](https://github.com/dev-kiki0/kikis-app/issues/61) |
| 81 | [#62](https://github.com/dev-kiki0/kikis-app/issues/62) | [Contracts] Restrict SAC `transfer` Authorization Contexts to Configured Asset Contract Address | Verified | [#62](https://github.com/dev-kiki0/kikis-app/issues/62) |
| 82 | [#63](https://github.com/dev-kiki0/kikis-app/issues/63) | [Contracts] Add Expiration Grace Window to Pending Wasm Upgrades in Agent Vault Contract | Verified | [#63](https://github.com/dev-kiki0/kikis-app/issues/63) |
| 83 | [#64](https://github.com/dev-kiki0/kikis-app/issues/64) | [Contracts] Implement Contract View Function for Current Daily Spend and Remaining Allowance | Verified | [#64](https://github.com/dev-kiki0/kikis-app/issues/64) |
| 85 | [#65](https://github.com/dev-kiki0/kikis-app/issues/65) | [Nulth] Prevent Race Conditions by Eliminating Mutable Shared State in `createNulthSigner` | Verified | [#65](https://github.com/dev-kiki0/kikis-app/issues/65) |
| 86 | [#66](https://github.com/dev-kiki0/kikis-app/issues/66) | [Nulth] Implement Rollback Capability for Off-Chain Daily Spend on Failed Proof Transactions | Verified | [#66](https://github.com/dev-kiki0/kikis-app/issues/66) |
| 87 | [#67](https://github.com/dev-kiki0/kikis-app/issues/67) | [Nulth] Replace Comma-Delimited String Concatenation in `commitAllowlist` with Canonical Length-Prefixed Encoding | Verified | [#67](https://github.com/dev-kiki0/kikis-app/issues/67) |
| 90 | [#68](https://github.com/dev-kiki0/kikis-app/issues/68) | [MCP] Handle Horizon 404 Unfunded Account Errors Gracefully in `handleCheckBalance` | Verified | [#68](https://github.com/dev-kiki0/kikis-app/issues/68) |
| 91 | [#69](https://github.com/dev-kiki0/kikis-app/issues/69) | [MCP] Reuse Existing Stream Iterator Instead of Re-opening Connections on Every `stream_session` Call | Verified | [#69](https://github.com/dev-kiki0/kikis-app/issues/69) |
| 92 | [#70](https://github.com/dev-kiki0/kikis-app/issues/70) | [MCP] Add `estimate_cost` Tool to MCP Server for Agent Pre-Execution Budgeting | Verified | [#70](https://github.com/dev-kiki0/kikis-app/issues/70) |
| 94 | [#71](https://github.com/dev-kiki0/kikis-app/issues/71) | [MCP] Enforce Sanitized URL Parsing and Block Localhost SSRF Across All MCP Tool Handlers | Verified | [#71](https://github.com/dev-kiki0/kikis-app/issues/71) |
| 96 | [#72](https://github.com/dev-kiki0/kikis-app/issues/72) | [Provider] Allow External `SessionStore` Injection in Express `createMppSessionHandler` | Verified | [#72](https://github.com/dev-kiki0/kikis-app/issues/72) |
| 97 | [#73](https://github.com/dev-kiki0/kikis-app/issues/73) | [Provider] Standardize Catch-All Error Handling for Malformed Payment Signature Headers in Provider Middleware | Verified | [#73](https://github.com/dev-kiki0/kikis-app/issues/73) |
| 100 | [#74](https://github.com/dev-kiki0/kikis-app/issues/74) | [Provider] Add Request Body Buffering and Replay for POST Endpoints in Fastify Provider Adapter | Verified | [#74](https://github.com/dev-kiki0/kikis-app/issues/74) |
| 106 | [#75](https://github.com/dev-kiki0/kikis-app/issues/75) | [Dashboard] Render Graceful Setup Fallback UI When Supabase Credentials Are Unset Instead of Runtime Crash | Verified | [#75](https://github.com/dev-kiki0/kikis-app/issues/75) |
| 108 | [#76](https://github.com/dev-kiki0/kikis-app/issues/76) | [Dashboard] Add In-Flight Request Deduplication and Abort Controller to `usePay` React Hook | Verified | [#76](https://github.com/dev-kiki0/kikis-app/issues/76) |
| 112 | [#77](https://github.com/dev-kiki0/kikis-app/issues/77) | [Database] Update `sessions.status` Check Constraint to Support Dispute and Refund States | Verified | [#77](https://github.com/dev-kiki0/kikis-app/issues/77) |
| 117 | [#78](https://github.com/dev-kiki0/kikis-app/issues/78) | [Agent] Implement Auto-Close and Cleanup Handler in Reference Autonomous Agent Runner | Verified | [#78](https://github.com/dev-kiki0/kikis-app/issues/78) |
| 122 | [#79](https://github.com/dev-kiki0/kikis-app/issues/79) | [Security] Verify Authorization Payload Nonce Expiration and Replay Cache in Provider Adapters | Verified | [#79](https://github.com/dev-kiki0/kikis-app/issues/79) |
| 123 | [#80](https://github.com/dev-kiki0/kikis-app/issues/80) | [Security] Prevent Delimiter Confusion and Injection in Multi-Parameter Witness Commitments | Verified | [#80](https://github.com/dev-kiki0/kikis-app/issues/80) |
| 124 | [#81](https://github.com/dev-kiki0/kikis-app/issues/81) | [Security] Enforce Maximum In-Flight Collateral Cap Across Multiple Concurrent Open Sessions | Verified | [#81](https://github.com/dev-kiki0/kikis-app/issues/81) |
| 126 | [#82](https://github.com/dev-kiki0/kikis-app/issues/82) | [Security] Reject Zero-Value and Negative Spend Reservations in `_checkAndReserveSpend` | Verified | [#82](https://github.com/dev-kiki0/kikis-app/issues/82) |
| 127 | [#83](https://github.com/dev-kiki0/kikis-app/issues/83) | [CI/CD] Add Automated Soroban Contract Unit Tests and Integration Tests to GitHub Actions Workflow | Verified | [#83](https://github.com/dev-kiki0/kikis-app/issues/83) |

---

### Batch 3: Final Publication Batch (44 Issues — GitHub #84 to #127)

| Draft ID | GitHub Issue | Title | Category | Priority | Labels | Status |
|---|---|---|---|---|---|---|
| Issue 5 | [#84](https://github.com/dev-kiki0/kikis-app/issues/84) | [SDK] Add Outbound HTTP/SOCKS5 Proxy Dispatcher Support for Enterprise Agent Runtimes | Core SDK Architecture & Payment Execution | P2 | `enhancement` `infrastructure` `sdk` | **Published (Batch 3)** |
| Issue 6 | [#85](https://github.com/dev-kiki0/kikis-app/issues/85) | [SDK] Unify Subpath Type Exports and Re-export Missing Internal Types at Package Root | Core SDK Architecture & Payment Execution | P3 | `bug` `developer-experience` `sdk` | **Published (Batch 3)** |
| Issue 9 | [#86](https://github.com/dev-kiki0/kikis-app/issues/86) | [x402] Add Pinned TLS Certificate and Custom mTLS Client Option for Facilitator Connections | x402 Protocol & Facilitator Integration | P2 | `enhancement` `security` `x402` | **Published (Batch 3)** |
| Issue 20 | [#87](https://github.com/dev-kiki0/kikis-app/issues/87) | [MPP Session] Propagate Session Lifetime Expiration and Timeout Events to React `useSession` Hook | MPP Session Streaming & WebSocket Channels | P2 | `bug` `mpp-session` `sdk` | **Published (Batch 3)** |
| Issue 23 | [#88](https://github.com/dev-kiki0/kikis-app/issues/88) | [Contracts] Add Batch Session Settlement Entrypoint for High-Throughput Providers | Soroban Smart Contracts & Agent Vault | P2 | `enhancement` `performance` `smart-contracts` | **Published (Batch 3)** |
| Issue 24 | [#89](https://github.com/dev-kiki0/kikis-app/issues/89) | [Contracts] Implement Multi-Sig / Two-Step Admin Governance for Emergency Vault Functions | Soroban Smart Contracts & Agent Vault | P2 | `enhancement` `security` `smart-contracts` | **Published (Batch 3)** |
| Issue 25 | [#90](https://github.com/dev-kiki0/kikis-app/issues/90) | [Contracts] Verify Ledger Close Time Variations Against Fixed Upgrade Timelock | Soroban Smart Contracts & Agent Vault | P3 | `bug` `security` `smart-contracts` | **Published (Batch 3)** |
| Issue 30 | [#91](https://github.com/dev-kiki0/kikis-app/issues/91) | [Nulth] Allow Configurable RPC URL and Timeout in `fetchLedgerSequence` | Nulth Vault & Cryptographic Signing | P2 | `bug` `infrastructure` `sdk` | **Published (Batch 3)** |
| Issue 36 | [#92](https://github.com/dev-kiki0/kikis-app/issues/92) | [MCP Server] Add Tool Response Streaming Pagination for High-Volume Registry Discovery | MCP Server Tools & Agent Runtime | P3 | `enhancement` `mcp` `performance` | **Published (Batch 3)** |
| Issue 44 | [#93](https://github.com/dev-kiki0/kikis-app/issues/93) | [Database] Scope `public_dashboard_stats` Aggregation View by Network and Support Partitioned Totals | Database, Storage & Settlement Deduplication | P2 | `bug` `database` `developer-experience` | **Published (Batch 3)** |
| Issue 45 | [#94](https://github.com/dev-kiki0/kikis-app/issues/94) | [Dashboard] Implement Real-Time Supabase WebSocket Subscriptions in `DashboardMetrics` and `TxFeed` | Dashboard & Web Application | P2 | `developer-experience` `enhancement` `performance` | **Published (Batch 3)** |
| Issue 46 | [#95](https://github.com/dev-kiki0/kikis-app/issues/95) | [Dashboard] Add Network Switcher Filter (Testnet vs Mainnet) to Dashboard Views | Dashboard & Web Application | P2 | `developer-experience` `enhancement` | **Published (Batch 3)** |
| Issue 47 | [#96](https://github.com/dev-kiki0/kikis-app/issues/96) | [Dashboard] Implement Cursor-Based Pagination for `SessionTable` and `TxFeed` | Dashboard & Web Application | P3 | `developer-experience` `enhancement` `performance` | **Published (Batch 3)** |
| Issue 50 | [#97](https://github.com/dev-kiki0/kikis-app/issues/97) | [CI/CD] Add Linting and Typecheck Steps for Examples and Enforce Prettier in CI Pipeline | Repository Quality & CI/CD | P2 | `developer-experience` `enhancement` `infrastructure` | **Published (Batch 3)** |
| Issue 61 | [#98](https://github.com/dev-kiki0/kikis-app/issues/98) | [Router] Permit Native Asset XLM in `assertManifestValid` Without Requiring Dummy Contract IDs | Payment Modes & Protocol Routing | P2 | `bug` `sdk` `security` | **Published (Batch 3)** |
| Issue 62 | [#99](https://github.com/dev-kiki0/kikis-app/issues/99) | [Router] Support Dynamic Asset Fallback Negotiation When Provider Primary Asset Fails Preflight | Payment Modes & Protocol Routing | P2 | `enhancement` `sdk` | **Published (Batch 3)** |
| Issue 65 | [#100](https://github.com/dev-kiki0/kikis-app/issues/100) | [Facilitator] Reuse `Mppx` Client Instances Across Consecutive `MppChargeClient.pay` Invocations | Facilitator & Transaction Lifecycle | P2 | `enhancement` `mpp-charge` `performance` `sdk` | **Published (Batch 3)** |
| Issue 67 | [#101](https://github.com/dev-kiki0/kikis-app/issues/101) | [Facilitator] Implement Circuit Breaker for Repeatedly Failing Facilitator RPC Endpoints | Facilitator & Transaction Lifecycle | P2 | `enhancement` `provider` `reliability` `sdk` | **Published (Batch 3)** |
| Issue 71 | [#102](https://github.com/dev-kiki0/kikis-app/issues/102) | [MPP Session] Hoist Dynamic `@stellar/mpp/channel/server` Import Outside `SessionReconciler` Loop | State-Channel Lifecycle & Streaming | P2 | `enhancement` `mpp-session` `performance` `provider` | **Published (Batch 3)** |
| Issue 88 | [#103](https://github.com/dev-kiki0/kikis-app/issues/103) | [Nulth] Add Cryptographic Proof Verification Entrypoint in `@kikis-app/nulth-sdk` | Nulth Zero-Knowledge SDK & Privacy Layer | P2 | `enhancement` `sdk` `security` | **Published (Batch 3)** |
| Issue 89 | [#104](https://github.com/dev-kiki0/kikis-app/issues/104) | [Nulth] Support Multi-Asset Sub-Caps and Witness Commitments in Nulth Policy Engine | Nulth Zero-Knowledge SDK & Privacy Layer | P2 | `enhancement` `sdk` `security` | **Published (Batch 3)** |
| Issue 93 | [#105](https://github.com/dev-kiki0/kikis-app/issues/105) | [MCP] Add `request_refund` and `get_dispute_status` Channel Dispute Tools to MCP Server | Model Context Protocol (MCP) Server | P2 | `enhancement` `mcp` `mpp-session` `security` | **Published (Batch 3)** |
| Issue 95 | [#106](https://github.com/dev-kiki0/kikis-app/issues/106) | [MCP] Add Tool Request Timeout and Cancellation Listener to MCP Server Runtime | Model Context Protocol (MCP) Server | P2 | `enhancement` `mcp` `provider` `reliability` | **Published (Batch 3)** |
| Issue 98 | [#107](https://github.com/dev-kiki0/kikis-app/issues/107) | [Provider] Expose Provider Readiness and Liveness Probes in Fastify and Hono Middleware Adapters | Provider Adapters & Middleware | P2 | `enhancement` `infrastructure` `provider` | **Published (Batch 3)** |
| Issue 99 | [#108](https://github.com/dev-kiki0/kikis-app/issues/108) | [Provider] Support Configurable CORS Headers and OPTIONS Preflight in `kikisAppHono` | Provider Adapters & Middleware | P2 | `enhancement` `provider` | **Published (Batch 3)** |
| Issue 102 | [#109](https://github.com/dev-kiki0/kikis-app/issues/109) | [Worker-A] Handle CORS Preflight Requests for Custom Payment Headers in Provider A Worker | Cloudflare Workers & Edge Infrastructure | P2 | `bug` `provider` | **Published (Batch 3)** |
| Issue 103 | [#110](https://github.com/dev-kiki0/kikis-app/issues/110) | [Worker-B] Deduplicate Periodic Background Manifest Registration in `ChannelSession.buildApp` | Cloudflare Workers & Edge Infrastructure | P2 | `database` `enhancement` `performance` `provider` | **Published (Batch 3)** |
| Issue 105 | [#111](https://github.com/dev-kiki0/kikis-app/issues/111) | [Worker] Add Worker Environment Variable Schema Validation and Type Guards at Cold Start | Cloudflare Workers & Edge Infrastructure | P2 | `enhancement` `provider` `security` | **Published (Batch 3)** |
| Issue 107 | [#112](https://github.com/dev-kiki0/kikis-app/issues/112) | [Dashboard] Aggregate `VoucherChart` by Voucher Timestamp and Filter by Network Environment | Next.js Web Dashboard & Monitoring | P2 | `bug` `developer-experience` `security` | **Published (Batch 3)** |
| Issue 109 | [#113](https://github.com/dev-kiki0/kikis-app/issues/113) | [Dashboard] Subscribe to `UPDATE` Events and Error Notifications in `useTxLog` Real-Time Hook | Next.js Web Dashboard & Monitoring | P2 | `bug` `database` `reliability` `sdk` | **Published (Batch 3)** |
| Issue 110 | [#114](https://github.com/dev-kiki0/kikis-app/issues/114) | [Dashboard] Implement Active Channel Collateral and Unsettled Voucher Gauge in Dashboard UI | Next.js Web Dashboard & Monitoring | P2 | `developer-experience` `enhancement` `mpp-session` `security` | **Published (Batch 3)** |
| Issue 111 | [#115](https://github.com/dev-kiki0/kikis-app/issues/115) | [Dashboard] Add Filter by Payee Address and Transaction Type to Dashboard Transaction Table | Next.js Web Dashboard & Monitoring | P3 | `developer-experience` `enhancement` | **Published (Batch 3)** |
| Issue 113 | [#116](https://github.com/dev-kiki0/kikis-app/issues/116) | [Database] Automatically Create Parent Directories with Restrictive Permissions in `FileSpendStore` | Database Schema, Migrations & Stores | P2 | `bug` `database` `sdk` `security` | **Published (Batch 3)** |
| Issue 114 | [#117](https://github.com/dev-kiki0/kikis-app/issues/117) | [Database] Merge and Deduplicate Providers Between Supabase and On-Chain Registries | Database Schema, Migrations & Stores | P2 | `enhancement` `sdk` | **Published (Batch 3)** |
| Issue 115 | [#118](https://github.com/dev-kiki0/kikis-app/issues/118) | [Database] Support Chunked Base64 Data Attributes for Long Provider Endpoints in `OnChainRegistry` | Database Schema, Migrations & Stores | P2 | `bug` `sdk` | **Published (Batch 3)** |
| Issue 116 | [#119](https://github.com/dev-kiki0/kikis-app/issues/119) | [Database] Add In-Memory TTL Cache to `OnChainRegistry.listProviders` to Protect Horizon Rate Limits | Database Schema, Migrations & Stores | P2 | `enhancement` `performance` `sdk` | **Published (Batch 3)** |
| Issue 118 | [#120](https://github.com/dev-kiki0/kikis-app/issues/120) | [Agent] Fix Hardcoded Testnet URLs and Pass-Through Secrets in `agent/src/stress.ts` | Autonomous Agent Framework & Reference Runners | P2 | `bug` `sdk` `testing` | **Published (Batch 3)** |
| Issue 119 | [#121](https://github.com/dev-kiki0/kikis-app/issues/121) | [Examples] Add Error Recovery and Reconnection Backoff to `streaming-orderbook-agent` | Autonomous Agent Framework & Reference Runners | P2 | `bug` `developer-experience` `mpp-session` `reliability` | **Published (Batch 3)** |
| Issue 120 | [#122](https://github.com/dev-kiki0/kikis-app/issues/122) | [Examples] Add Budget Limits and Spending Cap Configuration to `price-oracle-agent` | Autonomous Agent Framework & Reference Runners | P2 | `developer-experience` `enhancement` `security` | **Published (Batch 3)** |
| Issue 121 | [#123](https://github.com/dev-kiki0/kikis-app/issues/123) | [Examples] Create End-to-End WebSocket Streaming Example Demonstrating Interactive Bidding | Autonomous Agent Framework & Reference Runners | P2 | `developer-experience` `enhancement` `mpp-session` | **Published (Batch 3)** |
| Issue 125 | [#124](https://github.com/dev-kiki0/kikis-app/issues/124) | [Security] Validate On-Chain Vault Deployment Bytecode Hash Against Known Audited Releases | Security, Authorization & Spending-Cap Enforcement | P2 | `enhancement` `security` `smart-contracts` | **Published (Batch 3)** |
| Issue 128 | [#125](https://github.com/dev-kiki0/kikis-app/issues/125) | [CI/CD] Add Multi-Package Typecheck Matrix (`pnpm --filter ... typecheck`) to CI Pipeline | Developer Experience, Tooling & CI/CD | P2 | `developer-experience` `enhancement` `infrastructure` | **Published (Batch 3)** |
| Issue 129 | [#126](https://github.com/dev-kiki0/kikis-app/issues/126) | [DX] Generate Comprehensive OpenAPI / Swagger Specifications for Provider Endpoints | Developer Experience, Tooling & CI/CD | P3 | `developer-experience` `documentation` `enhancement` | **Published (Batch 3)** |
| Issue 130 | [#127](https://github.com/dev-kiki0/kikis-app/issues/127) | [DX] Add Interactive CLI Diagnostic Tool (`kikis-app doctor`) for Agent Environment and Horizon Connectivity | Developer Experience, Tooling & CI/CD | P2 | `developer-experience` `enhancement` `reliability` | **Published (Batch 3)** |

### Batch 4: Newly Published Issues (10 Issues — GitHub #128 to #137)

| Local ID | GitHub Issue | Title | Category | Priority | Labels | Canonical GitHub URL |
|---|---|---|---|---|---|---|
| 131 | [#128](https://github.com/dev-kiki0/kikis-app/issues/128) | [MPP Session] Parse `xdr.ScVal` via `scValToNative` in `MppSessionClient.getDisputeStatus` | State-Channel Lifecycle & Streaming | P1 | `mpp-session`, `smart-contracts`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/128 |
| 132 | [#129](https://github.com/dev-kiki0/kikis-app/issues/129) | [SDK] Enforce Upper Bound and Reject Excessive `Retry-After` Delays in `withRetry` | Core SDK Architecture & Payment Execution | P2 | `sdk`, `reliability`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/129 |
| 133 | [#130](https://github.com/dev-kiki0/kikis-app/issues/130) | [Nulth] Prevent Backwards Ledger Sequence Replay and Cap Reset in `NulthClient.buildPaymentAuthProof` | Nulth ZK SDK & Privacy Layer | P1 | `security`, `sdk`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/130 |
| 134 | [#131](https://github.com/dev-kiki0/kikis-app/issues/131) | [Contracts] Expose Public View Functions for Vault Status, Admin, and Pending Admin in `AgentVault` | Soroban Smart Contracts & Agent Vault | P2 | `smart-contracts`, `security`, `enhancement` | https://github.com/dev-kiki0/kikis-app/issues/131 |
| 135 | [#132](https://github.com/dev-kiki0/kikis-app/issues/132) | [Contracts] Validate Non-Negative Cap Boundary in `set_lifetime_cap` and `__constructor` | Soroban Smart Contracts & Agent Vault | P1 | `smart-contracts`, `security`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/132 |
| 136 | [#133](https://github.com/dev-kiki0/kikis-app/issues/133) | [React] Support Custom `SessionOptions` and Configurable Unmount Behavior in `useSession` | Dashboard & Web Application | P2 | `sdk`, `developer-experience`, `mpp-session` | https://github.com/dev-kiki0/kikis-app/issues/133 |
| 137 | [#134](https://github.com/dev-kiki0/kikis-app/issues/134) | [MCP Server] Validate Numeric String Input for `max_amount` in `handlePayForData` | Model Context Protocol (MCP) Server | P2 | `mcp`, `security`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/134 |
| 138 | [#135](https://github.com/dev-kiki0/kikis-app/issues/135) | [Provider] Strip Query Parameters When Matching `/.well-known/kikis-app.json` in Fastify Middleware | Provider Infrastructure & Cloudflare Workers | P2 | `provider`, `infrastructure`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/135 |
| 139 | [#136](https://github.com/dev-kiki0/kikis-app/issues/136) | [Dashboard] Recognize `mpp-session-ws` Mode in `TxFeed.tsx` Payment Mode Type Guard | Dashboard & Web Application | P3 | `developer-experience`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/136 |
| 140 | [#137](https://github.com/dev-kiki0/kikis-app/issues/137) | [Provider] Standardize Mainnet Soroban RPC Endpoint and Support RPC Configuration in `MppSessionHandler` | Provider Infrastructure & Cloudflare Workers | P2 | `provider`, `infrastructure`, `smart-contracts`, `bug` | https://github.com/dev-kiki0/kikis-app/issues/137 |

## Reconciled Backlog Status (134 Backlog Issues Tracked & Published)

All 134 engineering issue records in the Drips Wave backlog are accounted for and verified on GitHub:
- **134 Issues Published to GitHub**:
  - **Batch 1**: 30 issues ([#3](https://github.com/dev-kiki0/kikis-app/issues/3)–[#32](https://github.com/dev-kiki0/kikis-app/issues/32))
  - **Batch 2**: 50 issues ([#34](https://github.com/dev-kiki0/kikis-app/issues/34)–[#83](https://github.com/dev-kiki0/kikis-app/issues/83))
  - **Batch 3**: 44 issues ([#84](https://github.com/dev-kiki0/kikis-app/issues/84)–[#127](https://github.com/dev-kiki0/kikis-app/issues/127))
  - **Batch 4**: 10 issues ([#128](https://github.com/dev-kiki0/kikis-app/issues/128)–[#137](https://github.com/dev-kiki0/kikis-app/issues/137))
- **Duplicate Draft Records Retained**: **0** (All 6 historical duplicate draft records permanently removed)
- **Remaining Unpublished Drafts**: **0**

All draft specifications, technical architectures, and acceptance criteria have been transferred directly into remote GitHub issues on `dev-kiki0/kikis-app` and documented in the publication registers above.

## Complete Backlog Master Index (134 Published Issues)

Complete index of all 134 legitimate engineering issues identified across the codebase and published to GitHub (30 published in Batch 1, 50 published in Batch 2, 44 published in Batch 3, and 10 published in Batch 4; 0 duplicate records retained; 0 unpublished drafts remaining).

| Local ID | Title | Category | Priority | Labels | Tracking Status |
|---|---|---|---|---|---|
| 1 | [SDK] Support Request Payload and Method Forwarding in `KikisAppClient.pay()` | Core SDK & Route Selection | P0 | `sdk`, `bug`, `api` | **Published (Batch 1)** ([#3](https://github.com/dev-kiki0/kikis-app/issues/3)) |
| 2 | [SDK] Prevent Cache-Stampede on Concurrent Manifest Fetches | Core SDK & Route Selection | P2 | `sdk`, `performance` | **Published (Batch 1)** ([#4](https://github.com/dev-kiki0/kikis-app/issues/4)) |
| 3 | [SDK] Allow Configurable Soroban RPC URL Instead of Hardcoded Horizon Endpoints | Core SDK & Route Selection | P1 | `sdk`, `configuration`, `soroban` | **Published (Batch 1)** ([#5](https://github.com/dev-kiki0/kikis-app/issues/5)) |
| 4 | [SDK] Incorporate Session Mode Cost Amortization in `CostOptimal` Strategy | Core SDK & Route Selection | P2 | `sdk`, `routing`, `enhancement` | **Published (Batch 1)** ([#6](https://github.com/dev-kiki0/kikis-app/issues/6)) |
| 5 | [SDK] Add Custom HTTP Proxy Dispatcher Support for Enterprise Agents | Core SDK & Route Selection | P3 | `sdk`, `networking`, `enhancement` | **Published (Batch 3)** ([#84](https://github.com/dev-kiki0/kikis-app/issues/84)) |
| 6 | [SDK] Export Missing Type Definitions for Subpath Provider Imports | Core SDK & Route Selection | P1 | `sdk`, `types`, `developer-experience` | **Published (Batch 3)** ([#85](https://github.com/dev-kiki0/kikis-app/issues/85)) |
| 8 | [x402] Validate Facilitator Signature Challenge Expiration Before Signing | x402 Protocol Integration | P1 | `x402`, `security`, `bug` | **Published (Batch 1)** ([#7](https://github.com/dev-kiki0/kikis-app/issues/7)) |
| 9 | [x402] Implement Facilitator TLS Certificate Pinning and Domain Allowlisting | x402 Protocol Integration | P2 | `x402`, `security`, `networking` | **Published (Batch 3)** ([#86](https://github.com/dev-kiki0/kikis-app/issues/86)) |
| 10 | [x402] Support Exponential Backoff and `Retry-After` Header on 429/503 | x402 Protocol Integration | P2 | `x402`, `reliability`, `resilience` | **Published (Batch 1)** ([#8](https://github.com/dev-kiki0/kikis-app/issues/8)) |
| 11 | [MPP Charge] Support Smart Accounts and Custom Signers in `MppChargeClient` | MPP Charge Integration | P1 | `mpp-charge`, `sdk`, `smart-contracts` | **Published (Batch 1)** ([#9](https://github.com/dev-kiki0/kikis-app/issues/9)) |
| 13 | [MPP Charge] Sanitize Custom Asset Contract Decimals Beyond Standard 7-Decimal Assumptions | MPP Charge Integration | P2 | `mpp-charge`, `stellar`, `bug` | **Published (Batch 1)** ([#10](https://github.com/dev-kiki0/kikis-app/issues/10)) |
| 14 | [MPP Charge] Return Diagnostic Error Reasons on Horizon Transaction Submission Failures | MPP Charge Integration | P1 | `mpp-charge`, `developer-experience`, `errors` | **Published (Batch 1)** ([#11](https://github.com/dev-kiki0/kikis-app/issues/11)) |
| 15 | [MPP Session] Fix WebSocket Handshake Deadlock Between Client and Server | MPP Session & Streaming | P0 | `mpp-session`, `bug`, `networking` | **Published (Batch 1)** ([#12](https://github.com/dev-kiki0/kikis-app/issues/12)) |
| 17 | [MPP Session] Implement Active Dispute Polling During Channel Settlement Window | MPP Session & Streaming | P1 | `mpp-session`, `security`, `smart-contracts` | **Published (Batch 1)** ([#13](https://github.com/dev-kiki0/kikis-app/issues/13)) |
| 18 | [MPP Session] Clean Up Stale Event Listeners on Abnormal WebSocket Terminations | MPP Session & Streaming | P2 | `mpp-session`, `memory-leak`, `reliability` | **Published (Batch 1)** ([#14](https://github.com/dev-kiki0/kikis-app/issues/14)) |
| 19 | [MPP Session] Add Automatic Channel Top-Up When Deposit Drops Below Safety Threshold | MPP Session & Streaming | P2 | `mpp-session`, `enhancement` | **Published (Batch 1)** ([#15](https://github.com/dev-kiki0/kikis-app/issues/15)) |
| 20 | [MPP Session] Fix React `useSession` Hook Not Updating Vouchers and Ignoring Auto-Close | MPP Session & Streaming | P1 | `mpp-session`, `react`, `bug` | **Published (Batch 3)** ([#87](https://github.com/dev-kiki0/kikis-app/issues/87)) |
| 21 | [Smart Contract] Validate Payer and Enforce Spending Caps in `record_session_settlement` | Smart Contracts & Vault Security | P0 | `smart-contracts`, `security`, `soroban` | **Published (Batch 1)** ([#16](https://github.com/dev-kiki0/kikis-app/issues/16)) |
| 22 | [Smart Contract] Add Batch Settlement Execution in Agent Vault Contract | Smart Contracts & Vault Security | P2 | `smart-contracts`, `performance`, `soroban` | **Published (Batch 1)** ([#17](https://github.com/dev-kiki0/kikis-app/issues/17)) |
| 23 | [Smart Contract] Implement Multi-Guardian Social Recovery and Timelock Escrow | Smart Contracts & Vault Security | P2 | `smart-contracts`, `security`, `governance` | **Published (Batch 3)** ([#88](https://github.com/dev-kiki0/kikis-app/issues/88)) |
| 24 | [Smart Contract] Add Automated Wasm Compilation and Deterministic Build Checks to CI | Smart Contracts & Vault Security | P1 | `smart-contracts`, `ci-cd`, `testing` | **Published (Batch 3)** ([#89](https://github.com/dev-kiki0/kikis-app/issues/89)) |
| 25 | [Smart Contract] Add Contract Event Emission for Real-Time On-Chain Spend Tracking | Smart Contracts & Vault Security | P2 | `smart-contracts`, `soroban`, `indexing` | **Published (Batch 3)** ([#90](https://github.com/dev-kiki0/kikis-app/issues/90)) |
| 26 | [Smart Contract] Enforce Sequence Number Granularity to Prevent Sub-Sequence Replays | Smart Contracts & Vault Security | P1 | `smart-contracts`, `security`, `soroban` | **Published (Batch 1)** ([#18](https://github.com/dev-kiki0/kikis-app/issues/18)) |
| 27 | [Nulth Vault] Eliminate Duplicate Proof Construction Logic Between SDK and Nulth SDK | Nulth Vault & Cryptographic Utilities | P1 | `nulth`, `refactoring`, `code-quality` | **Published (Batch 1)** ([#19](https://github.com/dev-kiki0/kikis-app/issues/19)) |
| 28 | [Nulth Vault] Enable `mpp-charge` Protocol Execution for Nulth Vault Accounts | Nulth Vault & Cryptographic Utilities | P1 | `nulth`, `mpp-charge`, `bug` | **Published (Batch 2)** ([#34](https://github.com/dev-kiki0/kikis-app/issues/34)) |
| 29 | [Nulth Vault] Throw Specific `KikisAppVaultConfigError` Instead of `KikisAppManifestError` | Nulth Vault & Cryptographic Utilities | P2 | `nulth`, `errors`, `developer-experience` | **Published (Batch 1)** ([#20](https://github.com/dev-kiki0/kikis-app/issues/20)) |
| 30 | [Nulth Vault] Allow Configurable Horizon RPC URL in `fetchLedgerSequence` | Nulth Vault & Cryptographic Utilities | P2 | `nulth`, `configuration`, `networking` | **Published (Batch 3)** ([#91](https://github.com/dev-kiki0/kikis-app/issues/91)) |
| 31 | [Nulth Vault] Validate Ed25519 Session Key Signature Format Before Proof Generation | Nulth Vault & Cryptographic Utilities | P2 | `nulth`, `security`, `validation` | **Published (Batch 1)** ([#21](https://github.com/dev-kiki0/kikis-app/issues/21)) |
| 32 | [MCP Server] Prevent Crash in `pay_for_data` Tool When Provider Uses `mpp-session` | MCP Server Integration | P0 | `mcp`, `bug`, `crash` | **Published (Batch 1)** ([#22](https://github.com/dev-kiki0/kikis-app/issues/22)) |
| 33 | [MCP Server] Forward `commitmentSecret` to `openSession()` in `open_session` Tool | MCP Server Integration | P1 | `mcp`, `mpp-session`, `bug` | **Published (Batch 1)** ([#23](https://github.com/dev-kiki0/kikis-app/issues/23)) |
| 34 | [MCP Server] Expose `check_spend_cap` and `get_vault_status` MCP Tools | MCP Server Integration | P2 | `mcp`, `enhancement`, `agent-tools` | **Published (Batch 1)** ([#24](https://github.com/dev-kiki0/kikis-app/issues/24)) |
| 35 | [MCP Server] Restrict Allowed URL Protocols to Prevent SSRF via MCP Tools | MCP Server Integration | P1 | `mcp`, `security`, `ssrf` | **Published (Batch 1)** ([#25](https://github.com/dev-kiki0/kikis-app/issues/25)) |
| 36 | [MCP Server] Implement Cursor Pagination in `list_providers` Tool | MCP Server Integration | P2 | `mcp`, `performance`, `enhancement` | **Published (Batch 3)** ([#92](https://github.com/dev-kiki0/kikis-app/issues/92)) |
| 37 | [Provider] Handle Horizon 429 Rate Limits Gracefully in Cloudflare Worker Provider A | Provider Infrastructure & Cloudflare Workers | P1 | `provider`, `cloudflare`, `reliability` | **Published (Batch 1)** ([#26](https://github.com/dev-kiki0/kikis-app/issues/26)) |
| 38 | [Provider] Clear Interval Timer on WebSocket Abnormal Close in Provider B Worker | Provider Infrastructure & Cloudflare Workers | P1 | `provider`, `memory-leak`, `cloudflare` | **Published (Batch 1)** ([#27](https://github.com/dev-kiki0/kikis-app/issues/27)) |
| 39 | [Provider] Add Distributed Lock to Provider Scheduled Settlement Cron Workers | Provider Infrastructure & Cloudflare Workers | P1 | `provider`, `concurrency`, `database` | **Published (Batch 1)** ([#28](https://github.com/dev-kiki0/kikis-app/issues/28)) |
| 40 | [Provider] Implement Fastify WebSocket Transport Middleware for `mpp-session-ws` | Provider Infrastructure & Cloudflare Workers | P2 | `provider`, `mpp-session`, `enhancement` | **Published (Batch 1)** ([#29](https://github.com/dev-kiki0/kikis-app/issues/29)) |
| 41 | [Store] Add File-Locking Mechanism to `FileSpendStore` for Concurrent Agent Processes | Database, Storage & Settlement Deduplication | P1 | `sdk`, `security`, `bug` | **Published (Batch 1)** ([#30](https://github.com/dev-kiki0/kikis-app/issues/30)) |
| 42 | [Store] Handle Database Connection Failures Gracefully in `SupabaseSeenTxStore` Idempotency Checks | Database, Storage & Settlement Deduplication | P1 | `sdk`, `provider`, `reliability` | **Published (Batch 1)** ([#31](https://github.com/dev-kiki0/kikis-app/issues/31)) |
| 43 | [Database] Add Missing Composite Indexes to `tx_log` and `sessions` Migration Schema | Database, Storage & Settlement Deduplication | P2 | `database`, `performance`, `infrastructure` | **Published (Batch 1)** ([#32](https://github.com/dev-kiki0/kikis-app/issues/32)) |
| 44 | [Database] Scope `public_dashboard_stats` Aggregation View by Network and Support Partitioned Totals | Database, Storage & Settlement Deduplication | P2 | `database`, `dashboard`, `bug` | **Published (Batch 3)** ([#93](https://github.com/dev-kiki0/kikis-app/issues/93)) |
| 45 | [Dashboard] Implement Real-Time Supabase WebSocket Subscriptions in `DashboardMetrics` and `TxFeed` | Dashboard & Web Application | P2 | `dashboard`, `performance`, `enhancement` | **Published (Batch 3)** ([#94](https://github.com/dev-kiki0/kikis-app/issues/94)) |
| 46 | [Dashboard] Add Network Switcher Filter (Testnet vs Mainnet) to Dashboard Views | Dashboard & Web Application | P2 | `dashboard`, `ui`, `enhancement` | **Published (Batch 3)** ([#95](https://github.com/dev-kiki0/kikis-app/issues/95)) |
| 47 | [Dashboard] Implement Cursor-Based Pagination for `SessionTable` and `TxFeed` | Dashboard & Web Application | P3 | `dashboard`, `performance`, `enhancement` | **Published (Batch 3)** ([#96](https://github.com/dev-kiki0/kikis-app/issues/96)) |
| 48 | [Examples] Fix Unquoted Property Syntax Error and Missing Request Body in `agent-to-agent` Example | Examples & Developer Experience | P1 | `examples`, `bug`, `developer-experience` | **Published (Batch 2)** ([#35](https://github.com/dev-kiki0/kikis-app/issues/35)) |
| 49 | [Examples] Fix Unquoted Property Syntax Error and HTTP Method Mismatch in `inference-agent` Example | Examples & Developer Experience | P1 | `examples`, `bug`, `developer-experience` | **Published (Batch 2)** ([#36](https://github.com/dev-kiki0/kikis-app/issues/36)) |
| 50 | [CI/CD] Add Linting and Typecheck Steps for Examples and Enforce Prettier in CI Pipeline | Repository Quality & CI/CD | P2 | `ci-cd`, `infrastructure`, `developer-experience` | **Published (Batch 3)** ([#97](https://github.com/dev-kiki0/kikis-app/issues/97)) |
| 51 | [SDK] Inject Configurable Horizon RPC URL and Timeout into `_checkTrustline` | Core TypeScript Payment SDK | P1 | `sdk`, `networking`, `configuration`, `bug` | **Published (Batch 2)** ([#37](https://github.com/dev-kiki0/kikis-app/issues/37)) |
| 52 | [SDK] Enforce Strict Issuer Matching for Non-USDC Assets in Trustline Preflight | Core TypeScript Payment SDK | P0 | `sdk`, `security`, `validation`, `bug` | **Published (Batch 2)** ([#38](https://github.com/dev-kiki0/kikis-app/issues/38)) |
| 53 | [SDK] Convert Spend Limits and Accumulators Using Asset-Specific Decimals Instead of Hardcoded USDC Stroops | Core TypeScript Payment SDK | P0 | `sdk`, `accounting`, `spend-caps`, `bug` | **Published (Batch 2)** ([#39](https://github.com/dev-kiki0/kikis-app/issues/39)) |
| 54 | [SDK] Persist In-Flight Reservation Records to Prevent Phantom Spend Cap Leaks Across Process Crashes | Core TypeScript Payment SDK | P1 | `sdk`, `reliability`, `spend-caps`, `bug` | **Published (Batch 2)** ([#40](https://github.com/dev-kiki0/kikis-app/issues/40)) |
| 55 | [SDK] Support Non-JSON Response Formats (Text, Blob, Buffer) in `X402Client` and `MppChargeClient` | Core TypeScript Payment SDK | P1 | `sdk`, `developer-experience`, `enhancement` | **Published (Batch 2)** ([#41](https://github.com/dev-kiki0/kikis-app/issues/41)) |
| 56 | [SDK] Propagate `AbortSignal` Through `withRetry` and Retry Delay Timers | Core TypeScript Payment SDK | P2 | `sdk`, `networking`, `reliability`, `enhancement` | **Published (Batch 2)** ([#42](https://github.com/dev-kiki0/kikis-app/issues/42)) |
| 57 | [Router] Fix Multi-Mode Routing in `kikisAppHono` to Prevent Skipping `mpp-charge` When Session Modes Are Enabled | Payment Modes & Protocol Routing | P0 | `provider`, `hono`, `mpp-charge`, `mpp-session`, `bug` | **Published (Batch 2)** ([#43](https://github.com/dev-kiki0/kikis-app/issues/43)) |
| 58 | [Router] Fix Mode Precedence in Express `kikisAppMiddleware` to Allow Explicit `mpp-charge` Dispatching | Payment Modes & Protocol Routing | P1 | `provider`, `express`, `mpp-charge`, `mpp-session`, `bug` | **Published (Batch 2)** ([#44](https://github.com/dev-kiki0/kikis-app/issues/44)) |
| 59 | [Router] Respect Developer-Specified `explicitContract` in `resolveAssetContract` When Multi-Asset Config is Present | Payment Modes & Protocol Routing | P2 | `sdk`, `routing`, `assets`, `bug` | **Published (Batch 2)** ([#45](https://github.com/dev-kiki0/kikis-app/issues/45)) |
| 60 | [Router] Validate Multi-Asset Challenge Payee and Currency in `checkX402Accept` and `checkChargeChallenge` | Payment Modes & Protocol Routing | P1 | `sdk`, `security`, `x402`, `mpp-charge`, `bug` | **Published (Batch 2)** ([#46](https://github.com/dev-kiki0/kikis-app/issues/46)) |
| 61 | [Router] Permit Native Asset XLM in `assertManifestValid` Without Requiring Dummy Contract IDs | Payment Modes & Protocol Routing | P2 | `sdk`, `manifest`, `validation`, `bug` | **Published (Batch 3)** ([#98](https://github.com/dev-kiki0/kikis-app/issues/98)) |
| 62 | [Router] Support Dynamic Asset Fallback Negotiation When Provider Primary Asset Fails Preflight | Payment Modes & Protocol Routing | P2 | `sdk`, `routing`, `assets`, `enhancement` | **Published (Batch 3)** ([#99](https://github.com/dev-kiki0/kikis-app/issues/99)) |
| 63 | [Facilitator] Catch Network and Abort Errors in `withRetry` Instead of Bypassing Retry Loop | Facilitator & Transaction Lifecycle | P1 | `sdk`, `networking`, `reliability`, `bug` | **Published (Batch 2)** ([#47](https://github.com/dev-kiki0/kikis-app/issues/47)) |
| 64 | [Facilitator] Support Dynamic Base Fee Bumping During Stellar Network Fee Surges in `MppChargeClient` | Facilitator & Transaction Lifecycle | P2 | `mpp-charge`, `stellar`, `fees`, `enhancement` | **Published (Batch 2)** ([#48](https://github.com/dev-kiki0/kikis-app/issues/48)) |
| 65 | [Facilitator] Reuse `Mppx` Client Instances Across Consecutive `MppChargeClient.pay` Invocations | Facilitator & Transaction Lifecycle | P2 | `mpp-charge`, `performance`, `sdk`, `enhancement` | **Published (Batch 3)** ([#100](https://github.com/dev-kiki0/kikis-app/issues/100)) |
| 66 | [Facilitator] Validate OpenZeppelin Facilitator Response Schema and Signature Nonce Alignment | Facilitator & Transaction Lifecycle | P1 | `x402`, `security`, `facilitator`, `bug` | **Published (Batch 2)** ([#49](https://github.com/dev-kiki0/kikis-app/issues/49)) |
| 67 | [Facilitator] Implement Circuit Breaker for Repeatedly Failing Facilitator RPC Endpoints | Facilitator & Transaction Lifecycle | P2 | `sdk`, `reliability`, `networking`, `enhancement` | **Published (Batch 3)** ([#101](https://github.com/dev-kiki0/kikis-app/issues/101)) |
| 68 | [MPP Session] Prevent Permanent Channel Orphan Lock by Delaying `closed = true` Until Settlement Simulation Succeeds | State-Channel Lifecycle & Streaming | P0 | `mpp-session`, `lifecycle`, `soroban`, `bug` | **Published (Batch 2)** ([#50](https://github.com/dev-kiki0/kikis-app/issues/50)) |
| 69 | [MPP Session] Add Configurable Soroban RPC URL and Base Fee Overrides in `MppSessionClient.close` | State-Channel Lifecycle & Streaming | P1 | `mpp-session`, `soroban`, `configuration`, `bug` | **Published (Batch 2)** ([#51](https://github.com/dev-kiki0/kikis-app/issues/51)) |
| 70 | [MPP Session] Reconcile Cloudflare Durable Object Session Eviction with Closure-Scoped Voucher Counters | State-Channel Lifecycle & Streaming | P1 | `mpp-session`, `cloudflare`, `provider`, `bug` | **Published (Batch 2)** ([#52](https://github.com/dev-kiki0/kikis-app/issues/52)) |
| 71 | [MPP Session] Hoist Dynamic `@stellar/mpp/channel/server` Import Outside `SessionReconciler` Loop | State-Channel Lifecycle & Streaming | P2 | `mpp-session`, `performance`, `provider`, `enhancement` | **Published (Batch 3)** ([#102](https://github.com/dev-kiki0/kikis-app/issues/102)) |
| 72 | [MPP Session] Handle Already-Closed On-Chain Channels Gracefully in `SessionReconciler` | State-Channel Lifecycle & Streaming | P1 | `mpp-session`, `provider`, `database`, `bug` | **Published (Batch 2)** ([#53](https://github.com/dev-kiki0/kikis-app/issues/53)) |
| 73 | [MPP Session] Implement Proper Async Iterator Cleanup (`return()`) in `streamWebSocket` and MCP Stream Handlers | State-Channel Lifecycle & Streaming | P2 | `mpp-session`, `websocket`, `mcp`, `bug` | **Published (Batch 2)** ([#54](https://github.com/dev-kiki0/kikis-app/issues/54)) |
| 74 | [Voucher] Replace IEEE 754 `parseFloat` with Stroop `BigInt` Arithmetic in `SupabaseSessionStore` | Voucher Accounting, Verification & Replay Protection | P0 | `voucher`, `accounting`, `database`, `security`, `bug` | **Published (Batch 2)** ([#55](https://github.com/dev-kiki0/kikis-app/issues/55)) |
| 75 | [Voucher] Eliminate TOCTOU Race Condition in `SupabaseSessionStore.upsert` with Atomic SQL Updates | Voucher Accounting, Verification & Replay Protection | P1 | `voucher`, `database`, `concurrency`, `bug` | **Published (Batch 2)** ([#56](https://github.com/dev-kiki0/kikis-app/issues/56)) |
| 76 | [Voucher] Trigger `onSettled` Callback in `MppChargeHandler` When Receipt Header Uses Alternative Formats | Voucher Accounting, Verification & Replay Protection | P1 | `mpp-charge`, `provider`, `accounting`, `bug` | **Published (Batch 2)** ([#57](https://github.com/dev-kiki0/kikis-app/issues/57)) |
| 77 | [Voucher] Scope In-Memory Voucher and Session Records Per-Channel to Prevent Multi-Tenant Session Cross-Talk | Voucher Accounting, Verification & Replay Protection | P0 | `mpp-session`, `provider`, `concurrency`, `bug` | **Published (Batch 2)** ([#58](https://github.com/dev-kiki0/kikis-app/issues/58)) |
| 78 | [Voucher] Enforce Hard Replay Cap Directly in `claim_settlement_replay` SQL Migration | Voucher Accounting, Verification & Replay Protection | P1 | `database`, `security`, `settlement`, `bug` | **Published (Batch 2)** ([#59](https://github.com/dev-kiki0/kikis-app/issues/59)) |
| 79 | [Contracts] Enforce Emergency Freeze Check in `record_session_settlement` Entrypoint | Soroban Smart Contracts | P0 | `smart-contracts`, `security`, `soroban`, `bug` | **Published (Batch 2)** ([#60](https://github.com/dev-kiki0/kikis-app/issues/60)) |
| 80 | [Contracts] Refresh Instance Storage TTL via `bump_instance` in `record_session_settlement` | Soroban Smart Contracts | P1 | `smart-contracts`, `soroban`, `storage`, `bug` | **Published (Batch 2)** ([#61](https://github.com/dev-kiki0/kikis-app/issues/61)) |
| 81 | [Contracts] Restrict SAC `transfer` Authorization Contexts to Configured Asset Contract Address | Soroban Smart Contracts | P0 | `smart-contracts`, `security`, `soroban`, `bug` | **Published (Batch 2)** ([#62](https://github.com/dev-kiki0/kikis-app/issues/62)) |
| 82 | [Contracts] Add Expiration Grace Window to Pending Wasm Upgrades in Agent Vault Contract | Soroban Smart Contracts | P1 | `smart-contracts`, `governance`, `security`, `enhancement` | **Published (Batch 2)** ([#63](https://github.com/dev-kiki0/kikis-app/issues/63)) |
| 83 | [Contracts] Implement Contract View Function for Current Daily Spend and Remaining Allowance | Soroban Smart Contracts | P2 | `smart-contracts`, `soroban`, `indexing`, `enhancement` | **Published (Batch 2)** ([#64](https://github.com/dev-kiki0/kikis-app/issues/64)) |
| 85 | [Nulth] Prevent Race Conditions by Eliminating Mutable Shared State in `createNulthSigner` | Nulth Zero-Knowledge SDK & Privacy Layer | P0 | `nulth`, `concurrency`, `security`, `bug` | **Published (Batch 2)** ([#65](https://github.com/dev-kiki0/kikis-app/issues/65)) |
| 86 | [Nulth] Implement Rollback Capability for Off-Chain Daily Spend on Failed Proof Transactions | Nulth Zero-Knowledge SDK & Privacy Layer | P1 | `nulth`, `accounting`, `spend-caps`, `bug` | **Published (Batch 2)** ([#66](https://github.com/dev-kiki0/kikis-app/issues/66)) |
| 87 | [Nulth] Replace Comma-Delimited String Concatenation in `commitAllowlist` with Canonical Length-Prefixed Encoding | Nulth Zero-Knowledge SDK & Privacy Layer | P1 | `nulth`, `cryptography`, `security`, `bug` | **Published (Batch 2)** ([#67](https://github.com/dev-kiki0/kikis-app/issues/67)) |
| 88 | [Nulth] Add Cryptographic Proof Verification Entrypoint in `@kikis-app/nulth-sdk` | Nulth Zero-Knowledge SDK & Privacy Layer | P2 | `nulth`, `cryptography`, `verification`, `enhancement` | **Published (Batch 3)** ([#103](https://github.com/dev-kiki0/kikis-app/issues/103)) |
| 89 | [Nulth] Support Multi-Asset Sub-Caps and Witness Commitments in Nulth Policy Engine | Nulth Zero-Knowledge SDK & Privacy Layer | P2 | `nulth`, `assets`, `spend-caps`, `enhancement` | **Published (Batch 3)** ([#104](https://github.com/dev-kiki0/kikis-app/issues/104)) |
| 90 | [MCP] Handle Horizon 404 Unfunded Account Errors Gracefully in `handleCheckBalance` | Model Context Protocol (MCP) Server | P1 | `mcp`, `horizon`, `errors`, `bug` | **Published (Batch 2)** ([#68](https://github.com/dev-kiki0/kikis-app/issues/68)) |
| 91 | [MCP] Reuse Existing Stream Iterator Instead of Re-opening Connections on Every `stream_session` Call | Model Context Protocol (MCP) Server | P1 | `mcp`, `mpp-session`, `streaming`, `bug` | **Published (Batch 2)** ([#69](https://github.com/dev-kiki0/kikis-app/issues/69)) |
| 92 | [MCP] Add `estimate_cost` Tool to MCP Server for Agent Pre-Execution Budgeting | Model Context Protocol (MCP) Server | P2 | `mcp`, `agent-tools`, `cost-estimation`, `enhancement` | **Published (Batch 2)** ([#70](https://github.com/dev-kiki0/kikis-app/issues/70)) |
| 93 | [MCP] Add `request_refund` and `get_dispute_status` Channel Dispute Tools to MCP Server | Model Context Protocol (MCP) Server | P2 | `mcp`, `mpp-session`, `dispute`, `enhancement` | **Published (Batch 3)** ([#105](https://github.com/dev-kiki0/kikis-app/issues/105)) |
| 94 | [MCP] Enforce Sanitized URL Parsing and Block Localhost SSRF Across All MCP Tool Handlers | Model Context Protocol (MCP) Server | P1 | `mcp`, `security`, `ssrf`, `bug` | **Published (Batch 2)** ([#71](https://github.com/dev-kiki0/kikis-app/issues/71)) |
| 95 | [MCP] Add Tool Request Timeout and Cancellation Listener to MCP Server Runtime | Model Context Protocol (MCP) Server | P2 | `mcp`, `reliability`, `networking`, `enhancement` | **Published (Batch 3)** ([#106](https://github.com/dev-kiki0/kikis-app/issues/106)) |
| 96 | [Provider] Allow External `SessionStore` Injection in Express `createMppSessionHandler` | Provider Adapters & Middleware | P1 | `provider`, `express`, `mpp-session`, `storage`, `enhancement` | **Published (Batch 2)** ([#72](https://github.com/dev-kiki0/kikis-app/issues/72)) |
| 97 | [Provider] Standardize Catch-All Error Handling for Malformed Payment Signature Headers in Provider Middleware | Provider Adapters & Middleware | P1 | `provider`, `errors`, `security`, `bug` | **Published (Batch 2)** ([#73](https://github.com/dev-kiki0/kikis-app/issues/73)) |
| 98 | [Provider] Expose Provider Readiness and Liveness Probes in Fastify and Hono Middleware Adapters | Provider Adapters & Middleware | P2 | `provider`, `fastify`, `hono`, `devops`, `enhancement` | **Published (Batch 3)** ([#107](https://github.com/dev-kiki0/kikis-app/issues/107)) |
| 99 | [Provider] Support Configurable CORS Headers and OPTIONS Preflight in `kikisAppHono` | Provider Adapters & Middleware | P2 | `provider`, `hono`, `cors`, `networking`, `enhancement` | **Published (Batch 3)** ([#108](https://github.com/dev-kiki0/kikis-app/issues/108)) |
| 100 | [Provider] Add Request Body Buffering and Replay for POST Endpoints in Fastify Provider Adapter | Provider Adapters & Middleware | P1 | `provider`, `fastify`, `post`, `streaming`, `bug` | **Published (Batch 2)** ([#74](https://github.com/dev-kiki0/kikis-app/issues/74)) |
| 102 | [Worker-A] Handle CORS Preflight Requests for Custom Payment Headers in Provider A Worker | Cloudflare Workers & Edge Infrastructure | P2 | `provider`, `cloudflare`, `worker-a`, `cors`, `bug` | **Published (Batch 3)** ([#109](https://github.com/dev-kiki0/kikis-app/issues/109)) |
| 103 | [Worker-B] Deduplicate Periodic Background Manifest Registration in `ChannelSession.buildApp` | Cloudflare Workers & Edge Infrastructure | P2 | `provider`, `cloudflare`, `worker-b`, `database`, `performance` | **Published (Batch 3)** ([#110](https://github.com/dev-kiki0/kikis-app/issues/110)) |
| 105 | [Worker] Add Worker Environment Variable Schema Validation and Type Guards at Cold Start | Cloudflare Workers & Edge Infrastructure | P2 | `provider`, `cloudflare`, `configuration`, `validation`, `enhancement` | **Published (Batch 3)** ([#111](https://github.com/dev-kiki0/kikis-app/issues/111)) |
| 106 | [Dashboard] Render Graceful Setup Fallback UI When Supabase Credentials Are Unset Instead of Runtime Crash | Next.js Web Dashboard & Monitoring | P1 | `dashboard`, `nextjs`, `ui`, `error-handling`, `bug` | **Published (Batch 2)** ([#75](https://github.com/dev-kiki0/kikis-app/issues/75)) |
| 107 | [Dashboard] Aggregate `VoucherChart` by Voucher Timestamp and Filter by Network Environment | Next.js Web Dashboard & Monitoring | P2 | `dashboard`, `recharts`, `ui`, `accounting`, `bug` | **Published (Batch 3)** ([#112](https://github.com/dev-kiki0/kikis-app/issues/112)) |
| 108 | [Dashboard] Add In-Flight Request Deduplication and Abort Controller to `usePay` React Hook | Next.js Web Dashboard & Monitoring | P1 | `react`, `sdk`, `hooks`, `concurrency`, `bug` | **Published (Batch 2)** ([#76](https://github.com/dev-kiki0/kikis-app/issues/76)) |
| 109 | [Dashboard] Subscribe to `UPDATE` Events and Error Notifications in `useTxLog` Real-Time Hook | Next.js Web Dashboard & Monitoring | P2 | `react`, `sdk`, `realtime`, `database`, `bug` | **Published (Batch 3)** ([#113](https://github.com/dev-kiki0/kikis-app/issues/113)) |
| 110 | [Dashboard] Implement Active Channel Collateral and Unsettled Voucher Gauge in Dashboard UI | Next.js Web Dashboard & Monitoring | P2 | `dashboard`, `ui`, `mpp-session`, `accounting`, `enhancement` | **Published (Batch 3)** ([#114](https://github.com/dev-kiki0/kikis-app/issues/114)) |
| 111 | [Dashboard] Add Filter by Payee Address and Transaction Type to Dashboard Transaction Table | Next.js Web Dashboard & Monitoring | P3 | `dashboard`, `ui`, `filtering`, `enhancement` | **Published (Batch 3)** ([#115](https://github.com/dev-kiki0/kikis-app/issues/115)) |
| 112 | [Database] Update `sessions.status` Check Constraint to Support Dispute and Refund States | Database Schema, Migrations & Stores | P1 | `database`, `mpp-session`, `migrations`, `bug` | **Published (Batch 2)** ([#77](https://github.com/dev-kiki0/kikis-app/issues/77)) |
| 113 | [Database] Automatically Create Parent Directories with Restrictive Permissions in `FileSpendStore` | Database Schema, Migrations & Stores | P2 | `sdk`, `storage`, `security`, `bug` | **Published (Batch 3)** ([#116](https://github.com/dev-kiki0/kikis-app/issues/116)) |
| 114 | [Database] Merge and Deduplicate Providers Between Supabase and On-Chain Registries | Database Schema, Migrations & Stores | P2 | `sdk`, `registry`, `routing`, `enhancement` | **Published (Batch 3)** ([#117](https://github.com/dev-kiki0/kikis-app/issues/117)) |
| 115 | [Database] Support Chunked Base64 Data Attributes for Long Provider Endpoints in `OnChainRegistry` | Database Schema, Migrations & Stores | P2 | `sdk`, `registry`, `stellar`, `bug` | **Published (Batch 3)** ([#118](https://github.com/dev-kiki0/kikis-app/issues/118)) |
| 116 | [Database] Add In-Memory TTL Cache to `OnChainRegistry.listProviders` to Protect Horizon Rate Limits | Database Schema, Migrations & Stores | P2 | `sdk`, `registry`, `performance`, `caching`, `enhancement` | **Published (Batch 3)** ([#119](https://github.com/dev-kiki0/kikis-app/issues/119)) |
| 117 | [Agent] Implement Auto-Close and Cleanup Handler in Reference Autonomous Agent Runner | Autonomous Agent Framework & Reference Runners | P1 | `agent`, `lifecycle`, `mpp-session`, `bug` | **Published (Batch 2)** ([#78](https://github.com/dev-kiki0/kikis-app/issues/78)) |
| 118 | [Agent] Fix Hardcoded Testnet URLs and Pass-Through Secrets in `agent/src/stress.ts` | Autonomous Agent Framework & Reference Runners | P2 | `agent`, `stress`, `configuration`, `bug` | **Published (Batch 3)** ([#120](https://github.com/dev-kiki0/kikis-app/issues/120)) |
| 119 | [Examples] Add Error Recovery and Reconnection Backoff to `streaming-orderbook-agent` | Autonomous Agent Framework & Reference Runners | P2 | `examples`, `mpp-session`, `resilience`, `developer-experience` | **Published (Batch 3)** ([#121](https://github.com/dev-kiki0/kikis-app/issues/121)) |
| 120 | [Examples] Add Budget Limits and Spending Cap Configuration to `price-oracle-agent` | Autonomous Agent Framework & Reference Runners | P2 | `examples`, `spend-caps`, `developer-experience`, `security` | **Published (Batch 3)** ([#122](https://github.com/dev-kiki0/kikis-app/issues/122)) |
| 121 | [Examples] Create End-to-End WebSocket Streaming Example Demonstrating Interactive Bidding | Autonomous Agent Framework & Reference Runners | P2 | `examples`, `mpp-session-ws`, `websocket`, `developer-experience` | **Published (Batch 3)** ([#123](https://github.com/dev-kiki0/kikis-app/issues/123)) |
| 122 | [Security] Verify Authorization Payload Nonce Expiration and Replay Cache in Provider Adapters | Security, Authorization & Spending-Cap Enforcement | P1 | `security`, `provider`, `replay-protection`, `x402`, `bug` | **Published (Batch 2)** ([#79](https://github.com/dev-kiki0/kikis-app/issues/79)) |
| 123 | [Security] Prevent Delimiter Confusion and Injection in Multi-Parameter Witness Commitments | Security, Authorization & Spending-Cap Enforcement | P1 | `security`, `cryptography`, `nulth`, `bug` | **Published (Batch 2)** ([#80](https://github.com/dev-kiki0/kikis-app/issues/80)) |
| 124 | [Security] Enforce Maximum In-Flight Collateral Cap Across Multiple Concurrent Open Sessions | Security, Authorization & Spending-Cap Enforcement | P1 | `security`, `spend-caps`, `mpp-session`, `enhancement` | **Published (Batch 2)** ([#81](https://github.com/dev-kiki0/kikis-app/issues/81)) |
| 125 | [Security] Validate On-Chain Vault Deployment Bytecode Hash Against Known Audited Releases | Security, Authorization & Spending-Cap Enforcement | P2 | `security`, `smart-contracts`, `verification`, `enhancement` | **Published (Batch 3)** ([#124](https://github.com/dev-kiki0/kikis-app/issues/124)) |
| 126 | [Security] Reject Zero-Value and Negative Spend Reservations in `_checkAndReserveSpend` | Security, Authorization & Spending-Cap Enforcement | P2 | `security`, `spend-caps`, `validation`, `bug` | **Published (Batch 2)** ([#82](https://github.com/dev-kiki0/kikis-app/issues/82)) |
| 127 | [CI/CD] Add Automated Soroban Contract Unit Tests and Integration Tests to GitHub Actions Workflow | Developer Experience, Tooling & CI/CD | P1 | `ci-cd`, `smart-contracts`, `testing`, `infrastructure` | **Published (Batch 2)** ([#83](https://github.com/dev-kiki0/kikis-app/issues/83)) |
| 128 | [CI/CD] Add Multi-Package Typecheck Matrix (`pnpm --filter ... typecheck`) to CI Pipeline | Developer Experience, Tooling & CI/CD | P2 | `ci-cd`, `typescript`, `infrastructure`, `developer-experience` | **Published (Batch 3)** ([#125](https://github.com/dev-kiki0/kikis-app/issues/125)) |
| 129 | [DX] Generate Comprehensive OpenAPI / Swagger Specifications for Provider Endpoints | Developer Experience, Tooling & CI/CD | P3 | `developer-experience`, `documentation`, `openapi`, `enhancement` | **Published (Batch 3)** ([#126](https://github.com/dev-kiki0/kikis-app/issues/126)) |
| 130 | [DX] Add Interactive CLI Diagnostic Tool (`kikis-app doctor`) for Agent Environment and Horizon Connectivity | Developer Experience, Tooling & CI/CD | P2 | `developer-experience`, `cli`, `diagnostics`, `enhancement` | **Published (Batch 3)** ([#127](https://github.com/dev-kiki0/kikis-app/issues/127)) |
| 131 | [MPP Session] Parse `xdr.ScVal` via `scValToNative` in `MppSessionClient.getDisputeStatus` | State-Channel Lifecycle & Streaming | P1 | `mpp-session`, `smart-contracts`, `bug` | **Published (Batch 4)** ([#128](https://github.com/dev-kiki0/kikis-app/issues/128)) |
| 132 | [SDK] Enforce Upper Bound and Reject Excessive `Retry-After` Delays in `withRetry` | Core SDK Architecture & Payment Execution | P2 | `sdk`, `reliability`, `bug` | **Published (Batch 4)** ([#129](https://github.com/dev-kiki0/kikis-app/issues/129)) |
| 133 | [Nulth] Prevent Backwards Ledger Sequence Replay and Cap Reset in `NulthClient.buildPaymentAuthProof` | Nulth ZK SDK & Privacy Layer | P1 | `security`, `sdk`, `bug` | **Published (Batch 4)** ([#130](https://github.com/dev-kiki0/kikis-app/issues/130)) |
| 134 | [Contracts] Expose Public View Functions for Vault Status, Admin, and Pending Admin in `AgentVault` | Soroban Smart Contracts & Agent Vault | P2 | `smart-contracts`, `security`, `enhancement` | **Published (Batch 4)** ([#131](https://github.com/dev-kiki0/kikis-app/issues/131)) |
| 135 | [Contracts] Validate Non-Negative Cap Boundary in `set_lifetime_cap` and `__constructor` | Soroban Smart Contracts & Agent Vault | P1 | `smart-contracts`, `security`, `bug` | **Published (Batch 4)** ([#132](https://github.com/dev-kiki0/kikis-app/issues/132)) |
| 136 | [React] Support Custom `SessionOptions` and Configurable Unmount Behavior in `useSession` | Dashboard & Web Application | P2 | `sdk`, `developer-experience`, `mpp-session` | **Published (Batch 4)** ([#133](https://github.com/dev-kiki0/kikis-app/issues/133)) |
| 137 | [MCP Server] Validate Numeric String Input for `max_amount` in `handlePayForData` | Model Context Protocol (MCP) Server | P2 | `mcp`, `security`, `bug` | **Published (Batch 4)** ([#134](https://github.com/dev-kiki0/kikis-app/issues/134)) |
| 138 | [Provider] Strip Query Parameters When Matching `/.well-known/kikis-app.json` in Fastify Middleware | Provider Infrastructure & Cloudflare Workers | P2 | `provider`, `infrastructure`, `bug` | **Published (Batch 4)** ([#135](https://github.com/dev-kiki0/kikis-app/issues/135)) |
| 139 | [Dashboard] Recognize `mpp-session-ws` Mode in `TxFeed.tsx` Payment Mode Type Guard | Dashboard & Web Application | P3 | `developer-experience`, `bug` | **Published (Batch 4)** ([#136](https://github.com/dev-kiki0/kikis-app/issues/136)) |
| 140 | [Provider] Standardize Mainnet Soroban RPC Endpoint and Support RPC Configuration in `MppSessionHandler` | Provider Infrastructure & Cloudflare Workers | P2 | `provider`, `infrastructure`, `smart-contracts`, `bug` | **Published (Batch 4)** ([#137](https://github.com/dev-kiki0/kikis-app/issues/137)) |

---

## Assumptions, Limitations & Execution Audit Trail


1. **Repository Identification & Environment Verification**:
   - Target repository confirmed as `dev-kiki0/kikis-app` via git remote and GitHub API metadata.
   - Authenticated account: `dev-kiki0` with verified write and issue creation permissions.
   - Repository contains 0 pre-existing issues (and 2 Dependabot pull requests), ensuring zero duplicate collision.
2. **Duplicate & Overlap Evaluation**:
   - All 50 backlog drafts were compared against existing repository state and cross-checked against overlapping drafts.
   - Overlapping drafts (such as redundant request forwarding or duplicate WebSocket send definitions) were eliminated in favor of foundational issues.
3. **Verified GitHub Publication**:
   - Exactly 30 distinct, high-value issues were created via authenticated GitHub CLI (`gh issue create`).
   - Each created issue was programmatically retrieved and verified for title, description, acceptance criteria, and labels.
   - GitHub issue numbers allocated: `#3` through `#32` (inclusive).
4. **Backlog Local Preservation**:
   - Exactly 20 unpublished drafts are preserved locally with complete, unabridged specifications and acceptance criteria.
   - Original unpublished issue drafts were preserved locally during initial batches and subsequently published in Batches 2, 3, and 4.
   - Changes kept strictly local without git commits, pushes, branches, or pull requests.
5. **Phase 2 Codebase Investigation & Backlog Expansion (Issues 51–130)**:
   - Fresh investigation conducted across all 15 Phase 6 engineering domains.
   - Exactly 80 additional, highly specific, actionable issues drafted with concrete code references, implementation steps, and acceptance criteria.
   - All 80 new issues are kept strictly local and unpublished (0 GitHub issues created).
   - Codebase investigation expanded across all engineering domains, researching additional issues for Batches 2, 3, and 4.
   - Total unpublished drafts in backlog: 100 (20 preserved + 80 new). Total tracked issues: 130.
   - Sizing labels (e.g. S, M, L) are completely omitted from all issue descriptions.
6. **Phase 3 Issue Publication & Backlog Reconciliation (Batch 2 — 50 Issues)**:
   - Exactly 50 eligible, high-value, non-duplicate issue drafts were selected and published to GitHub repository `dev-kiki0/kikis-app`.
   - Sequential creation via GitHub CLI (`gh issue create`) with immediate verification (`gh issue view`).
   - GitHub issue numbers allocated: `#34` through `#83` (inclusive).
   - All 50 published draft sections were cleanly removed from the local unpublished catalog.
   - All 50 remaining unpublished drafts are preserved locally in full with unabridged specifications, acceptance criteria, and testing suites.
   - Master index updated with exact publication links for all 80 published issues and accurate status for all 50 remaining drafts.
   - Sizing labels (e.g. S, M, L) are completely omitted across all issues.
   - Zero git commits, branches, PRs, or code changes were made.
7. **Phase 4 Codebase Audit, Deduplication Cleanup & Publication (Batch 4 — 10 Issues)**:
   - Conducted deduplication audit against all existing 125 GitHub issues (#3–#127) and PRs (#1–#2), rejecting potential duplicate candidates (such as handleCheckBalance Horizon 404 handling already addressed by #68).
   - Performed fresh codebase audit identifying 10 unique, high-priority engineering issues (Drafts 131–140) with concrete code evidence across SDK, Contracts, MCP Server, Nulth SDK, and Provider infrastructure.
   - Conducted deduplication audit against all existing 125 GitHub issues (#3–#127) and PRs (#1–#2), rejecting potential duplicate candidates (such as `handleCheckBalance` Horizon 404 handling already addressed by #68).
   - Successfully published and remotely verified all 10 issues on `dev-kiki0/kikis-app` as GitHub issues `#128` through `#137`.
   - Master index and publication registers fully updated to reflect 134 published issues across Batches 1–4, with 0 unpublished drafts remaining.
   - Sizing labels (e.g. S, M, L) are completely omitted across all issues and documentation.
   - No git commits, branches, PRs, or application code changes were made.
8. **Phase 5 Permanent Removal of Duplicate Draft Records**:
   - Permanently removed the 6 historical duplicate draft records (Drafts 7, 12, 16, 84, 101, 104) from the backlog file.
   - Removed all individual duplicate entries and the entire deduplication register section from the document.
   - Removed all 6 duplicate draft rows from the Master Index table, bringing the Master Index row count to exactly 134 legitimate published issues.
   - Reconciled all totals across the document: 134 total tracked issues, 134 published issues, 0 duplicate records retained, and 0 unpublished drafts.
   - Zero application source code modifications and zero git operations (no commits, pushes, branches, or PRs).
