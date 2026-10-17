import { Validator, type Schema } from '@cfworker/json-schema'
import type { KikisAppManifest, PaymentMode, HttpRequestOptions } from '../types.js'
import {
  KikisAppError,
  KikisAppManifestError,
  KikisAppManifestTimeoutError,
  KikisAppManifestSunsetError,
  KikisAppNoSupportedModeError,
  KikisAppPolicyRejectError,
  KikisAppClientVersionError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { usdcToStroops } from '../internal/usdc.js'
import { noopLogger, type KikisAppLogger } from '../internal/logger.js'
import schema from '../schemas/kikis-app.schema.json' assert { type: 'json' }
import pkg from '../../package.json' assert { type: 'json' }
import { verifyManifestSignature } from '../manifest/sign.js'

const validator = new Validator(schema as unknown as Schema, '7')

const SDK_VERSION = pkg.version as string

function parseMajorMinor(version: string): [number, number] {
  const parts = version.split('.')
  return [Number.parseInt(parts[0] ?? '0', 10), Number.parseInt(parts[1] ?? '0', 10)]
}

function isVersionBelow(a: string, b: string): boolean {
  const [aMajor, aMinor] = parseMajorMinor(a)
  const [bMajor, bMinor] = parseMajorMinor(b)
  return aMajor < bMajor || (aMajor === bMajor && aMinor < bMinor)
}

function assertClientVersionSupported(manifest: KikisAppManifest, baseUrl: string): void {
  const minVersion = manifest.min_client_version
  if (minVersion && isVersionBelow(SDK_VERSION, minVersion)) {
    throw new KikisAppClientVersionError(
      `SDK version ${SDK_VERSION} is below the minimum required version ${minVersion} for provider at ${baseUrl}. Please upgrade the SDK.`,
    )
  }
}

function assertManifestActive(manifest: KikisAppManifest, baseUrl: string): void {
  const sunsetAt = manifest.sunset_at
  if (!sunsetAt) return

  const sunsetTime = Date.parse(sunsetAt)
  if (!Number.isFinite(sunsetTime)) {
    throw new KikisAppManifestError(
      `Manifest at ${baseUrl} contains an invalid sunset_at timestamp: ${sunsetAt}`,
    )
  }

  if (sunsetTime <= Date.now()) {
    throw new KikisAppManifestSunsetError(
      `Manifest for provider at ${baseUrl} sunset at ${sunsetAt} and can no longer be used`,
    )
  }
}

/**
 * Enforce the per-endpoint `deprecated` and `sunset_at` metadata for the URL
 * being paid. `pay()` never learns the HTTP method, so a path shared by more
 * than one descriptor (e.g. GET and POST on `/infer`) is refused only when
 * every matching descriptor has sunset. Paths the manifest does not list keep
 * today's behavior. Query strings and hashes are ignored because only
 * `URL.pathname` is compared.
 */
export function assertEndpointActive(
  manifest: KikisAppManifest,
  url: string,
  logger?: KikisAppLogger,
): void {
  const pathname = new URL(url).pathname
  const matches = Object.entries(manifest.endpoints).filter(
    ([, descriptor]) => descriptor.path === pathname,
  )
  if (matches.length === 0) return

  const now = Date.now()
  const allSunset = matches.every(([, descriptor]) => {
    const sunsetAt = descriptor.sunset_at
    return typeof sunsetAt === 'string' && Date.parse(sunsetAt) <= now
  })
  if (allSunset) {
    const [key, descriptor] = matches[0]!
    throw new KikisAppManifestSunsetError(
      `Endpoint '${key}' (${pathname}) sunset at ${descriptor.sunset_at} and can no longer be used`,
    )
  }

  const deprecated = matches.find(([, descriptor]) => descriptor.deprecated === true)
  if (deprecated && logger) {
    const [key, descriptor] = deprecated
    const sunsetSuffix = descriptor.sunset_at ? `; sunset_at ${descriptor.sunset_at}` : ''
    logger(
      'warn',
      `[KikisApp] WARNING: ${manifest.name} → ${pathname}; endpoint '${key}' is deprecated${sunsetSuffix}`,
    )
  }
}

/**
 * Validate semantic constraints for manifest fields beyond JSON schema syntax.
 * Enforces:
 * - All keys in `latency_hints` must be a subset of declared `regions`.
 * - If `assets` is defined, it must be a non-empty array whose first entry
 *   (`assets[0]`) matches the root-level `asset` and `asset_contract`.
 */
export function assertManifestValid(manifest: KikisAppManifest, baseUrl?: string): void {
  const context = baseUrl ? ` at ${baseUrl}` : ''
  if (manifest.latency_hints !== undefined) {
    if (!Array.isArray(manifest.regions) || manifest.regions.length === 0) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: latency_hints defined without declaring regions`,
      )
    }
    const regionSet = new Set(manifest.regions)
    for (const region of Object.keys(manifest.latency_hints)) {
      if (!regionSet.has(region)) {
        throw new KikisAppManifestError(
          `Invalid manifest${context}: latency_hints key '${region}' is not declared in regions (${manifest.regions.join(', ')})`,
        )
      }
    }
  }

  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: assets must be a non-empty array when defined`,
      )
    }
    for (let i = 0; i < manifest.assets.length; i++) {
      const a = manifest.assets[i]
      if (!a || typeof a.asset !== 'string' || typeof a.asset_contract !== 'string') {
        throw new KikisAppManifestError(
          `Invalid manifest${context}: assets[${i}] must define asset and asset_contract strings`,
        )
      }
    }
    const first = manifest.assets[0]!
    if (first.asset !== manifest.asset || first.asset_contract !== manifest.asset_contract) {
      throw new KikisAppManifestError(
        `Invalid manifest${context}: assets[0] (${first.asset}:${first.asset_contract}) must match root asset fields (${manifest.asset}:${manifest.asset_contract})`,
      )
    }
  }
}

