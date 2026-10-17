import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Keypair } from '@stellar/stellar-sdk'
import {
  InMemorySpendStore,
  FileSpendStore,
  signManifest,
  type KikisAppManifest,
  type EstimateCostResult,
} from '@kikis-app/kikis-app'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  handleCheckSpendCap,
  handleCheckVaultStatus,
  type HandlerDeps,
  type ToolResult,
  type HorizonBalance,
  type ProviderRow,
  type SupabaseQueryBuilder,
} from '../handlers.js'
import { MAX_STREAM_MESSAGES, TOOLS } from '../tools.js'

// ---------------------------------------------------------------------------
// Tool schema regression guard
// Ensures pay_for_data preferred_mode enum restricts to discrete payment modes
// ---------------------------------------------------------------------------

const DISCRETE_PAYMENT_MODES = ['x402', 'mpp-charge'] as const

describe('TOOLS schema regression', () => {
  it('pay_for_data preferred_mode enum restricts to discrete payment modes', () => {
    const tool = TOOLS.find((t) => t.name === 'pay_for_data')
    assert.ok(tool, 'pay_for_data tool must exist in TOOLS')

    const enumValues = (tool.inputSchema as unknown as {
      properties: { preferred_mode: { enum: string[] } }
    }).properties.preferred_mode.enum

    const expected = [...DISCRETE_PAYMENT_MODES].sort()
    const actual = [...enumValues].sort()

    assert.deepEqual(
      actual,
      expected,
      `Tool enum ${JSON.stringify(actual)} must match discrete modes ${JSON.stringify(expected)}`,
    )
  })

  it('stream_session max_messages is a bounded integer', () => {
    const tool = TOOLS.find((t) => t.name === 'stream_session')
    assert.ok(tool, 'stream_session tool must exist in TOOLS')

    const schema = (tool.inputSchema as unknown as {
      properties: { max_messages: { type: string; minimum: number; maximum: number } }
    }).properties.max_messages

    assert.equal(schema.type, 'integer')
    assert.equal(schema.minimum, 1)
    assert.equal(schema.maximum, MAX_STREAM_MESSAGES)
    assert.equal(MAX_STREAM_MESSAGES, 50)
  })

  it('check_spend_cap and check_vault_status tools exist in TOOLS', () => {
    const spendCapTool = TOOLS.find((t) => t.name === 'check_spend_cap')
    assert.ok(spendCapTool, 'check_spend_cap tool must exist in TOOLS')

    const vaultTool = TOOLS.find((t) => t.name === 'check_vault_status')
    assert.ok(vaultTool, 'check_vault_status tool must exist in TOOLS')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text)
}

/** Minimal KikisAppManifest fixture required by EstimateCostResult. */
const FAKE_MANIFEST: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Fake Provider',
  description: 'Test fixture provider',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CFAKESACADDRESS',
  payee: 'GFAKEPAYEEADDRESS',
  pricing: {},
  endpoints: {},
  tags: [],
}

/** Build a valid EstimateCostResult for test fakes. */
function estimate(amount: string): EstimateCostResult {
  return { amount, asset: 'USDC', mode: 'x402', manifest: FAKE_MANIFEST }
}

/** Minimal fake KikisAppClient */
function makeClient(overrides: Partial<{
  estimateCost: HandlerDeps['client']['estimateCost']
  pay: HandlerDeps['client']['pay']
  openSession: HandlerDeps['client']['openSession']
  getSpendStore: HandlerDeps['client']['getSpendStore']
  getSpendCap: HandlerDeps['client']['getSpendCap']
  getVaultConfig: HandlerDeps['client']['getVaultConfig']
}> = {}): HandlerDeps['client'] {
  const defaultStore = new InMemorySpendStore({ warn: false })
  return {
    estimateCost: overrides.estimateCost ?? (async () => estimate('0.001')),
    pay: overrides.pay ?? (async () => ({
      mode: 'x402' as const,
      amount: '0.001',
      txHash: 'TXHASH',
      timestamp: Date.now(),
      data: {},
    })),
    openSession: overrides.openSession ?? (async () => ({
      channelId: 'CHAN1',
      openTxHash: 'OPEN_TX',
      stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      close: async () => ({ closeTxHash: 'CLOSE_TX', totalPaid: '0.01', vouchersIssued: 3 }),
    })),
    getSpendStore: overrides.getSpendStore ?? (() => defaultStore),
    getSpendCap: overrides.getSpendCap ?? (() => ({ daily: '1.00', asset: 'USDC' })),
    getVaultConfig: overrides.getVaultConfig ?? (() => undefined),
  } as unknown as HandlerDeps['client']
}

/** Minimal fake Supabase client */
function makeSupabase(rows: unknown[], error: { message: string } | null = null): HandlerDeps['supabase'] {
  const terminal = Promise.resolve({ data: rows as ProviderRow[], error })
  const builder: unknown = Object.assign(terminal, {
    eq: () => builder,
    overlaps: () => builder,
  })
  return {
    from: (_table: string) => ({
      select: (_cols: string) => builder as SupabaseQueryBuilder,
    }),
  }
}

/** Fake session that yields each item once, then reports done. */
function makeStreamSession(items: unknown[]) {
  let idx = 0
  return {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          idx < items.length
            ? { done: false, value: items[idx++] }
            : { done: true, value: undefined },
      }),
    }),
  }
}

function baseDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    client: makeClient(),
    openSessions: new Map(),
    supabase: null,
    stellarSecret: Keypair.random().secret(),
    stellarNetwork: 'testnet',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// pay_for_data
// ---------------------------------------------------------------------------

describe('handlePayForData', () => {
  it('returns success when estimate is within max_amount', async () => {
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      baseDeps(),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.tx_hash, 'TXHASH')
  })

  it('returns isError when estimate exceeds max_amount', async () => {
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => estimate('5.00'),
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('exceeds max_amount'))
  })

  it('returns isError when provider returns an undefined amount', async () => {
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => ({ ...estimate('0'), amount: undefined as unknown as string }),
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('undefined or invalid price'))
  })

  it('passes forceMode (not preferredMode) to estimateCost and pay', async () => {
    let capturedModeOptions: unknown
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async (_url: string, opts: unknown) => {
          capturedModeOptions = opts
          return estimate('0.001')
        },
      }),
    })
    await handlePayForData(
      { url: 'https://p.example.com/data', max_amount: '1.00', preferred_mode: 'mpp-charge' },
      deps,
    )
    assert.deepEqual(capturedModeOptions, { forceMode: 'mpp-charge' })
  })

  it('returns isError when url is not http or https', async () => {
    const invalidUrls = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/data', 'not-a-url']
    for (const url of invalidUrls) {
      const result = await handlePayForData(
        { url, max_amount: '1.00' },
        baseDeps(),
      )
      assert.equal(result.isError, true)
      const body = parseResult(result) as any
      assert.equal(body.success, false)
      assert.equal(body.error, 'Invalid URL: must be an http or https URL')
    }
  })

  it('returns isError when preferred_mode is a session mode', async () => {
    const sessionModes = ['mpp-session', 'mpp-session-ws'] as const
    for (const mode of sessionModes) {
      const result = await handlePayForData(
        { url: 'https://provider.example.com/data', max_amount: '1.00', preferred_mode: mode as any },
        baseDeps(),
      )
      assert.equal(result.isError, true)
      const body = parseResult(result) as any
      assert.equal(body.success, false)
      assert.equal(body.error, 'Provider requires mpp-session mode. Please call open_session with this URL instead.')
    }
  })

  it('returns isError when provider only supports session mode', async () => {
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => ({
          amount: '0.001',
          asset: 'USDC',
          mode: 'mpp-session',
          manifest: { ...FAKE_MANIFEST, modes: ['mpp-session'] },
        }),
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.success, false)
    assert.equal(body.error, 'Provider requires mpp-session mode. Please call open_session with this URL instead.')
  })

  it('catches client.pay openSession errors and returns informative error', async () => {
    const deps = baseDeps({
      client: makeClient({
        pay: async () => {
          throw new Error('Use client.openSession() for mpp-session mode — client.pay() only handles discrete payments.')
        },
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.success, false)
    assert.equal(body.error, 'Provider requires mpp-session mode. Please call open_session with this URL instead.')
  })
})

// ---------------------------------------------------------------------------
// open_session
// ---------------------------------------------------------------------------

describe('handleOpenSession', () => {
  it('returns isError when COMMITMENT_SECRET is missing', async () => {
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      baseDeps(),
      undefined,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('COMMITMENT_SECRET'))
  })

  it('opens a session and stores it in openSessions', async () => {
    const sessions = new Map()
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      baseDeps({ openSessions: sessions }),
      'secret123',
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.channel_id, 'CHAN1')
    assert.ok(sessions.has('CHAN1'))
  })

  it('returns isError when initial_deposit is below min_deposit', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session': { min_deposit: '10.0' } },
    }
    const fetchManifest = async (_url: string) => ({
      json: async () => fakeManifest,
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '1.0' },
      baseDeps({ fetchManifest }),
      'secret123',
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('min_deposit'))
  })

  it('passes when initial_deposit meets min_deposit', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session': { min_deposit: '1.0' } },
    }
    const fetchManifest = async (_url: string) => ({
      json: async () => fakeManifest,
    })
    const sessions = new Map()
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '5.0' },
      baseDeps({ openSessions: sessions, fetchManifest }),
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.ok(sessions.has('CHAN1'))
  })

  it('reads min_deposit from mpp-session-ws when mpp-session is absent', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session-ws': { min_deposit: '10.0' } },
    }
    const fetchManifest = async (_url: string) => ({
      json: async () => fakeManifest,
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '1.0' },
      baseDeps({ fetchManifest }),
      'secret123',
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('min_deposit'))
  })

  it('returns isError when url is not http or https', async () => {
    const invalidUrls = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com']
    for (const url of invalidUrls) {
      const result = await handleOpenSession(
        { url },
        baseDeps(),
        'secret123',
      )
      assert.equal(result.isError, true)
      const body = parseResult(result) as any
      assert.equal(body.success, false)
      assert.equal(body.error, 'Invalid URL: must be an http or https URL')
    }
  })

  it('forwards commitmentSecret to client.openSession options', async () => {
    let capturedOptions: unknown
    const deps = baseDeps({
      client: makeClient({
        openSession: async (_url: string, opts: unknown) => {
          capturedOptions = opts
          return {
            channelId: 'CHAN-SECRET',
            openTxHash: 'TX-SECRET',
            stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
            close: async () => ({ closeTxHash: 'CLOSE', totalPaid: '0', vouchersIssued: 0 }),
          } as any
        },
      }),
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'my-external-secret',
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(capturedOptions, { commitmentSecret: 'my-external-secret' })
  })

  it('KikisAppClient.openSession uses commitmentSecret from SessionOptions when client was initialized without one', async () => {
    const { KikisAppClient } = await import('@kikis-app/kikis-app')
    const client = new KikisAppClient({
      wallet: Keypair.random(),
      network: 'testnet',
    })
    let secretPassedToSession: string | undefined
    ;(client as any).session.openSession = async (
      _url: string,
      _manifest: unknown,
      secret: string,
    ) => {
      secretPassedToSession = secret
      return { channelId: 'CHAN1' } as any
    }

    const payeeKey = Keypair.random()
    const rawManifest = {
      ...FAKE_MANIFEST,
      payee: payeeKey.publicKey(),
      modes: ['mpp-session'] as const,
      endpoints: { stream: { path: '/stream', method: 'GET' } },
      pricing: {
        'mpp-session': {
          rate: '0.0001',
          per: 'voucher' as const,
          channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
          min_deposit: '0.10',
          refund_waiting_period_ledgers: 17280,
        },
      },
    }
    const signedManifest = signManifest(rawManifest as any, payeeKey.secret())
    const origFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(signedManifest), { status: 200 })
    try {
      await client.openSession('https://provider.example.com', {
        commitmentSecret: 'injected-secret-xyz',
      })
      assert.equal(secretPassedToSession, 'injected-secret-xyz')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('KikisAppClient.openSession throws when neither client config nor SessionOptions provide commitmentSecret', async () => {
    const { KikisAppClient } = await import('@kikis-app/kikis-app')
    const client = new KikisAppClient({
      wallet: Keypair.random(),
      network: 'testnet',
    })
    const payeeKey = Keypair.random()
    const rawManifest = {
      ...FAKE_MANIFEST,
      payee: payeeKey.publicKey(),
      modes: ['mpp-session'] as const,
      endpoints: { stream: { path: '/stream', method: 'GET' } },
      pricing: {
        'mpp-session': {
          rate: '0.0001',
          per: 'voucher' as const,
          channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
          min_deposit: '0.10',
          refund_waiting_period_ledgers: 17280,
        },
      },
    }
    const signedManifest = signManifest(rawManifest as any, payeeKey.secret())
    const origFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify(signedManifest), { status: 200 })
    try {
      await assert.rejects(
        async () => {
          await client.openSession('https://provider.example.com')
        },
        /commitmentSecret is required/,
      )
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// ---------------------------------------------------------------------------
// stream_session
// ---------------------------------------------------------------------------

describe('handleStreamSession', () => {
  it('returns isError for unknown channel_id', async () => {
    const result = await handleStreamSession(
      { channel_id: 'MISSING' },
      baseDeps(),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('No open session'))
  })

  it('pulls up to max_messages from the async iterator', async () => {
    const items = ['msg1', 'msg2', 'msg3']
    let idx = 0
    const fakeSession = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            idx < items.length
              ? { done: false, value: items[idx++] }
              : { done: true, value: undefined },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 2 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 2)
    assert.deepEqual(body.messages, ['msg1', 'msg2'])
  })

  it('stops early when stream is exhausted before max_messages', async () => {
    const items = ['only_one']
    let idx = 0
    const fakeSession = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            idx < items.length
              ? { done: false, value: items[idx++] }
              : { done: true, value: undefined },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 10 },
      baseDeps({ openSessions: sessions }),
    )
    const body = parseResult(result) as any
    assert.equal(body.count, 1)
  })

  it('pulls exactly 1 message when max_messages is omitted', async () => {
    const items = ['msg1', 'msg2', 'msg3']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1' },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 1)
    assert.deepEqual(body.messages, ['msg1'])
  })

  it('returns the paid prefix with stats when a later voucher fails', async () => {
    const stats = {
      vouchersIssued: 2,
      currentCumulative: '0.0002',
      channelId: 'CHAN1',
      openTxHash: null,
    }
    const items = ['msg1', 'msg2']
    let idx = 0
    const fakeSession = {
      stats: () => stats,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx >= items.length) {
              throw new Error('local_daily_cap_exceeded')
            }
            return { done: false, value: items[idx++] }
          },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 5 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.success, false)
    assert.ok(body.error.includes('local_daily_cap_exceeded'))
    assert.equal(body.channel_id, 'CHAN1')
    assert.equal(body.count, 2)
    assert.deepEqual(body.messages, ['msg1', 'msg2'])
    assert.deepEqual(body.stats, stats)
  })

  it('resolves with an empty partial batch when the first voucher fails', async () => {
    const stats = { vouchersIssued: 0, currentCumulative: '0', channelId: 'CHAN1', openTxHash: null }
    const fakeSession = {
      stats: () => stats,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('Voucher request failed: HTTP 500')
          },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 5 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.count, 0)
    assert.deepEqual(body.messages, [])
  })

  it('closes the generator with return() on the normal path', async () => {
    let returnCalls = 0
    const items = ['msg1', 'msg2', 'msg3']
    let idx = 0
    const iterator = {
      next: async () =>
        idx < items.length
          ? { done: false, value: items[idx++] }
          : { done: true, value: undefined },
      return: async () => {
        returnCalls++
        return { done: true, value: undefined }
      },
    }
    const fakeSession = { stream: () => ({ [Symbol.asyncIterator]: () => iterator }) }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 2 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(returnCalls, 1)
  })

  it('closes the generator with return() on the error path', async () => {
    let returnCalls = 0
    const iterator = {
      next: async () => {
        throw new Error('local_daily_cap_exceeded')
      },
      return: async () => {
        returnCalls++
        return { done: true, value: undefined }
      },
    }
    const fakeSession = {
      stats: () => ({ vouchersIssued: 0, currentCumulative: '0', channelId: 'CHAN1', openTxHash: null }),
      stream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 3 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(returnCalls, 1)
  })

  it('still works with a generator that has no return() method', async () => {
    const items = ['msg1']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 1 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
  })

  for (const invalid of [0, -1, 2.5, 51]) {
    it(`rejects invalid max_messages ${invalid} without calling stream()`, async () => {
      let streamCalls = 0
      const fakeSession = {
        stats: () => ({}),
        stream: () => {
          streamCalls++
          return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }
        },
      }
      const sessions = new Map<string, any>([['CHAN1', fakeSession]])
      const result = await handleStreamSession(
        { channel_id: 'CHAN1', max_messages: invalid },
        baseDeps({ openSessions: sessions }),
      )
      assert.equal(result.isError, true)
      const body = parseResult(result) as any
      assert.ok(body.error.includes('1 and 50'))
      assert.equal(streamCalls, 0)
    })
  }

  it('accepts max_messages at the upper bound of 50', async () => {
    const items = ['msg1', 'msg2']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 50 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 2)
  })
})

