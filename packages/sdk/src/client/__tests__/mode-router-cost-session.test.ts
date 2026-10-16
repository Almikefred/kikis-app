/**
 * Issue #6: cost optimization should evaluate session modes (`mpp-session`
 * rate) and endpoint-specific price overrides.
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectMode } from '../ModeRouter.js'
import { KikisAppPolicyRejectError } from '../../errors.js'
import type { KikisAppManifest } from '../../types.js'

function sessionPricing(): KikisAppManifest['pricing']['mpp-session'] {
  return {
    rate: '0.0001',
    per: 'voucher',
    channel_factory: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZTCF',
    min_deposit: '0.10',
    refund_waiting_period_ledgers: 17280,
  }
}

function makeManifest(
  pricing: KikisAppManifest['pricing'],
  modes: KikisAppManifest['modes'] = ['x402', 'mpp-charge', 'mpp-session'],
  endpoints: KikisAppManifest['endpoints'] = {},
): KikisAppManifest {
  return {
    'kikis-app': '1.0',
    name: 'Cost Session Test',
    description: 'Cost optimization with session modes and endpoint rates',
    modes,
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    pricing,
    endpoints,
    tags: ['test'],
  }
}

describe('selectMode — cost optimization with session modes and endpoint rates (#6)', () => {
  it('selects mpp-session when its rate is cheapest and sustained', () => {
    const manifest = makeManifest({
      x402: { amount: '0.01', per: 'request' },
      'mpp-charge': { amount: '0.001', per: 'request' },
      'mpp-session': sessionPricing(),
    })
    assert.equal(selectMode(manifest, { optimize: 'cost', sustained: true }), 'mpp-session')
  })

  it('does not consider mpp-session without sustained', () => {
    const manifest = makeManifest({
      x402: { amount: '0.01', per: 'request' },
      'mpp-charge': { amount: '0.001', per: 'request' },
      'mpp-session': sessionPricing(),
    })
    assert.equal(selectMode(manifest, { optimize: 'cost' }), 'mpp-charge')
  })

  it('uses an endpoint price override to pick a cheaper mpp-charge', () => {
    const manifest = makeManifest(
      {
        x402: { amount: '0.00005', per: 'request' },
        'mpp-charge': { amount: '0.001', per: 'request' },
      },
      ['x402', 'mpp-charge'],
      {
        cheap: {
          method: 'GET',
          path: '/cheap',
          pricing: { 'mpp-charge': { amount: '0.00001', per: 'request' } },
        },
      },
    )
    // Without the endpoint override x402 (0.00005) is cheapest...
    assert.equal(selectMode(manifest, { optimize: 'cost' }), 'x402')
    // ...but the endpoint override makes mpp-charge (0.00001) cheapest.
    assert.equal(selectMode(manifest, { optimize: 'cost', endpoint: 'cheap' }), 'mpp-charge')
  })

  it('throws budget_per_request_exceeded when the ceiling is below every price', () => {
    const manifest = makeManifest({
      x402: { amount: '0.01', per: 'request' },
      'mpp-charge': { amount: '0.001', per: 'request' },
    })
    assert.throws(
      () => selectMode(manifest, { optimize: 'cost', budget_per_request: '0.0005' }),
      (error: unknown) => {
        assert.ok(error instanceof KikisAppPolicyRejectError)
        assert.equal((error as KikisAppPolicyRejectError).reason, 'budget_per_request_exceeded')
        return true
      },
    )
  })
})