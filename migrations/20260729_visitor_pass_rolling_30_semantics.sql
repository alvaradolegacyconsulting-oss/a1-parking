-- ══════════════════════════════════════════════════════════════════════
-- 20260729_visitor_pass_rolling_30_semantics.sql
-- Visitor pass limit: concurrency → rolling-30 semantics
-- ══════════════════════════════════════════════════════════════════════
--
-- Rewrites the count predicate in both functions of
-- 20260514_enforce_visitor_pass_limit.sql:
--   • enforce_visitor_pass_limit()  — the trigger that blocks INSERTs
--   • get_plate_pass_status()       — the advisory pre-check RPC
--
-- CREATE OR REPLACE (not DROP+CREATE) — preserves EXECUTE grants
-- (anon+authenticated on get_plate_pass_status; trigger has no grant
-- surface). Signatures unchanged.
--
-- ── LOCKED DECISIONS (Jose, 2026-07-28) ──────────────────────────────
--   1. Window: ROLLING 30 DAYS (created_at > now() - interval '30 days')
--      Only option that stops daily-visitor-as-parking abuse. Calendar
--      month gameable at boundaries.
--   2. Revoked passes: COUNT EVERYTHING ISSUED. is_active is NOT part
--      of the count predicate. Simplest to explain, ungameable — no
--      issue-revoke-reissue reset. exempt_plates is the remedy when a
--      manager revokes in error. Do NOT re-introduce `is_active=TRUE`
--      as an "obvious fix" — it silently reopens the abuse path.
--   3. Quota permanence: quota is permanent within the 30-day window.
--      No UI hard-delete of visitor_passes rows exists (confirmed via
--      grep of app/ 2026-07-28). exempt_plates is the sole reset
--      mechanism. Do NOT add a hard-delete affordance without
--      revisiting the count-everything decision.
--   4. Anon count-stripping: get_plate_pass_status RPC omits used/limit
--      keys when caller is anon (auth.uid() IS NULL). Rolling-30 turns
--      `used` into visit history for an arbitrary plate on the anon
--      /visitor page. Defense at the RPC boundary, not the render
--      layer — anyone with the anon key can call the RPC via curl.
--
-- ── SEQUENCING ───────────────────────────────────────────────────────
-- Ships BEFORE plate-status-company-scoping (formerly "Commit B"), per
-- reversed sequencing 2026-07-29: this migration is behaviourally inert
-- today (every property has visitor_pass_limit = NULL), while the
-- company-scoping op has signature changes + client callers + PostgREST
-- cache. Safe-first sequencing.
--
-- The plate-status-company-scoping migration MUST inherit this function
-- body (30-day predicate + v_is_anon branch) when it lands. Its VQ set
-- must assert both are still present. See:
-- docs/backlog/visitor-pass-limit-rolling-30-semantics.md
--
-- ── BAR-2 ANTI-WILDCARD NOTE (property ILIKE p_property in get_plate_
-- pass_status) is PRESERVED for now; plate-status-company-scoping is
-- the commit that closes it per docs/backlog/get_plate_pass_status-
-- ilike-wildcard-injection.md. This migration deliberately does not
-- fix it — merging would force redoing that arc's verification.
-- ══════════════════════════════════════════════════════════════════════


BEGIN;


-- ── STEP 1 — enforce_visitor_pass_limit (trigger, new predicate + HINT)

CREATE OR REPLACE FUNCTION enforce_visitor_pass_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT;
  v_exempt TEXT[];
  v_current_count INT;
  v_normalized_plate TEXT;
