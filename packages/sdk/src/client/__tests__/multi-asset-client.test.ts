import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { KikisAppClient } from '../KikisAppClient.js'
import { KikisAppTrustlineError, KikisAppManifestError, KikisAppPolicyRejectError } from '../../errors.js'
import { checkX402Accept, checkChargeChallenge } from '../challenge.js'
import { signManifest } from '../../manifest/sign.js'
import type { KikisAppManifest } from '../../types.js'
import { MppChargeClient } from '../MppChargeClient.js'
import { resolveAssetContract, selectAsset } from '../../internal/assetUtils.js'
import { stroopsToAmount } from '../../internal/usdc.js'

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function makeMultiAssetManifest(payeeKeypair: Keypair): KikisAppManifest {
  return signManifest(
    {
      'kikis-app': '1.0',
      name: 'Multi-Asset Client Test Service',
      description: 'Provider for client mode-to-asset testing',
      modes: ['x402', 'mpp-charge'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['x402'],
          endpoints: ['inference'],
        },
        {
          asset: 'EURC',
          asset_contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEURC',
          modes: ['x402'],
          endpoints: ['eurc-inference'],
        },
        {
          asset: 'XLM',
          asset_contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          modes: ['mpp-charge'],
          endpoints: ['lookup'],
        },
      ],
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
      endpoints: {
        inference: { method: 'POST', path: '/infer' },
        lookup: { method: 'GET', path: '/lookup' },
      },
      tags: ['test'],
    },
    payeeKeypair.secret(),
  )
}

describe('KikisAppClient — multi-asset eligibility & trustline preflight', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('preflight without mode falls back to root asset (USDC)', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          balance: '100.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const result = await client.preflight(manifest)
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'USDC')
  })

  it('preflight for mpp-charge checks and passes native XLM asset', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    // Account only has native XLM balance, NO USDC trustline
    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'native',
          balance: '50.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const result = await client.preflight(manifest, 'mpp-charge', '/lookup')
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'XLM')
  })

  it('preflight for x402 throws KikisAppTrustlineError when account lacks USDC trustline', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    // Account only has native XLM balance
    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'native',
          balance: '50.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await assert.rejects(
      () => client.preflight(manifest, 'x402', '/infer'),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppTrustlineError)
        assert.equal(err.asset, 'USDC')
        return true
      },
    )
  })

  it('throws KikisAppManifestError when no asset is eligible for the specified mode (no silent fallback to root asset)', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await assert.rejects(
      () => client.preflight(manifest, 'mpp-session'),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppManifestError)
        assert.match((err as Error).message, /No eligible assets found for mode 'mpp-session'/)
        return true
      },
    )
  })

  it('throws KikisAppManifestError when asset is restricted to a different endpoint', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    // x402 is scoped to 'inference' (/infer), not '/lookup'
    await assert.rejects(
      () => client.preflight(manifest, 'x402', '/lookup'),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppManifestError)
        assert.match((err as Error).message, /No eligible assets found for mode 'x402' for endpoint '\/lookup'/)
        return true
      },
    )
  })

  it('works normally with legacy single-asset manifest without assets array', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const legacyManifest = signManifest(
      {
        'kikis-app': '1.0',
        name: 'Legacy Single-Asset Test Service',
        description: 'Provider without assets array',
        modes: ['x402'],
        network: 'testnet',
        asset: 'USDC',
        asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        payee: payeeKeypair.publicKey(),
        pricing: {
          x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
        },
        endpoints: { test: { method: 'GET', path: '/test' } },
        tags: ['test'],
      },
      payeeKeypair.secret(),
    )

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          balance: '100.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const result = await client.preflight(legacyManifest, 'x402', '/test')
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'USDC')
  })
})

