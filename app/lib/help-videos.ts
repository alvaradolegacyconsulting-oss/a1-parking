// B85 Phase 2: build-time help-video reader. Server-only (uses fs).
// Mirrors app/lib/help-docs.ts shape for consistency. Videos live at
// docs/videos/NN-slug.md; frontmatter carries HeyGen embed details +
// chapter list + related_docs cross-links.
//
// Graceful empty handling: if docs/videos/ doesn't exist or is empty,
// getAllVideos() returns []. The /help/videos index page renders an
// empty state rather than failing — supports the "ship what exists,
// don't stub coming-soon" discipline.

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

export type VideoChapter = {
  title: string
  timestamp: number
}

export type HelpVideoFrontmatter = {
  title: string
  slug?: string  // optional; filename-derived is authoritative (validator warns on drift)
  category: string
  audience: string[]
  tier_required: string
  last_updated: string
  duration_seconds?: number
  heygen_embed_id?: string
  heygen_share_url: string
  related_docs?: string[]
  chapters?: VideoChapter[]
}

export type HelpVideo = {
  slug: string
  filename: string
  frontmatter: HelpVideoFrontmatter
  body: string
}

const VIDEOS_DIR = path.join(process.cwd(), 'docs', 'videos')

let cache: HelpVideo[] | null = null

function slugFromFilename(filename: string): string {
  // Mirror help-docs.ts: 01-resident.md → resident
  return filename.replace(/^\d+-/, '').replace(/\.md$/, '')
}

export function getAllVideos(): HelpVideo[] {
  if (cache) return cache
  if (!fs.existsSync(VIDEOS_DIR)) {
    cache = []
    return cache
  }
  const filenames = fs
    .readdirSync(VIDEOS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  cache = filenames.map((filename) => {
    const filepath = path.join(VIDEOS_DIR, filename)
    const raw = fs.readFileSync(filepath, 'utf8')
    const parsed = matter(raw)
    const fm = parsed.data as HelpVideoFrontmatter
    const slug = slugFromFilename(filename)
    return {
      slug,
      filename,
      frontmatter: fm,
      body: parsed.content,
    }
  })
  return cache
}

export function getAllVideoSlugs(): string[] {
  return getAllVideos().map((v) => v.slug)
}

export function getVideoBySlug(slug: string): HelpVideo | null {
  return getAllVideos().find((v) => v.slug === slug) ?? null
}

// Format duration in MM:SS for display ("4:00" for 240s)
export function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds < 0) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Format a chapter timestamp as MM:SS ("0:45" for 45s)
export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds)
}
