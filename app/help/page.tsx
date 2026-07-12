import type { Metadata } from 'next'
import Link from 'next/link'
import { getAllDocs, getCategories } from '../lib/help-docs'
import HelpSearchInput from './HelpSearchInput'
import HelpDocGrid, { type GridDoc } from './HelpDocGrid'
import HelpSupportAffordance from '../components/HelpSupportAffordance'

// B85: help center index. Server component; statically generated.
// Category filter via ?category= query param (locked: filter, not
// separate routes). Doc grid + role-aware sort live in HelpDocGrid
// client component; search input is HelpSearchInput client component
// with lazy flexsearch index load on first focus.

const GOLD = '#C9A227'
const BG = '#0a0d14'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'
const CARD_BG = 'rgba(255,255,255,0.02)'

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

export default async function HelpIndexPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const activeCategory = params.category ?? null

  const allDocs = getAllDocs()
  const allCategories = getCategories()
  const visibleDocs = activeCategory
    ? allDocs.filter((d) => d.frontmatter.category === activeCategory)
    : allDocs

  // Slim serialization for client component (no body, no html, no fs handles).
  const gridDocs: GridDoc[] = visibleDocs.map((d) => ({
    slug: d.slug,
    title: d.frontmatter.title,
    category: d.frontmatter.category,
    audience: d.frontmatter.audience ?? [],
    tier_required: d.frontmatter.tier_required,
    last_updated: d.frontmatter.last_updated,
  }))

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

        {/* Search — lazy-loads flexsearch + index on first focus */}
        <div style={{ marginBottom: 28 }}>
          <HelpSearchInput />
        </div>

        {/* Video library teaser link */}
        <div style={{ marginBottom: 28 }}>
          <Link
            href="/help/videos"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'rgba(201,162,39,0.06)', border: '1px solid rgba(201,162,39,0.3)',
              color: GOLD, fontSize: 13, fontWeight: 600, textDecoration: 'none',
              padding: '8px 14px', borderRadius: 999,
            }}
          >
            🎬 Watch video walkthroughs →
          </Link>
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

        {/* Docs grid (client component handles role-aware reorder post-hydration) */}
        <HelpDocGrid
          docs={gridDocs}
          categories={allCategories}
          activeCategory={activeCategory}
        />

        <footer style={{ marginTop: 48, paddingTop: 24, borderTop: `1px solid ${BORDER}`, color: MUTED, fontSize: 12, textAlign: 'center' }}>
          Can&apos;t find what you&apos;re looking for?{' '}
          <HelpSupportAffordance
            linkText="Contact support"
            fallbackText="Contact your company administrator"
            style={{ color: GOLD, textDecoration: 'none' }}
          />
        </footer>

      </div>
    </main>
  )
}
