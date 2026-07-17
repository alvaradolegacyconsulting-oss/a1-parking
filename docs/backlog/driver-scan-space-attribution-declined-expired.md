# Backlog — Driver scan card: extend "Resident's Space" attribution to declined + expired

**Filed:** 2026-07-18
**Filed during:** the pending-approval SPACE label warm-up (single-commit scope).
**Class:** driver-facing label ambiguity — same class as the pending-card fix that shipped this commit.

## The pattern

The driver-scan result card renders a shared block for three statuses:
- `pending` — "AWAITING MANAGER APPROVAL"
- `declined` — "REGISTRATION DECLINED"
- `expired` — "⚠ PERMIT EXPIRED"

All three render the same Space field, sourced from `_assigned_spaces` on the resident (via
`derive_space_allowed_plates` RPC — space attribution is to the RESIDENT, not the vehicle).

The pending-card commit changes the label to **"Resident's Space"** conditional on
`result.status === 'pending'`. `declined` and `expired` retain the ambiguous **"Space"**
label — same misread available (a driver could think "this declined vehicle had space 523"
rather than "the resident on this plate holds space 523").

## Why it wasn't fixed in the same commit

Explicit scope guard from Jose: "Driver pending-approval card only." Declined and expired
share the render block but are not the pending-approval card. The label conditional was
tightened to `pending` only rather than the whole block. This memo captures the same-class
ambiguity for the other two statuses.

## Proposed fix (when opened)

Two options:
1. **Same conditional widened:** `result.status === 'pending' || result.status === 'declined' || result.status === 'expired'` — but at that point it's all three statuses that share the block, so drop the conditional entirely and just use `"Resident's Space"` unconditionally in this render.
2. **Different labels per status** if the semantic isn't quite the same — e.g. `"Resident's Space (declined)"` — but this is likely over-fitted; option 1 is cleaner.

Recommendation: option 1 (unconditional `"Resident's Space"` label for the whole
pending/declined/expired render block).

## Location

`app/driver/page.tsx` — the render block covering the pending / declined / expired statuses.
The Space label span is at the top of the space-reference-data section, currently reading:

```tsx
<span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>
  {result.status === 'pending' ? "Resident's Space" : 'Space'}
</span>
```

Change to unconditional `"Resident's Space"` when this is opened.

## Do NOT fix ad-hoc

Per scope discipline, do not sweep this in a later unrelated commit. Open its own commit
(display-copy-only, one-file) when picked up.
