import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getAllVideoSlugs, getVideoBySlug, formatTimestamp, formatDuration } from '../../../lib/help-videos'
import { getDocBySlug } from '../../../lib/help-docs'

// B85 Phase 2: video detail. SSG per slug; Next 16 async params shape
// applied preemptively per Phase 1 corrective lesson. HeyGen iframe
// embedded in a responsive 16:9 wrapper; CSP frame-src configured at
// next.config.ts:headers() for this exact route pattern.
//
// Chapters render as a display-only reference list (HeyGen ?t= seek
// support unconfirmed at v1; locked decision is display-only with
// follow-up to wire seek links once tested).

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Params = { slug: string }

export function generateStaticParams(): Params[] {
  return getAllVideoSlugs().map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params
  const video = getVideoBySlug(slug)
  if (!video) return { title: 'Not found · ShieldMyLot Help' }
  const fm = video.frontmatter
  const description = video.body
    .replace(/^#.*$/m, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[#*_`>\[\]()]/g, '')
    .trim()
    .split('\n').filter(Boolean)[0]?.slice(0, 160) || fm.title
  return {
    title: `${fm.title} · ShieldMyLot Help`,
    description,
    openGraph: {
      title: `${fm.title} · ShieldMyLot Help`,
      description,
      type: 'video.other',
      url: `https://shieldmylot.com/help/videos/${video.slug}`,
    },
    twitter: {
      card: 'summary_large_image',
      title: `${fm.title} · ShieldMyLot Help`,
      description,
    },
  }
}

function AudienceBadge({ role }: { role: string }) {
  const label = role.replace(/_/g, ' ')
  return (
    <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, color: '#94a3b8', fontSize: 11, padding: '2px 8px', borderRadius: 10, marginRight: 6, textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

export default async function VideoDetailPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params
  const video = getVideoBySlug(slug)
  if (!video) notFound()

  const fm = video.frontmatter
  const relatedDocs = (fm.related_docs ?? [])
    .map((s) => getDocBySlug(s))
    .filter((d): d is NonNullable<typeof d> => d !== null)

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '32px 24px 64px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>

        <nav style={{ color: MUTED, fontSize: 12, marginBottom: 16 }}>
          <Link href="/" style={{ color: MUTED, textDecoration: 'none' }}>Home</Link>
          <span style={{ margin: '0 8px' }}>/</span>
          <Link href="/help" style={{ color: MUTED, textDecoration: 'none' }}>Help</Link>
          <span style={{ margin: '0 8px' }}>/</span>
          <Link href="/help/videos" style={{ color: MUTED, textDecoration: 'none' }}>Videos</Link>
          <span style={{ margin: '0 8px' }}>/</span>
          <span style={{ color: TEXT }}>{fm.title}</span>
        </nav>

        <h1 style={{ color: TEXT, fontSize: 30, fontWeight: 800, margin: '0 0 12px', letterSpacing: '-0.01em' }}>
          {fm.title}
        </h1>

        <div style={{ marginBottom: 8 }}>
          {fm.audience?.map((a) => <AudienceBadge key={a} role={a} />)}
        </div>
        <p style={{ color: MUTED, fontSize: 12, margin: '0 0 24px' }}>
          {fm.category}
          {fm.duration_seconds ? ` · ${formatDuration(fm.duration_seconds)}` : ''}
          {' · '}Last updated: {fm.last_updated}
        </p>

        {/* HeyGen iframe — responsive 16:9 via aspect-ratio. CSP
            frame-src 'self' https://app.heygen.com set in next.config.ts
            for /help/videos/:slug*. autoplay deliberately omitted per
            locked decision. */}
        <div style={{
          aspectRatio: '16 / 9', width: '100%', borderRadius: 12, overflow: 'hidden',
          background: '#000', marginBottom: 24, border: `1px solid ${BORDER}`,
        }}>
          <iframe
            src={fm.heygen_share_url}
            title={fm.title}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allow="encrypted-media; fullscreen"
            allowFullScreen
            style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        </div>

        {/* Chapter list — display-only v1. Seek-link wiring deferred
            pending HeyGen ?t= support confirmation. */}
        {fm.chapters && fm.chapters.length > 0 && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ color: TEXT, fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Chapters</h2>
            <ol style={{ listStyle: 'none', padding: 0, margin: 0, background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
              {fm.chapters.map((c, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderTop: i === 0 ? 'none' : `1px solid ${BORDER}`,
                  }}
                >
                  <span style={{ color: TEXT, fontSize: 14 }}>
                    <span style={{ color: MUTED, fontSize: 12, marginRight: 10 }}>{i + 1}.</span>
                    {c.title}
                  </span>
                  <span style={{ color: GOLD, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {formatTimestamp(c.timestamp)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Body content — markdown rendered as plain text paragraphs
            for v1. Video pages have lighter body content than docs;
            full marked-render parity is a polish-pass item if needed. */}
        {video.body.trim().length > 0 && (
          <section style={{ marginBottom: 32 }}>
            {video.body
              .replace(/^#.*$/m, '')  // strip the H1 (title rendered separately above)
              .split(/\n\n+/)
              .map((para, i) => {
                const trimmed = para.trim()
                if (!trimmed) return null
                // h2/h3 detection — render as section heading
                if (trimmed.startsWith('## ')) {
                  return (
                    <h2 key={i} style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '24px 0 10px' }}>
                      {trimmed.replace(/^## /, '')}
                    </h2>
                  )
                }
                if (trimmed.startsWith('### ')) {
                  return (
                    <h3 key={i} style={{ color: TEXT, fontSize: 15, fontWeight: 600, margin: '20px 0 8px' }}>
                      {trimmed.replace(/^### /, '')}
                    </h3>
                  )
                }
                return (
                  <p key={i} style={{ color: '#cbd5e1', fontSize: 15, lineHeight: 1.7, margin: '0 0 14px' }}>
                    {/* Render markdown **bold** inline */}
                    {trimmed.split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
                      seg.startsWith('**') && seg.endsWith('**')
                        ? <strong key={j} style={{ color: TEXT }}>{seg.slice(2, -2)}</strong>
                        : seg
                    )}
                  </p>
                )
              })}
          </section>
        )}

        {/* Related help docs footer */}
        {relatedDocs.length > 0 && (
          <div style={{ padding: '24px 0 0', borderTop: `1px solid ${BORDER}` }}>
            <p style={{ color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>
              Related help docs
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {relatedDocs.map((d) => (
                <li key={d.slug} style={{ marginBottom: 6 }}>
                  <Link href={`/help/${d.slug}`} style={{ color: GOLD, fontSize: 14, textDecoration: 'none' }}>
                    → {d.frontmatter.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <Link href="/help/videos" style={{ color: MUTED, fontSize: 13, textDecoration: 'none' }}>
            ← Back to video library
          </Link>
        </div>

      </div>
    </main>
  )
}
