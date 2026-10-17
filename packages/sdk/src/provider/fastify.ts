import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import { signManifest } from '../manifest/sign.js'
import type { KikisAppManifest, PaymentMode } from '../types.js'
import type { SeenTxStore } from './SeenTxStore.js'
import type { OrphanedSessionInfo } from './MppSessionHandler.js'
import type { KikisAppLogger } from '../internal/logger.js'
import { resolvePaymentMode } from './internal/detectPaymentMode.js'

export interface KikisAppFastifyOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
    /** WebSocket transport variant of mpp-session — same channel, WS streaming */
    'mpp-session-ws'?: { rate: string; channelFactory: string }
  }
  asset?: string
  assetContract?: string
  payee: string
  network: 'testnet' | 'mainnet'
  payeeSecretKey: string
  facilitatorApiKey?: string
  commitmentPublicKey?: string
  manifest: KikisAppManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onCallbackError?: (err: unknown, cbName: string) => void
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  idleTimeoutMs?: number
  seenTxStore?: SeenTxStore
  /**
   * Structured log sink for every adapter diagnostic (settlement errors,
   * callback failures, orphaned sessions). Defaults to a console-backed logger.
   */
  logger?: KikisAppLogger
}

// ---------------------------------------------------------------------------
// Express-compatible shim over Node's raw http objects
//
// Fastify's request.raw / reply.raw are plain Node IncomingMessage /
// ServerResponse. The Express-style handlers in this SDK call APIs that only
// exist on Express's extended versions (req.get, req.protocol, req.originalUrl,
// res.status, res.json, res.send, res.setHeader). This function builds a
// minimal shim so those calls work without modifying any handler.
// ---------------------------------------------------------------------------
function buildExpressShims(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): { req: Request; res: Response } {
  // --- Request shim ---
  const req = rawReq as unknown as Request
  const urlStr = rawReq.url ?? '/'
  const parsedUrl = new URL(urlStr, 'http://placeholder')

  // Express-style header getter
  const reqGet = (name: string): string | undefined => {
    const val = rawReq.headers[name.toLowerCase()]
    return Array.isArray(val) ? val[0] : val
  }

  if (!('get' in req && typeof (req as any).get === 'function')) {
    Object.defineProperty(req, 'get', { value: reqGet, configurable: true })
    Object.defineProperty(req, 'header', { value: reqGet, configurable: true })
  }
  if (!('protocol' in req)) {
    Object.defineProperty(req, 'protocol', {
      get: () => (fastifyRequest.protocol ?? 'http'),
      configurable: true,
    })
  }
  if (!('originalUrl' in req)) {
    Object.defineProperty(req, 'originalUrl', { value: urlStr, configurable: true })
  }
  if (!('path' in req)) {
    Object.defineProperty(req, 'path', { value: parsedUrl.pathname, configurable: true })
  }
  if (!('query' in req)) {
    const q: Record<string, string> = {}
    parsedUrl.searchParams.forEach((v, k) => { q[k] = v })
    Object.defineProperty(req, 'query', { value: q, configurable: true })
  }

  // --- Response shim ---
  // `res` and `rawRes` are the same object: the Express surface is defined
  // directly onto the Node ServerResponse. Capture the native methods before
  // any of them are shadowed, or setHeader/end recurse into themselves.
  const res = rawRes as unknown as Response
  const nativeSetHeader = rawRes.setHeader.bind(rawRes)
  const nativeGetHeader = rawRes.getHeader.bind(rawRes)
  const nativeEnd = rawRes.end.bind(rawRes)

  // Collect headers written via shim and flush at send time
  const extraHeaders: Record<string, string | string[]> = {}

  const resSend = (body?: unknown): Response => {
    if (!rawRes.headersSent) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        nativeSetHeader(k, v)
      }
      if (typeof body === 'string') {
        nativeEnd(body)
      } else if (body !== undefined && body !== null) {
        if (!nativeGetHeader('content-type')) {
          nativeSetHeader('Content-Type', 'application/json')
        }
        nativeEnd(JSON.stringify(body))
      } else {
        nativeEnd()
      }
    }
    return res
  }

  const resJson = (data: unknown): Response => {
    if (!nativeGetHeader('content-type')) {
      nativeSetHeader('Content-Type', 'application/json')
    }
    return resSend(data)
  }

  const resStatus = (code: number): Response => {
    rawRes.statusCode = code
    return res
  }

  const resSet = (field: string | Record<string, string | string[]>, val?: string | string[]): Response => {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) nativeSetHeader(k, v)
    } else if (val !== undefined) {
      extraHeaders[field] = val
      nativeSetHeader(field, val)
    }
    return res
  }

  const resSetHeader = (name: string, value: string | number | readonly string[]): Response => {
    nativeSetHeader(name, value as string)
    return res
  }

  if (!('status' in res && typeof (res as any).status === 'function')) {
    Object.defineProperty(res, 'status', { value: resStatus, configurable: true })
    Object.defineProperty(res, 'json', { value: resJson, configurable: true })
    Object.defineProperty(res, 'send', { value: resSend, configurable: true })
    Object.defineProperty(res, 'set', { value: resSet, configurable: true })
    Object.defineProperty(res, 'setHeader', { value: resSetHeader, configurable: true })
    Object.defineProperty(res, 'end', {
      value: (data?: unknown) => { nativeEnd(data) },
      configurable: true,
    })
  }

  return { req, res }
}

