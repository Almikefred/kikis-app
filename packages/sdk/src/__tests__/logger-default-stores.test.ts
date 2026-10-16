/**
 * Issue #286: a supplied logger has to reach the default stores the adapters
 * construct for themselves. The in-memory SeenTxStore emits its non-durability
 * warning on Cloudflare Workers — exactly where a structured sink matters — and
 * the default SpendStore warns on every construction.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { kikisAppHono } from '../provider/hono.js'
import { kikisApp } from '../provider/kikisAppMiddleware.js'
import { KikisAppClient } from '../client/KikisAppClient.js'
import type { KikisAppLogLevel, KikisAppLogger } from '../internal/logger.js'
import type { KikisAppManifest } from '../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SEEN_TX_WARNING = 'in-memory SeenTxStore'
const SPEND_WARNING = 'in-memory SpendStore'

const lines: Array<{ level: KikisAppLogLevel; message: string }> = []
const logger: KikisAppLogger = (level, message) => {
  lines.push({ level, message: String(message) })
}

function warnedWith(needle: string): boolean {
  return lines.some((l) => l.level === 'warn' && l.message.includes(needle))
}

const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Logger Threading Test',
  description: 'Unit test provider',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.001', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
  logger,
}

/**
 * The SeenTxStore warning is Workers-only, so run `fn` with a Workers user
 * agent and restore the real one afterwards.
 */
function onWorkers<T>(fn: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  if (!saved) throw new Error('navigator is required — the SeenTxStore warning gates on it')
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Cloudflare-Workers' },
    configurable: true,
    writable: true,
  })
  try {
    return fn()
  } finally {
    Object.defineProperty(globalThis, 'navigator', saved)
  }
}

beforeEach(() => {
  lines.length = 0
})

describe('supplied logger reaches the default stores (#286)', () => {
  it('reaches the Hono x402 SeenTxStore', () => {
    onWorkers(() => {
      kikisAppHono({ ...BASE_OPTS, modes: ['x402'], pricing: { x402: '0.001' } })
    })
    assert.ok(warnedWith(SEEN_TX_WARNING), 'Hono x402 warned through console, not the logger')
  })

  it('reaches the Hono mpp-charge SeenTxStore', () => {
    onWorkers(() => {
      kikisAppHono({ ...BASE_OPTS, modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.001' } })
    })
    assert.ok(warnedWith(SEEN_TX_WARNING), 'Hono mpp-charge warned through console, not the logger')
  })

  it('reaches the Express x402 SeenTxStore', () => {
    onWorkers(() => {
      kikisApp({ ...BASE_OPTS, modes: ['x402'], pricing: { x402: '0.001' } })
    })
    assert.ok(warnedWith(SEEN_TX_WARNING), 'Express x402 warned through console, not the logger')
  })

  it('reaches the Express mpp-charge SeenTxStore', () => {
    onWorkers(() => {
      kikisApp({ ...BASE_OPTS, modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.001' } })
    })
    assert.ok(warnedWith(SEEN_TX_WARNING), 'Express mpp-charge warned through console, not the logger')
  })

  it('reaches the client default SpendStore', () => {
    new KikisAppClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { asset: 'USDC', daily: '1.00' },
      logger,
    })
    assert.ok(warnedWith(SPEND_WARNING), 'the client spend store warned through console, not the logger')
  })
})
