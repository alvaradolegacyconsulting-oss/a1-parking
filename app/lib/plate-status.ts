// B230 Part B — shared plate-status meta.
//
// Three plate-lookup surfaces (driver, manager, CA) all render a
// status badge. Pre-Part-B, PM surfaces (manager + CA) collapsed
// "pending" and "plate_under_review" into "not authorized" — a
// safety-relevant miscommunication. Driver has always distinguished
// these states inline with rich do-not-tow copy (see
// app/driver/page.tsx:1515-1637).
//
// This module publishes the shared meta (badge colors, label, PM/driver
// copy variants, do-not-tow flag) so manager + CA can render the
// pending states consistently with the driver's semantics — same
// underlying state, surface-appropriate copy. Driver keeps its inline
// render as the reference implementation (behavior-preserving refactor
// there risks regressions on safety-critical copy; opt-in later).
//
// The `isDoNotTow` predicate is the load-bearing invariant: any status
// that classifies as do-not-tow MUST render prominently as such on
// enforcement-facing surfaces.

export type PlateStatus =
  | 'authorized'          // active permit (resident or CA-scope match)
  | 'pending'             // vehicles is_active=FALSE + status='pending' — permit approval pending
  | 'plate_under_review'  // vehicle_plate_changes.status='pending' matching the scanned plate
  | 'declined'            // vehicles is_active=FALSE + status='declined'
  | 'expired'             // vehicles is_active=FALSE + status='expired'
  | 'guest_authorized'    // active guest_authorizations row
  | 'visitor'             // active visitor_passes row
  | 'otherproperty'       // active permit at a different property in scope (CA surface)
  | 'unauthorized'        // pm_plate_lookup RPC's default when no branch matches
  | 'notfound'            // driver's client-cascade equivalent of 'unauthorized'

export type PlateSurface = 'driver' | 'pm'

export interface PlateStatusMeta {
  label:            string   // uppercase headline (used as the base badge text)
  bg:               string   // background color hex
  border:           string   // border color hex
  color:            string   // text color hex
  doNotTow:         boolean  // load-bearing: if TRUE, enforcement must not tow
  driverHeadline?:  string   // driver-surface copy (default: `label`)
  driverSubtitle?: string    // driver secondary line — richer imperative
  pmHeadline?:      string   // PM-surface copy (default: `label`)
  pmSubtitle?:      string   // PM secondary line — oversight-focused
}

// Color values sourced from driver/page.tsx:1521-1522 verbatim so the
// three surfaces share the exact same palette. If those literals ever
// change on the driver side, mirror here.
const AUTHORIZED_BG  = '#061406'
const AUTHORIZED_BR  = '#2e7d32'
const AUTHORIZED_FG  = '#4caf50'
const REVIEW_BG      = '#241a08'  // amber — pending / plate_under_review
const REVIEW_BR      = '#a16207'
const REVIEW_FG      = '#fbbf24'
const VISITOR_BG     = '#150f00'  // amber-ish for visitor + otherproperty
const VISITOR_BR     = '#a16207'
const VISITOR_FG     = '#fbbf24'
const GUEST_BG       = '#0a1628'  // blue — guest_authorized
const GUEST_BR       = '#3b82f6'
const GUEST_FG       = '#60a5fa'
const DENIED_BG      = '#140404'  // red — expired / declined / unauthorized / notfound
const DENIED_BR      = '#991b1b'
const DENIED_FG      = '#f44336'

