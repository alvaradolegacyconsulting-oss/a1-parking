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
// B93: shared link transformer — single source of truth across renderer
// (app/lib/help-docs.ts) and this validator. If a category prefix or slug
// rule changes, only the transformer file moves; both consumers track.
import {
  transformHelpLink,
  slugFromFilename,
  isValidTransformedHref,
} from '../app/lib/help-link-transformer.mjs'

const DOCS_DIR = path.join(process.cwd(), 'docs', 'help')
const VIDEOS_DIR = path.join(process.cwd(), 'docs', 'videos')

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

// ── 4. inline markdown body links → must transform to a valid production URL ─
// B93: validator now runs the production link transformer + asserts the
// output shape. Catches the bug class that survived from May 19 through
// May 31 (validator audited source-side slug existence; production routes
// served only /help/<slug> flat; 87 of 89 links 404'd while validator
// reported green). See feedback_validator_must_match_render_output.md.
//
// A link is valid if, after transformHelpLink(href), the result is one of:
//   • /help/<known-slug>(#anchor)?
//   • http:// or https://
//   • mailto: or tel:
//   • #anchor-only (intra-doc)
// Anything else fails — including hrefs the transformer's fallback path
// returns unchanged (e.g., shapes the transformer doesn't recognize).
const LINK_REGEX = /\]\(([^)]+)\)/g

for (const doc of docs) {
  let m
  const re = new RegExp(LINK_REGEX)
  while ((m = re.exec(doc.body)) !== null) {
    const href = m[1]
    const transformed = transformHelpLink(href)
    if (!isValidTransformedHref(transformed, docSlugs)) {
      errors.push(
        `${doc.filename}: body link "[…](${href})" → after transform "${transformed}" — does not resolve to a known help route, valid external scheme, or in-page anchor`
      )
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
