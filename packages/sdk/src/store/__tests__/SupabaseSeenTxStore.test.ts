import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSeenTxStore } from '../SupabaseSeenTxStore.js'
import { InMemorySeenTxStore } from '../../provider/SeenTxStore.js'

interface MockOptions {
  queryError?: string | (() => string | null)
  upsertError?: string | (() => string | null)
  data?: {
    tx_hash: string | null
    headers: Record<string, string> | null
    created_at?: string
  } | null | (() => { tx_hash: string | null; headers: Record<string, string> | null; created_at?: string } | null)
  rpcData?: number | null | (() => number | null)
  rpcError?: string | (() => string | null)
}

function mockSupabase(opts: MockOptions) {
  const upserts: unknown[] = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const client = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_field: string, _val: string) {
              return {
                maybeSingle() {
                  const err = typeof opts.queryError === 'function' ? opts.queryError() : opts.queryError
                  const d = typeof opts.data === 'function' ? opts.data() : opts.data
                  return Promise.resolve({
                    data: d ?? null,
                    error: err ? { message: err } : null,
                  })
                },
              }
            },
          }
        },
        upsert(payload: unknown, _opts: unknown) {
          upserts.push(payload)
          const err = typeof opts.upsertError === 'function' ? opts.upsertError() : opts.upsertError
          return Promise.resolve({
            data: null,
            error: err ? { message: err } : null,
          })
        },
      }
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args })
      const err = typeof opts.rpcError === 'function' ? opts.rpcError() : opts.rpcError
      const d = typeof opts.rpcData === 'function' ? opts.rpcData() : opts.rpcData
      return Promise.resolve({
        data: d ?? null,
        error: err ? { message: err } : null,
      })
    },
  } as unknown as SupabaseClient
  return { client, upserts, rpcCalls }
}

describe('SupabaseSeenTxStore', () => {
  it('returns undefined when no matching key exists', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ data: null }).client)
    const result = await store.get('nonexistent')
    assert.equal(result, undefined)
  })

  it('returns a SettlementRecord with createdAt mapped from created_at', async () => {
    const createdAt = '2026-09-01T12:00:00.000Z'
    const store = new SupabaseSeenTxStore(
      mockSupabase({
        data: {
          tx_hash: 'tx_abc123',
          headers: { 'X-Payment-Response': 'encoded-response' },
          created_at: createdAt,
        },
      }).client,
    )
    const result = await store.get('key1')
    assert.deepEqual(result, {
      txHash: 'tx_abc123',
      headers: { 'X-Payment-Response': 'encoded-response' },
      createdAt: Date.parse(createdAt),
    })
  })

  it('returns txHash as null when the row has no tx_hash', async () => {
    const store = new SupabaseSeenTxStore(
      mockSupabase({
        data: { tx_hash: null, headers: null, created_at: '2026-09-01T12:00:00.000Z' },
      }).client,
    )
    const result = await store.get('key1')
    assert.deepEqual(result, {
      txHash: null,
      createdAt: Date.parse('2026-09-01T12:00:00.000Z'),
    })
  })

  it('throws KikisAppNetworkError on query failure', async () => {
    const store = new SupabaseSeenTxStore(
      mockSupabase({ queryError: 'relation "settlements" does not exist' }).client,
    )
    await assert.rejects(() => store.get('key1'), {
      name: 'KikisAppNetworkError',
      message: /SupabaseSeenTxStore\.get failed/,
    })
  })

  it('writes created_at from the record on set', async () => {
    const createdAt = Date.UTC(2026, 8, 1, 12, 0, 0)
    const { client, upserts } = mockSupabase({})
    const store = new SupabaseSeenTxStore(client)
    await store.set('key1', { txHash: 'hash1', headers: { 'x-test': 'val' }, createdAt })

    assert.deepEqual(upserts, [
      {
        key: 'key1',
        tx_hash: 'hash1',
        headers: { 'x-test': 'val' },
        created_at: new Date(createdAt).toISOString(),
      },
    ])
  })

  it('throws KikisAppNetworkError on upsert failure', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ upsertError: 'duplicate key value' }).client)
    await assert.rejects(
      () => store.set('key1', { txHash: 'hash1', headers: { 'x-test': 'val' }, createdAt: Date.now() }),
      {
        name: 'KikisAppNetworkError',
        message: /SupabaseSeenTxStore\.set failed/,
      },
    )
  })

  it('claimReplay calls the claim_settlement_replay RPC and returns the count', async () => {
    const { client, rpcCalls } = mockSupabase({ rpcData: 2 })
    const store = new SupabaseSeenTxStore(client)
    assert.equal(await store.claimReplay('key1'), 2)
    assert.deepEqual(rpcCalls, [
      { fn: 'claim_settlement_replay', args: { p_key: 'key1' } },
    ])
  })

  it('claimReplay returns Infinity when no row comes back', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ rpcData: null }).client)
    assert.equal(await store.claimReplay('missing'), Number.POSITIVE_INFINITY)
  })

  it('claimReplay returns Infinity when the database replay cap refuses the claim', async () => {
    // migration 006 returns -1 once replay_count reaches p_max_replays
    const store = new SupabaseSeenTxStore(mockSupabase({ rpcData: -1 }).client)
    assert.equal(await store.claimReplay('capped'), Number.POSITIVE_INFINITY)
  })

  it('retries on transient query error and succeeds when query subsequently succeeds', async () => {
    let attempts = 0
    const store = new SupabaseSeenTxStore(
      mockSupabase({
        queryError: () => {
          attempts++
          return attempts === 1 ? 'connection reset by peer' : null
        },
        data: () => ({ tx_hash: 'tx_retry_ok', headers: null, created_at: '2026-09-01T12:00:00.000Z' }),
      }).client,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 },
      },
    )
    const result = await store.get('retry_key')
    assert.equal(attempts, 2)
    assert.equal(result?.txHash, 'tx_retry_ok')
  })

  it('falls back to fallbackStore.get when Supabase query fails after exhausted retries', async () => {
    const fallback = new InMemorySeenTxStore({ warn: false })
    fallback.set('fallback_key', { txHash: 'tx_from_fallback', createdAt: 12345 })

    const store = new SupabaseSeenTxStore(
      mockSupabase({ queryError: 'connection refused' }).client,
      {
        fallbackStore: fallback,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )

    const result = await store.get('fallback_key')
    assert.deepEqual(result, { txHash: 'tx_from_fallback', createdAt: 12345 })
  })

  it('falls back to fallbackStore.set when Supabase upsert fails after exhausted retries', async () => {
    const fallback = new InMemorySeenTxStore({ warn: false })
    const store = new SupabaseSeenTxStore(
      mockSupabase({ upsertError: 'database timeout' }).client,
      {
        fallbackStore: fallback,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )

    await store.set('set_fallback_key', { txHash: 'tx_fallback_set', createdAt: 54321 })
    assert.equal(fallback.get('set_fallback_key')?.txHash, 'tx_fallback_set')
  })

  it('falls back to fallbackStore.claimReplay when Supabase claimReplay RPC fails after exhausted retries', async () => {
    const fallback = new InMemorySeenTxStore({ warn: false })
    fallback.set('claim_key', { txHash: 'tx_claim', createdAt: Date.now() })

    const store = new SupabaseSeenTxStore(
      mockSupabase({ rpcError: 'rpc timeout' }).client,
      {
        fallbackStore: fallback,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )

    const count = await store.claimReplay('claim_key')
    assert.equal(count, 1)
  })
})