describe('Multi-asset challenge validation — checkX402Accept & checkChargeChallenge', () => {
  const payeeKeypair = Keypair.random()
  const manifest = makeMultiAssetManifest(payeeKeypair)
  const EURC_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEURC'
  const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
  const UNLISTED_CONTRACT = 'CUNKNOWNCONTRACT999999999999999999999999999999999999999'

  it('x402 challenges for non-root assets declared in manifest.assets pass validation successfully', () => {
    const accept = {
      scheme: 'exact',
      network: 'stellar:testnet',
      asset: EURC_CONTRACT,
      amount: '1000',
      payTo: payeeKeypair.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    }
    const rejection = checkX402Accept(accept, manifest, 'stellar:testnet', '0.001')
    assert.equal(rejection, null)
  })

  it('mpp-charge challenges for secondary assets pass validation', () => {
    const request = {
      amount: '800',
      currency: XLM_CONTRACT,
      recipient: payeeKeypair.publicKey(),
      methodDetails: { network: 'stellar:testnet' },
    }
    const rejection = checkChargeChallenge(request, manifest, 'stellar:testnet', '0.0008')
    assert.equal(rejection, null)
  })

  it('x402 and mpp-charge challenges referencing unlisted contracts are rejected with challenge_asset_mismatch', () => {
    const x402Accept = {
      scheme: 'exact',
      network: 'stellar:testnet',
      asset: UNLISTED_CONTRACT,
      amount: '1000',
      payTo: payeeKeypair.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    }
    const x402Rejection = checkX402Accept(x402Accept, manifest, 'stellar:testnet', '0.001')
    assert.ok(x402Rejection instanceof KikisAppPolicyRejectError)
    assert.equal(x402Rejection.reason, 'challenge_asset_mismatch')

    const chargeRequest = {
      amount: '800',
      currency: UNLISTED_CONTRACT,
      recipient: payeeKeypair.publicKey(),
      methodDetails: { network: 'stellar:testnet' },
    }
    const chargeRejection = checkChargeChallenge(chargeRequest, manifest, 'stellar:testnet', '0.0008')
    assert.ok(chargeRejection instanceof KikisAppPolicyRejectError)
    assert.equal(chargeRejection.reason, 'challenge_asset_mismatch')
  })
})

describe('MppChargeClient — multi-asset SAC and precision resolution', () => {
  const payeeKeypair = Keypair.random()
  const manifest = makeMultiAssetManifest(payeeKeypair)
  const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

  it('resolves the XLM SAC contract address when paying for an endpoint configured with XLM', () => {
    const resolvedContract = resolveAssetContract(manifest, 'mpp-charge', '/lookup')
    assert.equal(resolvedContract, XLM_CONTRACT)

    const asset = selectAsset(manifest, 'mpp-charge', '/lookup')
    assert.equal(asset.asset, 'XLM')
    assert.equal(asset.asset_contract, XLM_CONTRACT)
  })

  it('throws KikisAppManifestError when no asset is eligible for mpp-charge on that endpoint', async () => {
    const payerKeypair = Keypair.random()
    const chargeClient = new MppChargeClient(payerKeypair, 'testnet')
    await assert.rejects(
      () => chargeClient.pay('https://provider.test/infer', manifest),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppManifestError)
        assert.match((err as Error).message, /No eligible assets found for mode 'mpp-charge'/)
        return true
      },
    )
  })

  it('formats amount according to asset decimal precision scale', () => {
    // 7 decimals (standard SAC like XLM/USDC): 800 stroops -> "0.00008"
    assert.equal(stroopsToAmount(800n, 7), '0.00008')

    // 2 decimals (e.g., custom fiat token): 150 units -> "1.5"
    assert.equal(stroopsToAmount(150n, 2), '1.5')

    // 0 decimals (e.g., integer credit token): 100 units -> "100"
    assert.equal(stroopsToAmount(100n, 0), '100')

    // 6 decimals: 1000000 units -> "1"
    assert.equal(stroopsToAmount(1000000n, 6), '1')
  })

  it('executes pay for multi-asset XLM endpoint successfully when response is 200', async () => {
    const payerKeypair = Keypair.random()
    const chargeClient = new MppChargeClient(payerKeypair, 'testnet')
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ result: 'data' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })

      const res = await chargeClient.pay('https://provider.test/lookup', manifest)
      assert.equal(res.mode, 'mpp-charge')
      assert.deepEqual(res.data, { result: 'data' })
      assert.equal(res.amount, '0.0008')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