// ---------------------------------------------------------------------------
// close_session
// ---------------------------------------------------------------------------

describe('handleCloseSession', () => {
  it('returns isError for unknown channel_id', async () => {
    const result = await handleCloseSession({ channel_id: 'MISSING' }, baseDeps())
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('No open session'))
  })

  it('closes the session and removes it from openSessions', async () => {
    const fakeSession = {
      close: async () => ({
        closeTxHash: 'CLOSE_TX',
        totalPaid: '0.05',
        vouchersIssued: 5,
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleCloseSession(
      { channel_id: 'CHAN1' },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.close_tx_hash, 'CLOSE_TX')
    assert.equal(body.total_paid, '0.05')
    assert.equal(body.vouchers_issued, 5)
    // Must be evicted
    assert.equal(sessions.has('CHAN1'), false)
  })
})

// ---------------------------------------------------------------------------
// check_balance
// ---------------------------------------------------------------------------

describe('handleCheckBalance', () => {
  const secret = Keypair.random().secret()
  const keypair = Keypair.fromSecret(secret)

  const makeHorizon = (balances: HorizonBalance[]) => (_url: string) => ({
    loadAccount: async (_pk: string) => ({ balances }),
  })

  it('returns XLM native balance when no asset specified', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([{ asset_type: 'native', balance: '42.0000000' }]),
    })
    const result = await handleCheckBalance({}, deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.asset, 'XLM')
    assert.equal(body.balance, '42.0000000')
    assert.equal(body.account, keypair.publicKey())
  })

  it('returns 0 when native balance entry is absent', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([]),
    })
    const result = await handleCheckBalance({}, deps)
    const body = parseResult(result) as any
    assert.equal(body.balance, '0')
  })

  it('returns specific asset balance when asset_code provided', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'GA5...', balance: '100.00' },
      ]),
    })
    const result = await handleCheckBalance({ asset_code: 'USDC' }, deps)
    const body = parseResult(result) as any
    assert.equal(body.asset, 'USDC')
    assert.equal(body.balance, '100.00')
  })

  it('returns 0 when requested asset is not found', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([]),
    })
    const result = await handleCheckBalance({ asset_code: 'USDC' }, deps)
    const body = parseResult(result) as any
    assert.equal(body.balance, '0')
  })

  it('returns specific asset balance when both asset_code and asset_issuer are provided', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'ISSUER1', balance: '55.50' },
      ]),
    })
    const result = await handleCheckBalance(
      { asset_code: 'USDC', asset_issuer: 'ISSUER1' },
      deps,
    )
    const body = parseResult(result) as any
    assert.equal(body.balance, '55.50')
    assert.equal(body.issuer, 'ISSUER1')
  })
})