interface CacheEntry {
  manifest: KikisAppManifest
  fetchedAt: number
  expiresAt: number
}

const CACHE_TTL_MS = 60_000
const DEFAULT_MANIFEST_CACHE_MAX_SIZE = 512
const DEFAULT_MANIFEST_TIMEOUT_MS = 5_000

/**
 * Simple LRU cache backed by Map's insertion-order guarantee.
 * Bounds memory for long-running agents that contact many unique endpoints.
 */
class LruCache<K, V> {
  private map = new Map<K, V>()

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, value)
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }
}

/** In-memory manifest cache keyed by base URL, bounded to avoid unbounded heap growth. */
const manifestCache = new LruCache<string, CacheEntry>(DEFAULT_MANIFEST_CACHE_MAX_SIZE)

/** In-flight fetch promises keyed by base URL to coalesce concurrent requests. */
const inFlightFetches = new Map<string, Promise<KikisAppManifest>>()

/**
 * Override the manifest cache's max size (default 512). Affects the shared,
 * process-wide cache used by all KikisAppClient instances.
 */
export function configureManifestCache(maxSize: number): void {
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new KikisAppManifestError('Invalid manifest cache size: ' + maxSize)
  }
  manifestCache.setMaxSize(maxSize)
}

/**
 * Evict a provider's cached manifest immediately, forcing the next
 * `fetchManifest(baseUrl)` to re-fetch and re-validate it. Use when a
 * provider signals that their manifest changed (e.g. after a config update
 * or a failed payment due to a mode change) so the next request does not
 * keep routing on a stale cached copy for the remainder of the TTL.
 *
 * The cache is keyed by base URL as passed to `fetchManifest` — callers that
 * pass a full URL (e.g. `KikisAppClient.invalidateManifest`) must normalize
 * to the origin before calling this.
 */
export function invalidateManifest(baseUrl: string): void {
  manifestCache.delete(baseUrl)
  inFlightFetches.delete(baseUrl)
}

/**
 * Per-entry freshness from response headers, per RFC 9111:
 * `Cache-Control: no-store` and `no-cache` disable caching outright and take
 * precedence over everything else — the client has no revalidation path, so
 * `no-cache` (which permits reuse only after revalidation) is treated the
 * same as `no-store`. Otherwise, `max-age` wins over `Expires`, and both win
 * over the default TTL. Missing or unparseable directives fall back to the
 * default TTL (60s). `max-age=0` yields an immediately-stale entry, disabling
 * caching for that response.
 */
function ttlFromHeaders(headers: Headers, now: number): number {
  const cacheControl = headers.get('cache-control')
  if (cacheControl) {
    const directives = cacheControl.split(',').map((directive) => directive.trim().toLowerCase())
    if (directives.includes('no-store') || directives.includes('no-cache')) {
      return 0
    }
    const maxAge = /max-age=(\d+)/i.exec(cacheControl)
    if (maxAge) {
      return Number.parseInt(maxAge[1]!, 10) * 1000
    }
  }
  const expires = headers.get('expires')
  if (expires) {
    const expiresTime = Date.parse(expires)
    if (Number.isFinite(expiresTime)) {
      return expiresTime - now
    }
  }
  return CACHE_TTL_MS
}

