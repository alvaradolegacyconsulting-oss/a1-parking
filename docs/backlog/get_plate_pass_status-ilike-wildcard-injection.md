# get_plate_pass_status — ILIKE on caller-supplied argument enables wildcard cross-tenant read

**Status:** open, near-term. Not gated on Bar-2 / `public_signup_open`.
**Priority:** low-moderate — reachable today by any HTTP client (function is anon-callable by design), but disclosure surface is limited to `visitor_pass_limit` + `exempt_plates` array. Not PII.
**Filed:** 2026-07-23 (surfaced during DNT re-scope discovery)
**Related:** `project_bar2_pm_only_flip_checklist` memory — item (6) group, this is the split-out item (1)

## The defect

`get_plate_pass_status` in [migrations/20260514_enforce_visitor_pass_limit.sql:101](../../migrations/20260514_enforce_visitor_pass_limit.sql#L101) resolves the property arg with SQL `ILIKE`:

```sql
SELECT visitor_pass_limit, exempt_plates
INTO v_limit, v_exempt
FROM properties
WHERE name ILIKE p_property
LIMIT 1;
```

`p_property` is caller-supplied and reaches the query verbatim. A caller passing `%` matches every property in every tenant and receives whichever row Postgres returns first via `LIMIT 1`. Any single wildcard character (`%`, `_`) in `p_property` enables partial-match cross-tenant reads.

## Why this is separate from the Bar-2 entry

The **anon EXECUTE grant is intentional** — `/visitor` is the public visitor-pass flow, no login required. An anonymous caller looking up plate-to-status is the feature working as designed. The disclosure surface via the intended flow is inherent to the feature.

**What's actually wrong is narrower:** wildcard injection on a caller-supplied value is never intended, regardless of what the function is for. Independent of the Bar-2 company-scope group because:

- Reachable **today** — needs no `public_signup_open` flip
- Fixable **today** — one predicate swap, no waiting on other decisions
- Independent of the caller-authorization pattern the Bar-2 group shares (this is arg-handling)

## The fix

Replace `ILIKE` with normalized equality — preserves existing case- and whitespace-insensitive matching behavior, kills the wildcard path:

```sql
WHERE lower(trim(name)) = lower(trim(p_property))
```

Matches the normalization convention B1 and B2 established (`lower(trim())` both sides, character-for-character). Roughly 10 lines including the same-touch copy-nit fix in `enforce_visitor_pass_limit:48` (`exempt_plates` → `Visitor Pass Quota Exemptions`).

## What this DOESN'T fix

- Company scoping on the properties lookup — that's the Bar-2 entry item (6-site group). Same file, next function down, same class of latent defect. Do it there when Bar-2 comes up.
- `LIMIT 1` arbitrary-first behavior — after this fix, collision requires an exact same-name property in another tenant, which is the Bar-2 concern (already tracked).

## Scope of a fix commit

- **Migration:** `CREATE OR REPLACE FUNCTION public.get_plate_pass_status` with the one-line predicate swap. Everything else byte-identical. Header notes the fix, references this backlog doc, points at Bar-2 entry for the deferred company-scope work.
- **Verification:** VQ.NORMALIZED asserts `lower(trim(name)) = lower(trim(p_property))` exact string in function source. VQ.NO_ILIKE asserts no `~~*` in the function definition. Both silent post-apply.
- **Copy nit:** if bundled, `enforce_visitor_pass_limit` HINT text fix in same commit.

Not big enough for its own arc — bundle into whatever next visitor-pass touch is, OR ship as a small independent fix. Rough size: ~30 lines migration + ~40 lines verification.

## Standing gate

Per current arc (Authorized Plates in progress), no build until Mateo greenlights this in the sequence. If skipped now, remains in this backlog file until a natural touch of the visitor-pass functions makes it convenient.

## Bundles by default with

The Bar-2 company-scope fix on `get_plate_pass_status` + `enforce_visitor_pass_limit` — same file (`migrations/20260514_enforce_visitor_pass_limit.sql`), same two functions, same class of latent defect. Any earlier touch of either function picks this up in the same commit. **Do not ship those functions again without it.**

That named-trigger discipline is what makes "defer" a real deferral instead of the same floating-someday pattern that put `800ff4c` (anon sequence-defaults hole) on the floor.
