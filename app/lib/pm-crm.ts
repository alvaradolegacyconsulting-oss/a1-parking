// PM Resident CRM — client-side grouping helpers.
//
// The whole point of this module: fold N property-scoped batch loads
// (residents · pending residents · vehicles · spaces · space_residents ·
// guest_authorizations · space_requests) into a single CrmResident[]
// indexed by resident. Zero per-resident queries. This is the anti-N+1
// contract that keeps the CRM fast under any RLS regime.
//
// Match rule: primary by lowercased email; fallback by unit for legacy
// rows missing resident_email (early A1 data had unit-only vehicles).

import type { GuestAuth } from './guest-auth'

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

// ── Row shapes (loose; source tables carry lots of columns we don't need)

export interface CrmSpace {
  id: number
  label: string
  type: string | null
  status: string | null
  is_active: boolean
  assigned_to_resident_email?: string | null
  property?: string | null
}

export interface CrmSpaceResidentTie {
  space_id: number
  resident_email: string
}

export interface CrmSpaceRequest {
  id: number
  resident_email: string
  property: string
  requested_space_id?: number | null
  requested_space_label?: string | null
  note?: string | null
  status: string
  created_at: string
}

export interface CrmResident {
  id: number
  name: string
  email: string
  unit: string
  property: string
  phone: string | null
  status: 'pending' | 'active' | 'declined'
  is_active: boolean
  lease_end: string | null
  created_at: string | null
  manager_note: string | null
  // Grouped derivations:
  vehicles: any[]
  vehicleCounts: { approved: number; pending: number; underReview: number }
  assignedSpaces: CrmSpace[]
  guests: GuestAuth[]
  spaceRequest: CrmSpaceRequest | null
  needsApproval: boolean
}

// ── Grouping (single pass) ───────────────────────────────────────────

