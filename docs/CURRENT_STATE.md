# CURRENT_STATE

**Rolling state file. Overwrite in place at the end of each session — never create another dated
kickoff.** Read it first; it is the source of truth for where things stand.

**Should live in the repo** (`docs/CURRENT_STATE.md`) so Mateo can read and maintain it. Jose
uploads the current copy to project knowledge when starting a new chat.

*Last updated: July 23, 2026 (end of session)*

---

## Posture

**Stabilization while A1 runs.** A1 has surfaced nothing — weeks of quiet. Bar-2 is deliberately
parked. `public_signup_open` stays `false`. Nothing outstanding is urgent.

A1 is the only `production` company (3 test tenants + 1 demo). Jose **cannot log into A1's
portal** — he uses Test-LEGACY. **A1 checks must be SQL.**

**Tenant IDs:** Test-PM 87 · Test-ENF 88 · Test-LEGACY 89 · Demo 90 · **A1 Wrecker llc 91**
(production).

---

## 🔴 ACTIVE ARC — Authorized Plates

**What it is:** a per-property list of plates a manager or CA maintains. A match reads as
**Authorized** at scan time, exactly like an active resident — **and remains fully enforceable.**
Staff, vendors, contractors who park regularly.

**Origin:** replaced the Do Not Tow arc on July 23. `exempt_plates` was misread as tow protection;
DNT was then built assuming tow protection was the gap. It wasn't. Three distinct capabilities,
now named apart:

| | Capability | Meaning | Status |
|---|---|---|---|
| 1 | `properties.exempt_plates` (`text[]` column) | skips the annual visitor-pass **quota** | exists, unused, correct |
| 2 | `do_not_tow_plates` | **absolute** tow refusal, no override | **PARKED** |
| 3 | `authorized_plates` | standing authorization, **still enforceable** | ← this arc |

**Never merge or migrate between the three.**

### Commit plan — data entry ships LAST

| | Commit | State |
|---|---|---|
| ✅ | **AP-SCHEMA** `51c29f2` — table, trigger, 9 policies, grants, audit | 11 VQs silent |
| ✅ | **AP-CASCADE-DB** `59a3c4d` — `check_authorized_plate` RPC + `pm_plate_lookup` branch 1.5 | 11 VQs silent (post-apply only) |
| ✅ | **AP-CLIENT** `b02a2a5` — driver + CA branches, `authorized_plate` render on both, shared `AUTHORIZED_META`, `PLATE_STATUS_META`-derived fallback | `npm run build` clean; Vercel glance pending |
| ✅ | **AP-MANAGE-TRIGGER** `8b2024c` — `removed_at` server-clock via trigger + INSERT-branch `NULL` guard + `AP.TRIGGER_INSERT_NULL` + wrap-safe audit strings | evidence-verified via direct readout; 3 VQs post-apply-only (negative controls consumed by early first apply) |
| ⏳ | **AP-MANAGE-CLIENT** — manager + CA add/remove UI + `head:true` count column | ← **the switch** |

Every commit before AP-MANAGE is inert because the table stays empty — but note a CA *can* write
to `authorized_plates` via PostgREST today, so "inert" means no UI path, not unreachable.

### Locked decisions

- Status value **`'authorized_plate'`** — distinct value, **identical render** to the resident card
- **One DEFINER RPC, three callers** — driver client, `pm_plate_lookup`, CA client. Drivers have
  no `authorized_plates` SELECT policy by design, so a direct client query returns empty silently.
- Cascade position: **beside** the resident branch. In `pm_plate_lookup` it's the `ELSE` of the
  resident match — resident wins by construction.
- **Driver call passes `targetProp`. CA call passes `selectedProperty?.name ?? null`** — never
  always-NULL, which reintroduces the vendor-at-two-buildings `otherproperty` misreport.
- `label` — free text, **portal-only**, 80-char cap, `NULL` for drivers **at the RPC**, not just
  the UI
- **No expiry** v1 · **not metered** · **no enforcement-code changes**
- Manager **and** CA manage the list
- Per-property count in CA + super-admin views (visibility, not a cap)

### Three plate-resolution paths — all need the branch

| Path | Where | Roles |
|---|---|---|
| Driver scan | `app/driver/page.tsx` `searchPlate()` | driver |
| Manager scan | `pm_plate_lookup` RPC | manager, leasing_agent |
| CA scan | `app/company_admin/page.tsx` `searchPlate()` | company_admin |

`/visitor` and admin need no branch. **The CA cascade has no DNT check at all** — harmless now,
but evidence the three-cascade drift is already real.

**Acceptance criterion:** add one plate; driver, manager and CA all show Authorized; a driver
assigned to a *different* Test-LEGACY property shows non-resident. Runs after AP-MANAGE.

---

## PARKED

**`do_not_tow_plates`** — absolute tow refusal with no override. Contradicts the authorized-plates
model, so it has no user. Kept pending a decision on whether the capability is ever wanted.

