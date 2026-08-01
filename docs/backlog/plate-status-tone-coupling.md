# Fast-follow spec: derive plate colour from `doNotTow`, make the mismatch unwritable

**Filed:** 2026-08-01. **Status:** designed, NOT built.
**Blocked on:** enforcement stability at A1 — do NOT ship during active enforcement.
**Not before:** the following Monday (2026-08-04).

**Origin:** the badge P0 (commit `4631951`). `pending` fell through to red because the
driver surface reimplemented a colour mapping that manager and CA read from the shared
lib. The enumeration fix closed the instance. This closes the class.

---

## The problem being solved

Colour and `doNotTow` are currently two independent facts about a plate status, maintained
by hand in separate places. When they disagree, the driver reads one and enforcement code
reads the other.

That disagreement already exists today: `otherproperty` carries `doNotTow: false` while
`PLATE_STATUS_META` gives it the amber caution palette — a towable state presented in a
protective colour, under a headline containing the word "authorized."

Jose's read is that `otherproperty` is effectively unreachable now. Portfolio-wide plate
search was dropped; drivers search a single assigned property and lookups are scoped to
it. So this is latent rather than live. **It's still the right thing to fix, because the
point is that the mismatch is currently *expressible* — the next status added inherits
the same trap.**

---

## 🔴 The constraint that matters — don't flatten to two colours

"Derive colour from `doNotTow`" must **NOT** mean protected-green and towable-red.

`authorized` (green), `guest_authorized` (blue), and `pending` (amber) are all
`doNotTow: true`, and they are genuinely different situations that a driver reasons
about differently:

- **Green** — settled. A registered resident vehicle.
- **Blue** — a manager vetted and approved this guest.
- **Amber** — someone is mid-process; a human hasn't finished deciding.

Collapsing those loses information the driver actually uses at 2am. Keep every existing
hue exactly as it is today.

**The invariant is one level up: `doNotTow` determines the colour *family*; the specific
hue is a variant within that family.**

| `doNotTow` | family | hues in use |
|---|---|---|
| `true` | protective | green, blue, amber, gold |
| `false` | towable | red |
| unmapped | unknown | grey |

The rule being enforced: **no protective state can ever render in the towable palette,
and no towable state in the protective palette.** That's what broke. The hue choice
within a family was never the problem.

---

## Proposed shape

### 1. Add `tone` to every `PLATE_STATUS_META` entry

```ts
type Tone = 'protected' | 'towable' | 'unknown'

// each entry carries its family alongside its hue
pending:  { tone: 'protected', bg: REVIEW_BG, border: REVIEW_BR, ... }
notfound: { tone: 'towable',   bg: DENIED_BG, border: DENIED_BR, ... }
```

### 2. Assert the pair at module load (or in a unit test)

```ts
// Fails loudly at import time if a status's declared tone disagrees
// with its enforcement flag. A mismatch here is the bug class that put
// pending in the towable palette for every driver at Green Acres.
for (const status of ALL_PLATE_STATUSES) {
  const meta = PLATE_STATUS_META[status]
  const expected: Tone = isDoNotTow(status) ? 'protected' : 'towable'
  if (meta.tone !== expected) {
    throw new Error(
      `[plate-status] ${status}: tone='${meta.tone}' but isDoNotTow()=${isDoNotTow(status)}. ` +
      `Colour family must follow the enforcement flag.`
    )
  }
}
```

A future status with a mismatched pair then fails immediately and loudly, rather than
shipping and being found by a customer after a tow. Prefer a unit test if that's cleaner
in this codebase.

### 3. Retire the driver's inline ternary

Replace `app/driver/page.tsx:1711-1740` with a read from `PLATE_STATUS_META`, the way
manager (`page.tsx:4461`) and CA (`page.tsx:4056`) already do. Single source of truth;
the enumeration discipline comment goes away because there's nothing left to enumerate.

Keep the grey `unknown` fallthrough for a status genuinely absent from the meta — that
behaviour was right and should survive.

