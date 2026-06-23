'use client'
//
// Spaces v1.1 SearchableResidentPicker — reusable across manager + CA portals.
//
// Replaces the old <select> dropdown of all-residents-at-property (unusable
// at 500+ residents; manager scrolls to find one). This is a server-side-
// search picker: type to filter, match across name + unit + plate.
//
// PER-PROPERTY SCOPED (locked decision #4): the picker queries residents
// at the given property only. A space belongs to one property; tying a
// cross-property resident is never correct. Scope it so the wrong thing
// is unrepresentable, not merely discouraged.
//
// ACTIVE RESIDENTS ONLY: deactivated residents don't appear in search
// results. This matches the manager's intent ("assign to a current
// resident") and prevents accidentally re-tying a freed deactivated
// resident.
//
// PLATE MATCHING via join to vehicles: typing a plate fragment finds the
// resident who owns that plate. Same property, vehicles.is_active=TRUE.
//
// EXCLUDE-EMAILS prop: caller passes the emails ALREADY tied to the space
// (cap=2 enforcement is render-side advisory; the assign_space RPC also
// enforces server-side per the boundary-audit lesson). Tied residents
// don't reappear in the picker.

import { useEffect, useState, useRef } from 'react'
import { supabase } from '../supabase'

export interface SearchableResidentPickerResult {
  email: string
  name: string
  unit: string
  vehicle_count: number
  plates: string[]   // first ~5 plates for the result-row preview
}

interface Props {
  property: string
  onSelect: (resident: SearchableResidentPickerResult) => void
  excludeEmails?: string[]              // residents already tied; not re-shown
  placeholder?: string                  // input placeholder text
  autoFocus?: boolean
}

// Strip PostgREST .or() special chars from the search input. Manager search
// rarely includes these but stripping prevents query-parse breakage.
function sanitizeSearch(q: string): string {
  return q.replace(/[,()*%]/g, '').trim()
}

