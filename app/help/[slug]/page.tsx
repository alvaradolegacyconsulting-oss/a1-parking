import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getAllDocs, getAllSlugs, getDocBySlug, getCategories } from '../../lib/help-docs'

// B85: per-doc renderer. Server component; SSG via generateStaticParams.
// Each of the 16 help docs at docs/help/NN-slug.md becomes /help/<slug>.
//
// Frontmatter-driven behavior:
//   • title / category / audience / tier_required / last_updated / related
//     populate the doc header, sidebar position, and related-docs footer
//   • attorney_review_required: true → render NOTICE block at top + noindex
//   • noindex: true (optional) → noindex without the NOTICE block
//
// Inline marked output has slugified heading IDs (h1..h6) so search-result
// deep-links and in-page anchors work — see app/lib/help-docs.ts:slugifyHeading.

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Params = { slug: string }

export function generateStaticParams(): Params[] {
  return getAllSlugs().map((slug) => ({ slug }))
}

export function generateMetadata({ params }: { params: Params }): Metadata {
  const doc = getDocBySlug(params.slug)
  if (!doc) return { title: 'Not found · ShieldMyLot Help' }
  const fm = doc.frontmatter
  const description = doc.body
    .replace(/^#.*$/m, '')              // strip the H1
    .replace(/<[^>]+>/g, '')             // strip HTML
    .replace(/[#*_`>\[\]()]/g, '')        // strip md punctuation
    .trim()
    .split('\n').filter(Boolean)[0]?.slice(0, 160) || fm.title
  return {
    title: `${fm.title} · ShieldMyLot Help`,
    description,
    openGraph: {
      title: `${fm.title} · ShieldMyLot Help`,
      description,
      type: 'article',
      url: `https://shieldmylot.com/help/${doc.slug}`,
    },
    twitter: {
      card: 'summary',
      title: `${fm.title} · ShieldMyLot Help`,
      description,
    },
    robots: doc.shouldNoIndex ? { index: false, follow: false } : undefined,
  }
}

// ── Sidebar nav (CSS-only collapsible via <details>) ──────────────
function HelpSidebar({ currentSlug }: { currentSlug: string }) {
  const docs = getAllDocs()
  const categories = getCategories()
  return (
    <aside style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${BORDER}`, padding: '24px 16px', fontSize: 14 }}>
      <Link href="/help" style={{ color: GOLD, fontSize: 12, fontWeight: 700, textDecoration: 'none', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        ← All Help
      </Link>
      <div style={{ height: 18 }} />
      {categories.map((cat) => {
        const docsInCat = docs.filter((d) => d.frontmatter.category === cat)
        const hasCurrent = docsInCat.some((d) => d.slug === currentSlug)
        return (
          <details key={cat} open={hasCurrent} style={{ marginBottom: 10 }}>
            <summary style={{ color: TEXT, fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: '4px 0', listStyle: 'none' }}>
              {cat}
            </summary>
            <ul style={{ listStyle: 'none', padding: '4px 0 0 8px', margin: 0 }}>
              {docsInCat.map((d) => (
                <li key={d.slug} style={{ padding: '4px 0' }}>
                  <Link href={`/help/${d.slug}`} style={{ color: d.slug === currentSlug ? GOLD : '#94a3b8', fontSize: 13, textDecoration: 'none', fontWeight: d.slug === currentSlug ? 600 : 400 }}>
                    {d.frontmatter.title}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </aside>
  )
}

// ── Breadcrumb ───────────────────────────────────────────────────
function Breadcrumb({ category, title }: { category: string; title: string }) {
  return (
    <nav style={{ color: MUTED, fontSize: 12, marginBottom: 18 }}>
      <Link href="/" style={{ color: MUTED, textDecoration: 'none' }}>Home</Link>
      <span style={{ margin: '0 8px' }}>/</span>
      <Link href="/help" style={{ color: MUTED, textDecoration: 'none' }}>Help</Link>
      <span style={{ margin: '0 8px' }}>/</span>
      <Link href={`/help?category=${encodeURIComponent(category)}`} style={{ color: MUTED, textDecoration: 'none' }}>{category}</Link>
      <span style={{ margin: '0 8px' }}>/</span>
      <span style={{ color: TEXT }}>{title}</span>
    </nav>
  )
}

// ── Audience + tier badges ───────────────────────────────────────
function AudienceBadge({ role }: { role: string }) {
  const label = role.replace(/_/g, ' ')
  return (
    <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, color: '#94a3b8', fontSize: 11, padding: '2px 8px', borderRadius: 10, marginRight: 6, textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

function TierBadge({ tier }: { tier: string }) {
  // B85 locked: gold badge matching B62 landing-page tier card visual language.
  if (tier === 'any') return null
  return (
    <span style={{ display: 'inline-block', background: 'rgba(201,162,39,0.12)', border: `1px solid rgba(201,162,39,0.5)`, color: GOLD, fontSize: 11, padding: '2px 8px', borderRadius: 10, marginRight: 6, fontWeight: 600 }}>
      {tier}
    </span>
  )
}

// ── JSON-LD Article schema ───────────────────────────────────────
function ArticleJsonLd({ title, description, slug, lastUpdated, category }: { title: string; description: string; slug: string; lastUpdated: string; category: string }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    author: { '@type': 'Organization', name: 'Alvarado Legacy Consulting LLC' },
    publisher: { '@type': 'Organization', name: 'ShieldMyLot' },
    datePublished: lastUpdated,
    dateModified: lastUpdated,
    mainEntityOfPage: `https://shieldmylot.com/help/${slug}`,
    articleSection: category,
  }
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  )
}

export default function HelpDocPage({ params }: { params: Params }) {
  const doc = getDocBySlug(params.slug)
  if (!doc) notFound()

  const fm = doc.frontmatter
  const related = (fm.related ?? [])
    .map((slug) => getDocBySlug(slug))
    .filter((d): d is NonNullable<typeof d> => d !== null)

  // Strip the H1 from the rendered body — we render title separately above.
  // marked emits the first heading as h1 with the title; remove it once so
  // the page title isn't duplicated under the breadcrumb.
  const bodyHtml = doc.html.replace(/^<h1[^>]*>.*?<\/h1>\s*/, '')

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif' }}>
      <ArticleJsonLd
        title={fm.title}
        description={`ShieldMyLot help: ${fm.title}`}
        slug={doc.slug}
        lastUpdated={fm.last_updated}
        category={fm.category}
      />
      <div style={{ display: 'flex', maxWidth: 1200, margin: '0 auto' }}>
        <HelpSidebar currentSlug={doc.slug} />
        <article style={{ flex: 1, padding: '32px 32px 64px', maxWidth: 820 }}>
          <Breadcrumb category={fm.category} title={fm.title} />

          {/* Attorney-review NOTICE — top of article, no click-gate. B85 locked. */}
          {fm.attorney_review_required && (
            <div style={{ background: '#3a2a0a', border: '2px solid #d4a017', borderRadius: 10, padding: '18px 22px', marginBottom: 24 }}>
              <p style={{ color: '#d4a017', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
                ⚠ Notice — Structural Framework Only
              </p>
              <p style={{ color: '#fef3c7', fontSize: 14, lineHeight: 1.65, margin: 0 }}>
                This document references Texas Transportation Code Chapter 2308 and related compliance topics. It is provided as a structural framework for ShieldMyLot platform users only — it is NOT legal advice, has NOT been reviewed by an attorney, and does NOT substitute for licensed legal counsel on any specific situation. Towing operations involve significant liability; consult a Texas-licensed attorney for legal questions.
              </p>
            </div>
          )}

          <h1 style={{ color: TEXT, fontSize: 32, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.01em' }}>{fm.title}</h1>

          <div style={{ marginBottom: 8 }}>
            <TierBadge tier={fm.tier_required} />
            {fm.audience?.map((a) => <AudienceBadge key={a} role={a} />)}
          </div>
          <p style={{ color: MUTED, fontSize: 12, margin: '0 0 28px' }}>
            Last updated: {fm.last_updated}
          </p>

          {/* Doc body — marked HTML with anchored headings */}
          <div
            className="help-doc-body"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />

          {/* Related docs footer */}
          {related.length > 0 && (
            <div style={{ marginTop: 48, padding: '24px 0 0', borderTop: `1px solid ${BORDER}` }}>
              <p style={{ color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>
                Related
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {related.map((r) => (
                  <li key={r.slug} style={{ marginBottom: 6 }}>
                    <Link href={`/help/${r.slug}`} style={{ color: GOLD, fontSize: 14, textDecoration: 'none' }}>
                      → {r.frontmatter.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Thumbs feedback — pure no-op stub for v1. TODO: wire to /api/help-feedback */}
          <div style={{ marginTop: 36, padding: '18px 0', borderTop: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', gap: 16 }}>
            <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>Was this helpful?</p>
            <button
              type="button"
              data-feedback-stub="up"
              style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 14px', color: TEXT, fontSize: 13, cursor: 'pointer' }}
            >
              👍 Yes
            </button>
            <button
              type="button"
              data-feedback-stub="down"
              style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 14px', color: TEXT, fontSize: 13, cursor: 'pointer' }}
            >
              👎 No
            </button>
          </div>
        </article>
      </div>

      {/* Body content styling. Inline <style> instead of a CSS module to keep
          this self-contained — matches the rest of the codebase's inline-style
          discipline. Print-friendly rules at the bottom hide nav/sidebar/footer
          chrome when the user prints a doc. */}
      <style>{`
        .help-doc-body { color: #cbd5e1; font-size: 15px; line-height: 1.75; }
        .help-doc-body h1 { color: ${TEXT}; font-size: 24px; font-weight: 700; margin: 32px 0 14px; letter-spacing: -0.01em; scroll-margin-top: 80px; }
        .help-doc-body h2 { color: ${TEXT}; font-size: 20px; font-weight: 700; margin: 32px 0 12px; letter-spacing: -0.01em; scroll-margin-top: 80px; }
        .help-doc-body h3 { color: ${TEXT}; font-size: 17px; font-weight: 600; margin: 26px 0 10px; scroll-margin-top: 80px; }
        .help-doc-body h4 { color: ${TEXT}; font-size: 15px; font-weight: 600; margin: 22px 0 8px; scroll-margin-top: 80px; }
        .help-doc-body p { margin: 0 0 14px; }
        .help-doc-body ul, .help-doc-body ol { margin: 0 0 14px; padding-left: 24px; }
        .help-doc-body li { margin-bottom: 6px; }
        .help-doc-body a { color: ${GOLD}; text-decoration: none; border-bottom: 1px dotted rgba(201,162,39,0.4); }
        .help-doc-body a:hover { border-bottom-color: ${GOLD}; }
        .help-doc-body code { background: rgba(255,255,255,0.06); border: 1px solid ${BORDER}; border-radius: 4px; padding: 1px 6px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .help-doc-body pre { background: rgba(0,0,0,0.4); border: 1px solid ${BORDER}; border-radius: 8px; padding: 14px 18px; overflow-x: auto; margin: 0 0 16px; font-size: 13px; line-height: 1.6; }
        .help-doc-body pre code { background: transparent; border: none; padding: 0; }
        .help-doc-body blockquote { border-left: 3px solid ${GOLD}; padding: 4px 16px; margin: 16px 0; color: #94a3b8; font-style: italic; }
        .help-doc-body table { border-collapse: collapse; margin: 16px 0; font-size: 13px; }
        .help-doc-body th, .help-doc-body td { border: 1px solid ${BORDER}; padding: 8px 14px; text-align: left; }
        .help-doc-body th { background: rgba(255,255,255,0.04); font-weight: 600; }
        .help-doc-body hr { border: none; border-top: 1px solid ${BORDER}; margin: 32px 0; }
        @media print {
          aside, nav, [data-feedback-stub], button { display: none !important; }
          main { background: white !important; color: black !important; }
          .help-doc-body { color: #111 !important; font-size: 12pt !important; }
          .help-doc-body h1, .help-doc-body h2, .help-doc-body h3, .help-doc-body h4 { color: #111 !important; }
          .help-doc-body a { color: #111 !important; border-bottom: none !important; }
        }
      `}</style>
    </main>
  )
}
