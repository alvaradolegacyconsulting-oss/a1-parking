'use client'
// B85 Phase 2: docs grid with role-aware post-hydration reorder.
// Server component (app/help/page.tsx) passes a slim serializable docs
// array. Initial render uses the order as-provided (default category-
// order from server, no role reorder) so SSR HTML and client first-
// render match. After mount, fetches user role and reorders WITHIN each
// category — role-relevant docs bubble to the top of their category.
//
// Anonymous users: no reorder, no flash.
// Logged-in users: brief reorder flash on first paint, acceptable per
// locked "graceful post-hydration reorder" decision. B86 (deferred) will
// stash role in localStorage at /login so this can read sync + skip the
// flash entirely.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../supabase'

const GOLD = '#C9A227'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export type GridDoc = {
  slug: string
  title: string
  category: string
  audience: string[]
  tier_required: string
  last_updated: string
}

type Props = {
  docs: GridDoc[]
  categories: string[]
  activeCategory: string | null
}

// Local copy of sortDocsForRole (avoids importing the server-side lib
// with its fs dependency into a client component).
function sortByRole(docs: GridDoc[], role: string | null): GridDoc[] {
  if (!role) return docs
  const match: GridDoc[] = []
  const other: GridDoc[] = []
  for (const d of docs) {
    if (d.audience?.includes(role)) match.push(d)
    else other.push(d)
  }
  return [...match, ...other]
}

function AudienceBadge({ role }: { role: string }) {
  const label = role.replace(/_/g, ' ')
  return (
    <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, color: '#94a3b8', fontSize: 10, padding: '1px 7px', borderRadius: 10, marginRight: 4, textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

function TierBadge({ tier }: { tier: string }) {
  if (tier === 'any') return null
  return (
    <span style={{ display: 'inline-block', background: 'rgba(201,162,39,0.12)', border: `1px solid rgba(201,162,39,0.5)`, color: GOLD, fontSize: 10, padding: '1px 7px', borderRadius: 10, marginRight: 4, fontWeight: 600 }}>
      {tier}
    </span>
  )
}

export default function HelpDocGrid({ docs, categories, activeCategory }: Props) {
  const [viewerRole, setViewerRole] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadRole() {
      const { data: { user } } = await supabase.auth.getUser()
      if (cancelled || !user?.email) return
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .ilike('email', user.email)
        .maybeSingle()
      if (cancelled) return
      if (data?.role) setViewerRole(data.role)
    }
    void loadRole()
    return () => { cancelled = true }
  }, [])

  // Group docs by category; apply role-aware sort WITHIN each group.
  // Anonymous → group docs in default (filename) order. Logged-in →
  // role-relevant docs bubble to top of each category.
  const groupedDocs: Record<string, GridDoc[]> = {}
  for (const cat of categories) {
    const inCat = docs.filter((d) => d.category === cat)
    if (inCat.length > 0) groupedDocs[cat] = sortByRole(inCat, viewerRole)
  }

  if (docs.length === 0) {
    return (
      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '24px 28px', textAlign: 'center' }}>
        <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>No docs in this category yet.</p>
      </div>
    )
  }

  return (
    <>
      {Object.entries(groupedDocs).map(([cat, catDocs]) => (
        <section key={cat} style={{ marginBottom: 36 }}>
          {!activeCategory && (
            <h2 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 14px' }}>{cat}</h2>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {catDocs.map((d) => (
              <Link
                key={d.slug}
                href={`/help/${d.slug}`}
                style={{
                  display: 'block', background: CARD_BG, border: `1px solid ${BORDER}`,
                  borderRadius: 12, padding: '18px 18px 16px', textDecoration: 'none',
                }}
              >
                <h3 style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 8px' }}>{d.title}</h3>
                <div style={{ marginBottom: 10 }}>
                  <TierBadge tier={d.tier_required} />
                  {d.audience?.slice(0, 4).map((a) => <AudienceBadge key={a} role={a} />)}
                </div>
                <p style={{ color: MUTED, fontSize: 11, margin: 0 }}>Last updated: {d.last_updated}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