/**
 * Run an Express-style handler against a Fastify request/reply pair.
 *
 * If the handler writes a response directly (e.g. 402 challenge, error, or
 * session DELETE), we hijack the reply so Fastify does not try to serialise
 * a second response. If the handler calls next() without responding (settled
 * payment pass-through), we do not hijack, allowing Fastify to execute the
 * downstream route handler.
 */
function runExpressHandler(
  handler: RequestHandler,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): Promise<void> {
  const rawRes = fastifyReply.raw
  const { req, res } = buildExpressShims(
    fastifyRequest.raw,
    rawRes,
    fastifyRequest,
    fastifyReply,
  )
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      if (err != null) return reject(err)
      if (rawRes.writableEnded || rawRes.headersSent) fastifyReply.hijack()
      resolve()
    }
    Promise.resolve(handler(req, res, (err?: unknown) => finish(err))).then(() => finish(), finish)
  })
}

/**
 * Context key set by the mpp-session-ws middleware after a request's payment
 * credential has been verified, so the app's WebSocket upgrade route can
 * refuse to upgrade unauthenticated handshakes. Mirrors the Hono adapter's
 * `MPP_SESSION_WS_VERIFIED`.
 */
export const MPP_SESSION_WS_VERIFIED = 'kikis-app.mppSessionWs.verified'

/**
 * True when the kikisAppFastify mpp-session-ws middleware verified the
 * handshake request's Payment credential (see {@link MPP_SESSION_WS_VERIFIED}).
 * WebSocket upgrade routes should refuse to upgrade when this is false:
 *
 * ```ts
 * fastify.get('/stream', { websocket: true }, (socket, request) => {
 *   if (!mppSessionWsFastifyVerified(request)) return socket.close()
 *   // ... stream to the paid client
 * })
 * ```
 */
export function mppSessionWsFastifyVerified(request: object): boolean {
  return (request as Record<string, unknown>)[MPP_SESSION_WS_VERIFIED] === true
}

/** True when the request is a WebSocket upgrade handshake. */
function isWebSocketUpgradeRequest(request: FastifyRequest): boolean {
  const upgrade = request.headers['upgrade']
  const value = Array.isArray(upgrade) ? upgrade[0] : upgrade
  return (value ?? '').toLowerCase() === 'websocket'
}