export function buildCrmResidents(input: {
  residents: any[]
  pendingResidents: any[]
  vehicles: any[]
  spaces: CrmSpace[]
  spaceResidentTies: CrmSpaceResidentTie[]
  guestAuths: GuestAuth[]
  spaceRequests: CrmSpaceRequest[]
}): CrmResident[] {
  const allResidents = [...input.pendingResidents, ...input.residents]

  // Vehicles: index by lowered email, and by unit as fallback.
  const vehiclesByEmail = new Map<string, any[]>()
  const vehiclesByUnit = new Map<string, any[]>()
  for (const v of input.vehicles) {
    const email = norm(v.resident_email)
    const unit = norm(v.unit)
    if (email) {
      const list = vehiclesByEmail.get(email) ?? []
      list.push(v); vehiclesByEmail.set(email, list)
    }
    if (unit) {
      const list = vehiclesByUnit.get(unit) ?? []
      list.push(v); vehiclesByUnit.set(unit, list)
    }
  }

  // Spaces: primary via space_residents ties (multi-resident SoT), fallback
  // via spaces.assigned_to_resident_email (legacy single-resident).
  const spacesById = new Map<number, CrmSpace>()
  for (const s of input.spaces) spacesById.set(s.id, s)

  const spacesByEmail = new Map<string, CrmSpace[]>()
  for (const tie of input.spaceResidentTies) {
    const email = norm(tie.resident_email)
    if (!email) continue
    const s = spacesById.get(tie.space_id)
    if (!s) continue
    const list = spacesByEmail.get(email) ?? []
    list.push(s); spacesByEmail.set(email, list)
  }
  for (const s of input.spaces) {
    const email = norm(s.assigned_to_resident_email)
    if (!email) continue
    if (!spacesByEmail.has(email)) spacesByEmail.set(email, [s])
  }

  // Guest auths: by email OR unit.
  const guestsByEmail = new Map<string, GuestAuth[]>()
  const guestsByUnit = new Map<string, GuestAuth[]>()
  for (const g of input.guestAuths) {
    const email = norm((g as any).resident_email)
    const unit = norm((g as any).unit)
    if (email) {
      const list = guestsByEmail.get(email) ?? []
      list.push(g); guestsByEmail.set(email, list)
    }
    if (unit) {
      const list = guestsByUnit.get(unit) ?? []
      list.push(g); guestsByUnit.set(unit, list)
    }
  }

  // Pending space requests: one per resident (first-wins on duplicates).
  const spaceReqByEmail = new Map<string, CrmSpaceRequest>()
  for (const sr of input.spaceRequests) {
    if (norm(sr.status) !== 'pending') continue
    const email = norm(sr.resident_email)
    if (email && !spaceReqByEmail.has(email)) spaceReqByEmail.set(email, sr)
  }

  // Count residents per unit so we can warn about ambiguous unit-fallback
  // attribution at shared units (slice-2 guardrail per Jose 2026-07-03).
  const residentsPerUnit = new Map<string, number>()
  for (const r of allResidents) {
    const u = norm(r.unit)
    if (u) residentsPerUnit.set(u, (residentsPerUnit.get(u) ?? 0) + 1)
  }

  return allResidents.map((r): CrmResident => {
    const email = norm(r.email)
    const unit = norm(r.unit)
    let vs = vehiclesByEmail.get(email) ?? []
    if (vs.length === 0 && !email && unit) {
      vs = vehiclesByUnit.get(unit) ?? []
      // Ambiguous-attribution guard: unit-fallback fired at a unit with >1
      // resident. Surface (not silence) so any real-world drift is loud.
      if (vs.length > 0 && (residentsPerUnit.get(unit) ?? 0) > 1) {
        console.warn('[pm-crm] vehicle unit-fallback matched at shared unit — ambiguous attribution', {
          unit,
          resident_id: r.id,
          resident_name: r.name,
          matched_vehicle_ids: vs.map((v: any) => v.id),
          note: 'resident had no email; vehicle attribution may be wrong. Verify resident_email on the vehicle rows.',
        })
      }
    }
    const counts = countVehicles(vs)
    const gs = guestsByEmail.get(email) ?? guestsByUnit.get(unit) ?? []
    const ss = spacesByEmail.get(email) ?? []
    const sr = spaceReqByEmail.get(email) ?? null
    const status = ((r.status as string) ?? (r.is_active ? 'active' : 'pending')) as CrmResident['status']
    const needsApproval =
      status === 'pending' ||
      counts.pending > 0 ||
      counts.underReview > 0 ||
      sr !== null
    return {
      id: r.id,
      name: r.name || '(unnamed)',
      email: r.email || '',
      unit: r.unit || '',
      property: r.property || '',
      phone: r.phone ?? null,
      status,
      is_active: r.is_active ?? (status === 'active'),
      lease_end: r.lease_end ?? null,
      created_at: r.created_at ?? null,
      manager_note: r.manager_note ?? null,
      vehicles: vs,
      vehicleCounts: counts,
      assignedSpaces: ss,
      guests: gs,
      spaceRequest: sr,
      needsApproval,
    }
  })
}

export function countVehicles(vs: any[]): { approved: number; pending: number; underReview: number } {
  let approved = 0, pending = 0, underReview = 0
  for (const v of vs) {
    const s = norm(v.status)
    if (s === 'under_review') underReview++
    else if (s === 'pending') pending++
    else if (s === 'active' || s === 'approved') approved++
  }
  return { approved, pending, underReview }
}

// ── Insights (top-of-page 5-count strip)

export interface CrmInsights {
  needApproval: number
  spaceRequests: number
  platesUnderReview: number
  activeResidents: number
  approvedPermits: number
}

export function computeInsights(rows: CrmResident[]): CrmInsights {
  let needApproval = 0, spaceRequests = 0, platesUnderReview = 0, activeResidents = 0, approvedPermits = 0
  for (const r of rows) {
    if (r.needsApproval) needApproval++
    if (r.spaceRequest) spaceRequests++
    platesUnderReview += r.vehicleCounts.underReview
    if (r.status === 'active') activeResidents++
    approvedPermits += r.vehicleCounts.approved
  }
  return { needApproval, spaceRequests, platesUnderReview, activeResidents, approvedPermits }
}

// ── List filter + search (client-side)

export type CrmFilter = 'all' | 'active' | 'needs' | 'review'

export function filterCrmRows(rows: CrmResident[], filter: CrmFilter, search: string): CrmResident[] {
  const q = search.trim().toLowerCase()
  return rows.filter(r => {
    if (filter === 'active' && r.status !== 'active') return false
    if (filter === 'needs' && !r.needsApproval) return false
    if (filter === 'review' && r.vehicleCounts.underReview === 0) return false
    if (!q) return true
    const hay = [r.name, r.email, r.unit, ...r.vehicles.map((v: any) => v.plate)].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?'
}
