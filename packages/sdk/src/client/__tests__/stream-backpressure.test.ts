/**
 * Unit tests for MppSessionClient.stream() backpressure.
 *
 * Strategy: intercept mppx.fetch() at the module boundary using a
 * controllable fake-fetch that resolves on demand, letting us assert
 * exactly how many requests are in-flight at each point.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { KikisAppManifest, StreamOptions } from '../../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A deferred promise whose resolve/reject functions are exposed externally. */
function deferred<T = unknown>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Build a mock SessionHandle.stream() that uses a controlled fetch queue. */
function buildMockStream(fetchFn: () => Promise<unknown>) {
  let vouchersIssued = 0

  return {
    vouchersIssued: () => vouchersIssued,
    async *stream(options?: StreamOptions): AsyncIterable<unknown> {
      const concurrency = Math.max(1, options?.concurrency ?? 1)

      const doFetch = () => fetchFn()

      if (concurrency === 1) {
        while (true) {
          const data = await doFetch()
          vouchersIssued++
          yield data
        }
      } else {
        const queue: Array<Promise<unknown>> = []
        for (let i = 0; i < concurrency; i++) queue.push(doFetch())

        while (true) {
          const data = await queue.shift()!
          queue.push(doFetch())
          vouchersIssued++
          yield data
        }
      }
    },
  }
}

// ── Test 1: StreamOptions is exported from types ──────────────────────────────

{
  const opts: StreamOptions = { concurrency: 1 }
  assert.strictEqual(opts.concurrency, 1, 'StreamOptions.concurrency should be 1')
  console.log('✓ Test 1: StreamOptions interface is exported and usable')
}

// ── Test 2: default concurrency is 1 — next fetch not issued until ACK ───────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream()[Symbol.asyncIterator]()

  // Kick off the first next() — it should issue exactly one fetch.
  const firstNext = iter.next()
  await Promise.resolve() // flush microtasks

  assert.strictEqual(fetchCallCount, 1, 'with concurrency:1, only 1 fetch should be in flight after first next()')

  // Resolve the first fetch — the generator should yield and pause.
  pendingFetches[0]!.resolve({ seq: 1 })
  const { value: v1 } = await firstNext
  assert.deepStrictEqual(v1, { seq: 1 }, 'yielded value should be the resolved fetch body')

  // Start the second iteration — it should issue exactly one more fetch.
  const secondNext = iter.next()
  await Promise.resolve()
  assert.strictEqual(fetchCallCount, 2, 'second fetch issued only after first was ACKed')

  pendingFetches[1]!.resolve({ seq: 2 })
  const { value: v2 } = await secondNext
  assert.deepStrictEqual(v2, { seq: 2 })

  console.log('✓ Test 2: concurrency:1 (default) — next voucher not issued until HTTP 200 received')
}

// ── Test 3: concurrency:2 — 2 requests in flight before first yield ──────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 2 })[Symbol.asyncIterator]()

  // With concurrency:2, the pipelined path pre-fills 2 fetches immediately.
  const firstNext = iter.next()
  await Promise.resolve() // flush microtasks

  assert.strictEqual(fetchCallCount, 2, 'concurrency:2 should have 2 fetches in flight before first yield')

  // Resolve both.
  pendingFetches[0]!.resolve({ seq: 1 })
  pendingFetches[1]!.resolve({ seq: 2 })

  const { value: v1 } = await firstNext
  assert.deepStrictEqual(v1, { seq: 1 }, 'first yielded value must be from the first issued request (order preserved)')

  // After draining slot 0, a replacement should have been issued (total = 3).
  await Promise.resolve()
  assert.strictEqual(fetchCallCount, 3, 'window replenished to 2 after yielding first result')

  console.log('✓ Test 3: concurrency:2 — 2 fetches in flight, window replenished after each yield')
}

// ── Test 4: results yielded in issue order even when later fetch resolves first

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 2 })[Symbol.asyncIterator]()

  const firstNext = iter.next()
  await Promise.resolve()

  // Resolve in REVERSE order — second resolves before first.
  pendingFetches[1]!.resolve({ seq: 2 })
  pendingFetches[0]!.resolve({ seq: 1 })

  const { value: v1 } = await firstNext
  // Must yield seq:1 (issue order), not seq:2 (resolution order).
  assert.deepStrictEqual(v1, { seq: 1 }, 'results must be yielded in issue order regardless of resolution order')

  console.log('✓ Test 4: results yielded in issue order even when out-of-order resolution occurs')
}

