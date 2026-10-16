-- ─── Issue #59: claim_settlement_replay hard cap ─────────────────────
--
-- Boundary test for the replay limit enforced by migration
-- 006_settlement_replay_limit.sql: with the default budget of 5, claims 1-5
-- succeed, the 6th claim must be refused by the database itself (-1), the
-- stored counter must not move past the budget, and an unknown key must
-- still return NULL.
--
-- Run against a database where the migrations have been applied:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/006_settlement_replay_limit.test.sql
--
-- Everything runs inside one transaction and rolls back, so no probe rows
-- are left behind.

BEGIN;

DO $$
DECLARE
    v_claim integer;
    v_count integer;
BEGIN
    INSERT INTO settlements (key) VALUES ('__replay_cap_probe__');

    -- Claims 1..5 (the default budget) succeed and report the new count.
    FOR i IN 1..5 LOOP
        SELECT claim_settlement_replay('__replay_cap_probe__') INTO v_claim;
        ASSERT v_claim = i,
            format('claim %s should return %s, got %s', i, i, v_claim);
    END LOOP;

    -- The 6th claim hits the hard cap: refused with -1 ...
    SELECT claim_settlement_replay('__replay_cap_probe__') INTO v_claim;
    ASSERT v_claim = -1,
        format('the 6th claim must be refused with -1, got %s', v_claim);

    -- ... and the stored counter is unchanged.
    SELECT replay_count INTO v_count
      FROM settlements WHERE key = '__replay_cap_probe__';
    ASSERT v_count = 5,
        format('replay_count must stay at the budget (5), got %s', v_count);

    -- An explicit p_max_replays argument is honoured at its own boundary.
    SELECT claim_settlement_replay('__replay_cap_probe__', 5) INTO v_claim;
    ASSERT v_claim = -1,
        format('explicit p_max_replays = 5 must reject as well, got %s', v_claim);

    -- An unknown key returns NULL (distinct from the -1 cap refusal).
    SELECT claim_settlement_replay('__no_such_key__') INTO v_claim;
    ASSERT v_claim IS NULL,
        format('unknown key must return NULL, got %s', v_claim);

    RAISE NOTICE 'claim_settlement_replay hard cap verified';
END $$;

ROLLBACK;