// ---------------------------------------------------------------------------
// list_providers
// ---------------------------------------------------------------------------

describe('handleListProviders', () => {
  it('returns isError when supabase is null', async () => {
    const result = await handleListProviders({}, baseDeps({ supabase: null }))
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('SUPABASE_URL'))
  })

  it('returns providers from supabase without filters', async () => {
    const rows = [
      { name: 'ProvA', description: 'desc', network: 'testnet', asset: 'USDC', modes: ['x402'], tags: ['price'], base_url: 'https://a.example.com' },
    ]
    const deps = baseDeps({ supabase: makeSupabase(rows) })
    const result = await handleListProviders({}, deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.count, 1)
    assert.equal(body.providers[0].name, 'ProvA')
  })

  it('returns isError when supabase reports an error', async () => {
    const deps = baseDeps({ supabase: makeSupabase([], { message: 'DB error' }) })
    const result = await handleListProviders({}, deps)
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('DB error'))
  })

  it('returns 0 providers when supabase returns empty array', async () => {
    const deps = baseDeps({ supabase: makeSupabase([]) })
    const result = await handleListProviders({}, deps)
    const body = parseResult(result) as any
    assert.equal(body.count, 0)
    assert.deepEqual(body.providers, [])
  })

  it('applies tag filter (overlaps)', async () => {
    const rows = [
      { name: 'ProvB', description: '', network: 'testnet', asset: 'USDC', modes: ['mpp-charge'], tags: ['dex'], base_url: 'https://b.example.com' },
    ]
    let calledOverlaps = false
    const supabase: HandlerDeps['supabase'] = {
      from: (_t: string) => ({
        select: (_c: string) => ({
          overlaps: (_f: string, _v: unknown) => {
            calledOverlaps = true
            return Promise.resolve({ data: rows, error: null })
          },
          eq: (_f: string, _v: unknown) => ({
            overlaps: (_f2: string, _v2: unknown) => {
              calledOverlaps = true
              return Promise.resolve({ data: rows, error: null })
            },
          }),
        }),
      }),
    }
    const deps = baseDeps({ supabase })
    const result = await handleListProviders({ tags: 'dex,price' }, deps)
    assert.ok(calledOverlaps, 'overlaps() should have been called for tag filtering')
    const body = parseResult(result) as any
    assert.equal(body.providers[0].name, 'ProvB')
  })
})

