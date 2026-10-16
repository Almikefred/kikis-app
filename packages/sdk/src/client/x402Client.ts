import { createEd25519Signer, type ClientStellarSigner } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http'
import type { KikisAppManifest, PaymentResult } from '../types.js'
import {
  KikisAppManifestError,
  KikisAppSignatureError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { checkX402Accept, filterX402Accepts, type Caip2Network } from './challenge.js'
import type { ModeSelectOptions } from './ModeRouter.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, Caip2Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/** Outcome of the retried unpaid probe. */
type ProbeOutcome =
  | { kind: 'free'; data: unknown }
  | { kind: 'payment-required'; init: Response }

export interface FacilitatorReceipt {
  txHash?: string
  transaction?: string
  nonce?: string
  network?: string
  timestamp?: number | string
  [key: string]: unknown
}

export class X402Client {
  private readonly httpClient: x402HTTPClient
  private readonly signer: ClientStellarSigner

  constructor(
    secretKeyOrSigner: string | ClientStellarSigner,
    private readonly network: Network,
    private readonly retryPolicy?: RetryPolicy,
  ) {
    const caip2 = CAIP2[network]
    this.signer =
      typeof secretKeyOrSigner === 'string'
        ? createEd25519Signer(secretKeyOrSigner, caip2)
        : secretKeyOrSigner
    const scheme = new ExactStellarScheme(this.signer)
    const core = new x402Client()
    core.register(caip2, scheme)
    this.httpClient = new x402HTTPClient(core)
  }

  /** Replace signer (e.g. swap to Nulth ZK account payer before pay) */
  withSigner(signer: ClientStellarSigner): X402Client {
    return new X402Client(signer, this.network, this.retryPolicy)
  }

  async pay(
    url: string,
    manifest: KikisAppManifest,
    options?: ModeSelectOptions,
  ): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new KikisAppManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new KikisAppManifestError('manifest.pricing.x402.facilitator missing')
    }

    const caip2 = CAIP2[this.network]

    // Phase 1: unpaid probe. This can retry freely — no payment exists yet.
    const probe = await withRetry(async (): Promise<ProbeOutcome> => {
      let init: Response
      try {
        init = await fetch(url, { headers: { 'X-Preferred-Mode': 'x402' } })
      } catch (err) {
        throw wrapFetchError(err, 'x402 initial request')
      }

      if (init.status !== 402) {
        if (!init.ok) {
          throw httpStatusToError(
            `x402 initial request failed: HTTP ${init.status}`,
            init.status,
            init,
          )
        }
        let data: unknown
        const responseType = options?.responseType ?? 'auto'
        const contentType = init.headers.get('content-type') ?? ''
        if (responseType === 'text' || (responseType === 'auto' && contentType.startsWith('text/'))) {
          data = await init.text()
        } else if (
          responseType === 'arrayBuffer' ||
          responseType === 'blob' ||
          (responseType === 'auto' &&
            (contentType.startsWith('image/') ||
              contentType.includes('application/octet-stream') ||
              contentType.includes('application/pdf')))
        ) {
          data = await init.arrayBuffer()
        } else {
          try {
            data = await init.json()
          } catch {
            throw new KikisAppManifestError(
              `Failed to parse JSON from non-402 response (HTTP ${init.status})`,
            )
          }
        }
        return { kind: 'free', data }
      }

      return { kind: 'payment-required', init }
    }, this.retryPolicy)

    if (probe.kind === 'free') {
      return { data: probe.data, txHash: null, mode: 'x402', amount: '0', timestamp: Date.now() }
    }

    const init = probe.init
    const reqHeader = init.headers.get('X-Payment-Requirements')
    if (!reqHeader) {
      throw new KikisAppManifestError('402 response missing X-Payment-Requirements header')
    }

    let paymentRequired
    try {
      paymentRequired = decodePaymentRequiredHeader(reqHeader)
    } catch (err) {
      throw new KikisAppManifestError('402 X-Payment-Requirements header is malformed', {
        cause: err,
      })
    }

    const firstAccept = paymentRequired.accepts[0]
    if (!firstAccept) {
      throw new KikisAppManifestError('402 response carries no payment accepts')
    }

    // Phase 2: bind the unsigned 402 to the signed manifest BEFORE signing.
    // A mismatched challenge must never reach createPaymentPayload.
    const allowed = filterX402Accepts(paymentRequired.accepts, manifest, caip2, pricing.amount)
    if (allowed.length === 0) {
      // `accepts` is non-empty here, so accepts[0] — the entry the scheme would
      // have signed — failed its own checks. That rejection is the report.
      throw checkX402Accept(firstAccept, manifest, caip2, pricing.amount)
    }

    // Phase 3: sign exactly once per pay() call.
    let paymentPayload
    try {
      paymentPayload = await this.httpClient.createPaymentPayload({
        ...paymentRequired,
        accepts: allowed,
      })
    } catch (err) {
      throw new KikisAppSignatureError(`x402 payment signing failed: ${String(err)}`, {
        cause: err,
      })
    }

    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)
    const signedAmount = stroopsToUsdc(BigInt(paymentPayload.accepted.amount))

    // Phase 4: paid request. Retries reuse the SAME paymentHeaders object, so
    // the provider's idempotency store can replay the cached settlement rather
    // than charging a second time.
    const settled = await withRetry(async (): Promise<Response> => {
      let response: Response
      try {
        response = await fetch(url, { headers: paymentHeaders })
      } catch (err) {
        throw wrapFetchError(err, 'x402 settlement request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `x402 payment failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw new KikisAppManifestError(`x402 payment failed: HTTP ${response.status}`)
      }

      return response
    }, this.retryPolicy)

    let txHash: string | null = null
    const responseHeader = settled.headers.get('X-Payment-Response')
    if (responseHeader) {
      let settleResponse: FacilitatorReceipt
      try {
        settleResponse = decodePaymentResponseHeader(responseHeader) as FacilitatorReceipt
      } catch (err) {
        throw new KikisAppSignatureError(`Failed to decode X-Payment-Response header: ${String(err)}`, {
          cause: err,
        })
      }

      // Nonce alignment: verify receipt's nonce matches the payment payload's nonce
      const payloadNonce =
        (paymentPayload as any).nonce ??
        (paymentPayload.payload as any)?.nonce ??
        (paymentPayload.accepted as any)?.nonce ??
        (paymentPayload.accepted?.extra as any)?.nonce

      const receiptNonce =
        settleResponse.nonce ??
        (settleResponse as any).payload?.nonce ??
        (settleResponse as any).extensions?.nonce

      if (payloadNonce !== undefined || receiptNonce !== undefined) {
        if (!receiptNonce || receiptNonce !== payloadNonce) {
          throw new KikisAppSignatureError(
            `Facilitator receipt nonce mismatch: expected "${payloadNonce}", got "${receiptNonce}"`,
          )
        }
      }

      // Timestamp freshness: verify receipt timestamp is within acceptable drift (< 60s)
      if (settleResponse.timestamp !== undefined) {
        let receiptTimeMs: number
        if (typeof settleResponse.timestamp === 'number') {
          receiptTimeMs =
            settleResponse.timestamp < 1e11
              ? settleResponse.timestamp * 1000
              : settleResponse.timestamp
        } else {
          const parsed = Date.parse(settleResponse.timestamp)
          receiptTimeMs = !Number.isNaN(parsed) ? parsed : Number(settleResponse.timestamp)
        }

        if (Number.isNaN(receiptTimeMs)) {
          throw new KikisAppSignatureError('Facilitator receipt timestamp is invalid')
        }

        const driftMs = Math.abs(Date.now() - receiptTimeMs)
        if (driftMs > 60_000) {
          throw new KikisAppSignatureError(
            `Facilitator receipt timestamp outside acceptable drift (< 60s): drift was ${Math.round(driftMs / 1000)}s`,
          )
        }
      }

      txHash = settleResponse.txHash ?? settleResponse.transaction ?? null
    }

    let data: unknown
    const responseType = options?.responseType ?? 'auto'
    const contentType = settled.headers.get('content-type') ?? ''
    if (responseType === 'text' || (responseType === 'auto' && contentType.startsWith('text/'))) {
      data = await settled.text()
    } else if (
      responseType === 'arrayBuffer' ||
      responseType === 'blob' ||
      (responseType === 'auto' &&
        (contentType.startsWith('image/') ||
          contentType.includes('application/octet-stream') ||
          contentType.includes('application/pdf')))
    ) {
      data = await settled.arrayBuffer()
    } else {
      try {
        data = await settled.json()
      } catch {
        throw new KikisAppManifestError('Failed to parse JSON from settled response')
      }
    }
    return { data, txHash, mode: 'x402', amount: signedAmount, timestamp: Date.now() }
  }
}