export type { KikisAppLogger, KikisAppLogLevel, KikisAppLogFields } from '../internal/logger.js'

export interface ModeSelectOptions {
  /** Force mpp-session if the provider supports it */
  sustained?: boolean
  session?: boolean
  /**
   * Preferred streaming transport for sustained sessions. When 'websocket',
   * the mpp-session-ws variant is preferred when the provider advertises it;
   * when 'sse' (or omitted), the classic mpp-session mode is preferred.
   * Either transport falls back to the other session variant when the
   * preferred one is not advertised.
   */
  transport?: 'sse' | 'websocket'
  /** Prefer the lowest-cost supported per-request mode when set to 'cost'. */
  optimize?: 'cost'
  /** Optional maximum acceptable per-request amount for cost-based selection. */
  budget_per_request?: string
  /**
   * Override mode selection and use this specific mode.
   * Throws KikisAppNoSupportedModeError if the provider does not support it.
   */
  forceMode?: PaymentMode
  /**
   * Endpoint key whose endpoint-specific price/rate overrides (from
   * `manifest.endpoints[endpoint].price` / `.amount` / `.rate`) are used
   * instead of manifest-level pricing when comparing unit costs.
   */
  endpoint?: string
  /** Structured logger for mode selection events. Defaults to no-op. */
  logger?: KikisAppLogger
  /**
   * Expected response content type for the paid response body.
   * When 'auto' (default), the client inspects the Content-Type header:
   * - application/json → parsed JSON object
   * - text/* → returned as string
   * - image/*, application/octet-stream, etc. → returned as ArrayBuffer
   * When a specific type is set, the client uses that parsing strategy
   * regardless of the Content-Type header.
   */
  responseType?: 'json' | 'text' | 'arrayBuffer' | 'blob' | 'auto'
  /**
   * Optional HTTP request options (method, headers, body) to send with the
   * payment request. Preserved across probes and settlement.
   */
  request?: HttpRequestOptions
}

/**
 * Fetch, validate, and cache a KikisApp manifest from `baseUrl`.
 *
 * `expectedPayee`, when provided, is the out-of-band trust anchor for the
 * manifest (e.g. the account this provider registered on-chain): the fetched
 * manifest's `payee` must equal it or `KikisAppSignatureError` is thrown.
 * Callers that obtained a payee from a registry/pinned allowlist MUST pass it;
 * without it the self-signed signature alone proves nothing about who served
 * the manifest.
 */
export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
  expectedPayee?: string,
): Promise<KikisAppManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached && Date.now() < cached.expiresAt) {
    // Re-assert the trust anchor even on cache hits: the manifest content is
    // immutable, but `expectedPayee` is per-caller, so a caller with a
    // different anchor must still have the binding enforced.
    verifyManifestSignature(cached.manifest, expectedPayee)
    assertClientVersionSupported(cached.manifest, baseUrl)
    assertManifestValid(cached.manifest, baseUrl)
    assertManifestActive(cached.manifest, baseUrl)
    return cached.manifest
  }

  const existingInFlight = inFlightFetches.get(baseUrl)
  if (existingInFlight) {
    const manifest = await existingInFlight
    verifyManifestSignature(manifest, expectedPayee)
    assertClientVersionSupported(manifest, baseUrl)
    assertManifestValid(manifest, baseUrl)
    assertManifestActive(manifest, baseUrl)
    return manifest
  }

  const url = baseUrl.replace(/\/$/, '') + '/.well-known/kikis-app.json'

  const fetchPromise = (async () => {
    try {
      return await withRetry(async () => {
        let raw: unknown
        let resp: Response
        let expiresAt = 0
        try {
          resp = await fetch(url, { signal: AbortSignal.timeout(manifestTimeoutMs) })
          if (!resp.ok) {
            if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
              throw httpStatusToError(
                `Manifest fetch failed: HTTP ${resp.status} from ${url}`,
                resp.status,
                resp,
              )
            }
            throw new KikisAppManifestError(
              `Manifest fetch failed: HTTP ${resp.status} from ${url}`,
            )
          }
        } catch (err) {
          if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw new KikisAppManifestTimeoutError(
              `Manifest fetch timed out after ${manifestTimeoutMs}ms from ${url}`,
              { cause: err },
            )
          }
          if (err instanceof KikisAppError) throw err
          throw wrapFetchError(err, `Manifest fetch error from ${url}`)
        }

        const now = Date.now()
        expiresAt = now + ttlFromHeaders(resp.headers, now)

        try {
          raw = await resp.json()
        } catch (err) {
          throw new KikisAppManifestError(`Manifest at ${url} is not valid JSON`, { cause: err })
        }

        const result = validator.validate(raw)
        if (!result.valid) {
          const msgs = result.errors.map(err => err.error).join('; ')
          throw new KikisAppManifestError(`Invalid manifest at ${url}: ${msgs}`)
        }

        const parsedManifest = raw as unknown as KikisAppManifest
        assertManifestValid(parsedManifest, baseUrl)
        verifyManifestSignature(parsedManifest)
        assertClientVersionSupported(parsedManifest, baseUrl)
        assertManifestActive(parsedManifest, baseUrl)
        manifestCache.set(baseUrl, { manifest: parsedManifest, fetchedAt: Date.now(), expiresAt })
        return parsedManifest
      }, retryPolicy)
    } finally {
      inFlightFetches.delete(baseUrl)
    }
  })()

  inFlightFetches.set(baseUrl, fetchPromise)

  const manifest = await fetchPromise
  verifyManifestSignature(manifest, expectedPayee)
  return manifest
}

