-- ════════════════════════════════════════════════════════════════════
-- PUBLIC-grant retrofit — CORRECTIVE
-- Drafted: May 27, 2026 — NOT YET APPLIED.
--
-- ── CONTEXT ─────────────────────────────────────────────────────────
-- The original named-5 retrofit migration (4c733d5,
-- migrations/20260526_public_grant_retrofit_named5.sql) was applied via
-- SQL Editor and produced a PARTIAL-APPLY state. Post-apply audit
-- output (Jose ran the Q1 audit immediately after):
--
--   Function                | Grantees                                        | Status
--   ------------------------|-------------------------------------------------|---------
--   validate_proposal_code  | PUBLIC, anon, authenticated, postgres, srv_role | UNCHANGED
--   redeem_proposal_code    | authenticated, postgres, service_role           | DONE CORRECTLY
--   pm_plate_lookup         | PUBLIC, authenticated, postgres, service_role   | PARTIAL
--   check_resident_plate    | PUBLIC, anon, authenticated, postgres, srv_role | UNCHANGED
--   create_visitor_pass     | PUBLIC, anon, authenticated, postgres, srv_role | UNCHANGED
--
-- redeem_proposal_code is COMPLETE — both PUBLIC and anon revoked, end
-- state matches spec. NOT touched by this corrective.
--
-- pm_plate_lookup is PARTIAL — anon revoked but PUBLIC still present.
-- PUBLIC inheritance means anon can still invoke. Needs PUBLIC revoke.
--
-- validate_proposal_code, check_resident_plate, create_visitor_pass
-- are UNCHANGED — PUBLIC still present on all three. Each retains anon
-- and authenticated as intended; only PUBLIC needs revoking.
--
-- ── ROOT CAUSE (per Jose's apply-mechanic note) ────────────────────
-- SQL Editor applied 4c733d5 statement-by-statement rather than as a
-- single BEGIN/COMMIT block, causing partial execution + some failed
-- statements that didn't roll back their successful neighbors. The
-- migration content was correct; the apply path was the issue.
--
-- Forward-looking lesson worth filing as feedback when memory next
-- batches: SQL Editor users must paste BEGIN/COMMIT as ONE block,
-- not statement-by-statement.
--
-- ── PRE-APPLY VERIFICATION (Jose runs in SQL Editor before applying) ─
-- Re-run the partial-state audit. Should still match the table above
-- (no out-of-band changes since Jose's earlier audit):
--
--   SELECT p.proname, r.grantee, r.privilege_type
--   FROM information_schema.routine_privileges r
--   JOIN pg_proc p ON p.proname = r.routine_name
--   WHERE r.routine_schema = 'public'
--     AND r.routine_name IN (
--       'validate_proposal_code', 'redeem_proposal_code',
--       'pm_plate_lookup', 'check_resident_plate', 'create_visitor_pass'
--     )
--     AND r.privilege_type = 'EXECUTE'
--   ORDER BY p.proname, r.grantee;
--
--   If pre-state diverges from the partial-state table above, STOP
--   and re-audit before applying this corrective.
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block below into SQL Editor as ONE
-- block, then click Run ONCE. Do NOT click Run on individual
-- statements — that's what produced the partial-apply state on 4c733d5.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- pm_plate_lookup: finish the partial tightening (PUBLIC still present
-- on the function; anon was successfully revoked by 4c733d5).
REVOKE EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;

-- validate_proposal_code: REVOKE PUBLIC (anon retained for /signup/redeem
-- anon precheck use case).
REVOKE EXECUTE ON FUNCTION public.validate_proposal_code(TEXT) FROM PUBLIC;

-- check_resident_plate: REVOKE PUBLIC (anon retained for /visitor anon
-- plate precheck).
REVOKE EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT) FROM PUBLIC;

-- create_visitor_pass: REVOKE PUBLIC (anon retained for /visitor anon
-- pass submit). Multi-line arg form preserved exactly per spec.
REVOKE EXECUTE ON FUNCTION public.create_visitor_pass(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- ── A. PUBLIC grant absent on all 5 functions ──────────────────────
--   SELECT p.proname, r.grantee, r.privilege_type
--   FROM information_schema.routine_privileges r
--   JOIN pg_proc p ON p.proname = r.routine_name
--   WHERE r.routine_schema = 'public'
--     AND r.routine_name IN (
--       'validate_proposal_code', 'redeem_proposal_code',
--       'pm_plate_lookup', 'check_resident_plate', 'create_visitor_pass'
--     )
--     AND r.privilege_type = 'EXECUTE'
--   ORDER BY p.proname, r.grantee;
--
--   Expected post-corrective — each function present WITHOUT a PUBLIC row:
--     redeem_proposal_code    → authenticated, postgres, service_role
--     pm_plate_lookup         → authenticated, postgres, service_role
--     validate_proposal_code  → anon, authenticated, postgres, service_role
--     check_resident_plate    → anon, authenticated, postgres, service_role
--     create_visitor_pass     → anon, authenticated, postgres, service_role
--
-- ── B-E (smoke tests from 4c733d5, re-runnable) ────────────────────
-- Reference migrations/20260526_public_grant_retrofit_named5.sql footer
-- for the full smoke battery:
--   B — Anon redeem_proposal_code rejected at grant level (42501)
--   C — Anon pm_plate_lookup rejected at grant level (42501) ← was PARTIAL
--   D — Anon validate/check_resident_plate/create_visitor_pass still work
--   E — Authenticated smoke confirms all 5 callable
--
-- After this corrective, smoke C should reach 42501 grant-level rejection
-- where pre-corrective it would have reached the function-body role
-- check (returning a body-RAISE error message rather than 42501).
--
-- ── ROLLBACK (if needed) ────────────────────────────────────────────
-- Re-grant PUBLIC on the 4 functions, restoring pre-corrective state.
-- pm_plate_lookup's anon grant was already revoked by 4c733d5 and is
-- not touched here.
--
--   BEGIN;
--   GRANT EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.validate_proposal_code(TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.create_visitor_pass(
--     TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
--   ) TO PUBLIC;
--   COMMIT;
--
-- No data state affected. Rollback restores partial-state pre-corrective.
-- To fully revert to pre-4c733d5 state, also run 4c733d5's rollback block.
-- ════════════════════════════════════════════════════════════════════