**Provably unpopulatable:** `INSERT`/`UPDATE` revoked from `authenticated` (`0d0a7fe`),
`COMMENT ON TABLE` documents it, B1's VQ.4 asserts it. `service_role` retains access.
**The tow guards in `set_violation_status`, `stamp_tow_ticket` and `regenerate_tow_ticket` are
LIVE and inert only because the table is empty.** Re-granting INSERT/UPDATE reactivates the
capability — a decision, not a cleanup.

**B3 (CSV export DNT filter)** — stopped. No never-towable vehicles under this model.

---

## Shipped July 23

| Commit | What |
|---|---|
| `6b4ff1d` | Commit A — dropped the DNT creation trigger (tag-not-block pivot) |
| `721ab61` | **B1** — 6 RLS policies rewritten on `do_not_tow_plates` |
| `8f13a0f` | **B2** — company scoping on 5 DNT lookups + `regenerate_tow_ticket` guard |
| `0d0a7fe` | DNT-PARK — revoke writes + extended VQ.4 |
| `51c29f2` | AP-SCHEMA — `authorized_plates` table |
| `59a3c4d` | AP-CASCADE-DB — `check_authorized_plate` + `pm_plate_lookup` branch 1.5 |
| `0e90711` | Add `docs/CURRENT_STATE.md` (rolling state file) |
| `b02a2a5` | AP-CLIENT — driver + CA branches + `authorized_plate` render + fallback |
| `8b2024c` | AP-MANAGE-TRIGGER — `removed_at` server-clock + INSERT-branch NULL guard |

**B1 and B2 closed a real cross-tenant defect and survive the re-scope.** A manager at one company
could read *and write* another company's per-property plate list through PostgREST, and
`check_dnt_plate` returned another tenant's free-text `reason` to a driver.

**All of it is source-verified only.** Every VQ is structural. Behavioral proof is still owed.

---

## Open items (none urgent)

- **C5 Order Form probe** — refactored to import the real writer; awaiting push greenlight
- **`order_forms` E2E** — closes on the first real proposal-code redemption; don't manufacture one
- **Backlog `800ff4c`** — anon sequence-defaults hole. LOW, ~30 min
- **Backlog `get_plate_pass_status` ILIKE wildcard** — `docs/backlog/`. Bundles with the Bar-2
  visitor-pass touch
- **Fast-follow:** `create_visitor_pass` write-side dedup · vehicles-branch determinism

---

## Bar-2 (parked)

See `bar2_state_of_play_july22_2026.md`. Blockers cluster into one arc: **`accept_saas_agreement`
chicken-and-egg** (keystone, blocks B2-4 + self-serve C5) → **B2-4** end-to-end signup.
**B2-3b is DONE.**

**Plus the name-keyed scoping group — 6 sites, one class.** Properties resolved by name with no
company predicate, several via `~~*`: `set_violation_status` · `regenerate_tow_ticket` ×2 ·
`stamp_tow_ticket` · `get_plate_pass_status` · `enforce_visitor_pass_limit`.

**Bypass framing:** B2's guard scopes to the caller's company; ILIKE lets a caller reach another
tenant's violation; the guard is present, correct, and irrelevant. Latent today (zero collisions),
live the moment `public_signup_open` flips. Fix shape:
`lower(trim(p.company)) = lower(trim(get_my_company()))`.

---

## Disciplines (in `docs/development/migration-verification-template.md`)

1. **`VQ.GRANTS` on every new table** — explicit table *and* sequence privileges
2. **Read the schema, don't remember it** — `information_schema.columns` first
3. **Source-inspection VQs: assert on executable syntax** — `pg_get_functiondef()` includes
   comments; keep rationale outside function bodies
4. **Negative control** — run every new VQ against the **unfixed** state before applying. *A VQ
   that has never been observed failing is untested.* Where state can't produce a failure,
   self-test the predicate.
5. **Delimiter-extracted VQs** — fixed-text delimiters, no per-site decoration, exactly-once and
   in-order assertions
6. **Set assertions** — array `=` is order-sensitive. Use `@>` both directions, report
   `missing`/`unexpected` via `EXCEPT`. An assertion that fires must say *what* differs.
7. **Ordering assertions** — `position()` returns 0 for an absent needle, so
   `position(a) < position(b)` is true when `a` is missing. Guard `= 0` explicitly first.

**Supabase editor:** paste verification files **whole** — the auto-RLS helper injects
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` into partial pastes and breaks dollar quoting. This is
also what makes `DO`-block atomicity hold.

**Validated detectors to date: 2** — VQ.1 (B1) and VQ.CANONICAL (B2). Both fired on real defects
and named the offending object. AP-SCHEMA's and AP-CASCADE-DB's VQs are silent but structurally
unvalidated; AP-CASCADE-DB's pre-apply pass was skipped.

---

## Standing rules

Report-first → eyeball → deploy → **verify by evidence, not the success toast** · separate commits
for independent rollback · **nothing on A1 without an explicit greenlight; any A1 issue → stop and
assess** · **do NOT bump `TOS_/PRIVACY_/SAAS_VERSION`** · `FOR_MATEO_*` files are messages, not
knowledge — relay and let go · **SQL sent to Jose is always a complete standalone statement;
fragments for Mateo's files are labelled as such** · **diff reports paste code verbatim, not
summaries** — three false alarms in one session came from reviewing shorthand instead of source.