interface ModeSelection {
  mode: PaymentMode
  reason?: 'cost-optimized'
}

/**
 * Cost-based mode selection (#6). Compares the unit cost of every available
 * mode — per-request modes (`x402`, `mpp-charge`) by `amount` and session
 * modes (`mpp-session`, `mpp-session-ws`) by `rate` when sustained sessions
 * are acceptable — and returns the cheapest mode within the caller's budget.
 *
 * Endpoint-specific price/rate overrides (`manifest.endpoints[endpoint]`,
 * selected via `options.endpoint`) take precedence over manifest-level
 * pricing.
 */
function selectByCost(
  modes: PaymentMode[],
  manifest: KikisAppManifest,
  options: ModeSelectOptions,
): ModeSelection | undefined {
  // A caller-supplied ceiling must be a well-formed USDC decimal string.
  // Validating up front keeps a malformed value ('abc', '$0.01', '') from
  // parsing to NaN/Infinity and silently disabling the budget guard, which
  // would let the cheapest mode be selected at any price.
  let budgetStroops: bigint | null = null
  if (options.budget_per_request !== undefined) {
    try {
      budgetStroops = usdcToStroops(options.budget_per_request)
    } catch {
      throw new KikisAppPolicyRejectError('invalid_budget_per_request')
    }
  }

  const endpoint = options.endpoint ? manifest.endpoints[options.endpoint] : undefined

  const unitPrice = (mode: PaymentMode): string | undefined => {
    // Endpoint-specific overrides take precedence over manifest-level pricing.
    if (endpoint) {
      const perMode = endpoint.pricing?.[mode]
      if (mode === 'mpp-session' || mode === 'mpp-session-ws') {
        return perMode?.rate ?? endpoint.rate ?? manifest.pricing[mode]?.rate
      }
      return perMode?.amount ?? endpoint.price ?? endpoint.amount ?? manifest.pricing[mode]?.amount
    }
    if (mode === 'mpp-session' || mode === 'mpp-session-ws') {
      return manifest.pricing[mode]?.rate
    }
    return manifest.pricing[mode]?.amount
  }

  const candidates: Array<{ mode: PaymentMode; amountStroops: bigint }> = []
  for (const mode of modes) {
    // Session modes are priced per voucher (`rate`) and only enter the cost
    // comparison when sustained sessions are acceptable.
    if ((mode === 'mpp-session' || mode === 'mpp-session-ws') && !options.sustained) continue
    const price = unitPrice(mode)
    if (typeof price !== 'string') continue
    try {
      candidates.push({ mode, amountStroops: usdcToStroops(price) })
    } catch {
      // Unparseable pricing can't be compared against a budget — drop it.
      continue
    }
  }

  if (candidates.length === 0) return undefined

  const affordableCandidates =
    budgetStroops === null
      ? candidates
      : candidates.filter((candidate) => candidate.amountStroops <= budgetStroops)

  if (affordableCandidates.length === 0) {
    // All candidates exceed the caller's budget ceiling — error instead of
    // silently falling through to an over-budget mode.
    if (budgetStroops !== null) {
      throw new KikisAppPolicyRejectError('budget_per_request_exceeded')
    }
    return undefined
  }

  const cheapestCandidate = [...affordableCandidates].sort((a, b) =>
    a.amountStroops < b.amountStroops ? -1 : a.amountStroops > b.amountStroops ? 1 : 0,
  )[0]
  return { mode: cheapestCandidate.mode, reason: 'cost-optimized' }
}

