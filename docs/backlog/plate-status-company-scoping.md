# plate-status-company-scoping — the next commit on `get_plate_pass_status` + `enforce_visitor_pass_limit`

**Filed:** 2026-07-29 (rename from "Commit B" per Mateo — see naming note below).
**Status:** designed, NOT built. Queued after rolling-30 verification is silent (2026-07-29 `35b18eb`).
**Bundles:** every touch of these two functions from now on. See "Bundled fixes" below.

## Naming — "Commit B" retired

Previously called "Commit B" in conversation notes. Renamed **plate-status-company-scoping** because
`vehicle-state.ts` already has a "Migration B" (the vehicles.status DEFAULT flip) and both touch the enforcement
path — two things called "B" is how a wrong file gets applied.

Corresponding rename: the FK-epic follow-on formerly called "Commit C" becomes
**`visitor-pass-trigger-scoping`**.

## Scope

Rewrites `get_plate_pass_status` and `enforce_visitor_pass_limit` (both in
`migrations/20260514_enforce_visitor_pass_limit.sql`) to add company scoping to the properties lookup +
authorized-plate check, closing the Bar-2 cross-company property-name collision on the tow path — the same class
Six-site Commit A closed for `set_violation_status` / `stamp_tow_ticket` / `regenerate_tow_ticket` (`b80db63`).

Signature change (adds `p_company`): `get_plate_pass_status(text, text)` → `get_plate_pass_status(text, text, text)`.
Two-phase deploy pattern (add-then-drop) so all 4 client callers migrate before the old signature is dropped.

## Bundled fixes — do NOT ship the functions again without ALL of these

The named-trigger discipline: any touch of `get_plate_pass_status` or `enforce_visitor_pass_limit` picks up every
open backlog item on those functions in the same commit. Otherwise deferred items float indefinitely (see
`800ff4c` for the anti-pattern this discipline exists to prevent).

Bundled today:

1. **ILIKE wildcard on `p_property` arg** — `docs/backlog/get_plate_pass_status-ilike-wildcard-injection.md`.
   Replace `WHERE name ILIKE p_property` with `WHERE lower(trim(name)) = lower(trim(p_property))`. ~10 lines.

2. **Company scoping** — the primary scope of this commit. Add `p_company` parameter; join against
   `properties.company` scoped to `lower(trim(company)) = lower(trim(p_company))`. Applies to BOTH the
   `properties` lookup and the `visitor_passes` count subquery.

3. 🔴 **Inheritance from rolling-30** — see next section. Without this, `CREATE OR REPLACE` on the RPC
   silently reverts the 30-day predicate + anon count-strip that shipped 2026-07-29 in `ec4493f`.

## 🔴 Inheritance from rolling-30 (2026-07-29, `ec4493f` + `35b18eb`) — NON-NEGOTIABLE

The current function body reflects rolling-30 semantics + anon count-strip. This commit's rewrite MUST START
FROM THE CURRENT BODY, not the pre-rolling-30 body. Otherwise `CREATE OR REPLACE` silently reverts both.

Nothing catches a silent revert unless the verification asserts inheritance.

**Carry into the new body (both functions where applicable):**

- `v_is_anon := (auth.uid() IS NULL)` with the anti-refactor comment listing the 8 `SECURITY DEFINER`
  precedents. Do NOT "simplify" to `auth.jwt() IS NULL` — Supabase anon key IS a JWT.
- Count predicate `created_at > now() - interval '30 days'` (both functions).
- Two count-carrying exits gated on `v_is_anon`; three no-count exits ungated. Do NOT restructure to a single
  exit.
- Trigger's `RAISE` message + HINT (the 2026-07-29 rewrite: "already been issued N visitor passes in the last
  30 days" + "Contact the property manager if you need access").

**Add these VQs to the verification file** (all on the whitespace-normalized body, both functions pinned via
`::regprocedure` for the new 3-arg signature):

```sql
-- Inherited from rolling-30 (2026-07-29). The company-scoping widening
-- must not revert these. Pinned to the new signature so the assertion
-- runs against the rewritten function, not a stale (text,text) overload.

--   VQ.INHERIT_PREDICATE
--     count uses created_at + 30-day interval; matches
--     %created_at%interval%30 days% on the normalized body

--   VQ.INHERIT_NO_OLD
--     no 'AND expires_at > now()' clause returned — executable-clause
--     form (not bare 'expires_at' token) so future comments quoting the
--     old predicate don't false-fail

--   VQ.INHERIT_V_IS_ANON
--     'v_is_anon := (auth.uid() IS NULL)' present as an assignment;
--     assignment form is prose-proof (see rolling-30 v3 discipline
--     re: anti-refactor comments quoting the banned string)

--   VQ.INHERIT_GATED_COUNT
--     exactly 2 occurrences of 'CASE WHEN v_is_anon' in the RPC body
--     (structural, format-invariant via length-diff trick). Catches a
--     third count-carrying exit added ungated — which no LIKE would
--     notice.
```

**Also add** `VQ.NO_JWT_IS_NULL_TRAP` — match `:= (auth.jwt()` assignment (NOT bare `%auth.jwt() IS NULL%` —
that false-fails on the anti-refactor comment).

## Behavioural probe — inherit + extend

The rolling-30 probe (6 checks on Test-LEGACY, in `docs/backlog/visitor-pass-limit-rolling-30-semantics.md`)
carries forward. Extend for the new signature:

- **Anon shape check** runs against `get_plate_pass_status(p_property, p_plate, p_company)`. Assert arrival at
  `within`/`at_limit` first (probe setup forces the count-carrying path — set `visitor_pass_limit = 3`, seed a
  pass), then assert no `used`/`limit` for anon, present for authenticated.
- **Company-scope smoke** — call with `p_company = 'A1 Wrecker llc'` against a Green Acres plate; call with
  `p_company = 'wrong company'` against the same plate; the second must NOT resolve.

## Residual — #8 count inflation (unchanged in kind, larger in practice)

The Six-site Commit A rescope noted a residual: the count query's JOIN key IS the colliding value, so a schema
change is required to fully close it (FK migration). That residual is unchanged by this commit — company scoping
on the outer lookup doesn't fix the inner count's collision surface.

**Larger in practice under rolling-30:** a cross-company name collision now inflates a **30-day visit count**
rather than a concurrent-pass count. So a colliding property whose passes overlap the 30-day window can push
another property's count higher, which is much more likely to trip a real limit than the concurrency version.

Note in the migration header + residual paragraph.

## Two-phase deploy

Per Six-site Commit B design notes carried in prior conversation:

- Phase 1: `add-then-drop` — CREATE new `(text, text, text)` overload alongside existing `(text, text)`.
  Update 4 client callers to pass `p_company`. Ship. Verify no anon 500s.
- Phase 2: DROP `(text, text)` overload. Assert exactly 1 overload of each function post-drop. NOTIFY pgrst
  for PostgREST cache reload.

## SQL editor discipline

- Single-paste for the transaction, editor cleared between (per `feedback_sql_editor_partial_apply`).
- Diagnostic → apply → verification, one session.
- Absence checks: executable-clause form, never bare token (2026-07-29 discipline —
  `docs/backlog/visitor-pass-limit-rolling-30-semantics.md`).
- Pattern checks: whitespace-normalized via `regexp_replace(..., '\s+', ' ', 'g')`.
- Body fetches: pinned via `::regprocedure` for the exact new signature.

## Ships after

Rolling-30 (`ec4493f` + verification v3 `35b18eb`) applied and probe-verified on prod.
