'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'

type Status = 'draft' | 'issued' | 'redeemed' | 'expired' | 'revoked'
type Tab = 'all' | Status

type Row = {
  id: number
  code: string
  client_name: string | null
  client_email: string | null
  status: Status
  expires_at: string | null
  redeemed_at: string | null
  base_tier_type: string | null
  base_tier: string | null
  company_id: number | null
  created_at: string
}

const STATUS_BADGE: Record<Status, { bg: string; fg: string; border: string; label: string }> = {
  draft:    { bg: '#1e2535', fg: '#aaa',     border: '#3a4055', label: 'Draft' },
  issued:   { bg: '#0e1a2a', fg: '#4fc3f7',  border: '#0288d1', label: 'Issued' },
  redeemed: { bg: '#0d1f0d', fg: '#4caf50',  border: '#2e7d32', label: 'Redeemed' },
  expired:  { bg: '#2a1f0a', fg: '#fbbf24',  border: '#a16207', label: 'Expired' },
  revoked:  { bg: '#3a1a1a', fg: '#f44336',  border: '#b71c1c', label: 'Revoked' },
}

const TIER_LABEL: Record<string, string> = {
  starter: 'Starter', growth: 'Growth', legacy: 'Legacy',
  essential: 'Essential', professional: 'Professional', enterprise: 'Enterprise',
}

function effectiveStatus(row: Row): Status {
  if (row.status === 'issued' && row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return 'expired'
  }
  return row.status
}

export default function ProposalCodesList() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('all')

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      const { data: roleData } = await supabase
        .from('user_roles').select('role').ilike('email', user.email!).single()
      if (roleData?.role !== 'admin') { window.location.href = '/'; return }
      setAuthChecked(true)
      const { data } = await supabase
        .from('proposal_codes')
        .select('id, code, client_name, client_email, status, expires_at, redeemed_at, base_tier_type, base_tier, company_id, created_at')
        .order('created_at', { ascending: false })
      setRows((data as Row[]) || [])
      setLoading(false)
    })()
  }, [])

  if (!authChecked) {
    return (
      <main style={{ minHeight: '100vh', background: '#0f1117', color: '#888', fontFamily: 'Arial, sans-serif', padding: '40px', textAlign: 'center' }}>
        Checking access…
      </main>
    )
  }

  const filtered = tab === 'all' ? rows : rows.filter(r => effectiveStatus(r) === tab)

  const counts = (() => {
    const c: Record<Tab, number> = { all: rows.length, draft: 0, issued: 0, redeemed: 0, expired: 0, revoked: 0 }
    rows.forEach(r => { c[effectiveStatus(r)]++ })
    return c
  })()

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Drafts' },
    { key: 'issued', label: 'Issued' },
    { key: 'redeemed', label: 'Redeemed' },
    { key: 'expired', label: 'Expired' },
    { key: 'revoked', label: 'Revoked' },
  ]

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h1 style={{ color: '#C9A227', fontSize: '22px', fontWeight: 'bold', margin: 0 }}>Proposal Codes</h1>
            <p style={{ color: '#888', fontSize: '12px', margin: '4px 0 0' }}>
              Custom subscription proposals · {rows.length} total
            </p>
          </div>
          <button
            onClick={() => router.push('/admin/proposal-codes/new')}
            style={{ padding: '10px 16px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            + New Proposal Code
          </button>
        </div>

        <div style={{ display: 'flex', gap: '4px', background: '#1e2535', borderRadius: '8px', padding: '3px', marginBottom: '14px', flexWrap: 'wrap' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: '7px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                fontSize: '12px', fontWeight: tab === t.key ? 'bold' : 'normal',
                background: tab === t.key ? '#C9A227' : 'transparent',
                color: tab === t.key ? '#0f1117' : '#aaa',
                fontFamily: 'Arial',
              }}>
              {t.label} <span style={{ opacity: 0.7 }}>({counts[t.key]})</span>
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ color: '#555', textAlign: 'center', padding: '40px' }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '40px', textAlign: 'center' }}>
            <p style={{ color: '#555', fontSize: '13px', margin: 0 }}>
              {tab === 'all' ? 'No proposal codes yet. Create one to get started.' : `No codes in ${tab} state.`}
            </p>
          </div>
        ) : (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', overflow: 'hidden' }}>
            {filtered.map((r, i) => {
              const eff = effectiveStatus(r)
              const badge = STATUS_BADGE[eff]
              const tierLabel = r.base_tier_type && r.base_tier
                ? `${r.base_tier_type === 'enforcement' ? 'Enf' : 'PM'} · ${TIER_LABEL[r.base_tier] || r.base_tier}`
                : '—'
              const expiresStr = r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—'
              return (
                <div key={r.id}
                  onClick={() => router.push(`/admin/proposal-codes/${r.code}`)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.5fr 1.5fr 0.9fr 0.9fr 0.9fr',
                    gap: '12px',
                    alignItems: 'center',
                    padding: '12px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid #1e2535',
                    cursor: 'pointer',
                  }}>
                  <div>
                    <p style={{ color: '#C9A227', fontFamily: 'Courier New', fontSize: '13px', fontWeight: 'bold', margin: 0 }}>{r.code}</p>
                    <p style={{ color: '#555', fontSize: '10px', margin: '2px 0 0' }}>
                      created {new Date(r.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div>
                    <p style={{ color: 'white', fontSize: '12px', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.client_name || '—'}
                    </p>
                    <p style={{ color: '#888', fontSize: '10px', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.client_email || ''}
                    </p>
                  </div>
                  <p style={{ color: '#aaa', fontSize: '11px', margin: 0 }}>{tierLabel}</p>
                  <p style={{ color: eff === 'expired' ? '#fbbf24' : '#aaa', fontSize: '11px', margin: 0 }}>{expiresStr}</p>
                  <span style={{
                    background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
                    padding: '3px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold',
                    textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center',
                    justifySelf: 'end',
                  }}>{badge.label}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
