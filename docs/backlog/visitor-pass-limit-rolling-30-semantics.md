# BACKLOG — Visitor pass limit: rolling-30 semantics · DESIGNED, NOT BUILT

**Designed July 28, 2026. Nothing applied.** Ships **after** six-site Commit B (Wed/Thu), as one commit of
eleven items.

This file is the complete record. Everything needed to build it is here — no other file required.

---

## The problem

The manager Settings control is labelled *"Max passes per plate per **year**"*. The code counts **neither per
year nor per month** — it counts **currently active, unexpired passes**:

```sql
AND is_active = TRUE
AND expires_at > now();
```

Identical predicate in **both** `enforce_visitor_pass_limit()` (the trigger that actually blocks the INSERT) and
`get_plate_pass_status()` (the advisory pre-check) — `migrations/20260514_enforce_visitor_pass_limit.sql`, trigger
at L64-69. They agree with each other today, so a change must move both together.

**So a limit of 3 means "3 simultaneous live passes," and passes expire in 4–24 hours.** The count returns to
zero daily.

**Which means it does not do what it exists to do.** The stated purpose is stopping a resident from avoiding paid
reserved parking by arriving as a "visitor" every day. A concurrency cap doesn't touch that — a fresh pass every
day never approaches the limit. What it blocks is one plate holding several passes at once: a different and much
less interesting abuse.

