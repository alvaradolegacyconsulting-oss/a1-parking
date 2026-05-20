// B85: build-time help-doc reader. Server-only (uses fs). All consumers
// (sitemap, index page, per-doc page, generateStaticParams, search index
// builder) share the same parsed cache. Per the B85 pre-flight: Path (a)
// build-time render with gray-matter + marked.

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { Marked } from 'marked'
// B93: shared link transformer — renderer + validator pull from one source.
// .mjs to keep cross-runtime friction down (TS server component here AND
// .mjs build-time validator both import this file).
import { transformHelpLink, slugFromFilename as sharedSlugFromFilename } from './help-link-transformer.mjs'

export type HelpDocFrontmatter = {
  title: string
  category: string
  audience: string[]
  tier_required: string
  last_updated: string
  related?: string[]
  related_videos?: { slug: string; chapter?: number; timestamp?: number }[]
  attorney_review_required?: boolean
  // B85 pre-flight: optional generalization of the attorney-review noindex
  // gate. Set true on any doc that should NOT be indexed by search engines.
  // 16-texas-chapter-2308 sets attorney_review_required: true which
  // implies noindex: true (handled below); explicit noindex stays available
  // for future docs that need to be hidden from indexing without the
  // attorney NOTICE block.
  noindex?: boolean
}

export type HelpDoc = {
  slug: string
  filename: string
  frontmatter: HelpDocFrontmatter
  body: string
  html: string
  shouldNoIndex: boolean
}

// ── marked configuration ──────────────────────────────────────────
// Slugified heading IDs (~20 LOC) per locked B85 decision. Search results
// + in-page anchor links rely on this. h1/h2/h3/h4 all get anchored.
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')        // strip any inline HTML
    .replace(/[^a-z0-9\s-]/g, '')   // strip punctuation
    .trim()
    .replace(/\s+/g, '-')           // spaces → dashes
    .replace(/-+/g, '-')            // collapse repeated dashes
}

const marked = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      // tokens is the inline-parsed text; render it to a string for ID derivation
      // and re-render for output (preserves inline markup like emphasis/code).
      const text = this.parser.parseInline(tokens)
      const stripped = text.replace(/<[^>]+>/g, '')
      const id = slugifyHeading(stripped)
      return `<h${depth} id="${id}">${text}</h${depth}>\n`
    },
    // B93: normalize cross-doc href shapes to /help/<slug> at render time.
    // Source markdown uses ../<category>/NN-slug.md (legacy categorized
    // design) but the production route surface is flat /help/<slug>. The
    // transformer in app/lib/help-link-transformer.mjs handles the mapping;
    // both this renderer AND scripts/validate-help-links.mjs import it so
    // there's one source of truth.
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const transformedHref = transformHelpLink(href)
      const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : ''
      return `<a href="${transformedHref}"${titleAttr}>${text}</a>`
    },
  },
})

// ── doc loading ───────────────────────────────────────────────────
const DOCS_DIR = path.join(process.cwd(), 'docs', 'help')

let cache: HelpDoc[] | null = null

// Re-export the shared slug derivation under the local name so existing
// call sites (getAllDocs below) keep working without renaming. Source of
// truth lives in app/lib/help-link-transformer.mjs — see B93 commit.
const slugFromFilename = sharedSlugFromFilename

export function getAllDocs(): HelpDoc[] {
  if (cache) return cache
  if (!fs.existsSync(DOCS_DIR)) {
    cache = []
    return cache
  }
  const filenames = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort() // 01-...md sorts before 02-...md naturally
  cache = filenames.map((filename) => {
    const filepath = path.join(DOCS_DIR, filename)
    const raw = fs.readFileSync(filepath, 'utf8')
    const parsed = matter(raw)
    const fm = parsed.data as HelpDocFrontmatter
    const slug = slugFromFilename(filename)
    const html = marked.parse(parsed.content) as string
    return {
      slug,
      filename,
      frontmatter: fm,
      body: parsed.content,
      html,
      // attorney_review_required: true implies noindex
      shouldNoIndex: Boolean(fm.noindex) || Boolean(fm.attorney_review_required),
    }
  })
  return cache
}

export function getAllSlugs(): string[] {
  return getAllDocs().map((d) => d.slug)
}

export function getDocBySlug(slug: string): HelpDoc | null {
  return getAllDocs().find((d) => d.slug === slug) ?? null
}

export function getCategories(): string[] {
  const set = new Set(getAllDocs().map((d) => d.frontmatter.category))
  return Array.from(set)
}

// Role-aware sort for the index page (locked B85 decision: sort, not filter).
// If a viewer role is provided, docs whose `audience` includes that role
// bubble to the top, preserving filename order within each bucket.
export function sortDocsForRole(docs: HelpDoc[], viewerRole: string | null): HelpDoc[] {
  if (!viewerRole) return docs
  const matches: HelpDoc[] = []
  const others: HelpDoc[] = []
  for (const d of docs) {
    if (d.frontmatter.audience?.includes(viewerRole)) matches.push(d)
    else others.push(d)
  }
  return [...matches, ...others]
}
