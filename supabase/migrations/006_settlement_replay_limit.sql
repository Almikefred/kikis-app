-- ─── Settlement replay limit ──────────────────────────────────
--
-- A settled payment may be replayed to recover the cached response after a
-- post-settlement network timeout, but only within a short window and only a
-- bounded number of times. Without a counter, the same header replays forever
-- (until eviction or the 7-day retention sweep), so one paid request unlocks
-- unlimited free responses.
--
-- `replay_count` is bumped atomically by `claim_settlement_replay`, which the
-- SDK's SupabaseSeenTxStore calls on each cache hit. The UPDATE takes a row
-- lock, so concurrent claims observe distinct counts and cannot both slip
-- under the limit.
--
-- The hard cap is enforced here, in the database engine, not in the caller:
-- `p_max_replays` bounds how many times one settled payment may ever be
-- replayed (default 5). Once `replay_count` reaches it the UPDATE matches no
-- row and the claim is refused — a buggy or hostile caller cannot drain the
-- cached responses no matter what it passes or forgets to check.

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS replay_count integer NOT NULL DEFAULT 0;

-- Drop the original uncapped single-argument signature (no-op on a fresh
-- database). Without this, CREATE OR REPLACE below would create a second
-- function and leave the uncapped one callable on databases where migration
-- 006 already ran.
DROP FUNCTION IF EXISTS claim_settlement_replay(text);

CREATE OR REPLACE FUNCTION claim_settlement_replay(
  p_key text,
  p_max_replays integer DEFAULT 5
)
RETURNS integer
LANGUAGE sql
AS $$
  WITH claimed AS (
    UPDATE settlements
    SET replay_count = replay_count + 1
    WHERE key = p_key AND replay_count < p_max_replays
    RETURNING replay_count
  )
  SELECT COALESCE(
    (SELECT replay_count FROM claimed),
    -- Claim refused: -1 when the key exists but exhausted its replay budget,
    -- NULL when the key is unknown. Callers treat both as "already spent".
    CASE WHEN EXISTS (SELECT 1 FROM settlements WHERE key = p_key) THEN -1 END
  );
$$;

-- Providers call this with the service key only. Keep the anon and
-- authenticated roles from incrementing (or probing) settlement counters.
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_settlement_replay(text, integer) TO service_role;