// ---------------------------------------------------------------------------
// check_spend_cap
// ---------------------------------------------------------------------------

describe('handleCheckSpendCap', () => {
  it('returns formatted daily_cap, spent_today, and remaining with InMemorySpendStore', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const today = new Date().toISOString().slice(0, 10)
    // 0.05 USDC = 500_000 microUSDC
    await store.write({
      date: today,
      totalMicros: '500000',
      endpoints: {},
      pendingReserves: [],
    })

    const deps = baseDeps({
      client: makeClient({
        getSpendCap: () => ({ daily: '1.00', asset: 'USDC' }),
        getSpendStore: () => store,
      }),
    })

    const result = await handleCheckSpendCap(deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.deepEqual(body, {
      daily_cap: '1.00',
      spent_today: '0.05',
      remaining: '0.95',
    })
  })

  it('works with FileSpendStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kikis-spend-test-'))
    const filePath = path.join(tmpDir, 'spend.json')
    try {
      const fileStore = new FileSpendStore(filePath)
      const today = new Date().toISOString().slice(0, 10)
      await fileStore.write({
        date: today,
        totalMicros: '500000',
        endpoints: {},
        pendingReserves: [],
      })

      const deps = baseDeps({
        client: makeClient({
          getSpendCap: () => ({ daily: '1.00', asset: 'USDC' }),
          getSpendStore: () => fileStore,
        }),
      })

      const result = await handleCheckSpendCap(deps)
      assert.equal(result.isError, undefined)
      const body = parseResult(result) as any
      assert.deepEqual(body, {
        daily_cap: '1.00',
        spent_today: '0.05',
        remaining: '0.95',
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns zero spent_today and full remaining when no spend recorded today', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const deps = baseDeps({
      client: makeClient({
        getSpendCap: () => ({ daily: '1.00', asset: 'USDC' }),
        getSpendStore: () => store,
      }),
    })

    const result = await handleCheckSpendCap(deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.deepEqual(body, {
      daily_cap: '1.00',
      spent_today: '0.00',
      remaining: '1.00',
    })
  })
})

