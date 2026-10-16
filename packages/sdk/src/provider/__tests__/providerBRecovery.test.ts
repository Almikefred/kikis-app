import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { Hono } from 'hono'
import type { KikisAppManifest } from '../../types.js'
import { reconcileAbandonedSessions } from '../SessionReconciler.js'

// ── kikisAppHono harness for the Durable Object reboot simulation ─────────────
// Same technique as hono-verified-voucher.test.ts: mock the mpp channel server
// and capture the `commit` the mocked onVerifiedCredential hands each
// middleware instance, so verified vouchers can be simulated without a signed
// mppx round-trip. Registered before hono.js loads; SessionReconciler (above)
// keeps its real bindings because it was imported statically first.

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const providerBPayee = Keypair.random()
const providerBCommitKey = Keypair.random()
const providerBPayer = Keypair.random()

let recoveredCloseCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      recoveredCloseCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
    stellar: () => [],
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastRecoveryCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastRecoveryCommit = commit
      return method
    },
  },
})

const { kikisAppHono } = await import('../hono.js')

const recoveryManifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Provider-B Recovery Harness',
  description: 'Simulated Durable Object isolate for reboot tests',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: providerBPayee.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

/** A Map-backed sessionStore that outlives any single middleware closure. */
function makeSharedSessionStore(): {
  get(k: string): Promise<unknown>
  put(k: string, v: unknown): Promise<void>
  delete(k: string): Promise<void>
  update(k: string, fn: (v: unknown) => unknown): void
} {
  const m = new Map<string, unknown>()
  return {
    async get(k: string) { return m.get(k) },
    async put(k: string, v: unknown) { m.set(k, v) },
    async delete(k: string) { m.delete(k) },
    update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
  }
}

/**
 * One "isolate": a fresh middleware closure (fresh in-memory counters) over a
 * caller-owned session store, plus the commit hook this instance registered.
 */
function buildRecoveryApp(handlers: {
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
}, sessionStore: unknown): { app: Hono; commit: Commit } {
  recoveredCloseCalls = []
  const app = new Hono()
  app.use(
    '*',
    kikisAppHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: providerBPayee.publicKey(),
      network: 'testnet',
      payeeSecretKey: providerBPayee.secret(),
      commitmentPublicKey: providerBCommitKey.publicKey(),
      manifest: recoveryManifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      sessionStore: sessionStore as never,
      ...handlers,
    }),
  )
  assert.ok(lastRecoveryCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = lastRecoveryCommit!
  return { app, commit }
}