export default function SearchableResidentPicker({
  property,
  onSelect,
  excludeEmails = [],
  placeholder = 'Search by name, unit, or plate…',
  autoFocus = false,
}: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchableResidentPickerResult[]>([])
  const [loading, setLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const lowerExclude = excludeEmails.map(e => e.toLowerCase())

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const safeQuery = sanitizeSearch(query)
    if (safeQuery.length < 2) {
      setResults([])
      setShowDropdown(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        // Two parallel queries: (a) residents matched by name OR email OR
        // unit; (b) vehicles matched by plate fragment, then their owning
        // residents at this property. Union deduped by email, capped at 20.
        const [residentsByDirectMatch, vehiclesByPlate] = await Promise.all([
          supabase
            .from('residents')
            .select('email, name, unit')
            .ilike('property', property)
            .eq('is_active', true)
            .or(`name.ilike.%${safeQuery}%,email.ilike.%${safeQuery}%,unit.ilike.%${safeQuery}%`)
            .limit(40),
          supabase
            .from('vehicles')
            .select('plate, resident_email')
            .ilike('property', property)
            .eq('is_active', true)
            .eq('status', 'active')
            .ilike('plate', `%${safeQuery.toUpperCase()}%`)
            .limit(20),
        ])

        // Resolve vehicles-by-plate → their resident records.
        const plateMatchEmails = Array.from(new Set(
          (vehiclesByPlate.data ?? [])
            .map(v => (v.resident_email ?? '').toLowerCase())
            .filter(Boolean)
        ))
        let residentsByPlate: { email: string; name: string; unit: string }[] = []
        if (plateMatchEmails.length > 0) {
          const { data } = await supabase
            .from('residents')
            .select('email, name, unit')
            .ilike('property', property)
            .eq('is_active', true)
            .in('email', plateMatchEmails)
          residentsByPlate = data ?? []
        }

        // Dedupe by lowercase email; drop excluded; cap at 20.
        const merged = new Map<string, { email: string; name: string; unit: string }>()
        for (const r of (residentsByDirectMatch.data ?? [])) {
          const email = (r.email ?? '').toLowerCase()
          if (!email || lowerExclude.includes(email)) continue
          if (!merged.has(email)) merged.set(email, { email, name: r.name ?? '', unit: r.unit ?? '' })
        }
        for (const r of residentsByPlate) {
          const email = (r.email ?? '').toLowerCase()
          if (!email || lowerExclude.includes(email)) continue
          if (!merged.has(email)) merged.set(email, { email, name: r.name ?? '', unit: r.unit ?? '' })
        }
        const candidates = Array.from(merged.values()).slice(0, 20)
        if (candidates.length === 0) {
          setResults([])
          setShowDropdown(true)  // show "no matches" empty state
          return
        }

        // Vehicle count + first ~5 plates per candidate (for result preview).
        const candidateEmails = candidates.map(c => c.email)
        const { data: allVehicles } = await supabase
          .from('vehicles')
          .select('plate, resident_email')
          .ilike('property', property)
          .eq('is_active', true)
          .eq('status', 'active')
          .in('resident_email', candidateEmails)
        const platesByEmail = new Map<string, string[]>()
        for (const v of (allVehicles ?? [])) {
          const email = (v.resident_email ?? '').toLowerCase()
          if (!email) continue
          const list = platesByEmail.get(email) ?? []
          list.push(v.plate)
          platesByEmail.set(email, list)
        }

        const enriched: SearchableResidentPickerResult[] = candidates.map(c => {
          const plates = platesByEmail.get(c.email) ?? []
          return {
            email: c.email,
            name: c.name,
            unit: c.unit,
            vehicle_count: plates.length,
            plates: plates.slice(0, 5),
          }
        })
        enriched.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
        setResults(enriched)
        setShowDropdown(true)
      } finally {
        setLoading(false)
      }
    }, 200)   // 200ms debounce
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, property, excludeEmails.join(',')])

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { if (results.length > 0) setShowDropdown(true) }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          width: '100%', padding: '9px 10px', background: '#1e2535',
          border: '1px solid #3a4055', borderRadius: '6px', color: 'white',
          fontSize: '13px', boxSizing: 'border-box',
        }}
      />
      {showDropdown && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: '#1e2535', border: '1px solid #3a4055', borderRadius: '8px',
            maxHeight: '280px', overflowY: 'auto', zIndex: 50,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
          onMouseDown={e => e.preventDefault()} /* prevent input blur on click */
        >
          {loading && results.length === 0 && (
            <p style={{ color: '#888', fontSize: '12px', padding: '12px', margin: 0, textAlign: 'center' }}>
              Searching…
            </p>
          )}
          {!loading && results.length === 0 && sanitizeSearch(query).length >= 2 && (
            <p style={{ color: '#888', fontSize: '12px', padding: '12px', margin: 0, textAlign: 'center' }}>
              No matching active residents at this property
              {excludeEmails.length > 0 && ' (excluding those already tied)'}.
            </p>
          )}
          {results.map(r => (
            <div
              key={r.email}
              onClick={() => {
                onSelect(r)
                setQuery('')
                setResults([])
                setShowDropdown(false)
              }}
              style={{
                padding: '10px 12px', borderBottom: '1px solid #2a2f3d',
                cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '3px',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#2a2f3d' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = '#1e2535' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'white', fontWeight: 'bold', fontSize: '13px' }}>
                  {r.name || r.email}
                </span>
                <span style={{ color: '#888', fontSize: '11px' }}>
                  Unit {r.unit || '—'} · {r.vehicle_count} {r.vehicle_count === 1 ? 'vehicle' : 'vehicles'}
                </span>
              </div>
              {r.plates.length > 0 && (
                <div style={{ color: '#666', fontSize: '11px', fontFamily: 'Courier New' }}>
                  {r.plates.join(' · ')}{r.vehicle_count > r.plates.length ? ` · +${r.vehicle_count - r.plates.length} more` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
