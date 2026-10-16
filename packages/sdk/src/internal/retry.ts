import { KikisAppError, KikisAppNetworkError } from '../errors.js'
import { resolveLogger, type KikisAppLogger } from './logger.js'

export interface RetryPolicy {
  /** Total attempts including the first call. Default: 4 (3 retries). */
  maxAttempts?: number
  /** Base delay for exponential backoff in ms. Default: 250. */
  baseDelayMs?: number
  /** Maximum jittered backoff delay in ms. Default: 30000. */
  maxDelayMs?: number
  /** Called before each retry with the attempt number, error, and upcoming delay. */
  /**
   * Observability hook fired before each retry. Awaited, so a returned promise
   * is honoured; throwing or rejecting is caught and logged rather than
   * aborting the retry loop.
   */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void | Promise<void>
  /**
   * Log sink for internal diagnostics (an `onRetry` hook that throws).
   * Defaults to a console-backed logger.
   */
  logger?: KikisAppLogger
}

export const DEFAULT_RETRY_POLICY: Required<Omit<RetryPolicy, 'onRetry' | 'logger'>> = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
}

/**
 * Full jitter exponential backoff delay.
 * Delay range: 0..min(maxDelayMs, baseDelayMs * 2 ** attempt).
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs = DEFAULT_RETRY_POLICY.maxDelayMs,
): number {
  const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.floor(Math.random() * (cappedDelay + 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Determines whether an error represents a transient network or abort failure
 * that should be retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof KikisAppError) {
    return err.retryable
  }
  if (!(err instanceof Error)) {
    return false
  }
  if (err.name === 'TypeError' && /fetch failed|failed to fetch/i.test(err.message)) {
    return true
  }
  if (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    err.name === 'ConnectTimeoutError' ||
    err.name === 'SocketError'
  ) {
    return true
  }
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || /aborted/i.test(err.message)) {
      return true
    }
  }
  const anyErr = err as Record<string, unknown>
  const code = anyErr['code'] || (anyErr['cause'] as Record<string, unknown> | undefined)?.['code']
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return true
  }
  const causeName = (anyErr['cause'] as Record<string, unknown> | undefined)?.['name']
  if (
    causeName === 'ConnectTimeoutError' ||
    causeName === 'SocketError' ||
    causeName === 'TimeoutError' ||
    causeName === 'AbortError'
  ) {
    return true
  }
  return false
}

/**
 * Execute `fn` with exponential backoff on retryable KikisAppErrors and transient network errors.
 * Honors `retryAfterMs` from facilitator 429/503 responses when present.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, onRetry, logger } = {
    ...DEFAULT_RETRY_POLICY,
    ...policy,
  }
  const log = resolveLogger(logger)
  let lastError: KikisAppError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isTransient = isTransientNetworkError(err)
      if (!(err instanceof KikisAppError) && !isTransient) {
        throw err
      }

      const retryable = err instanceof KikisAppError ? err.retryable : true
      const retryAfterMs = err instanceof KikisAppError ? err.retryAfterMs : undefined
      const effectiveErr =
        err instanceof KikisAppError
          ? err
          : new KikisAppNetworkError(err instanceof Error ? err.message : String(err), { cause: err })
      lastError = effectiveErr

      if (!retryable || attempt >= maxAttempts - 1) {
        throw err
      }

      const delay =
        retryAfterMs !== undefined
          ? retryAfterMs
          : backoffDelayMs(attempt, baseDelayMs, maxDelayMs)

      if (onRetry) {
        try {
          await onRetry(attempt, err as Error, delay)
        } catch (cbErr) {
          log('error', '[withRetry] onRetry callback threw:', { error: cbErr })
        }
      }

      await sleep(delay)
    }
  }

  throw lastError ?? new KikisAppError('Retry exhausted', 'NETWORK', false)
}
