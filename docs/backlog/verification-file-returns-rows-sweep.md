# Backlog — verification-file returns-rows sweep (P2 hygiene)

**Filed:** 2026-08-13 (Mateo Aug 13 correction 0b).
**Priority:** P2 hygiene. No behavior change; visibility only. Do
opportunistically when touching any verification file; a dedicated
sweep is optional.

## The problem

Every `*_verification.sql` file in `migrations/` that uses the
`BEGIN … DO $$ RAISE EXCEPTION … END $$; COMMIT;` pattern has been
**silent on pass since day one**. The Supabase SQL Editor returns
the result of the LAST statement in a paste; a bare `DO` block
returns nothing, `COMMIT` returns nothing. Jose could not
distinguish:
- passed all gates (no rows, no error), OR
- forgot to run the file (no rows, no error)

Mateo's Aug 9 rule: "a verification file returning no rows on
success is indistinguishable from one that never ran." The rule was
right. The pattern I first tried to implement it (final SELECT before
COMMIT) still had `COMMIT` as the last statement, so it produced
silence anyway. Discovered when Jose reported the approve_vehicle
verification "silent" on 2026-08-13.

## The fix

Verification files are read-only assertions — nothing to roll back.
Drop `BEGIN;` and `COMMIT;` entirely. Every `DO $$ … END $$;` block
still RAISEs on failure and aborts the paste with the exception
message. Add a terminal `SELECT` that returns one PASS row:

```sql
-- (No BEGIN)
DO $$ … RAISE EXCEPTION 'VQ.<GATE>: …' … END $$;
DO $$ … END $$;
DO $$ … END $$;

SELECT
  'PASS'::TEXT                   AS status,
  '<name-or-migration>'::TEXT    AS target,
  ARRAY['GATE_1','GATE_2', …]    AS gates_verified,
  now()                          AS verified_at;
-- (No COMMIT)
```

**Non-verification migrations still use `BEGIN`/`COMMIT`.** Those
DO have work to roll back on failure — dropping the transaction wrap
would leave a partial CREATE on error. Only VERIFICATION files (read-
only, assertion-only) get the no-transaction shape.

## Files touched by this sweep

Applied 2026-08-13 alongside the correction:

- ✅ [migrations/20260809_approve_vehicle_null_property_scope_hardening_verification.sql](../../migrations/20260809_approve_vehicle_null_property_scope_hardening_verification.sql)
- ✅ [migrations/20260809_deactivate_vehicle_null_property_scope_hardening_verification.sql](../../migrations/20260809_deactivate_vehicle_null_property_scope_hardening_verification.sql)

## Files not yet touched

Every other `*_verification.sql` in `migrations/`. Retrofit shape
opportunistically when touching them. Suggested command to enumerate:

```bash
ls migrations/*_verification.sql | while read f; do
  if grep -q '^BEGIN;' "$f" && ! grep -q "'PASS'" "$f"; then
    echo "$f"
  fi
done
```

Each retrofit is mechanical:
1. Delete leading `BEGIN;` line
2. Delete trailing `COMMIT;` line
3. Append terminal SELECT listing the VQ.\* gates checked

## Related

- Memory: [[feedback_verification_returns_rows_no_transaction]]
- Aug 9 origin rule: verification must be observable, not silent