function selectFromModes(
  modes: PaymentMode[],
  manifest: KikisAppManifest,
  options: ModeSelectOptions,
): ModeSelection | undefined {
  if (options.sustained || options.session) {
    // Prefer the session variant matching the requested transport, falling
    // back to the other session variant when the preferred one is missing.
    if (options.transport === 'websocket') {
      if (modes.includes('mpp-session-ws')) return { mode: 'mpp-session-ws' }
      if (modes.includes('mpp-session')) return { mode: 'mpp-session' }
    } else {
      if (modes.includes('mpp-session')) return { mode: 'mpp-session' }
      if (modes.includes('mpp-session-ws')) return { mode: 'mpp-session-ws' }
    }
  }

  if (options.optimize === 'cost') {
    return selectByCost(modes, manifest, options)
  }

  if (modes.includes('mpp-charge')) return { mode: 'mpp-charge' }
  if (modes.includes('x402')) return { mode: 'x402' }
  return undefined
}

function logSelection(
  manifest: KikisAppManifest,
  selection: ModeSelection,
  log: KikisAppLogger,
  deprecated: boolean,
): void {
  const reason = selection.reason ? ` (${selection.reason})` : ''
  if (deprecated) {
    log(
      'warn',
      `[KikisApp] WARNING: ${manifest.name} → ${selection.mode}${reason}; selected deprecated mode because no active supported mode is available`,
    )
    return
  }
  log('info', `[KikisApp] ${manifest.name} → ${selection.mode}${reason}`)
}

/**
 * Deterministic mode selection per Section 6.3 of KIKIS_APP_MASTER.md.
 *
 * Active modes are always considered before modes listed in `deprecated_modes`.
 * Deprecated modes remain usable as a compatibility fallback and produce a
 * logger warning when selected. An explicit forceMode remains authoritative,
 * but also warns when the forced mode is deprecated.
 */
export function selectMode(
  manifest: KikisAppManifest,
  options: ModeSelectOptions = {},
): PaymentMode {
  const modes = manifest.modes
  const log = options.logger ?? noopLogger
  const deprecatedSet = new Set(manifest.deprecated_modes ?? [])

  if (options.forceMode) {
    if (!modes.includes(options.forceMode)) {
      throw new KikisAppNoSupportedModeError(
        `Provider does not support forced mode: ${options.forceMode} (available: ${modes.join(', ')})`,
      )
    }
    if (deprecatedSet.has(options.forceMode)) {
      log(
        'warn',
        `[KikisApp] WARNING: ${manifest.name} → ${options.forceMode} (forced); selected mode is deprecated`,
      )
    } else {
      log('info', `[KikisApp] ${manifest.name} → ${options.forceMode} (forced)`)
    }
    return options.forceMode
  }

  const activeModes = modes.filter((mode) => !deprecatedSet.has(mode))
  const deprecatedModes = modes.filter((mode) => deprecatedSet.has(mode))

  const activeSelection = selectFromModes(activeModes, manifest, options)
  if (activeSelection) {
    logSelection(manifest, activeSelection, log, false)
    return activeSelection.mode
  }

  const deprecatedSelection = selectFromModes(deprecatedModes, manifest, options)
  if (deprecatedSelection) {
    logSelection(manifest, deprecatedSelection, log, true)
    return deprecatedSelection.mode
  }

  throw new KikisAppNoSupportedModeError(
    `No supported payment mode found in manifest (modes: ${modes.join(', ')})`,
  )
}

/**
 * Rank a list of provider manifests by estimated p50 round-trip latency for a given target region.
 * Manifests declaring latency_hints for the target region are sorted ascending by latency (lowest first).
 * Manifests that list the region in `regions` without an explicit latency hint come next.
 * Manifests not advertising the target region come last.
 */
export function rankProvidersByLatency(
  manifests: KikisAppManifest[],
  targetRegion: string,
): KikisAppManifest[] {
  return [...manifests].sort((a, b) => {
    const latA = a.latency_hints?.[targetRegion]
    const latB = b.latency_hints?.[targetRegion]
    const inRegionsA = a.regions?.includes(targetRegion) ?? false
    const inRegionsB = b.regions?.includes(targetRegion) ?? false

    // Both have numeric latency hints
    if (latA !== undefined && latB !== undefined) {
      return latA - latB
    }
    if (latA !== undefined) return -1
    if (latB !== undefined) return 1

    // Neither has explicit latency hint, check regions inclusion
    if (inRegionsA && !inRegionsB) return -1
    if (!inRegionsA && inRegionsB) return 1

    return 0
  })
}

