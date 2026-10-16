import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { registerProvider } from '../registerProvider.js'
import { signManifest } from '../../manifest/sign.js'
import type { KikisAppManifest } from '../../types.js'
import { KikisAppSignatureError } from '../../errors.js'

describe('registerProvider', () => {
  const keypair = Keypair.random()
  const payee = keypair.publicKey()
  const secret = keypair.secret()

  const rawManifest: KikisAppManifest = {
    'kikis-app': '1.0',
    name: 'Test DEX Provider',
    description: 'Test provider description',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee,
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['price', 'dex', 'stellar'],
    categories: ['data/price'],
  }

  it('rejects an unsigned manifest with KikisAppSignatureError', async () => {
    const mockSupabase = {} as SupabaseClient
    await assert.rejects(
      () => registerProvider({ supabase: mockSupabase, manifest: rawManifest, baseUrl: 'https://api.test' }),
      KikisAppSignatureError,
    )
  })

  it('rejects a manifest with an invalid signature', async () => {
    const mockSupabase = {} as SupabaseClient
    const tampered = {
      ...rawManifest,
      signature_version: '2' as const,
      signature: Buffer.from('invalid-signature-bytes-not-real').toString('base64'),
    }

    await assert.rejects(
      () => registerProvider({ supabase: mockSupabase, manifest: tampered, baseUrl: 'https://api.test' }),
      KikisAppSignatureError,
    )
  })

  it('upserts a valid signed manifest into Supabase', async () => {
    const signed = signManifest(rawManifest, secret)
    let upsertPayload: Record<string, unknown> | null = null
    let upsertOptions: Record<string, unknown> | null = null

    const mockSupabase = {
      from(table: string) {
        assert.equal(table, 'providers')
        return {
          upsert: async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
            upsertPayload = payload
            upsertOptions = options
            return { error: null }
          },
        }
      },
    } as unknown as SupabaseClient

    await registerProvider({
      supabase: mockSupabase,
      manifest: signed,
      baseUrl: 'https://api.test/',
    })

    assert.ok(upsertPayload)
    assert.equal((upsertPayload as Record<string, unknown>)['name'], 'Test DEX Provider')
    assert.equal((upsertPayload as Record<string, unknown>)['base_url'], 'https://api.test')
    assert.equal((upsertPayload as Record<string, unknown>)['payee'], payee)
    assert.deepEqual((upsertPayload as Record<string, unknown>)['tags'], ['price', 'dex', 'stellar'])
    assert.equal((upsertPayload as Record<string, unknown>)['verified'], true)
    assert.deepEqual(upsertOptions, { onConflict: 'base_url' })
  })

  it('supports positional arguments overload', async () => {
    const signed = signManifest(rawManifest, secret)
    let called = false

    const mockSupabase = {
      from(table: string) {
        assert.equal(table, 'providers')
        return {
          upsert: async () => {
            called = true
            return { error: null }
          },
        }
      },
    } as unknown as SupabaseClient

    await registerProvider(mockSupabase, signed, 'https://api.test')
    assert.equal(called, true)
  })
})
