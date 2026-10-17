import type { SupabaseClient } from '@supabase/supabase-js'
import type { SeenTxStore, SettlementRecord } from '../provider/SeenTxStore.js'
import { KikisAppNetworkError } from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { resolveLogger, type KikisAppLogger } from '../internal/logger.js'

export interface SupabaseSeenTxStoreOptions {
  /** Optional secondary fallback store (e.g. InMemorySeenTxStore) during DB outages. */
  fallbackStore?: SeenTxStore | undefined
  /** Custom retry policy for transient database/network errors. */
  retryPolicy?: RetryPolicy | undefined
  /** Structured logger for failure warnings. */
  logger?: KikisAppLogger | undefined
}

const DEFAULT_STORE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 25,
  maxDelayMs: 200,
}

/**
 * Settlement idempotency backed by Postgres via Supabase.
 *
 * The in-memory default {@link InMemorySeenTxStore} is per-handler and
 * per-process. On serverless/edge runtimes (Cloudflare Workers, Deno Deploy,
 * Lambda@Edge) each request may land in a fresh isolate with an empty cache.
 * An agent retrying after a post-settlement timeout would miss the cache and
 * settle a second time, charging twice on-chain.
 *
 * Postgres gives the read-your-writes consistency this needs; Workers KV
 * would not, since a retry can outrun propagation and reintroduce the double
 * settle.
 *
 * Requires the `settlements` table from migration `003_settlement_idempotency`
 * and the `claim_settlement_replay` function from migration
 * `006_settlement_replay_limit`:
 *
 * ```sql
 * CREATE TABLE settlements (
 *   key        TEXT PRIMARY KEY,
 *   tx_hash    TEXT,
 *   headers    JSONB,
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * ```
 *
 * @example
 * ```ts
 * import { SupabaseSeenTxStore } from '@kikis-app/kikis-app/provider/hono'
 * import { createClient } from '@supabase/supabase-js'
 *
 * const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
 * const seenTxStore = new SupabaseSeenTxStore(supabase)
 *
 * kikisAppHono({ ..., seenTxStore })
 * ```
 */
export class SupabaseSeenTxStore implements SeenTxStore {
  readonly fallbackStore?: SeenTxStore | undefined
  private readonly retryPolicy: RetryPolicy
  private readonly log: ReturnType<typeof resolveLogger>

  constructor(
    private readonly supabase: SupabaseClient,
    options: SupabaseSeenTxStoreOptions = {},
  ) {
    this.fallbackStore = options.fallbackStore
    this.retryPolicy = options.retryPolicy ?? DEFAULT_STORE_RETRY_POLICY
    this.log = resolveLogger(options.logger)
  }

  async get(key: string): Promise<SettlementRecord | undefined> {
    const fetchRecord = async () => {
      const { data, error } = await this.supabase
        .from('settlements')
        .select('tx_hash, headers, created_at')
        .eq('key', key)
        .maybeSingle()

      if (error) {
        throw new KikisAppNetworkError(`SupabaseSeenTxStore.get failed: ${error.message}`, {
          cause: error,
        })
      }
      return data
    }

    let data: any
    try {
      data = await withRetry(fetchRecord, this.retryPolicy)
    } catch (err) {
      if (this.fallbackStore) {
        this.log(
          'warn',
          `[SupabaseSeenTxStore] get failed after retries, delegating to fallback store: ${(err as Error).message}`,
        )
        return this.fallbackStore.get(key)
      }
      throw err instanceof KikisAppNetworkError
        ? err
        : new KikisAppNetworkError(`SupabaseSeenTxStore.get failed: ${(err as Error).message}`, {
            cause: err,
          })
    }

    if (!data) return undefined

    const headers = data.headers as Record<string, string> | null
    return {
      txHash: (data.tx_hash as string | null) ?? null,
      ...(headers ? { headers } : {}),
      createdAt: Date.parse(data.created_at as string),
    }
  }

  async set(key: string, record: SettlementRecord): Promise<void> {
    const upsertRecord = async () => {
      const { error } = await this.supabase.from('settlements').upsert(
        {
          key,
          tx_hash: record.txHash,
          headers: record.headers ?? null,
          created_at: new Date(record.createdAt ?? Date.now()).toISOString(),
        },
        { onConflict: 'key' },
      )

      if (error) {
        throw new KikisAppNetworkError(`SupabaseSeenTxStore.set failed: ${error.message}`, {
          cause: error,
        })
      }
    }

    try {
      await withRetry(upsertRecord, this.retryPolicy)
    } catch (err) {
      if (this.fallbackStore) {
        this.log(
          'warn',
          `[SupabaseSeenTxStore] set failed after retries, delegating to fallback store: ${(err as Error).message}`,
        )
        return this.fallbackStore.set(key, record)
      }
      throw err instanceof KikisAppNetworkError
        ? err
        : new KikisAppNetworkError(`SupabaseSeenTxStore.set failed: ${(err as Error).message}`, {
            cause: err,
          })
    }
  }

  /**
   * Atomically increment the settlement's replay counter through the
   * `claim_settlement_replay` Postgres function (migration 006). The UPDATE's
   * row lock gives concurrent claims distinct counts. Returns `Infinity` when
   * the claim is refused — the key no longer exists (`null`) or its
   * database-level replay budget is exhausted (`-1`) — so the caller treats it
   * as spent in both cases.
   */
  async claimReplay(key: string): Promise<number> {
    const rpcCall = async () => {
      const { data, error } = await this.supabase.rpc('claim_settlement_replay', {
        p_key: key,
      })

      if (error) {
        throw new KikisAppNetworkError(`SupabaseSeenTxStore.claimReplay failed: ${error.message}`, {
          cause: error,
        })
      }
      return data
    }

    let data: any
    try {
      data = await withRetry(rpcCall, this.retryPolicy)
    } catch (err) {
      if (this.fallbackStore?.claimReplay) {
        this.log(
          'warn',
          `[SupabaseSeenTxStore] claimReplay failed after retries, delegating to fallback store: ${(err as Error).message}`,
        )
        return this.fallbackStore.claimReplay(key)
      }
      throw err instanceof KikisAppNetworkError
        ? err
        : new KikisAppNetworkError(
            `SupabaseSeenTxStore.claimReplay failed: ${(err as Error).message}`,
            { cause: err },
          )
    }

    // `null` — unknown key; `-1` — `replay_count` already at `p_max_replays`
    // and the database refused the increment. Neither may replay.
    if (data == null || (data as number) < 0) return Number.POSITIVE_INFINITY
    return data as number
  }
}