// ---------------------------------------------------------------------------
// check_vault_status
// ---------------------------------------------------------------------------

describe('handleCheckVaultStatus', () => {
  it('returns configured: false when no vault is configured on client', async () => {
    const deps = baseDeps({
      client: makeClient({
        getVaultConfig: () => undefined,
      }),
    })
    const result = await handleCheckVaultStatus(deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.configured, false)
    assert.equal(body.message, 'No vault configured on client')
  })

  it('returns active allowlist, current ledger sequence, and expiry ledger when vault is configured', async () => {
    const fakeVault = {
      mode: 'nulth' as const,
      nulthAccount: 'CNULTHACCOUNT',
      witnessSecret: 'secret',
      allowedPayees: ['GPAYEE1', 'GPAYEE2'],
      dailyCapUsdc: '10.0',
      expiryLedger: 99999,
    }
    const deps = baseDeps({
      client: makeClient({
        getVaultConfig: () => fakeVault as any,
      }),
      fetchLedgerSequence: async () => 12345,
    })
    const result = await handleCheckVaultStatus(deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.configured, true)
    assert.equal(body.mode, 'nulth')
    assert.equal(body.vault_account, 'CNULTHACCOUNT')
    assert.deepEqual(body.allowed_payees, ['GPAYEE1', 'GPAYEE2'])
    assert.equal(body.current_ledger_sequence, 12345)
    assert.equal(body.expiry_ledger, 99999)
    assert.equal(body.daily_cap, '10.0')
  })
})