### 4. `otherproperty` — resolve the existing mismatch

It currently declares amber with `doNotTow: false`. Per Jose: **follow `doNotTow`**. So
it becomes red unless the reader finds a specific reason to think the flag is the thing
that's wrong. Flag it if you find one.

**Pre-answered from source (2026-08-01):**
- `otherproperty` is **NOT reachable from the driver cascade today**. Only referenced in
  the ternary (defensive), the `PlateStatus` type definition, and CA-surface code.
  Driver's `searchPlate` never returns it — portfolio-wide plate search was dropped and
  no branch produces `otherproperty` on driver. Comment the state to record this rather
  than deleting; the label reads reassuringly if a future change ever reintroduces it.

---

## Bundle into the same arc

Filed alongside this and cheapest to do together:

### Orphaned `driverHeadline` values

`pending.driverHeadline = '⚠ REGISTRATION PENDING'` and
`plate_under_review.driverHeadline = '⚠ PLATE CHANGE UNDER REVIEW'` are unused — the
driver has inline copy at `app/driver/page.tsx:1905-1909` (`AWAITING MANAGER APPROVAL`
for pending; `REGISTRATION DECLINED` for declined; `⚠ PERMIT EXPIRED` for expired).
Wire them up or delete them; don't leave dead copy that looks live.

Recommended: **delete** the orphaned `driverHeadline` fields for these two states. Per
`plateHeadline()` fallback (`plate-status.ts:167`), removed values fall back to `label`,
which is already correct. Manager/CA consumers unaffected.

### `do_not_tow` gold branch reachability

**Pre-answered from source (2026-08-01):**
- `do_not_tow` **IS still reachable** from the driver cascade at
  `app/driver/page.tsx:440-451`. The `check_dnt_plate` RPC is still called; on
  `is_dnt: true` the surface returns `status: 'do_not_tow'`. Even though DNT WRITES are
  revoked (per prior memory), the READ path is live. The gold-border rendering is not
  orphaned. Do NOT remove it.

### Two names for one state

Driver header says `AWAITING MANAGER APPROVAL`; lib label says `REGISTRATION PENDING`.
Both fine, both imperative-free, but a driver and a manager on the phone will describe
the same plate differently. Reconcile here or in the composite arc, whichever is tidier.

**Recommendation: defer to the composite arc.** The composite reframe will refresh
driver's inline render substantially anyway (need to display multiple records); the
naming reconciliation lands more naturally there.

---

## Out of scope

The composite display arc (show every record, no winner) is separate and needs its own
report cycle. This spec is only about making colour and enforcement agree by
construction.

They do interact in one place: once composite display exists, `isDoNotTow(composite)`
resolves **most-protective-wins** (agreed on both sides). The `tone` derivation should
read from that same resolved value, not from the headline status. Worth keeping in view
so the two arcs don't need rework.

---

## Verify

- [ ] Every existing hue unchanged — green, blue, amber, gold, red, grey all render
      exactly as today
- [ ] `pending` still amber on all three surfaces
- [ ] Assertion fires on a deliberately mismatched entry, then revert the test case
- [ ] Driver surface has no inline colour logic left
- [ ] `npm run build` clean
- [ ] Manager and CA plate-lookup renders unchanged (they already consume META)

---

## Sequencing

1. This spec — colour/`doNotTow` coupling + `otherproperty` resolution + orphaned
   `driverHeadline` cleanup + `do_not_tow` reachability confirmed
2. Composite display arc — separate report cycle
3. Pass snapshot onto violation record
4. Driver visitor-pass view (A1 ask)
5. Finding 3 revisit — likely warn not block

---

## Cross-references

- `4631951` — badge P0 fix that motivated this arc
- `PLATE_STATUS_META` — shared lib the driver consumes for `isDoNotTow` but not for
  colours
- `feedback_pending_vs_decided_no_is_not_one_class.md` — related discipline: cascade
  order category rules
- `feedback_rls_denials_return_empty_not_error.md` — same "make the failure mode
  impossible by construction" family
