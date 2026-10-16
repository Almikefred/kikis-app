/**
 * Unit tests for SessionHandle.stats() (#32).
 *
 * stats() must expose live vouchersIssued / currentCumulative / channelId /
 * openTxHash without closing the session, updated synchronously on every
 * stream() yield. The real stellar.channel() client signs vouchers via a
 * Soroban RPC call, so mppx/client and @stellar/mpp/channel/client are mocked
 * (registered before the client module is imported, like session-ws.test.ts)
 * and the channel client's onProgress 'signed' event is scripted — that event
 * is what feeds the closure's currentCumulative in the real flow.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { after, before, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type {
  KikisAppManifest,
  SessionEvent,
  SessionHandle,
  SessionOptions,
  SessionVoucherPayload,
} from '../../types.js'
import { KikisAppChannelStateError, KikisAppSignatureError } from '../../errors.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Scripted mppx + channel client ───────────────────────────────────────────

type ProgressEvent = { type: 'signed'; cumulativeAmount: string }

let capturedOnProgress: ((event: ProgressEvent) => void) | null = null
// Consumed one per fetch, mirroring one signed voucher per stream() iteration.
let scriptedCumulatives: string[] = []
let scriptedFetchRejects = false
let scriptedFetchNonJson = false
let scriptedFetchError: Error | null = null
let fetchCallCount = 0

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: {
      channel: (opts: { onProgress?: (event: ProgressEvent) => void }) => {
        capturedOnProgress = opts.onProgress ?? null
        return {}
      },
    },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async (): Promise<Response> => {
          fetchCallCount++
          if (scriptedFetchError) {
            throw scriptedFetchError
          }
          if (scriptedFetchRejects) {
            throw new TypeError('fetch failed')
          }
          if (scriptedFetchNonJson) {
            return new Response('<html>proxy error</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
          }
          // The real channel client fires onProgress({ type: 'signed' }) when
          // it signs a voucher; the closure reads it into currentCumulative.
          const cumulative = scriptedCumulatives.shift()
          if (cumulative !== undefined) {
            capturedOnProgress?.({ type: 'signed', cumulativeAmount: cumulative })
          }
          return new Response(JSON.stringify({ seq: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): KikisAppManifest {
  return {
    'kikis-app': '1.0',
    name: 'Stats Test Provider',
    description: 'Provider exercised by session stats unit tests',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: Keypair.random().publicKey(),
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['orderbook', 'stellar', 'test'],
  }
}

async function openHandle(options?: SessionOptions) {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(
    SESSION_URL,
    buildManifest(),
    Keypair.random().secret(),
    options,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionHandle.stats()', () => {
  it('reports zeroed stats and channel identity before any streaming', async () => {
    scriptedCumulatives = []
    scriptedFetchRejects = false
    const handle = await openHandle()

    const stats = handle.stats()
    assert.equal(stats.vouchersIssued, 0)
    assert.equal(stats.currentCumulative, '0.0000000')
    assert.equal(stats.channelId, CHANNEL_CONTRACT)
    assert.equal(stats.openTxHash, null)
  })

  it('reflects vouchers issued and cumulative synchronously after each yield', async () => {
    scriptedCumulatives = ['1000', '2500']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()

    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')
    assert.equal(handle.stats().channelId, CHANNEL_CONTRACT)
    assert.equal(handle.stats().openTxHash, null)

    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 2)
    assert.equal(handle.stats().currentCumulative, '0.0002500')
  })

  it('tracks cumulative in payment-asset decimal units matching totalPaid', async () => {
    scriptedCumulatives = ['1000000000'] // 100 USDC in microUSDC
    scriptedFetchRejects = false
    const handle = await openHandle()

    await handle.stream()[Symbol.asyncIterator]().next()
    assert.equal(handle.stats().currentCumulative, '100.0000000')
  })

  it('is stable between yields (same snapshot until the next voucher)', async () => {
    scriptedCumulatives = ['1000', '2000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const before = handle.stats()
    assert.deepEqual(before, handle.stats())
    assert.equal(handle.stats().vouchersIssued, 0)

    await handle.stream()[Symbol.asyncIterator]().next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.deepEqual(handle.stats(), handle.stats())
  })

  it('keeps prior counters intact when a stream iteration fails', async () => {
    scriptedCumulatives = ['1000', '2000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')

    // Next fetch fails — the iteration throws and must not corrupt stats.
    scriptedFetchRejects = true
    await assert.rejects(() => iter.next())
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')
  })

  it('accumulates across many yields', async () => {
    // stats() feeds the same closure counters close() settles on, so a
    // mid-stream per-session sub-cap check agrees with the final settlement.
    scriptedCumulatives = ['1000', '2000', '3000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()
    for (let i = 0; i < 3; i++) {
      await iter.next()
    }
    const stats = handle.stats()
    assert.equal(stats.vouchersIssued, 3)
    assert.equal(stats.currentCumulative, '0.0003000')
  })

  it('throws KikisAppChannelStateError when voucher response is not valid JSON', async () => {
    scriptedCumulatives = ['1000']
    scriptedFetchRejects = false
    scriptedFetchNonJson = true
    try {
      const handle = await openHandle()
      const iter = handle.stream()[Symbol.asyncIterator]()
      await assert.rejects(
        () => iter.next(),
        (err: unknown) => {
          assert.ok(err instanceof KikisAppChannelStateError)
          assert.match(err.message, /Voucher response was not valid JSON \(HTTP 200\)/)
          assert.ok(err.cause instanceof SyntaxError)
          return true
        },
      )
    } finally {
      scriptedFetchNonJson = false
    }
  })

  it('surfaces non-network mppx voucher errors as SIGNATURE and is attempted once', async () => {
    scriptedCumulatives = ['1000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    fetchCallCount = 0
    const signingErr = new Error('invalid signature bytes')
    scriptedFetchError = signingErr

    try {
      const iter = handle.stream()[Symbol.asyncIterator]()
      await assert.rejects(
        () => iter.next(),
        (err: unknown) => {
          assert.ok(err instanceof KikisAppSignatureError)
          assert.equal(err.retryable, false)
          assert.equal(err.code, 'SIGNATURE')
          assert.equal(err.cause, signingErr)
          return true
        },
      )
      assert.equal(fetchCallCount, 1, 'voucher request should be attempted exactly once (no retry)')
    } finally {
      scriptedFetchError = null
    }
  })
})

// ── session:voucher emission (#15) ────────────────────────────────────────────

describe('SessionHandle session:voucher event', () => {
  it('emits with updated counters after every voucher', async () => {
    scriptedCumulatives = ['1000', '2500']
    scriptedFetchRejects = false
    const handle = await openHandle()
    const payloads: SessionVoucherPayload[] = []
    handle.on('session:voucher', (p) => {
      payloads.push(p)
    })

    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    assert.deepEqual(
      payloads,
      [{ vouchersIssued: 1, currentCumulative: '0.0001000' }],
      'the first voucher must emit counters advanced by one voucher',
    )

    await iter.next()
    assert.deepEqual(
      payloads,
      [
        { vouchersIssued: 1, currentCumulative: '0.0001000' },
        { vouchersIssued: 2, currentCumulative: '0.0002500' },
      ],
      'every subsequent voucher must emit the running totals',
    )
  })

  it('keeps counters in sync with stats() at each emission', async () => {
    scriptedCumulatives = ['1000', '2000']
    scriptedFetchRejects = false
    const handle = await openHandle()
    const payloads: SessionVoucherPayload[] = []
    handle.on('session:voucher', (p) => {
      payloads.push(p)
    })

    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    await iter.next()

    const stats = handle.stats()
    const last = payloads.at(-1)
    assert.ok(last, 'a payload must have been emitted per voucher')
    assert.equal(last.vouchersIssued, stats.vouchersIssued)
    assert.equal(last.currentCumulative, stats.currentCumulative)
  })
})

// ── Listener management (#14) ─────────────────────────────────────────────────

describe('SessionHandle listener management', () => {
  // A real close() runs offline here: the Soroban RPC surface close() uses is
  // faked and its DELETE request is served by a global fetch stub (same
  // pattern as session-close-stream.test.ts). Registered in before() — after
  // MppSessionClient is loaded — so only close()'s call-time dynamic import
  // resolves to the fake.
  const originalFetch = globalThis.fetch

  before(() => {
    mock.module('@stellar/stellar-sdk', { namedExports: buildFakeSdk() })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ closeTxHash: 'CLOSE_TX_HASH' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch
  })

  after(() => {
    globalThis.fetch = originalFetch
  })

  /** Let the 20ms lifetime guard fire and its close() settle. */
  const SETTLE_MS = 100

  /** Open a session whose lifetime guard fires shortly, with close() stubbed. */
  async function openFailingSession(): Promise<SessionHandle> {
    const handle = await openHandle({ maxDurationMs: 20 })
    handle.close = () => Promise.reject(new Error('stubbed close failure'))
    return handle
  }

  it('delivers both lifecycle events to attached listeners (control)', async () => {
    const handle = await openFailingSession()
    const fired: SessionEvent[] = []
    handle.on('session:timeout', () => {
      fired.push('session:timeout')
    })
    handle.on('session:close-failed', () => {
      fired.push('session:close-failed')
    })

    await new Promise((r) => setTimeout(r, SETTLE_MS))

    // The control for the eviction tests below: with listeners attached,
    // both events of the failing-lifetime-guard flow reach them in order.
    assert.deepEqual(fired, ['session:timeout', 'session:close-failed'])
  })

  it('removeAllListeners() evicts every attached callback', async () => {
    const handle = await openFailingSession()
    const fired: SessionEvent[] = []
    handle.on('session:timeout', () => {
      fired.push('session:timeout')
    })
    handle.on('session:close-failed', () => {
      fired.push('session:close-failed')
    })

    handle.removeAllListeners()
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    assert.deepEqual(fired, [], 'no listener should run after removeAllListeners()')
  })

  it("removeAllListeners('session:timeout') evicts only that event's callbacks", async () => {
    const handle = await openFailingSession()
    const fired: SessionEvent[] = []
    handle.on('session:timeout', () => {
      fired.push('session:timeout')
    })
    handle.on('session:close-failed', () => {
      fired.push('session:close-failed')
    })

    handle.removeAllListeners('session:timeout')
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    // The close-failed listener survived — only the named event was evicted.
    assert.deepEqual(fired, ['session:close-failed'])
  })

  it('a successful close() clears the internal listener map', async (t) => {
    scriptedCumulatives = []
    scriptedFetchRejects = false
    const handle = await openHandle({ maxDurationMs: 0 })
    handle.on('session:timeout', () => {})
    handle.on('session:close-failed', () => {})

    // Nothing can emit after a successful close — the guard timer is cleared
    // and no auto-close can fail — so the eviction is observed by watching
    // the listeners map receive Map.prototype.clear during close(). The map
    // holds one Set per subscribed event: exactly two here.
    const originalClear = Map.prototype.clear
    const cleared: Array<{ map: Map<unknown, unknown>; sizeAtClear: number }> = []
    t.mock.method(Map.prototype, 'clear', function (this: Map<unknown, unknown>) {
      cleared.push({ map: this, sizeAtClear: this.size })
      return originalClear.call(this)
    })

    await handle.close()

    const listenerMap = cleared.find((entry) => entry.sizeAtClear === 2)
    assert.ok(listenerMap, 'close() must clear the two-entry listener map')
    assert.equal(
      listenerMap.map.size,
      0,
      'the listener map must be empty after close()',
    )
  })

  it('a failed close() keeps its listeners so session:close-failed still lands', async () => {
    const handle = await openFailingSession()
    const fired: SessionEvent[] = []
    handle.on('session:close-failed', () => {
      fired.push('session:close-failed')
    })

    // The lifetime-guard auto-close fails — the listener must still be
    // attached, because close() only clears listeners on success.
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    assert.deepEqual(fired, ['session:close-failed'])
  })
})

// ── Fake Soroban RPC for close() (mirrors session-close-stream.test.ts) ───────

function buildFakeSdk() {
  class FakeServer {
    constructor(_url: string) {}
    async getAccount() {
      return {
        accountId: () => Keypair.random().publicKey(),
        sequenceNumber: () => '1',
        incrementSequenceNumber: () => undefined,
      }
    }
    async simulateTransaction() {
      return { result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } } }
    }
  }

  class FakeContract {
    constructor(_address: string) {}
    call(fn: string, ...args: unknown[]) {
      return { __op: fn, args }
    }
  }

  class FakeTransactionBuilder {
    constructor(_account: unknown, _opts: unknown) {}
    addOperation() {
      return this
    }
    setTimeout() {
      return this
    }
    build() {
      return { sign: (_kp: unknown) => undefined }
    }
  }

  return {
    rpc: {
      Server: FakeServer,
      Api: { isSimulationError: () => false },
    },
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    BASE_FEE: '100',
    nativeToScVal: (value: unknown) => ({ __scval: value }),
  }
}
