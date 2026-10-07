import type { SupabaseClient } from '@supabase/supabase-js'
import type { KikisAppManifest } from '../types.js'
import { verifyManifestSignature } from '../manifest/sign.js'
import { KikisAppManifestError } from '../errors.js'

export interface RegisterProviderOptions {
  supabase: SupabaseClient
  manifest: KikisAppManifest & { signature?: string; signature_version?: string }
  baseUrl: string
  /**
   * Whether to flag the provider record as verified in Supabase.
   * Defaults to true (since signature is verified before writing).
   */
  verified?: boolean
}

/**
 * Register a provider in the Supabase `providers` table.
 *
 * Verifies the manifest's Ed25519 signature before upserting into the
 * database keyed on `base_url`.
 *
 * Throws `KikisAppSignatureError` if the manifest is unsigned or invalid,
 * and `Error` if the database upsert fails.
 */
export async function registerProvider(
  optionsOrSupabase: RegisterProviderOptions | SupabaseClient,
  manifestArg?: KikisAppManifest & { signature?: string },
  baseUrlArg?: string,
  verifiedArg?: boolean,
): Promise<void> {
  let supabase: SupabaseClient
  let manifest: KikisAppManifest & { signature?: string }
  let baseUrl: string
  let verified: boolean

  if ('supabase' in optionsOrSupabase) {
    supabase = optionsOrSupabase.supabase
    manifest = optionsOrSupabase.manifest
    baseUrl = optionsOrSupabase.baseUrl
    verified = optionsOrSupabase.verified ?? true
  } else {
    supabase = optionsOrSupabase
    if (!manifestArg || !baseUrlArg) {
      throw new KikisAppManifestError('manifest and baseUrl are required for registerProvider')
    }
    manifest = manifestArg
    baseUrl = baseUrlArg
    verified = verifiedArg ?? true
  }

  // Mandatory signature check before registering into Supabase
  verifyManifestSignature(manifest)

  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')

  const { error } = await supabase.from('providers').upsert(
    {
      name: manifest.name,
      description: manifest.description ?? null,
      base_url: normalizedBaseUrl,
      modes: manifest.modes,
      tags: manifest.tags ?? [],
      categories: manifest.categories ?? [],
      network: manifest.network,
      payee: manifest.payee,
      manifest: manifest as unknown as Record<string, unknown>,
      verified,
      registered_at: new Date().toISOString(),
    },
    { onConflict: 'base_url' },
  )

  if (error) {
    throw new Error(`Failed to register provider in Supabase: ${error.message}`)
  }
}
