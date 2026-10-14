# Tag switch: the data is clean, the UI is lying

Report only, 2026-10-15. Nothing changed.

## 🔴 First, the question that mattered: A1 is not affected

**A1 Wrecker llc: 0 of 10 properties have either switch on.** Nobody
turned anything on for a real customer.

## What the data actually says

| | |
|---|---|
| column default | `BOOLEAN NOT NULL DEFAULT false`, both columns (`20261012_piece0_property_feature_switches.sql:47-48`) |
| `parking_tags_enabled` ON | **1** of 28 · off 27 · NULL 0 |
| `printable_visitor_passes_enabled` ON | **1** of 28 · off 27 · NULL 0 |
| the one property | **Northgate Commerce Center** [Demo Company], both switches |
| A1 | **0 / 10**, both columns |

**No migration and no seed turns them on.** The default is `false`;
`20260711_seed_demo_data_rpc.sql` contains zero references to either
column; and the only write path is
`set_property_feature_switch`, whose comment says so.

Audit history — 10 switch changes, ever:

- **8** by gate canaries (`zz-*`, all on Test Legacy Property, all
  restored by the gates that made them)
- **2** by a real person: `demo-ca@test.shieldmylot.com`,
  2026-10-12T23:44, turning both on for Northgate

That second pair is the Piece 1 UI test — reported at the time as
"CA 'Physical passes' switches are live and work (both on for
Northgate, demo)". One property, switched on deliberately, two days
ago.

## 🔴 So why does it look like every demo property has it on

Because it does look that way, and the observation is correct. The data
is fine and the component is wrong.

`app/components/PhysicalPassSwitches.tsx:52`

```ts
const [state, setState] = useState<Record<SwitchName, boolean>>({
  parking_tags: !!parkingTags,
  printable_visitor_passes: !!printablePasses,
})
```

`useState(initial)` reads its argument **only on first mount**. The
mount site is `app/company_admin/page.tsx:7089`:

```tsx
<PhysicalPassSwitches
  propertyId={selected.id}
  parkingTags={!!(selected as any).parking_tags_enabled}
  …
```

**No `key`.** In the two-panel Properties CRM, `selected` changes as the
CA clicks a different property, but React reuses the same component
instance — same type, same position — so `state` keeps whatever the
FIRST property showed and never updates again.

Click Northgate first (both on), then click anything else: both
switches still read ON, for every property, until the page reloads.

**The component already knew about this.** Line 58-60, for the message
slot:

```ts
// One message slot, stamped with the property it belongs to, so a
// message can never be read against a different property after a
// switch of context.
const [msg, setMsg] = useState<{ forProperty: number; … }>(null)
```

So instance reuse was understood and defended against — for the
message, and not for the switch state beside it.

## How bad is it

**Display only, but the operator cannot trust what they see.**

`toggle(name, next)` computes `next` from the stale `state`, so the
first click after a context switch sends the *opposite of the stale
value* rather than the opposite of reality. Both mismatch directions
land on a no-op at the database — if the display says ON and reality is
OFF, the click sends `enabled: false` — so **it cannot switch a feature
on without the operator clicking a control that reads OFF.** The RPC
also audits with the prior value, so a real change stays
distinguishable from a re-save.

The harm is that a CA reads the wrong state for 27 of 28 properties and
a click appears to do nothing.

## The fix, for your call — one line

```tsx
<PhysicalPassSwitches
  key={selected.id}          // ← a new instance per property
  propertyId={selected.id}
```

`key` is the idiomatic fix: it forces a fresh instance, so `useState`
re-reads the props for each property, and the `msg` guard keeps working
unchanged. The alternative — deriving `state` from props with an
effect — is more code and reintroduces a sync to get wrong.

🔴 **A `key` would be invisible to every gate we have.** It is a render
concern and `verify:switches` tests the RPC and the column, which were
always correct. The check that would catch it has to click two
properties in sequence and assert the second one's switches match its
own row — which is class 7 (render-side gating) seen from the other
direction: not a render trusted as a control, but a render that
misreports a control's state.

## Not in scope here

Whether a demo property *should* have tags on is a separate question.
Northgate's state is deliberate and recent; if you want it off, the CA
switch turns it off and audits the change.
