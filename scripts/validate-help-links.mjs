#!/usr/bin/env node
// B85: build-time validator for help-doc cross-links.
// Wired as `prebuild` in package.json. Fails the build with exit code 1
// if any frontmatter related[] entry or inline markdown link references
// a slug that doesn't resolve to a real doc.
//
// Per locked B85 decision: fail-fast > shipping a broken-link help center.
// Discipline marker filed post-ship as feedback_build_time_internal_link_validation.md.

import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

const DOCS_DIR = path.join(process.cwd(), 'docs', 'help')
const VIDEOS_DIR = path.join(process.cwd(), 'docs', 'videos')

function slugFromFilename(filename) {
  return filename.replace(/^\d+-/, '').replace(/\.md$/, '')
}

function readDocs(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((filename) => {
      const filepath = path.join(dir, filename)
      const parsed = matter(fs.readFileSync(filepath, 'utf8'))
      return {
        slug: slugFromFilename(filename),
        filename,
        frontmatter: parsed.data,
        body: parsed.content,
      }
    })
}

const docs = readDocs(DOCS_DIR)
const videos = readDocs(VIDEOS_DIR)

const docSlugs = new Set(docs.map((d) => d.slug))
const videoSlugs = new Set(videos.map((v) => v.slug))

const errors = []

// ── 1. frontmatter related[] → must resolve to real doc slugs ─────
for (const doc of docs) {
  const related = doc.frontmatter.related ?? []
  if (!Array.isArray(related)) {
    errors.push(`${doc.filename}: frontmatter.related is not an array`)
    continue
  }
  for (const slug of related) {
    if (typeof slug !== 'string') {
      errors.push(`${doc.filename}: related entry is not a string: ${JSON.stringify(slug)}`)
      continue
    }
    if (!docSlugs.has(slug)) {
      errors.push(`${doc.filename}: related → "${slug}" does not resolve to any doc`)
    }
  }
}

// ── 2. frontmatter related_videos[].slug → must resolve to real video slugs ─
for (const doc of docs) {
  const rv = doc.frontmatter.related_videos
  if (!rv) continue
  if (!Array.isArray(rv)) {
    errors.push(`${doc.filename}: frontmatter.related_videos is not an array`)
    continue
  }
  for (const entry of rv) {
    if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string') {
      errors.push(`${doc.filename}: related_videos entry missing string slug: ${JSON.stringify(entry)}`)
      continue
    }
    if (!videoSlugs.has(entry.slug)) {
      errors.push(`${doc.filename}: related_videos → "${entry.slug}" does not resolve to any video`)
    }
  }
}

// ── 2b. Video frontmatter slug, if present, must match filename-derived slug ─
// Filename is the authoritative slug source (matches help-docs convention).
// Surfaces drift if a video author edits the frontmatter slug without
// renaming the file.
for (const video of videos) {
  const fmSlug = video.frontmatter.slug
  if (typeof fmSlug === 'string' && fmSlug !== video.slug) {
    errors.push(`${video.filename}: frontmatter slug "${fmSlug}" does not match filename-derived slug "${video.slug}"`)
  }
}

// ── 3. frontmatter related_docs[] on videos → must resolve to doc slugs ─
for (const video of videos) {
  const rd = video.frontmatter.related_docs ?? []
  if (!Array.isArray(rd)) {
    errors.push(`${video.filename}: frontmatter.related_docs is not an array`)
    continue
  }
  for (const slug of rd) {
    if (typeof slug !== 'string') continue
    if (!docSlugs.has(slug)) {
      errors.push(`${video.filename}: related_docs → "${slug}" does not resolve to any doc`)
    }
  }
}

// ── 4. inline markdown body links → must resolve when they point at our help routes ─
// Patterns we validate (only internal help links):
//   [text](./other-doc.md)
//   [text](../help/other-slug.md)
//   [text](/help/other-slug)
// External (https://...) and anchor-only (#section) links are skipped.
const INTERNAL_HELP_LINK = /\]\(([^)]+)\)/g

function extractHelpSlug(href) {
  if (href.startsWith('http://') || href.startsWith('https://')) return null
  if (href.startsWith('#')) return null
  if (href.startsWith('mailto:') || href.startsWith('tel:')) return null

  // Strip query string + fragment
  const cleaned = href.split('#')[0].split('?')[0]

  // /help/<slug>
  const helpRoute = cleaned.match(/^\/help\/([a-z0-9-]+)\/?$/i)
  if (helpRoute) return helpRoute[1]

  // ./other-doc.md or ../help/other-doc.md or other-doc.md
  const mdFile = cleaned.match(/(?:^|\/)(\d+-[a-z0-9-]+)\.md$/i)
  if (mdFile) return slugFromFilename(mdFile[1] + '.md')

  return null
}

for (const doc of docs) {
  let m
  const localRegex = new RegExp(INTERNAL_HELP_LINK)
  while ((m = localRegex.exec(doc.body)) !== null) {
    const href = m[1]
    const slug = extractHelpSlug(href)
    if (slug === null) continue
    if (!docSlugs.has(slug)) {
      errors.push(`${doc.filename}: body link "[…](${href})" → slug "${slug}" does not resolve`)
    }
  }
}

// ── Report ────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error('\n❌ Help-doc cross-link validation FAILED:\n')
  for (const e of errors) console.error('  • ' + e)
  console.error(`\n${errors.length} broken reference${errors.length === 1 ? '' : 's'}. Build aborted.`)
  process.exit(1)
}

console.log(`✅ Help-doc cross-link validation passed (${docs.length} docs, ${videos.length} videos).`)