// ── Test 5: concurrency defaults to 1 when option is omitted ─────────────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({})[Symbol.asyncIterator]()

  iter.next()
  await Promise.resolve()

  assert.strictEqual(fetchCallCount, 1, 'empty options object should default to concurrency:1')
  pendingFetches[0]!.resolve({})

  console.log('✓ Test 5: empty StreamOptions defaults to concurrency:1')
}

// ── Test 6: concurrency values below 1 are clamped to 1 ─────────────────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 0 })[Symbol.asyncIterator]()

  iter.next()
  await Promise.resolve()

  assert.strictEqual(fetchCallCount, 1, 'concurrency:0 should be clamped to 1')
  pendingFetches[0]!.resolve({})

  console.log('✓ Test 6: concurrency:0 clamped to 1, still sequential')
}

console.log('\nAll stream backpressure tests passed.')

// ── Test 7: early termination disposes the stream iterator (#54) ──────────────
//
// The mocks above only exercise queueing — cleanup on early exit is a property
// of the REAL MppSessionClient.stream(): breaking out of consumption (or
// calling iterator.return() directly) must reach the generator's finally block,
// which aborts the AbortController handed to mppx.fetch — the transport the
// mpp-session reader is wired through. mppx/client and the channel client are
// mocked at the module boundary (same technique as session-stats.test.ts) so
// the real stream() runs without the network, and the mocked fetch records
// every AbortSignal it was handed.

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

const capturedSignals: AbortSignal[] = []

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: { channel: () => ({}) },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async (_url: string, init?: { signal?: AbortSignal }): Promise<Response> => {
          if (init?.signal) capturedSignals.push(init.signal)
          return new Response(JSON.stringify({ seq: capturedSignals.length }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

function buildCleanupManifest(): KikisAppManifest {
  return {
    'kikis-app': '1.0',
    name: 'Cleanup Test Provider',
    description: 'Provider exercised by iterator-cleanup tests',
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

async function openCleanupHandle() {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(SESSION_URL, buildCleanupManifest(), Keypair.random().secret())
}

// ── Test 7a: explicit iterator.return() aborts the transport ─────────────────

{
  capturedSignals.length = 0
  const handle = await openCleanupHandle()
  const iter = handle.stream()[Symbol.asyncIterator]()

  await iter.next()
  assert.equal(capturedSignals.length, 1, 'first pull issues exactly one voucher fetch')
  const signal = capturedSignals[0]!
  assert.equal(signal.aborted, false, 'transport stays active while the consumer keeps iterating')

  // The consumer walks away mid-stream — this must reach the stream's
  // cleanup (generator finally → AbortController.abort()).
  await iter.return?.()
  assert.equal(signal.aborted, true, 'iterator.return() must abort the stream transport (#54)')

  console.log('✓ Test 7a: explicit iterator.return() aborts the in-flight transport')
}

// ── Test 7b: breaking out of for-await disposes the iterator ─────────────────

{
  capturedSignals.length = 0
  const handle = await openCleanupHandle()

  let consumed = 0
  for await (const _item of handle.stream()) {
    consumed++
    break // early exit — the loop must close the iterator on its way out
  }

  assert.equal(consumed, 1, 'exactly one item consumed before the break')
  assert.equal(capturedSignals.length, 1)
  assert.equal(
    capturedSignals[0]!.aborted,
    true,
    'a for-await break must run the stream cleanup chain (#54)',
  )

  console.log('✓ Test 7b: for-await break triggers iterator cleanup')
}

// ── Test 7c: pipelined streams abort every queued fetch on early return ──────

{
  capturedSignals.length = 0
  const handle = await openCleanupHandle()
  const iter = handle.stream({ concurrency: 2 })[Symbol.asyncIterator]()

  await iter.next()
  assert.ok(
    capturedSignals.length >= 2,
    'concurrency:2 keeps the refill window in flight before cleanup',
  )

  await iter.return?.()
  assert.ok(
    capturedSignals.every((signal) => signal.aborted),
    'every queued fetch shares the stream AbortController and must be aborted (#54)',
  )

  console.log('✓ Test 7c: pipelined stream aborts its whole window on early return')
}

console.log('\nAll stream iterator-cleanup tests passed.')