export function kikisAppFastify(opts: KikisAppFastifyOptions): FastifyPluginAsync {
  const signedManifest = signManifest(opts.manifest, opts.payeeSecretKey)
  const handlerMap = new Map<PaymentMode, RequestHandler>()

  if (opts.modes.includes('x402')) {
    const x402Price = opts.pricing.x402
    if (x402Price) {
      handlerMap.set(
        'x402',
        createX402Handler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: x402Price,
          ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
          ...(opts.facilitatorApiKey ? { facilitatorApiKey: opts.facilitatorApiKey } : {}),
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
      )
    }
  }

  if (opts.modes.includes('mpp-charge')) {
    const chargePrice = opts.pricing['mpp-charge']
    if (chargePrice) {
      handlerMap.set(
        'mpp-charge',
        createMppChargeHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: chargePrice,
          ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
      )
    }
  }

  // Session modes (mpp-session, mpp-session-ws) share one handler so a
  // provider advertising both transports verifies vouchers against the same
  // cumulative state and a DELETE close sees the combined total — mirrors
  // kikisAppHono's shared session state. The WebSocket handshake is verified
  // exactly like any other session request: it is an HTTP request that must
  // carry a valid Payment credential before the app's @fastify/websocket
  // route is allowed to upgrade it.
  const sessionModes = (['mpp-session', 'mpp-session-ws'] as const).filter(
    (mode) => opts.modes.includes(mode) && !!opts.pricing[mode],
  )
  const primarySessionMode = sessionModes[0]
  if (primarySessionMode) {
    if (!opts.commitmentPublicKey) {
      throw new Error('kikisAppFastify: mpp-session/mpp-session-ws mode requires commitmentPublicKey')
    }
    const sessionPricing = opts.pricing[primarySessionMode]!
    const sessionHandler = createMppSessionHandler({
      payeeSecretKey: opts.payeeSecretKey,
      network: opts.network,
      channelFactory: sessionPricing.channelFactory,
      rate: sessionPricing.rate,
      mode: primarySessionMode,
      ...(opts.assetContract ? { assetContract: opts.assetContract } : {}),
      manifest: signedManifest,
      commitmentPublicKey: opts.commitmentPublicKey,
      ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
      ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
      ...(opts.onVoucher ? { onVoucher: opts.onVoucher } : {}),
      ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
      ...(opts.onOrphaned ? { onOrphaned: opts.onOrphaned } : {}),
      ...(opts.idleTimeoutMs != null ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    })
    for (const mode of sessionModes) {
      handlerMap.set(mode, sessionHandler)
    }
  }

  const availableModes = new Set(handlerMap.keys())

  const plugin: FastifyPluginAsync = async (fastify) => {
    // Serve the signed manifest at the well-known endpoint
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.url === '/.well-known/kikis-app.json') {
        reply.hijack()
        const body = JSON.stringify(signedManifest)
        reply.raw.setHeader('Content-Type', 'application/json')
        reply.raw.setHeader('Content-Length', Buffer.byteLength(body))
        reply.raw.end(body)
        return
      }

      if (handlerMap.size === 0) return

      // Route to the handler that speaks the mode the request targets — the
      // same header-driven dispatch as the Hono and Express adapters. A
      // WebSocket upgrade handshake is steered to the mpp-session-ws handler,
      // so only a paid handshake can reach the app's upgrade route.
      const isWebSocketUpgrade = isWebSocketUpgradeRequest(request)
      const selectedMode = resolvePaymentMode(
        (name) => {
          const value = request.headers[name]
          return Array.isArray(value) ? value[0] : value
        },
        availableModes,
        { isWebSocketUpgrade },
      )
      if (!selectedMode) return
      const handler = handlerMap.get(selectedMode)
      if (!handler) return

      await runExpressHandler(handler, request, reply)

      // Payment verified and the handler passed the request through (no 402
      // was written): flag the request so the app's @fastify/websocket route
      // can confirm the handshake was paid via mppSessionWsFastifyVerified
      // before performing the upgrade.
      if (selectedMode === 'mpp-session-ws' && isWebSocketUpgrade && !reply.raw.writableEnded) {
        Object.defineProperty(request, MPP_SESSION_WS_VERIFIED, { value: true, configurable: true })
      }
    })
  }

  // Fastify encapsulates plugins by default, so an onRequest hook added inside
  // one only sees routes declared inside that same plugin. Payment middleware
  // has to cover the routes the app declares on the parent instance, so opt out
  // of encapsulation. This is what fastify-plugin sets, without the dependency.
  Object.defineProperty(plugin, Symbol.for('skip-override'), { value: true })

  return plugin
}
