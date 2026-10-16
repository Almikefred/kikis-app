/**
 * Shared multi-mode request routing for the provider adapters (Hono,
 * Express).
 *
 * A provider advertising several payment modes must dispatch each request to
 * the handler that speaks the mode the client is actually using. The target
 * mode is read from the request headers:
 *
 * 1. `x-preferred-mode` — explicit agent/developer override.
 * 2. x402 payment headers (`payment-signature` / `x-payment`).
 * 3. The mppx `Authorization: Payment ...` credential, whose embedded
 *    challenge names the intent (`charge` vs `channel`).
 *
 * Requests without any usable mode signal fall back to the provider's
 * default challenge — session, then charge, then x402 — so unauthenticated
 * probes keep receiving the same 402 they always did.
 *
 * Workers-safe: only Web-standard APIs, no `Buffer`.
 */
import type { PaymentMode } from '../../types.js'
import { base64ToUtf8 } from '../encoding.js'

/** Reads one request header — matches Express `req.get` and Hono `c.req.header`. */
export type HeaderReader = (name: string) => string | undefined

const PAYMENT_MODES: readonly PaymentMode[] = [
  'x402',
  'mpp-charge',
  'mpp-session',
  'mpp-session-ws',
]

function isPaymentMode(value: string): value is PaymentMode {
  return (PAYMENT_MODES as readonly string[]).includes(value)
}

/** mppx challenge intents that denote the discrete charge method. */
const CHARGE_INTENTS = new Set(['charge', 'mpp-charge'])
/** mppx challenge intents that denote a streaming channel/session method. */
const SESSION_INTENTS = new Set(['channel', 'session', 'mpp-session', 'mpp-session-ws'])
/** Legacy credential payload discriminators for charge (`type`)… */
const CHARGE_PAYLOAD_TYPES = new Set(['hash', 'transaction'])
/** …and for session (`action`). */
const SESSION_PAYLOAD_ACTIONS = new Set(['open', 'voucher', 'close'])

/** Decodes url-safe, unpadded base64 JSON; undefined when it isn't valid JSON. */
function tryDecodeBase64Json(b64: string): unknown {
  try {
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return JSON.parse(base64ToUtf8(padded))
  } catch {
    return undefined
  }
}

/** Maps a decoded Payment credential to 'charge' or 'session', when it names one. */
function intentFromCredential(credential: unknown): 'charge' | 'session' | undefined {
  if (typeof credential !== 'object' || credential === null) return undefined
  const { challenge, payload } = credential as {
    challenge?: { intent?: unknown }
    payload?: { action?: unknown; type?: unknown }
  }

  // mppx wire format: the embedded challenge names the method's intent.
  if (typeof challenge?.intent === 'string') {
    if (CHARGE_INTENTS.has(challenge.intent)) return 'charge'
    if (SESSION_INTENTS.has(challenge.intent)) return 'session'
  }

  // Legacy @stellar/mpp format: the payload discriminates by action/type.
  if (typeof payload === 'object' && payload !== null) {
    if (typeof payload.action === 'string' && SESSION_PAYLOAD_ACTIONS.has(payload.action)) {
      return 'session'
    }
    if (typeof payload.type === 'string' && CHARGE_PAYLOAD_TYPES.has(payload.type)) {
      return 'charge'
    }
  }
  return undefined
}

/** Extracts the payment intent from an `Authorization: Payment ...` header. */
function intentFromAuthorization(header: string): 'charge' | 'session' | undefined {
  const match = header.match(/^Payment\s+(.+)$/i)
  if (!match?.[1]) return undefined
  const value = match[1].trim()

  // mppx: `Payment <base64url JSON>` — a single blob.
  const blobIntent = intentFromCredential(tryDecodeBase64Json(value))
  if (blobIntent) return blobIntent

  // Legacy: `Payment credential=<b64>,signature=<hex>` (comma-separated).
  const credentialPart = value
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith('credential='))
  if (credentialPart) {
    const b64 = credentialPart.slice('credential='.length).replace(/^"|"$/g, '')
    return intentFromCredential(tryDecodeBase64Json(b64))
  }
  return undefined
}

/** Picks the session-mode handler for a session intent / unauthenticated request. */
function pickSessionMode(
  available: ReadonlySet<PaymentMode>,
  isWebSocketUpgrade: boolean,
): PaymentMode | undefined {
  // A verified WebSocket handshake must reach the mpp-session-ws handler —
  // only it flags MPP_SESSION_WS_VERIFIED for the app's upgrade route.
  if (isWebSocketUpgrade && available.has('mpp-session-ws')) return 'mpp-session-ws'
  if (available.has('mpp-session')) return 'mpp-session'
  if (available.has('mpp-session-ws')) return 'mpp-session-ws'
  return undefined
}

/** The provider's default challenge when a request carries no mode signal. */
function defaultMode(
  available: ReadonlySet<PaymentMode>,
  isWebSocketUpgrade: boolean,
): PaymentMode | undefined {
  return (
    pickSessionMode(available, isWebSocketUpgrade) ??
    (available.has('mpp-charge') ? 'mpp-charge' : undefined) ??
    (available.has('x402') ? 'x402' : undefined)
  )
}

export interface PaymentModeRoutingOptions {
  /** True when the request is a WebSocket upgrade handshake. */
  isWebSocketUpgrade?: boolean
}

/**
 * Resolves which registered mode should handle a request.
 *
 * Returns the explicitly requested mode when the headers identify one and
 * the provider offers it; otherwise the provider's default mode (see the
 * module doc). A mode the provider does not offer is never returned.
 */
export function resolvePaymentMode(
  readHeader: HeaderReader,
  available: ReadonlySet<PaymentMode>,
  options: PaymentModeRoutingOptions = {},
): PaymentMode | undefined {
  const isWebSocketUpgrade = options.isWebSocketUpgrade === true

  // 1. Explicit override — an agent that knows its mode must always win.
  const preferred = readHeader('x-preferred-mode')
  if (preferred && isPaymentMode(preferred) && available.has(preferred)) {
    return preferred
  }

  // 2. x402 payment headers.
  if (readHeader('payment-signature') || readHeader('x-payment')) {
    if (available.has('x402')) return 'x402'
  } else {
    // 3. mpp Payment credential — decode which intent it was issued for.
    const authorization = readHeader('authorization')
    if (authorization) {
      const intent = intentFromAuthorization(authorization)
      if (intent === 'charge' && available.has('mpp-charge')) {
        return 'mpp-charge'
      }
      if (intent === 'session') {
        const sessionMode = pickSessionMode(available, isWebSocketUpgrade)
        if (sessionMode) return sessionMode
      }
    }
  }

  // No usable signal — the provider's default challenge.
  return defaultMode(available, isWebSocketUpgrade)
}