export const PLATE_STATUS_META: Record<PlateStatus, PlateStatusMeta> = {
  authorized: {
    label: 'AUTHORIZED',
    bg: AUTHORIZED_BG, border: AUTHORIZED_BR, color: AUTHORIZED_FG,
    doNotTow: true,
    driverHeadline: '✓ AUTHORIZED',
    pmHeadline: '✓ Authorized',
  },
  pending: {
    label: 'REGISTRATION PENDING — DO NOT TOW',
    bg: REVIEW_BG, border: REVIEW_BR, color: REVIEW_FG,
    doNotTow: true,
    driverHeadline: '⚠ REGISTRATION PENDING — DO NOT TOW',
    driverSubtitle: 'Resident has submitted this vehicle; awaiting PM approval.',
    pmHeadline: 'Under review',
    pmSubtitle: 'Permit approval pending. Do not treat as unauthorized.',
  },
  plate_under_review: {
    label: 'PLATE UNDER REVIEW — DO NOT TOW',
    bg: REVIEW_BG, border: REVIEW_BR, color: REVIEW_FG,
    doNotTow: true,
    driverHeadline: '⚠ DO NOT TOW — plate change under review',
    driverSubtitle: 'Resident has requested this plate; awaiting PM approval.',
    pmHeadline: 'Plate change under review',
    pmSubtitle: 'A resident-submitted plate change is pending. Do not treat as unauthorized.',
  },
  declined: {
    label: 'PERMIT DECLINED',
    bg: DENIED_BG, border: DENIED_BR, color: DENIED_FG,
    doNotTow: false,
    driverHeadline: '✗ PERMIT DECLINED',
    pmHeadline: 'Permit declined',
  },
  expired: {
    label: 'PERMIT EXPIRED',
    bg: DENIED_BG, border: DENIED_BR, color: DENIED_FG,
    doNotTow: false,
    driverHeadline: '✗ PERMIT EXPIRED',
    pmHeadline: 'Permit expired',
  },
  guest_authorized: {
    label: 'GUEST AUTHORIZED',
    bg: GUEST_BG, border: GUEST_BR, color: GUEST_FG,
    doNotTow: true,
    driverHeadline: '✓ GUEST AUTHORIZED',
    pmHeadline: 'Guest authorized',
  },
  visitor: {
    label: 'VISITOR PASS',
    bg: VISITOR_BG, border: VISITOR_BR, color: VISITOR_FG,
    doNotTow: true,
    driverHeadline: '✓ VISITOR PASS',
    pmHeadline: 'Visitor pass',
  },
  otherproperty: {
    label: 'AUTHORIZED AT OTHER PROPERTY',
    bg: VISITOR_BG, border: VISITOR_BR, color: VISITOR_FG,
    doNotTow: false,   // CA surface: authorized elsewhere ≠ authorized here
    driverHeadline: 'AUTHORIZED (OTHER PROPERTY)',
    pmHeadline: 'Authorized at another property',
    pmSubtitle: 'This plate is registered at a different property in your portfolio.',
  },
  unauthorized: {
    label: 'NOT AUTHORIZED',
    bg: DENIED_BG, border: DENIED_BR, color: DENIED_FG,
    doNotTow: false,
    driverHeadline: '✗ NOT AUTHORIZED',
    pmHeadline: 'Not authorized',
  },
  notfound: {
    label: 'NO PERMIT FOUND',
    bg: DENIED_BG, border: DENIED_BR, color: DENIED_FG,
    doNotTow: false,
    driverHeadline: '✗ NO PERMIT FOUND',
    pmHeadline: 'No permit on file',
  },
}

// Load-bearing invariant on the enforcement side. Do NOT weaken by
// adding an inline check at a call site — always route through this.
export function isDoNotTow(status: PlateStatus): boolean {
  return PLATE_STATUS_META[status]?.doNotTow ?? false
}

// Convenience — surface-appropriate copy for the headline + subtitle.
export function plateHeadline(status: PlateStatus, surface: PlateSurface): string {
  const meta = PLATE_STATUS_META[status]
  if (!meta) return status.toUpperCase()
  const surfaceLine = surface === 'driver' ? meta.driverHeadline : meta.pmHeadline
  return surfaceLine ?? meta.label
}

export function plateSubtitle(status: PlateStatus, surface: PlateSurface): string | null {
  const meta = PLATE_STATUS_META[status]
  if (!meta) return null
  return (surface === 'driver' ? meta.driverSubtitle : meta.pmSubtitle) ?? null
}