function hexToBytesRecovery(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function makeSupabaseMock(rows: any[]) {
  const store = [...rows]
  return {
    from: (_table: string) => ({
      // Chainable so it mirrors the reconciler's scoped, ordered query.
      select: (_cols?: string) => {
        const filters: Array<(r: any) => boolean> = []
        let cap = Infinity
        let orderField: string | undefined
        let ascending = true
        const query = {
          eq: (field: string, val: unknown) => {
            filters.push(r => r[field] === val)
            return query
          },
          is: (field: string, val: unknown) => {
            filters.push(r => (r[field] ?? null) === val)
            return query
          },
          not: (field: string, operator: string, val: unknown) => {
            if (operator !== 'is') throw new Error(`unsupported operator: ${operator}`)
            filters.push(r => (r[field] ?? null) !== val)
            return query
          },
          order: (field: string, options: { ascending: boolean }) => {
            orderField = field
            ascending = options.ascending
            return query
          },
          limit: (n: number) => {
            cap = n
            return query
          },
          then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
            const data = store.filter(r => filters.every(f => f(r)))
            if (orderField) {
              const direction = ascending ? 1 : -1
              data.sort((left, right) =>
                direction * String(left[orderField!]).localeCompare(String(right[orderField!])),
              )
            }
            return Promise.resolve({
              data: data.slice(0, cap),
              error: null,
            }).then(onOk, onErr)
          },
        }
        return query
      },
      update: (data: any) => ({
        eq: (_field: string, val: string) => {
          const row = store.find(r => r.channel_id === val)
          if (row) Object.assign(row, data)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  } as any
}

describe('Provider-B Session Recovery Pipeline', () => {
  const payeeKp = Keypair.random()
  const channelId = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

  it('successfully recovers an orphaned closing session written by provider-b', async () => {
    // Provider stores cumulative_amount as a USDC decimal in NUMERIC(20,7).
    const providerBSessions: any[] = [
      {
        channel_id: channelId,
        payee: payeeKp.publicKey(),
        payer: 'GAGENT123',
        cumulative_amount: '0.005',
        status: 'closing',
        channel_contract: channelId,
        network: 'testnet',
        voucher_count: 5,
        last_signature: 'a'.repeat(128),
      },
    ]

    const mockChannelClose = async (args: any) => {
      assert.equal(args.channel, channelId)
      assert.equal(args.amount, 50000n)
      assert.equal(args.signature.toString('hex'), 'a'.repeat(128))
      return 'tx-hash-provider-b-settled'
    }

    const stats = await reconcileAbandonedSessions({
      supabase: makeSupabaseMock(providerBSessions),
      network: 'testnet',
      payeeSecretKey: payeeKp.secret(),
      channelClose: mockChannelClose as any,
    })

    assert.equal(stats.orphanedCount, 1)
    assert.equal(stats.recoveredCount, 1)
    assert.equal(stats.failedCount, 0)
    assert.equal(providerBSessions[0]!.status, 'closed')
    assert.equal(providerBSessions[0]!.settlement_tx_hash, 'tx-hash-provider-b-settled')
  })

  it('recovers legacy decimal cumulative_amount rows gracefully', async () => {
    const legacyDecimalSession: any[] = [
      {
        channel_id: channelId,
        payee: payeeKp.publicKey(),
        payer: 'GAGENT123',
        cumulative_amount: '0.005', // legacy decimal format
        status: 'closing',
        channel_contract: channelId,
        network: 'testnet',
        voucher_count: 5,
        last_signature: 'b'.repeat(128),
      },
    ]

    const mockChannelClose = async (args: any) => {
      assert.equal(args.amount, 50000n)
      return 'tx-hash-legacy-settled'
    }

    const stats = await reconcileAbandonedSessions({
      supabase: makeSupabaseMock(legacyDecimalSession),
      network: 'testnet',
      payeeSecretKey: payeeKp.secret(),
      channelClose: mockChannelClose as any,
    })

    assert.equal(stats.recoveredCount, 1)
    assert.equal(legacyDecimalSession[0]!.status, 'closed')
  })
})

describe('Provider-B Durable Object session persistence (#52)', () => {
  it('DELETE after a simulated isolate reboot settles from the persisted voucher, never the client body', async () => {
    // Shared durable storage — the equivalent of the Durable Object's
    // ctx.storage between evictions.
    const sessionStore = makeSharedSessionStore()

    // First "isolate": the provider verifies one voucher for 5000 stroops.
    const first = buildRecoveryApp({}, sessionStore)
    await first.commit({
      payload: { amount: '5000', signature: 'ff'.repeat(32) },
      source: providerBPayer.publicKey(),
    })

    // Eviction: a brand-new closure (fresh in-memory record and voucherCount)
    // over the same persistent storage. No new voucher lands before close.
    const second = buildRecoveryApp({}, sessionStore)

    // The client self-reports an inflated amount/signature in the DELETE body.
    const res = await second.app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '9999000', signature: 'ee'.repeat(32) }),
    })

    assert.equal(res.status, 200)
    const json = (await res.json()) as { closeTxHash: unknown }
    assert.equal(json.closeTxHash, 'mock-close-tx-hash')
    assert.equal(recoveredCloseCalls.length, 1)
    assert.equal(
      recoveredCloseCalls[0]!.amount,
      5000n,
      'settlement must come from the persisted verified voucher, not the client body',
    )
    assert.deepEqual(
      recoveredCloseCalls[0]!.signature,
      hexToBytesRecovery('ff'.repeat(32)),
      'the provider\'s own verified signature must be used, not the client\'s claim',
    )
  })

  it('voucherCount continues from the persisted counter after a reboot', async () => {
    const sessionStore = makeSharedSessionStore()
    const first = buildRecoveryApp({}, sessionStore)
    await first.commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })

    const voucherIndexes: number[] = []
    const second = buildRecoveryApp(
      {
        onVoucher: async (_channelId, voucherIndex) => {
          voucherIndexes.push(voucherIndex)
        },
      },
      sessionStore,
    )
    await second.commit({ payload: { amount: '2000', signature: 'bb'.repeat(32) } })

    assert.deepEqual(
      voucherIndexes,
      [2],
      'the post-reboot voucher must be indexed after the pre-reboot one, not from 0',
    )
  })
})