Help docs are honest about *current* behaviour (`docs/help/09-visitor-passes.md:53-59`, "Per-plate concurrent
limit"), and the trigger's error HINT is honest too. **Only the three Manager Settings strings are wrong.** Both
become wrong on the change.

---

## Decisions locked (Jose, July 28)

| Decision | Choice | Why |
|---|---|---|
| Window | **Rolling 30 days** | Only option serving the stated purpose. Calendar month is gameable at boundaries. |
| Revoked passes | **Count everything issued** | Simplest to explain, ungameable (no issue-revoke-reissue reset). `exempt_plates` is the remedy when a manager revokes in error. |
| Anon counts | **RPC omits them** | Rolling-30 turns `used` into visit history for an arbitrary plate on an anon page. Defend at the RPC boundary, not the render layer — anyone with the anon key can call it via curl. |
| Guidance figure | **None — teach how to choose** | "Typical default: 1-2" is catastrophic under the new unit. |

**Record all four in the migration header**, with reasoning, so none gets "fixed" back later.

---

## 🔴 What this does to residents — say it in the UI

Today: *"one plate can't hold more than N passes at once"* — effectively unlimited visits.
After: *"one plate can only visit N times in 30 days."*

That's the abuse fix, and it **will also catch legitimate frequent visitors** — a caregiver, an adult child
visiting a parent weekly, a home health aide. At a limit of 3, a daughter visiting every Sunday is blocked from
week four.

`exempt_plates` is the designed remedy, but a manager only reaches for it if the copy says so. **The limit and
the exempt list must be described together**, not as unrelated boxes as they are today.

**And the number's meaning inverts** — under concurrency 3 is generous; under rolling-30 it's three visits a
month. So the label can never ship ahead of the semantics: that would invite someone to configure a number under
today's meaning that silently becomes far harsher. Every property is `NULL` today, which is why this is the
cheapest possible moment.

---

## The eleven items — one commit

1. **`enforce_visitor_pass_limit()`** — `is_active = TRUE AND expires_at > now()` → `created_at > now() - interval '30 days'`
2. **`get_plate_pass_status()`** — identical predicate change
3. **Trigger `RAISE` message + HINT** — currently *"Wait for existing passes to expire"*, which becomes wrong (the
   count is issue-based; waiting doesn't help). New copy: *"This vehicle has already been issued N visitor passes
   at this property in the last 30 days. Contact the property manager if you need access."*
4. **`app/manager/page.tsx:4143`** — description string
5. **`app/manager/page.tsx:4144`** — label → `Max visitor passes per plate per 30 days`
6. **`app/manager/page.tsx:4248`** — exempt-plates description
7. **`docs/help/09-visitor-passes.md:53-59`** — rewrite, **including the number**. Retitle "Per-plate concurrent
   limit" → "Per-plate visits per 30 days"
8. **`docs/help/04-adding-properties.md:96`** — exempt-plates steering language
9. **Migration header** — the four decisions above, plus: rides on Commit B's function body, inherits the Bar-2
   anti-wildcard fix (`docs/backlog/get_plate_pass_status-ilike-wildcard-injection.md`: *"Do not ship those
   functions again without it"*), and **quota is permanent because no UI hard-delete exists**
10. **Anon count-stripping** — RPC branch + TS union + two `/visitor` render fallbacks + smoke assertion (below)
11. **`/api/visitor/create-pass`** — sanitize the trigger's `23514` for anon callers so the count doesn't leak on
    the failure path

**Untouched:** `MAX_VISITOR_PASSES_PER_PROPERTY_MONTH` and its `tier-config.ts` entries — a *different* metric
(per-property monthly volume), runtime-unused but roadmap-planned, and honestly disclosed in the help docs as
"tracked but not tier-capped". Leave it.

### Suggested copy

- **Label:** `Max visitor passes per plate per 30 days`
- **Description:** *"How many times the same vehicle can be issued a visitor pass at this property within a
  rolling 30-day period. Leave blank for unlimited. Add regular visitors — caregivers, family, service providers
  — to the exempt list below so they're never counted."*
- **Exempt:** *"Plates on this list are never counted against the visitor pass limit."*
- **Help doc guidance:** *"Set this well above normal visiting frequency and low enough to catch someone parking
  daily. A vehicle visiting a few times a week is a normal guest; a vehicle here most days is using visitor
  passes instead of paying for a space. Leave it blank until you see a pattern worth limiting."*

Drop "annual" and "yearly" everywhere.

---

## 🔴 Item 10 — the anon branch, and the two ways it can silently no-op

### Five exits, only two carry counts

`get_plate_pass_status` returns from five places: empty input → `unlimited`; `v_limit IS NULL` → `unlimited`;
exempt plate → `exempt`; `v_current_count >= v_limit` → `at_limit` **+ counts**; fallthrough → `within`
**+ counts**.

**Only the last two need gating. Do not restructure to a single exit** — Commit B's VQs assert body text in this
function.

```sql
DECLARE
  v_is_anon BOOLEAN;
BEGIN
  -- 🔴 auth.uid() NOT auth.jwt() — Supabase's anon key IS a JWT (role='anon',
  -- no sub claim), so auth.jwt() returns claims JSON and is NEVER NULL; that
  -- guard would silently not fire. auth.uid() reads the sub claim, which IS
  -- null for anon. Precedent inside SECURITY DEFINER: 20260521_b65_4_redeem_
  -- signature, 20260520_b65_self_serve_signup, 20260707_b118_layer2_redeem,
  -- 20260710_acceptance_reviewed_at_signup, 20260713_tos_acceptances (+3).
  -- Do NOT "simplify" this to auth.jwt() IS NULL.
  v_is_anon := (auth.uid() IS NULL);

  -- (three no-count exits UNCHANGED)

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
```

TS union — counts become optional; `/visitor` render fallbacks at **L382** (`within`) and **L385** (`at_limit`),
both currently rendering `"{used} of {limit} active passes"`. L378 (`exempt`) and L467 (submit disable) need no
change — neither reads counts.

### The smoke assertion, and why its setup is load-bearing

`scripts/smoke-grant-remediation-post-revoke.ts:192-194` currently asserts only *"no error"* and *"returned
something"* — it would pass whether counts leak or not.

**And a shape assertion alone is still vacuous**, because every property has `visitor_pass_limit = NULL`: the RPC
exits at the null-limit branch, returns `{'state':'unlimited'}` with no counts, and the check goes green **without
ever reaching the guarded exit.**

```ts
// Setup — force the count-carrying path. Without this the RPC exits at
// v_limit IS NULL and the assertion below is theatre. Do NOT remove the
// pass_limit set / seeded pass as "unnecessary setup" — they are what makes
// the negative control reach the guarded exit.
await admin.from('properties').update({ visitor_pass_limit: 3 }).eq('id', testPropertyId)
await admin.from('visitor_passes').insert([{ /* testProperty, probePlate, active */ }])

try {
  const { data, error } = await anon.rpc('get_plate_pass_status', { p_plate: probePlate, p_property: testProperty })
  if (error) fail(`get_plate_pass_status: ${error.message}`)
  else if (!data) fail('get_plate_pass_status returned null data')
  else if (data.state !== 'within' && data.state !== 'at_limit')
    fail(`probe setup failed — got state=${data.state}, expected within/at_limit`)
  else if (data.used !== undefined || data.limit !== undefined)
    fail(`LEAKED counts to anon: ${JSON.stringify(data)}`)
  else ok('counts-free state for anon on the count-carrying branch')
} finally {
  await admin.from('visitor_passes').delete().eq('plate', probePlate).eq('property', testProperty)
  await admin.from('properties').update({ visitor_pass_limit: null }).eq('id', testPropertyId)
}
```

Confirm the script has a **service-role client** for the setup writes — it currently constructs only an anon
client. Fails loudly if missing, so it's a build-time annoyance rather than a risk.

---

## Probe — behavioural, on Test-LEGACY

1. **25-day boundary** — 3 passes created 25 days ago, **already expired** → a 4th refused at limit 3. This is
   the exact case that passes today.
2. **31-day boundary** — a pass created 31 days ago must **not** count.
3. **Revoked-inside-window** — a revoked pass created 10 days ago **must** count (the count-everything decision).
4. **Anon shape** — no `used`/`limit`, having first asserted arrival at `within`/`at_limit`. **Load-bearing.**
5. **Authenticated shape** — `used`/`limit` present.
6. **Anon insert at limit** via `/api/visitor/create-pass` → generic message, no count in the error text.

---

## Sequencing

**Commit B ships first.** It rewrites `get_plate_pass_status` with VQs asserting specific body text; folding
these together means redoing that verification against a moving target. Rolling-30 lands on top and inherits the
Bar-2 anti-wildcard fix from the same function-body version.

---

## New discipline this produced

🔴 **A negative control must assert it reached the guarded path.** Bitten twice in two days: a `<PID>` placeholder
meant the no-shadow trigger test never ran (reported a syntax error, not a pass), and the anon count assertion
would have gone green against `unlimited` without touching the branch. **A test that cannot fail is worse than no
test, because it gets recorded as evidence.** Prove arrival, then assert behaviour.

Add to `CURRENT_STATE` on the next update, alongside the existing discipline list.
