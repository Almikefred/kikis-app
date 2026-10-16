/**
 * Tests for Manifest metadata validation and consumption:
 *   - latency_hints subset constraint against regions
 *   - surfacing regions, latency_hints, capabilities on preflight and estimateCost
 *   - rankProvidersByLatency ranking helper
 *
 * Run with: pnpm --filter @kikis-app/kikis-app test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { KikisAppClient } from '../KikisAppClient.js'
import { assertManifestValid, rankProvidersByLatency } from '../ModeRouter.js'
import { KikisAppManifestError } from '../../errors.js'
import type { KikisAppManifest } from '../../types.js'
import { signManifest } from '../../manifest/sign.js'

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

const PAYEE_KEYPAIR = Keypair.random()

const VALID_MANIFEST_BASE: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Metadata Test Provider',
  description: 'Provider for testing regions, latency_hints, capabilities',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE_KEYPAIR.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['price', 'stellar'],
  regions: ['IAD', 'AMS', 'FRA'],
  latency_hints: { IAD: 14, AMS: 22 },
  capabilities: {
    streaming: ['sse', 'websocket'],
    webhooks: true,
    idempotency_keys: true,
    content_types: ['application/json'],
  },
}

// ── Test 1: assertManifestValid enforces latency_hints subset of regions ──────

{
  // Valid subset
  assert.doesNotThrow(() => {
    assertManifestValid(VALID_MANIFEST_BASE)
  })

  // Invalid: latency hint for region not in regions
  const invalidManifest: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    regions: ['IAD', 'AMS'],
    latency_hints: { IAD: 14, SIN: 99 },
  }

  assert.throws(
    () => {
      assertManifestValid(invalidManifest)
    },
    (err: unknown) => {
      return err instanceof KikisAppManifestError && String(err).includes("latency_hints key 'SIN' is not declared in regions")
    },
    'Should throw KikisAppManifestError when latency_hints contains unlisted region',
  )

  // Invalid: latency hints defined but regions missing
  const { regions: _omittedRegions, ...restWithoutRegions } = VALID_MANIFEST_BASE
  const noRegionsManifest: KikisAppManifest = {
    ...restWithoutRegions,
    latency_hints: { IAD: 14 },
  }

  assert.throws(
    () => {
      assertManifestValid(noRegionsManifest)
    },
    (err: unknown) => {
      return err instanceof KikisAppManifestError && String(err).includes('latency_hints defined without declaring regions')
    },
    'Should throw KikisAppManifestError when latency_hints defined without regions',
  )

  console.log('✓ Test 1: assertManifestValid correctly validates latency_hints subset constraint')
}

// ── Test 2: rankProvidersByLatency orders providers accurately ────────────────

{
  const providerA: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    name: 'Provider A (IAD: 25ms)',
    regions: ['IAD', 'AMS'],
    latency_hints: { IAD: 25, AMS: 30 },
  }

  const providerB: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    name: 'Provider B (IAD: 12ms)',
    regions: ['IAD'],
    latency_hints: { IAD: 12 },
  }

  const providerC: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    name: 'Provider C (IAD declared without hint)',
    regions: ['IAD', 'FRA'],
    latency_hints: { FRA: 10 },
  }

  const providerD: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    name: 'Provider D (other region)',
    regions: ['SIN'],
    latency_hints: { SIN: 5 },
  }

  const ranked = rankProvidersByLatency([providerA, providerC, providerD, providerB], 'IAD')

  assert.equal(ranked[0]?.name, 'Provider B (IAD: 12ms)')
  assert.equal(ranked[1]?.name, 'Provider A (IAD: 25ms)')
  assert.equal(ranked[2]?.name, 'Provider C (IAD declared without hint)')
  assert.equal(ranked[3]?.name, 'Provider D (other region)')

  console.log('✓ Test 2: rankProvidersByLatency accurately ranks manifests by region latency')
}

// ── Test 3: estimateCost surfaces regions, latency_hints, and capabilities ────

{
  const signedManifest = signManifest(VALID_MANIFEST_BASE, PAYEE_KEYPAIR.secret())

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/kikis-app.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(signedManifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  try {
    const client = new KikisAppClient({ wallet: Keypair.random(), network: 'testnet' })
    const estimate = await client.estimateCost(`${server.url}/price`)

    assert.deepEqual(estimate.regions, ['IAD', 'AMS', 'FRA'])
    assert.deepEqual(estimate.latency_hints, { IAD: 14, AMS: 22 })
    assert.equal(estimate.capabilities?.webhooks, true)
    assert.equal(estimate.capabilities?.idempotency_keys, true)
    assert.deepEqual(estimate.capabilities?.streaming, ['sse', 'websocket'])
    assert.deepEqual(estimate.capabilities?.content_types, ['application/json'])

    console.log('✓ Test 3: estimateCost surfaces regions, latency_hints, and capabilities')
  } finally {
    await server.close()
  }
}

// ── Test 4: preflight surfaces metadata and validates subset constraints ──────

{
  const client = new KikisAppClient({ wallet: Keypair.random(), network: 'testnet' })
  // Stub trustline check for offline test
  ;(client as any)._checkTrustline = async () => {}

  const preflightRes = await client.preflight(VALID_MANIFEST_BASE)

  assert.equal(preflightRes.hasTrustline, true)
  assert.equal(preflightRes.asset, 'USDC')
  assert.deepEqual(preflightRes.modes, ['x402', 'mpp-charge'])
  assert.deepEqual(preflightRes.regions, ['IAD', 'AMS', 'FRA'])
  assert.deepEqual(preflightRes.latency_hints, { IAD: 14, AMS: 22 })
  assert.equal(preflightRes.capabilities?.webhooks, true)

  // Preflight with invalid latency hint must throw
  const invalidManifest: KikisAppManifest = {
    ...VALID_MANIFEST_BASE,
    regions: ['IAD'],
    latency_hints: { AMS: 15 },
  }

  await assert.rejects(
    async () => {
      await client.preflight(invalidManifest)
    },
    (err: unknown) => {
      return err instanceof KikisAppManifestError
    },
  )

  console.log('✓ Test 4: preflight surfaces metadata and rejects invalid latency_hints')
}

console.log('\nAll manifest metadata tests passed.')
