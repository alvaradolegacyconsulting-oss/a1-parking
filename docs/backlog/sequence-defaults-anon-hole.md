# Backlog — anon sequence defaults reopened by `7de4ff9`

**Filed:** 2026-07-23 during DNT Commit 2 review.
**Severity:** LOW (modest exposure — anon `nextval()` burns sequence values, not a data leak).
**Priority:** Not urgent. File-and-fix after the DNT arc completes.

## The gap

Grant remediation commit `321a373` (2026-07-22) included:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
```

That line was **removed entirely** by fix commit `7de4ff9` (same day) because it broke authenticated
INSERT on future BIGSERIAL tables — every new table would fail at `nextval()` until an explicit
`GRANT USAGE ... TO authenticated` was added, and the audit_logs_id_seq trap had just proved that
hardcoded per-sequence GRANTs are their own bug class.

The blunt removal was the pragmatic fix at the time. **But removing the REVOKE restored Supabase's
bootstrap default:**

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
```

**So every table created from now on gets `anon` sequence privileges by default** — the exact
inherit-the-hole pattern the whole remediation existed to close, just on sequences rather than
tables.

## Why it's not urgent

- Exposure is modest — `anon` calling `nextval()` on a public-schema sequence burns sequence values.
  That's a mild denial-of-service curiosity, not a data leak. Sequence values are not sensitive; the
  table's row grants (which the remediation DOES revoke for anon by default) are what protect data.
- `do_not_tow_plates` (the first table since 7de4ff9) is safe because its migration explicitly
  revokes anon on the sequence.
- Existing tables in the schema had their anon sequence USAGE revoked directly by
  `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated` in the remediation. Only
  FUTURE tables inherit the reopened default.

## Why it still needs fixing

- "Deny by default that doesn't hold for new objects" isn't deny by default.
- The next table built without explicit anon sequence REVOKE gets the hole silently. A migration
  author who trusts the deny-by-default posture (correctly) but forgets the explicit REVOKE (easy)
  ships anon sequence USAGE.
- Doesn't affect data safety, but contradicts the posture. Fix it while the lesson is fresh.

## Fix — surgical split (report-first, small additive migration)

Split the default rather than dropping it entirely:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
```

Anon stays denied on future sequences; authenticated keeps `USAGE + SELECT` (the two privileges any
BIGSERIAL INSERT + RETURNING path needs); no future table inherits the anon hole.

`service_role` is unaffected — it's not in either statement, and its grants live at a different
layer (superuser bypass).

## Verification companion

Add a `VQ` asserting that a newly-created sequence has anon `USAGE` = false. Simplest: create a
temporary sequence, check `has_sequence_privilege('anon', ..., 'USAGE') = false`, drop it. Runs
in the migration's own transaction so it aborts cleanly on failure.

## Also worth updating

- `docs/audits/2026-07-22-public-grants-audit.md` — add a note that the blunt REVOKE-then-remove
  approach in the initial remediation missed the ALTER-DEFAULT-PRIVILEGES-split-per-role subtlety.
  Sequence USAGE for anon vs authenticated has different intent; a single-role REVOKE would have
  worked from the start.
- `docs/development/migration-verification-template.md` — after this fix ships, add a note that
  the anon sequence USAGE assertion in VQ.GRANTS is now belt-and-suspenders (default is denied) but
  still MUST be included, because migration authors shouldn't need to know about the default state.

## Priority + effort

**LOW priority, ~30 min effort:** one migration (2 ALTER DEFAULT PRIVILEGES statements + VQ) +
audit doc note + template note. Report-first before push. Runs at whatever moment fits between
other Bar-2 work.

## Cross-references

- `321a373` — initial grant remediation
- `7de4ff9` — the fix that removed the sequence-default REVOKE
- `e17a24f` — DNT Commit 2 where this was noticed
- `docs/audits/2026-07-22-public-grants-audit.md`
- `docs/development/migration-verification-template.md`
