import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/charge/client'
import { Mppx } from 'mppx/client'
import type { KikisAppManifest, PaymentResult, MppChargeClientOptions } from '../types.js'
import {
  KikisAppManifestError,
  KikisAppPolicyRejectError,
  KikisAppFeeError,
  KikisAppNetworkError,
  httpStatusToError,
  wrapMppError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { prepareHttpRequestInit } from '../internal/http.js'
import { checkChargeChallenge, type Caip2Network } from './challenge.js'
import type { ModeSelectOptions } from './ModeRouter.js'

/**
 * Estimate network base fee in stroops from Horizon /fee_stats.
 */
export async function estimateBaseFee(
  horizonUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const url = `${horizonUrl.replace(/\/+$/, '')}/fee_stats`
  const res = await fetchFn(url)
  if (!res.ok) {
    throw new KikisAppNetworkError(`Failed to fetch fee stats from Horizon: HTTP ${res.status}`)
  }
  const stats = (await res.json()) as {
    last_ledger_base_fee?: string | number
    fee_charged?: {
      p90?: string | number
      mode?: string | number
      min?: string | number
      max?: string | number
    }
    max_fee?: {
      mode?: string | number
      p90?: string | number
    }
  }
  const feeCandidate =
    stats.fee_charged?.p90 ??
    stats.fee_charged?.mode ??
    stats.last_ledger_base_fee ??
    100
  return Number(feeCandidate)
}

export class MppChargeClient {
  private readonly retryPolicy?: RetryPolicy
  private readonly options?: MppChargeClientOptions

  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    retryPolicyOrOptions?: RetryPolicy | MppChargeClientOptions,
    options?: MppChargeClientOptions,
  ) {
    if (
      retryPolicyOrOptions &&
      ('maxFeeStroops' in retryPolicyOrOptions ||
        'maxBaseFeeStroops' in retryPolicyOrOptions ||
        'dynamicFee' in retryPolicyOrOptions ||
        'horizonUrl' in retryPolicyOrOptions)
    ) {
      this.options = retryPolicyOrOptions as MppChargeClientOptions
      this.retryPolicy = undefined
    } else {
      this.retryPolicy = retryPolicyOrOptions as RetryPolicy | undefined
      this.options = options
    }
  }

  async pay(
    url: string,
    manifest: KikisAppManifest,
    options?: ModeSelectOptions,
  ): Promise<PaymentResult> {
    const pricing = manifest.pricing['mpp-charge']
    if (!pricing) {
      throw new KikisAppManifestError('manifest.pricing.mpp-charge missing')
    }

    const caip2: Caip2Network =
      this.network === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet'

    const endpoint = (() => {
      try {
        return new URL(url).pathname
      } catch {
        return url
      }
    })()

    const maxFeeCap = this.options?.maxFeeStroops ?? this.options?.maxBaseFeeStroops
    let calculatedFee = 100

    if (this.options?.dynamicFee) {
      const horizonUrl =
        this.options?.horizonUrl ??
        (this.network === 'testnet'
          ? 'https://horizon-testnet.stellar.org'
          : 'https://horizon.stellar.org')
      const estimated = await estimateBaseFee(horizonUrl, this.options?.fetchFn)
      if (maxFeeCap !== undefined && estimated > maxFeeCap) {
        throw new KikisAppFeeError(
          `Estimated base fee of ${estimated} stroops exceeds maxFeeStroops (${maxFeeCap})`,
          { fee: estimated, maxFee: maxFeeCap },
        )
      }
      calculatedFee = Math.max(100, estimated)
    } else if (maxFeeCap !== undefined) {
      calculatedFee = maxFeeCap
    }

    let txHash: string | null = null
    let signedAmount: string | undefined
    // The credential is created at most once per pay() call. Every retry after
    // the first reuses it, so the provider's idempotency store can replay the
    // cached settlement instead of charging a second time.
    let credential: string | undefined

    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        (stellar.charge as (opts: Record<string, unknown>) => any)({
          keypair: this.keypair,
          mode: 'pull',
          fee: calculatedFee,
          baseFee: calculatedFee,
          maxFee: maxFeeCap ?? calculatedFee,
          feeEnvelope: {
            baseFee: calculatedFee,
            maxFee: maxFeeCap ?? calculatedFee,
          },
          onProgress(event: any) {
            if (event.type === 'paid') {
              txHash = event.hash
            }
          },
        }),
      ],
      onChallenge: async (challenge, { createCredential }) => {
        // Bind the unsigned challenge to the signed manifest before signing.
        const request = challenge.request
        const rejection = checkChargeChallenge(request, manifest, caip2, pricing.amount, endpoint)
        if (rejection) throw rejection

        const amount = request['amount']
        if (typeof amount !== 'string') {
          throw new KikisAppPolicyRejectError('challenge_amount_invalid')
        }
        signedAmount = stroopsToUsdc(BigInt(amount))
        credential ??= await createCredential()
        return credential
      },
    })

    const reqInit = prepareHttpRequestInit(options?.request)

    return withRetry(async (): Promise<PaymentResult> => {
      let response: Response
      try {
        response = credential
          ? await mppx.rawFetch(url, {
              ...reqInit,
              headers: { ...reqInit.headers, Authorization: credential },
            })
          : await mppx.fetch(url, reqInit)
      } catch (err) {
        throw wrapMppError(err, 'MPP charge request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `MPP charge failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw new KikisAppManifestError(`MPP charge failed: HTTP ${response.status}`)
      }

      let data: unknown
      const responseType = options?.responseType ?? 'auto'
      const contentType = response.headers.get('content-type') ?? ''
      if (responseType === 'text' || (responseType === 'auto' && contentType.startsWith('text/'))) {
        data = await response.text()
      } else if (
        responseType === 'arrayBuffer' ||
        responseType === 'blob' ||
        (responseType === 'auto' &&
          (contentType.startsWith('image/') ||
            contentType.includes('application/octet-stream') ||
            contentType.includes('application/pdf')))
      ) {
        data = await response.arrayBuffer()
      } else {
        try {
          data = await response.json()
        } catch (cause) {
          throw new KikisAppManifestError(
            `Failed to parse JSON from response (HTTP ${response.status})`,
            { cause },
          )
        }
      }
      return {
        data,
        txHash,
        mode: 'mpp-charge',
        amount: signedAmount ?? pricing.amount,
        timestamp: Date.now(),
      }
    }, this.retryPolicy)
  }
}
