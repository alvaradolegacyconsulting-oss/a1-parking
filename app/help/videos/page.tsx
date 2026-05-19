import type { Metadata } from 'next'
import Link from 'next/link'
import { getAllVideos, formatDuration } from '../../lib/help-videos'

// B85 Phase 2: video library index. Server component; static. Renders
// one card per video that actually exists. NO "Coming soon" stubs per
// locked decision — show what exists; commits light up the page.

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export const metadata: Metadata = {
  title: 'Video Library · ShieldMyLot Help',
  description: 'Short video walkthroughs of common ShieldMyLot workflows for residents, managers, drivers, and admins.',
  openGraph: {
    title: 'Video Library · ShieldMyLot Help',
    description: 'Short video walkthroughs of common ShieldMyLot workflows.',
    url: 'https://shieldmylot.com/help/videos',
    type: 'website',
  },
}

function AudienceBadge({ role }: { role: string }) {
  const label = role.replace(/_/g, ' ')
  return (
    <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, color: '#94a3b8', fontSize: 10, padding: '1px 7px', borderRadius: 10, marginRight: 4, textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

// Gradient placeholder thumbnail per pre-flight gap 1. HeyGen doesn't
// expose a thumbnail URL in the embed frontmatter today; this gives the
// card a clear visual anchor without inventing a thumbnail field.
function VideoThumbnail({ title, duration }: { title: string; duration: string }) {
  return (
    <div style={{
      width: '100%', aspectRatio: '16 / 9', borderRadius: 10, marginBottom: 14,
      background: 'linear-gradient(135deg, rgba(201,162,39,0.18) 0%, rgba(201,162,39,0.04) 100%)',
      border: `1px solid rgba(201,162,39,0.25)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative',
    }}>
      <div style={{ fontSize: 36, color: GOLD, opacity: 0.6 }}>▶</div>
      {duration && (
        <span style={{
          position: 'absolute', bottom: 8, right: 10,
          background: 'rgba(0,0,0,0.55)', color: TEXT, fontSize: 11, fontWeight: 600,
          padding: '2px 8px', borderRadius: 6,
        }}>
          {duration}
        </span>
      )}
    </div>
  )
}

export default function VideoLibraryIndexPage() {
  const videos = getAllVideos()

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '40px 24px 64px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        <header style={{ marginBottom: 32 }}>
          <nav style={{ color: MUTED, fontSize: 12, marginBottom: 12 }}>
            <Link href="/" style={{ color: MUTED, textDecoration: 'none' }}>Home</Link>
            <span style={{ margin: '0 8px' }}>/</span>
            <Link href="/help" style={{ color: MUTED, textDecoration: 'none' }}>Help</Link>
            <span style={{ margin: '0 8px' }}>/</span>
            <span style={{ color: TEXT }}>Video Library</span>
          </nav>
          <h1 style={{ color: TEXT, fontSize: 36, fontWeight: 800, margin: '0 0 12px', letterSpacing: '-0.02em' }}>
            Video Library
          </h1>
          <p style={{ color: '#94a3b8', fontSize: 16, margin: 0, lineHeight: 1.6 }}>
            Short video walkthroughs of common workflows. New videos publish here as they&apos;re recorded.
          </p>
        </header>

        {videos.length === 0 ? (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '40px 32px', textAlign: 'center' }}>
            <p style={{ color: TEXT, fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>No videos yet</p>
            <p style={{ color: MUTED, fontSize: 14, margin: 0, lineHeight: 1.6 }}>
              The first videos are in production. Check back soon, or browse the{' '}
              <Link href="/help" style={{ color: GOLD, textDecoration: 'none' }}>text help docs</Link>{' '}for the same content.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
            {videos.map((v) => (
              <Link
                key={v.slug}
                href={`/help/videos/${v.slug}`}
                style={{
                  display: 'block', background: CARD_BG, border: `1px solid ${BORDER}`,
                  borderRadius: 12, padding: 16, textDecoration: 'none',
                }}
              >
                <VideoThumbnail
                  title={v.frontmatter.title}
                  duration={formatDuration(v.frontmatter.duration_seconds)}
                />
                <h3 style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 6px' }}>{v.frontmatter.title}</h3>
                <p style={{ color: MUTED, fontSize: 12, margin: '0 0 10px' }}>{v.frontmatter.category}</p>
                <div>
                  {v.frontmatter.audience?.slice(0, 4).map((a) => <AudienceBadge key={a} role={a} />)}
                </div>
              </Link>
            ))}
          </div>
        )}

        <footer style={{ marginTop: 48, paddingTop: 24, borderTop: `1px solid ${BORDER}`, color: MUTED, fontSize: 12, textAlign: 'center' }}>
          Looking for text guides instead?{' '}
          <Link href="/help" style={{ color: GOLD, textDecoration: 'none' }}>Browse the help docs</Link>.
        </footer>

      </div>
    </main>
  )
}