BEGIN
  SELECT visitor_pass_limit, exempt_plates
  INTO v_limit, v_exempt
  FROM properties
  WHERE name = NEW.property;

  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  v_normalized_plate := UPPER(regexp_replace(NEW.plate, '[^A-Z0-9]', '', 'gi'));

  IF v_exempt IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_exempt) AS ep
    WHERE UPPER(regexp_replace(ep, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
  ) THEN
    RETURN NEW;
  END IF;

  -- 2026-07-29 rolling-30 predicate. Every pass issued in the last 30
  -- days counts against the limit — including revoked (is_active=FALSE)
  -- passes, per the count-everything-issued decision in the header.
  -- Do NOT re-add `is_active = TRUE` — that reopens issue-revoke-reissue.
  SELECT COUNT(*) INTO v_current_count
  FROM visitor_passes
  WHERE property = NEW.property
    AND UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
    AND created_at > now() - interval '30 days';

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION
      'This vehicle has already been issued % visitor passes at this property in the last 30 days.',
      v_current_count
      USING ERRCODE = '23514',
            HINT = 'Contact the property manager if you need access.';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger definition unchanged (from 20260514):
--   BEFORE INSERT ON visitor_passes FOR EACH ROW EXECUTE FUNCTION enforce_visitor_pass_limit();
-- CREATE OR REPLACE FUNCTION does not require DROP/CREATE TRIGGER.


-- ── STEP 2 — get_plate_pass_status (RPC, same predicate + v_is_anon)

CREATE OR REPLACE FUNCTION get_plate_pass_status(
  p_property TEXT,
  p_plate TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT;
  v_exempt TEXT[];
  v_current_count INT;
  v_normalized_plate TEXT;
  v_is_anon BOOLEAN;
BEGIN
  -- 🔴 auth.uid() NOT auth.jwt() — Supabase's anon key IS a JWT
  -- (role='anon', no sub claim), so auth.jwt() returns claims JSON
  -- and is NEVER NULL; a guard on auth.jwt() IS NULL would silently
  -- not fire. auth.uid() reads the sub claim, which IS null for anon.
  -- Precedent inside SECURITY DEFINER: 20260521_b65_4_redeem_signature,
  -- 20260520_b65_self_serve_signup, 20260707_b118_layer2_redeem,
  -- 20260710_acceptance_reviewed_at_signup, 20260713_tos_acceptances,
  -- plus 3 others. Do NOT "simplify" this to auth.jwt() IS NULL.
  v_is_anon := (auth.uid() IS NULL);

  IF p_property IS NULL OR p_property = '' OR p_plate IS NULL OR p_plate = '' THEN
    RETURN jsonb_build_object('state', 'unlimited');
  END IF;

  SELECT visitor_pass_limit, exempt_plates
  INTO v_limit, v_exempt
  FROM properties
  WHERE name ILIKE p_property
  LIMIT 1;

  IF v_limit IS NULL THEN
    RETURN jsonb_build_object('state', 'unlimited');
  END IF;

  v_normalized_plate := UPPER(regexp_replace(p_plate, '[^A-Z0-9]', '', 'gi'));

  IF v_exempt IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_exempt) AS ep
    WHERE UPPER(regexp_replace(ep, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
  ) THEN
    RETURN jsonb_build_object('state', 'exempt');
  END IF;

  -- 2026-07-29 rolling-30 predicate; see enforce_visitor_pass_limit for
  -- rationale.
  SELECT COUNT(*) INTO v_current_count
  FROM visitor_passes
  WHERE property ILIKE p_property
    AND UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
    AND created_at > now() - interval '30 days';

  -- Anon count-stripping: two count-carrying exits gated on v_is_anon.
  -- Three earlier exits (unlimited×2, exempt) already return no counts
  -- and are unchanged. Do NOT restructure to a single exit — plate-
  -- status-company-scoping's VQs assert body text in this function.
  IF v_current_count >= v_limit THEN
    RETURN CASE WHEN v_is_anon
      THEN jsonb_build_object('state', 'at_limit')
      ELSE jsonb_build_object('state', 'at_limit', 'used', v_current_count, 'limit', v_limit)
    END;
  END IF;

  RETURN CASE WHEN v_is_anon
    THEN jsonb_build_object('state', 'within')
    ELSE jsonb_build_object('state', 'within', 'used', v_current_count, 'limit', v_limit)
  END;
END;
$$;

-- Grants preserved by CREATE OR REPLACE (anon+authenticated retain
-- EXECUTE on get_plate_pass_status per 20260514 L157).


COMMIT;
