import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KikisAppError,
  KikisAppManifestError,
  KikisAppFacilitatorError,
  KikisAppNetworkError,
  parseRetryAfterMs,
} from '../errors.js'
import { withRetry, backoffDelayMs, DEFAULT_RETRY_POLICY } from '../internal/retry.js'

describe('backoffDelayMs', () => {
  it('applies full jitter within exponential backoff range', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5

    try {
      assert.equal(backoffDelayMs(0, 250), 125)
      assert.equal(backoffDelayMs(1, 250), 250)
      assert.equal(backoffDelayMs(2, 250), 500)
      assert.equal(backoffDelayMs(3, 250), 1000)
      assert.equal(backoffDelayMs(4, 250), 2000)
    } finally {
      Math.random = originalRandom
    }
  })

  it('caps jittered backoff at maxDelayMs', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5

    try {
      assert.equal(backoffDelayMs(10, 250, 1000), 500)
    } finally {
      Math.random = originalRandom
    }
  })
})

describe('withRetry', () => {
  it('retries retryable errors up to maxAttempts', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) {
          throw new KikisAppNetworkError('transient')
        }
        return Promise.resolve('ok')
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new KikisAppManifestError('invalid manifest')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof KikisAppManifestError,
    )
    assert.equal(calls, 1)
  })

  it('honors retryAfterMs from facilitator errors', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }) as typeof setTimeout

    let calls = 0
    try {
      await assert.rejects(
        () =>
          withRetry(
            () => {
              calls++
              throw new KikisAppFacilitatorError('rate limited', 429, {
                retryAfterMs: 750,
              })
            },
            { maxAttempts: 3, baseDelayMs: 250 },
          ),
        (err: unknown) => err instanceof KikisAppFacilitatorError,
      )
      assert.equal(calls, 3)
      assert.ok(delays.length >= 2, 'expected at least 2 retry delays')
      assert.ok(
        delays.every((d) => d === 750),
        `expected Retry-After delay 750ms, got ${delays.join(',')}`,
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('uses capped full jitter for retry delays when retryAfterMs is absent', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    const originalRandom = Math.random
    Math.random = () => 0.25
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }) as typeof setTimeout

    let calls = 0
    try {
      const result = await withRetry(
        async () => {
          calls++
          if (calls < 3) {
            throw new KikisAppNetworkError('transient')
          }
          return Promise.resolve('ok')
        },
        { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 150 },
      )
      assert.equal(result, 'ok')
      assert.equal(calls, 3)
      assert.deepEqual(delays, [25, 37])
    } finally {
      globalThis.setTimeout = originalSetTimeout
      Math.random = originalRandom
    }
  })

  it('stops at maxAttempts for persistent retryable errors', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new KikisAppNetworkError('still down')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof KikisAppNetworkError,
    )
    assert.equal(calls, DEFAULT_RETRY_POLICY.maxAttempts)
  })

  it('calls onRetry with attempt number, error, and delay before each retry', async () => {
    const retries: Array<{ attempt: number; error: Error; delay: number }> = []
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) {
          throw new KikisAppNetworkError('transient')
        }
        return Promise.resolve('ok')
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        onRetry: (attempt, error, nextDelayMs) => {
          retries.push({ attempt, error, delay: nextDelayMs })
        },
      },
    )
    assert.equal(result, 'ok')
    assert.equal(retries.length, 2)
    const first = retries[0]!
    const second = retries[1]!
    assert.equal(first.attempt, 0)
    assert.ok(first.error instanceof KikisAppNetworkError)
    assert.ok(first.delay >= 0)
    assert.equal(second.attempt, 1)
  })

  it('does not call onRetry when the error is not retryable', async () => {
    const retries: number[] = []
    await assert.rejects(
      () =>
        withRetry(
          () => {
            throw new KikisAppManifestError('bad')
          },
          {
            maxAttempts: 4,
            baseDelayMs: 1,
            onRetry: (attempt) => {
              retries.push(attempt)
            },
          },
        ),
      (err: unknown) => err instanceof KikisAppManifestError,
    )
    assert.equal(retries.length, 0)
  })

  it('does not call onRetry on the final attempt', async () => {
    const retries: number[] = []
    await assert.rejects(
      () =>
        withRetry(
          () => {
            throw new KikisAppNetworkError('still down')
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1,
            onRetry: (attempt) => {
              retries.push(attempt)
            },
          },
        ),
      (err: unknown) => err instanceof KikisAppNetworkError,
    )
    assert.deepEqual(retries, [0, 1])
  })

  it('isolates onRetry callback errors and retries with original error surfaced', async () => {
    let calls = 0
    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...params: any[]) => {
      if (typeof params[0] === 'string' && params[0].includes('onRetry')) {
        loggedErrors.push(...params.slice(1))
      }
      originalConsoleError(...params)
    }

    try {
      await assert.rejects(
        () =>
          withRetry(
            () => {
              calls++
              throw new KikisAppNetworkError('transient')
            },
            {
              maxAttempts: 3,
              baseDelayMs: 1,
              onRetry: () => {
                throw new Error('logger exploded')
              },
            },
          ),
        (err: unknown) =>
          err instanceof KikisAppNetworkError &&
          err.message === 'transient',
      )
      assert.equal(calls, 3)
      assert.ok(
        loggedErrors.some((e) => e instanceof Error && e.message === 'logger exploded'),
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  it('isolates async onRetry rejections and continues retrying', async () => {
    let calls = 0
    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...params: any[]) => {
      if (typeof params[0] === 'string' && params[0].includes('onRetry')) {
        loggedErrors.push(...params.slice(1))
      }
      originalConsoleError(...params)
    }

    try {
      const result = await withRetry(
        async () => {
          calls++
          if (calls < 3) {
            throw new KikisAppNetworkError('transient')
          }
          return Promise.resolve('ok')
        },
        {
          maxAttempts: 4,
          baseDelayMs: 1,
          onRetry: async () => {
            throw new Error('logger exploded async')
          },
        },
      )
      assert.equal(result, 'ok')
      assert.equal(calls, 3)
      assert.ok(
        loggedErrors.some((e) => e instanceof Error && e.message === 'logger exploded async'),
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  it('rethrows non-KikisApp errors immediately', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new TypeError('unexpected')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof TypeError,
    )
    assert.equal(calls, 1)
  })

  it('retries on simulated TypeError: fetch failed and succeeds when back online', async () => {
    let calls = 0
    const result = await withRetry(
      () => {
        calls++
        if (calls < 3) {
          throw new TypeError('fetch failed')
        }
        return Promise.resolve('recovered')
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    )
    assert.equal(result, 'recovered')
    assert.equal(calls, 3)
  })

  it('retries on simulated TypeError: fetch failed up to maxAttempts before exhausting', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new TypeError('fetch failed')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof TypeError)
        assert.equal((err as TypeError).message, 'fetch failed')
        return true
      },
    )
    assert.equal(calls, 4)
  })

  it('retries on socket errors and abort errors (ConnectTimeoutError, ECONNRESET)', async () => {
    let calls = 0
    const socketErr = new Error('read ECONNRESET')
    ;(socketErr as any).code = 'ECONNRESET'

    const result = await withRetry(
      () => {
        calls++
        if (calls === 1) {
          throw socketErr
        }
        if (calls === 2) {
          const timeoutErr = new Error('connection timeout')
          timeoutErr.name = 'ConnectTimeoutError'
          throw timeoutErr
        }
        return Promise.resolve('ok')
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })
})

describe('withRetry — AbortSignal (#42)', () => {
  it('aborting during backoff rejects immediately with AbortError and stops retrying', { timeout: 10_000 }, async () => {
    const controller = new AbortController()
    let calls = 0
    const startedAt = Date.now()
    const originalRandom = Math.random
    Math.random = () => 1.0
    try {
      const retryPromise = withRetry(
        async () => {
          calls++
          throw new KikisAppNetworkError('transient')
        },
        { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal },
      )
      // Abort while the loop is sleeping its first (minute-long) backoff.
      setTimeout(() => controller.abort(), 10)
      await assert.rejects(
        retryPromise,
        (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
      )
      assert.equal(calls, 1, 'no further attempts after abort')
      assert.ok(
        Date.now() - startedAt < 5_000,
        'abort must cut the backoff short, not wait out baseDelayMs',
      )
    } finally {
      Math.random = originalRandom
    }
  })

  it('rejects without calling fn when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++
            return 'ok'
          },
          { maxAttempts: 4, baseDelayMs: 1, signal: controller.signal },
        ),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    )
    assert.equal(calls, 0)
  })

  it('clears the pending backoff timer on abort (no leaked timers)', { timeout: 10_000 }, async () => {
    const controller = new AbortController()
    const backoffTimers: Array<{ handle: unknown; ms: number }> = []
    const cleared = new Set<unknown>()
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const originalRandom = Math.random
    Math.random = () => 1.0
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const handle = originalSetTimeout(fn, ms)
      backoffTimers.push({ handle, ms: ms ?? 0 })
      return handle
    }) as typeof setTimeout
    globalThis.clearTimeout = ((handle: unknown) => {
      cleared.add(handle)
      ;(originalClearTimeout as (h: unknown) => void)(handle)
    }) as typeof clearTimeout

    try {
      const retryPromise = withRetry(
        async () => {
          throw new KikisAppNetworkError('transient')
        },
        { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal },
      )
      setTimeout(() => controller.abort(), 10)
      await assert.rejects(
        retryPromise,
        (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
      )

      // Only the minute-long backoff timers belong to withRetry — the 10ms
      // abort timer above is the test's own.
      const withRetryTimers = backoffTimers.filter((t) => t.ms >= 60_000)
      assert.ok(withRetryTimers.length >= 1, 'expected at least one backoff timer')
      for (const timer of withRetryTimers) {
        assert.ok(cleared.has(timer.handle), 'backoff timer must be cleared on abort')
      }
    } finally {
      Math.random = originalRandom
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('produces no unhandled rejections when abort fires during backoff', { timeout: 10_000 }, async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const originalRandom = Math.random
    Math.random = () => 1.0
    try {
      const controller = new AbortController()
      const retryPromise = withRetry(
        async () => {
          throw new KikisAppNetworkError('transient')
        },
        { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal },
      )
      setTimeout(() => controller.abort(), 10)
      await assert.rejects(
        retryPromise,
        (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
      )
      // Give the microtask/macrotask queues a beat to surface stray rejections.
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.deepEqual(unhandled, [])
    } finally {
      Math.random = originalRandom
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('ignores an abort that happens only after a successful run', async () => {
    const controller = new AbortController()
    const result = await withRetry(async () => 'ok', {
      maxAttempts: 3,
      baseDelayMs: 1,
      signal: controller.signal,
    })
    assert.equal(result, 'ok')
    // A late abort must not create unhandled rejections via a stale listener.
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})

describe('parseRetryAfterMs', () => {
  it('parses Retry-After seconds', () => {
    const res = new Response(null, { headers: { 'Retry-After': '2' } })
    assert.equal(parseRetryAfterMs(res), 2000)
  })
})
