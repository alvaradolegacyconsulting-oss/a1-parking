'use client'

// ════════════════════════════════════════════════════════════════════
// PlateStateSelect — a select that cannot rewrite what it cannot show
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THE INVARIANT: rendering a vehicle and saving it without touching
// this field leaves the stored state byte-identical, whatever it holds.
//
// A plain <select> breaks that. When `value` matches no <option> the
// browser selects the FIRST option, so the next save writes that
// instead — silent corruption of a field nobody edited. 11 production
// rows (LA, TN, MO, MS, MI) and 84 spelled "Texas" were exposed to
// exactly this.
//
// The unrecognised value is therefore rendered as a real option, first
// in the list, labelled "(as recorded)". Preserved AND visible: the
// operator can see the row holds something unusual rather than having
// it quietly conformed.

import { plateStateOptions } from '../lib/us-states'

export default function PlateStateSelect({
  value, onChange, style, disabled, id, ariaLabel,
}: {
  value: string | null | undefined
  onChange: (next: string) => void
  style?: React.CSSProperties
  disabled?: boolean
  id?: string
  ariaLabel?: string
}) {
  const opts = plateStateOptions(value)
  return (
    <select
      id={id}
      aria-label={ariaLabel ?? 'Plate state'}
      // Never undefined: an uncontrolled select would pick its own
      // first option and reintroduce the bug from the other direction.
      value={(value ?? '') || ''}
      onChange={e => onChange(e.target.value)}
      style={style}
      disabled={disabled}
    >
      {!value && <option value="">—</option>}
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
