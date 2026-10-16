import type { PaymentRequirements } from '@x402/core/types'
import type { KikisAppManifest } from '../types.js'
import { KikisAppPolicyRejectError } from '../errors.js'
import { usdcToStroops } from '../internal/usdc.js'
import { resolvePayee } from '../internal/payee.js'
import { isAssetEligible } from '../internal/assetUtils.js'

/**
 * Pure, RPC-free validators that bind a payment challenge (the unsigned 402
 * body) to the signed manifest before any credential is created.
 *
 * The manifest is signed by the provider's payee, but the 402 that describes
 * *what* to sign is not. A dishonest or compromised provider can serve a
 * correctly signed manifest priced at 0.0001 USDC and then demand 1000 USDC,
 * payable to any address, in any SAC token the agent holds. These validators
 * are the client-side guard: every field that ends up in the signed transfer
 * (network, payee, asset, amount) is compared against the manifest.
 */

export type Caip2Network = 'stellar:testnet' | 'stellar:pubnet'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A positive integer base-unit string (stroops), no leading zeros. */
function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

/**
 * Validate a base-unit amount against the manifest price.
 * Returns a rejection when the value is malformed or exceeds the manifest.
 */
function checkAmount(
  amount: unknown,
  maxAmount: string,
): KikisAppPolicyRejectError | null {
  if (!isPositiveIntegerString(amount)) {
    return new KikisAppPolicyRejectError('challenge_amount_invalid')
  }
  let max: bigint
  try {
    max = usdcToStroops(maxAmount)
  } catch {
    return new KikisAppPolicyRejectError('challenge_amount_invalid')
  }
  if (BigInt(amount) > max) {
    return new KikisAppPolicyRejectError('challenge_amount_exceeds_manifest')
  }
  return null
}

/**
 * Validate one x402 `accepts` entry against the manifest. Returns the rejection
 * to throw, or `null` when the entry is safe to sign.
 *
 * `maxAmount` is the price the caller already read from the manifest, in USDC
 * decimal string form. Passing it in keeps this module free of `pricing`
 * lookups that would need a non-null assertion.
 */
export function checkX402Accept(
  accept: PaymentRequirements,
  manifest: KikisAppManifest,
  network: Caip2Network,
  maxAmount: string,
  endpoint?: string,
): KikisAppPolicyRejectError | null {
  if (accept.network !== network) {
    return new KikisAppPolicyRejectError('challenge_network_mismatch')
  }
  if (accept.payTo !== resolvePayee(manifest, 'x402')) {
    return new KikisAppPolicyRejectError('challenge_payee_mismatch')
  }
  let eligible = false
  try {
    eligible = isAssetEligible(manifest, accept.asset, 'x402', endpoint)
  } catch {
    eligible = false
  }
  if (!eligible) {
    return new KikisAppPolicyRejectError('challenge_asset_mismatch')
  }
  return checkAmount(accept.amount, maxAmount)
}

/**
 * Keep only the x402 accepts entries that pass {@link checkX402Accept}. The
 * caller throws the rejection for `accepts[0]` when this returns empty.
 */
export function filterX402Accepts(
  accepts: readonly PaymentRequirements[],
  manifest: KikisAppManifest,
  network: Caip2Network,
  maxAmount: string,
  endpoint?: string,
): PaymentRequirements[] {
  return accepts.filter((accept) => checkX402Accept(accept, manifest, network, maxAmount, endpoint) === null)
}

/**
 * Validate an mpp-charge challenge request against the manifest.
 *
 * `@stellar/mpp` treats a missing `methodDetails.network` as `stellar:testnet`,
 * so this mirrors that default rather than rejecting an absent network.
 * Returns the rejection to throw, or `null` when the challenge is safe to sign.
 */
export function checkChargeChallenge(
  request: Record<string, unknown>,
  manifest: KikisAppManifest,
  network: Caip2Network,
  maxAmount: string,
  endpoint?: string,
): KikisAppPolicyRejectError | null {
  const methodDetails = request['methodDetails']
  const rawNetwork = isRecord(methodDetails) ? methodDetails['network'] : undefined
  const challengeNetwork = rawNetwork === undefined ? 'stellar:testnet' : rawNetwork
  if (challengeNetwork !== network) {
    return new KikisAppPolicyRejectError('challenge_network_mismatch')
  }

  const recipient = request['recipient']
  if (typeof recipient !== 'string' || recipient !== resolvePayee(manifest, 'mpp-charge')) {
    return new KikisAppPolicyRejectError('challenge_payee_mismatch')
  }

  const currency = request['currency']
  let eligible = false
  if (typeof currency === 'string') {
    try {
      eligible = isAssetEligible(manifest, currency, 'mpp-charge', endpoint)
    } catch {
      eligible = false
    }
  }
  if (!eligible) {
    return new KikisAppPolicyRejectError('challenge_asset_mismatch')
  }

  return checkAmount(request['amount'], maxAmount)
}
