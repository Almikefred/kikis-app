/**
 * Issue #9: MppChargeClient should accept a custom `ClientStellarSigner`
 * (e.g. a Nulth ZK account signer) in addition to a raw Stellar `Keypair`.
 *
 * Verifies:
 *   - a custom signer initializes without throwing (backwards-compatible
 *     Keypair instantiation still works),
 *   - the signer is wired into `stellar.charge` as the charge keypair,
 *   - standard `Keypair` instantiation remains fully backwards compatible.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import type { KikisAppManifest } from '../../types.js'

let lastChargeOptions: Record<string, unknown> | undefined

const fakeMppx = {
  fetch: async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  rawFetch: async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
}

const mockSigner: ClientStellarSigner = {
  address: 'CABXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXSH6W',
  signAuthEntry: async () => ({
    signedAuthEntry: 'mock-signed-auth-entry',
    signerAddress: 'CABXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXSH6W',
  }),
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
  name: 'Signer Test',
  description: 'MppChargeClient custom signer integration',
  modes: ['mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE.publicKey(),
  pricing: { 'mpp-charge': { amount: '0.001', per: 'request' } },
  endpoints: {},
  tags: ['test'],
}

describe('MppChargeClient — custom signers (#9)', () => {
  it('initializes with a custom ClientStellarSigner', () => {
    const client = new MppChargeClient(mockSigner, 'testnet')
    assert.ok(client)
  })

  it('wires the custom signer into stellar.charge as the charge keypair', async () => {
    lastChargeOptions = undefined
    const client = new MppChargeClient(mockSigner, 'testnet')
    await client.pay('https://provider.test/price', manifest)
    assert.equal(lastChargeOptions?.keypair, mockSigner)
  })

  it('keeps standard Keypair instantiation fully backwards compatible', async () => {
    lastChargeOptions = undefined
    const keypair = Keypair.random()
    const client = new MppChargeClient(keypair, 'testnet')
    await client.pay('https://provider.test/price', manifest)
    assert.equal(lastChargeOptions?.keypair, keypair)
  })
})