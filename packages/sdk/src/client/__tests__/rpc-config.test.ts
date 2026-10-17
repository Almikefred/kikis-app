/**
 * Issue #5: custom Soroban RPC URL and timeout configuration.
 *
 * Verifies that a developer-supplied `rpcUrl` is forwarded through
 * `MppChargeClient` to `stellar.charge` (which builds the Soroban RPC server
 * used for charge simulation / submission), and that omitting it retains the
 * public-default behaviour.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { KikisAppManifest } from '../../types.js'

let lastChargeOptions: Record<string, unknown> | undefined

const fakeMppx = {
  fetch: async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  rawFetch: async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => fakeMppx,
    },
  },
})

mock.module('@stellar/mpp/charge/client', {
  namedExports: {
    stellar: {
      charge: (opts: Record<string, unknown>) => {
        lastChargeOptions = opts
        return { name: 'stellar/charge', intent: 'charge', onProgress: opts['onProgress'] }
      },
    },
  },
})

const { MppChargeClient } = await import('../MppChargeClient.js')

const PAYEE = Keypair.random()

const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'RPC Config Test',
  description: 'Verify custom RPC URL is forwarded to stellar.charge',
  modes: ['mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE.publicKey(),
  pricing: { 'mpp-charge': { amount: '0.001', per: 'request' } },
  endpoints: {},
  tags: ['test'],
}

describe('MppChargeClient — RPC config (#5)', () => {
  it('forwards a custom rpcUrl to stellar.charge', async () => {
    lastChargeOptions = undefined
    const client = new MppChargeClient(Keypair.random(), 'testnet', undefined, {
      rpcUrl: 'https://custom-soroban-rpc.myorg.internal',
    })
    await client.pay('https://provider.test/price', manifest)
    assert.equal(lastChargeOptions?.rpcUrl, 'https://custom-soroban-rpc.myorg.internal')
  })

  it('omits rpcUrl when not configured (public default retained)', async () => {
    lastChargeOptions = undefined
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await client.pay('https://provider.test/price', manifest)
    assert.equal(lastChargeOptions?.rpcUrl, undefined)
  })
})