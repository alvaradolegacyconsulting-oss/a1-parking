import type { Metadata } from 'next'
import Link from 'next/link'
import { getAllDocs, getCategories } from '../lib/help-docs'

// B85: help center index. Server component; statically generated.
// Category filter via ?category= query param — index-page filter,
// not a separate route (locked B85 decision).
//
// Role-aware sort (Jose's locked decision) is DEFERRED to session 2.
// Default sort: category order (Getting Started → Enforcement → PM →
// Shared → Compliance) then filename order within category. Anonymous
// users get this default; logged-in role-aware reorder lands in the
// follow-up polish pass.
//
// Search input rendered but UI wiring (flexsearch lazy-load) also
// deferred to session 2. Stub renders the input; future commit wires
// the index fetch + result render.

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export const metadata: Metadata = {
  title: 'Help Center · ShieldMyLot',
  description: 'Documentation, guides, and reference for ShieldMyLot — Texas parking enforcement platform.',
  openGraph: {
    title: 'Help Center · ShieldMyLot',
    description: 'Documentation, guides, and reference for ShieldMyLot.',
    url: 'https://shieldmylot.com/help',
    type: 'website',
  },
}

type SearchParams = { category?: string }

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

export default async function HelpIndexPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Next 16: searchParams is a Promise. Await it.
  const params = await searchParams
  const activeCategory = params.category ?? null

  const allDocs = getAllDocs()
  const allCategories = getCategories()
  const visibleDocs = activeCategory
    ? allDocs.filter((d) => d.frontmatter.category === activeCategory)
    : allDocs

  // Group visible docs by category for rendering
  const groupedDocs: Record<string, typeof allDocs> = {}
  for (const cat of allCategories) {
    const group = visibleDocs.filter((d) => d.frontmatter.category === cat)
    if (group.length > 0) groupedDocs[cat] = group
  }

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '40px 24px 64px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        <header style={{ marginBottom: 36 }}>
          <p style={{ color: GOLD, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
            ShieldMyLot™ Help Center
          </p>
          <h1 style={{ color: TEXT, fontSize: 36, fontWeight: 800, margin: '0 0 12px', letterSpacing: '-0.02em' }}>
            How can we help?
          </h1>
          <p style={{ color: '#94a3b8', fontSize: 16, margin: 0, lineHeight: 1.6 }}>
            Guides, references, and operational know-how for the platform.
          </p>
        </header>

        {/* Search input — UI placeholder; flexsearch lazy-load wiring lands in B85 session 2.
            Renders as a non-functional input today; styled to fit the surface so the polish
            pass slot it without layout shift. */}
        <div style={{ marginBottom: 32 }}>
          <input
            type="search"
            placeholder="Search help docs… (coming soon)"
            aria-label="Search help docs"
            disabled
            style={{
              width: '100%', background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10,
              padding: '12px 16px', color: TEXT, fontSize: 14, fontFamily: 'inherit', outline: 'none',
              opacity: 0.55, cursor: 'not-allowed',
            }}
          />
        </div>

        {/* Category filter chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
          <Link
            href="/help"
            style={{
              background: !activeCategory ? GOLD : CARD_BG,
              color: !activeCategory ? '#0a0d14' : '#94a3b8',
              border: `1px solid ${!activeCategory ? GOLD : BORDER}`,
              borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            All
          </Link>
          {allCategories.map((cat) => {
            const active = activeCategory === cat
            return (
              <Link
                key={cat}
                href={`/help?category=${encodeURIComponent(cat)}`}
                style={{
                  background: active ? GOLD : CARD_BG,
                  color: active ? '#0a0d14' : '#94a3b8',
                  border: `1px solid ${active ? GOLD : BORDER}`,
                  borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                {cat}
              </Link>
            )
          })}
        </div>

        {/* Doc grid by category */}
        {Object.entries(groupedDocs).map(([cat, docs]) => (
          <section key={cat} style={{ marginBottom: 36 }}>
            <h2 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 14px' }}>{cat}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {docs.map((d) => (
                <Link
                  key={d.slug}
                  href={`/help/${d.slug}`}
                  style={{
                    display: 'block', background: CARD_BG, border: `1px solid ${BORDER}`,
                    borderRadius: 12, padding: '18px 18px 16px', textDecoration: 'none',
                  }}
                >
                  <h3 style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 8px' }}>{d.frontmatter.title}</h3>
                  <div style={{ marginBottom: 10 }}>
                    <TierBadge tier={d.frontmatter.tier_required} />
                    {d.frontmatter.audience?.slice(0, 4).map((a) => <AudienceBadge key={a} role={a} />)}
                  </div>
                  <p style={{ color: MUTED, fontSize: 11, margin: 0 }}>Last updated: {d.frontmatter.last_updated}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}

        {visibleDocs.length === 0 && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '24px 28px', textAlign: 'center' }}>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>No docs in this category yet.</p>
          </div>
        )}

        <footer style={{ marginTop: 48, paddingTop: 24, borderTop: `1px solid ${BORDER}`, color: MUTED, fontSize: 12, textAlign: 'center' }}>
          Can&apos;t find what you&apos;re looking for?{' '}
          <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none' }}>Contact support</a>.
        </footer>

      </div>
    </main>
  )
}
