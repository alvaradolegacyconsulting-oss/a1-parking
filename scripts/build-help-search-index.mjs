#!/usr/bin/env node
// B85 Phase 2: emit public/help-search-index.json at build time.
// Wired as prebuild after the cross-link validator. Client fetches the
// JSON on first search-input focus, lazy-builds a flexsearch Document
// index, and runs queries against it on keystroke.
//
// Index shape per doc (~16 entries):
//   { slug, title, category, audience[], excerpt, headings[{id, text}] }
//
// Body fully indexed? NO — per locked B85 decision, title + headings +
// first paragraph + audience array only. If post-launch feedback says
// search misses deeper-doc matches, expand to body in a 1-line change
// (replace excerpt with full content).

import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

const DOCS_DIR = path.join(process.cwd(), 'docs', 'help')
const OUT_FILE = path.join(process.cwd(), 'public', 'help-search-index.json')

function slugFromFilename(filename) {
  return filename.replace(/^\d+-/, '').replace(/\.md$/, '')
}

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function extractHeadings(body) {
  const headings = []
  const lines = body.split('\n')
  for (const line of lines) {
    // h2/h3/h4 — h1 is the doc title (rendered separately in page)
    const m = line.match(/^(##|###|####)\s+(.+?)\s*$/)
    if (m) {
      const text = m[2].replace(/[*_`]/g, '').trim()
      headings.push({ id: slugifyHeading(text), text })
    }
  }
  return headings
}

function extractExcerpt(body) {
  // First non-heading, non-empty paragraph
  const blocks = body.split(/\n\n+/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    // Strip markdown punctuation; truncate to 240 chars
    const clean = trimmed
      .replace(/[*_`>\[\]()]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return clean.slice(0, 240)
  }
  return ''
}

if (!fs.existsSync(DOCS_DIR)) {
  console.error(`docs/help/ not found at ${DOCS_DIR}; nothing to index.`)
  // Still emit empty file so the client doesn't 404 on first request
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify({ docs: [] }))
  process.exit(0)
}

const filenames = fs
  .readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()

const docs = filenames.map((filename) => {
  const raw = fs.readFileSync(path.join(DOCS_DIR, filename), 'utf8')
  const parsed = matter(raw)
  const fm = parsed.data
  return {
    slug: slugFromFilename(filename),
    title: fm.title,
    category: fm.category,
    audience: Array.isArray(fm.audience) ? fm.audience : [],
    excerpt: extractExcerpt(parsed.content),
    headings: extractHeadings(parsed.content),
  }
})

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
fs.writeFileSync(OUT_FILE, JSON.stringify({ docs }))

const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1)
console.log(`✅ Help search index built: ${docs.length} docs → public/help-search-index.json (${sizeKb} KB)`)
