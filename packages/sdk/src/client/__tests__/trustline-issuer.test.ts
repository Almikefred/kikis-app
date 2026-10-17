import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { Asset, Horizon, Keypair, Networks, StrKey } from '@stellar/stellar-sdk'
import { KikisAppClient } from '../KikisAppClient.js'
import { KikisAppTrustlineError, KikisAppNetworkError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { KikisAppManifest } from '../../types.js'

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const TESTNET_EURC_ISSUER = 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO'
const SPAM_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' // Mainnet issuer used on testnet

function makeUsdcManifest(payeeKeypair: Keypair): KikisAppManifest {
  return signManifest(
    {
      'kikis-app': '1.0',
      name: 'Test Service',
      description: 'Trustline test provider',
      modes: ['x402'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: ['test'],
    },
    payeeKeypair.secret(),
  )
}

function makeEurcManifest(payeeKeypair: Keypair): KikisAppManifest {
  return signManifest(
    {
      'kikis-app': '1.0',
      name: 'EURC Service',
      description: 'Trustline EURC test',
      modes: ['x402'],
      network: 'testnet',
      asset: 'EURC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: ['test'],
    },
    payeeKeypair.secret(),
  )
}

function makeCustomAssetManifest(payeeKeypair: Keypair): KikisAppManifest {
  return signManifest(
    {
      'kikis-app': '1.0',
      name: 'Custom Asset Service',
      description: 'Trustline custom asset test',
      modes: ['x402'],
      network: 'testnet',
      asset: 'CUSTOM',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: ['test'],
    },
    payeeKeypair.secret(),
  )
}

describe('KikisAppClient — Trustline issuer enforcement', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('validates testnet USDC issuer and Soroban contract ID derivation', () => {
    assert.equal(StrKey.isValidEd25519PublicKey(TESTNET_USDC_ISSUER), true)
    const asset = new Asset('USDC', TESTNET_USDC_ISSUER)
    const contractId = asset.contractId(Networks.TESTNET)
    assert.equal(contractId, 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA')
  })

  it('passes and caches when USDC is from the expected issuer', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeUsdcManifest(payeeKeypair)

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

    const cacheKey = `testnet:${payerKeypair.publicKey()}:USDC`
    const cache = (KikisAppClient as unknown as { _trustlineCache: Map<string, { exists: boolean }> })._trustlineCache
    assert.equal(cache.has(cacheKey), false)

    const result = await client.preflight(manifest)
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'USDC')

    // Cached after passing
    assert.equal(cache.has(cacheKey), true)
  })

  it('throws KikisAppTrustlineError and does not cache when USDC is from a different issuer', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeUsdcManifest(payeeKeypair)

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: SPAM_ISSUER,
          balance: '100.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const cacheKey = `testnet:${payerKeypair.publicKey()}:USDC`
    const cache = (KikisAppClient as unknown as { _trustlineCache: Map<string, { exists: boolean }> })._trustlineCache

    await assert.rejects(
      async () => client.preflight(manifest),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppTrustlineError)
        assert.equal(err.asset, 'USDC')
        assert.equal(err.issuer, TESTNET_USDC_ISSUER)
        assert.match(err.remediation, new RegExp(`change-trust --asset USDC:${TESTNET_USDC_ISSUER}`))
        return true
      },
    )

    // Failed check must NOT be cached
    assert.equal(cache.has(cacheKey), false)
  })

  it('rejects EURC from a spoofed issuer with KikisAppTrustlineError', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeEurcManifest(payeeKeypair)

    const randomIssuer = Keypair.random().publicKey()

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: randomIssuer,
          balance: '50.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await assert.rejects(
      async () => client.preflight(manifest),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppTrustlineError)
        assert.equal(err.asset, 'EURC')
        assert.equal(err.issuer, TESTNET_EURC_ISSUER)
        assert.match(err.remediation, new RegExp(`change-trust --asset EURC:${TESTNET_EURC_ISSUER}`))
        return true
      },
    )
  })

  it('rejects unknown asset with no registered issuer', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeCustomAssetManifest(payeeKeypair)

    const randomIssuer = Keypair.random().publicKey()

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum12',
          asset_code: 'CUSTOM',
          asset_issuer: randomIssuer,
          balance: '50.0000000',
        },
      ],
    }))

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await assert.rejects(
      async () => client.preflight(manifest),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppTrustlineError)
        assert.equal(err.asset, 'CUSTOM')
        assert.equal(err.issuer, 'unknown')
        assert.match(err.remediation, /No trusted issuer registered/)
        return true
      },
    )
  })

  it('directs trustline Horizon queries to custom horizonRpcUrl and caches with custom endpoint key', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeUsdcManifest(payeeKeypair)
    const customUrl = 'https://custom-horizon.internal.net'

    let capturedServerUrl: string | undefined
    mock.method(Horizon.Server.prototype, 'loadAccount', async function (this: Horizon.Server) {
      capturedServerUrl = this.serverURL.toString().replace(/\/$/, '')
      return {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: TESTNET_USDC_ISSUER,
            balance: '100.0000000',
          },
        ],
      }
    })

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
      horizonRpcUrl: customUrl,
    })

    const cacheKey = `testnet:${customUrl}:${payerKeypair.publicKey()}:USDC`
    const cache = (KikisAppClient as unknown as { _trustlineCache: Map<string, { exists: boolean }> })._trustlineCache
    assert.equal(cache.has(cacheKey), false)

    const result = await client.preflight(manifest)
    assert.equal(result.hasTrustline, true)
    assert.equal(capturedServerUrl, customUrl)
    assert.equal(cache.has(cacheKey), true)
  })

  it('triggers a retryable KikisAppNetworkError when Horizon query exceeds rpcTimeoutMs', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeUsdcManifest(payeeKeypair)
    const customUrl = 'https://slow-horizon.internal.net'

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
      // Simulate slow Horizon response
      await new Promise((resolve) => setTimeout(resolve, 200))
      return {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: TESTNET_USDC_ISSUER,
            balance: '100.0000000',
          },
        ],
      }
    })

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
      horizonRpcUrl: customUrl,
      rpcTimeoutMs: 50,
    })

    await assert.rejects(
      async () => client.preflight(manifest),
      (err: unknown) => {
        assert.ok(err instanceof KikisAppNetworkError)
        assert.equal(err.retryable, true)
        assert.match(err.message, /timed out after 50ms/)
        return true
      },
    )
  })

  it('falls back to default public Horizon endpoints when horizonRpcUrl is unconfigured', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeUsdcManifest(payeeKeypair)

    let capturedServerUrl: string | undefined
    mock.method(Horizon.Server.prototype, 'loadAccount', async function (this: Horizon.Server) {
      capturedServerUrl = this.serverURL.toString().replace(/\/$/, '')
      return {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: TESTNET_USDC_ISSUER,
            balance: '100.0000000',
          },
        ],
      }
    })

    const client = new KikisAppClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await client.preflight(manifest)
    assert.equal(capturedServerUrl, 'https://horizon-testnet.stellar.org')
  })
})
