// B93: shared help-doc link transformer. Pure JS ESM — no Next.js or TS-
// specific imports — so both the runtime renderer (app/lib/help-docs.ts,
// imported via Next's build pipeline) AND the build-time validator
// (scripts/validate-help-links.mjs, run by plain Node) can pull from one
// source of truth. Adding a category prefix or changing the slug rule
// only requires touching this file.
//
// ── BUG CLASS THIS FIXES ────────────────────────────────────────────
// docs/help/*.md were authored against an earlier categorized URL design
// (../enforcement-track/04-adding-properties.md), but B85 Phase 2 shipped
// a flat /help/<slug> route surface. Marked's default link renderer
// passes hrefs through unchanged → browser resolves to /enforcement-track/...
// → 404. 87 of 89 internal links broke this way. The validator was
// matching the filename suffix and ignoring the path prefix, so it
// reported green-while-production-404. See feedback_validator_must_match_render_output.md.

const CATEGORY_PREFIXES = [
  'enforcement-track',
  'getting-started',
  'property-management-track',
  'shared',
  'compliance',
]

const CATEGORY_PREFIX_RE = new RegExp(`^(?:${CATEGORY_PREFIXES.join('|')})/`)

// Derive a slug from a doc filename: "03-understanding-your-tier.md" →
// "understanding-your-tier". Same rule the route handler uses via
// app/lib/help-docs.ts:slugFromFilename — kept here so both the renderer
// and validator share the canonical mapping.
//
// 2026-07-11 — regex extended to also strip an optional single letter
// suffix after the digits ("^\d+[a-z]?-"), so filenames like
// "00a-getting-started-company-admin.md" resolve to the clean slug
// "getting-started-company-admin". Needed to slot the 4 Getting-Started
// flyers ahead of the existing 01/02/03 without renumbering them.
export function slugFromFilename(filename) {
  return filename.replace(/^\d+[a-z]?-/, '').replace(/\.md$/, '')
}

// Transform a markdown link href to its production-route shape.
//   • http://, https://, mailto:, tel:, #anchor → unchanged
//   • ../enforcement-track/04-adding-properties.md → /help/adding-properties
//   • ../shared/12-managing-disputes.md#step-2  → /help/managing-disputes#step-2
//   • 01-signup-and-first-login.md              → /help/signup-and-first-login
//   • Anything else (e.g., README.md, unknown shape) → unchanged + console.warn
//     so dev-mode catches future drift without breaking the build.
export function transformHelpLink(href) {
  if (typeof href !== 'string' || href.length === 0) return href

  // Pass through external + anchor + mailto + tel.
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return href

  // Pass through already-correct production URLs unchanged. Without this,
  // a source-author who writes /help or /help/<slug> directly would trip
  // the "unhandled" fallback warning even though their href is correct.
  if (href === '/help' || href === '/help/') return href
  if (/^\/help\/[a-z0-9-]+(#[a-z0-9-]+)?$/i.test(href)) return href

  // Strip leading ./ or ../ (possibly multiple times).
  let cleaned = href
  while (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    cleaned = cleaned.replace(/^\.\.?\//, '')
  }

  // Strip leading category prefix (enforcement-track/, getting-started/, etc.).
  cleaned = cleaned.replace(CATEGORY_PREFIX_RE, '')

  // Match NN-slug.md with optional #anchor.
  const m = cleaned.match(/^(\d+-[a-z0-9-]+)\.md(#[a-z0-9-]+)?$/i)
  if (m) {
    const slug = slugFromFilename(m[1] + '.md')
    const anchor = m[2] || ''
    return `/help/${slug}${anchor}`
  }

  // Fall through with a dev-mode warning. Production renders the original
  // (visibly broken) href — same behavior as pre-B93, so we don't regress
  // by silently dropping unhandled links. Future class drift surfaces here.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[help-link-transformer] unhandled href, passing through: ${href}`)
  }
  return href
}

// Allow-list for the validator: a transformed href is valid if it matches
// one of these shapes. Anything else fails the build.
//   • /help                              — help center index page
//   • /help/<known-slug>(#anchor)?       — specific doc, optionally deep-link
//   • external (http/https/mailto/tel)
//   • intra-page anchor (#...)
export function isValidTransformedHref(transformed, knownSlugs) {
  if (typeof transformed !== 'string') return false
  if (/^(https?:|mailto:|tel:|#)/i.test(transformed)) return true
  if (transformed === '/help' || transformed === '/help/') return true
  const m = transformed.match(/^\/help\/([a-z0-9-]+)(#[a-z0-9-]+)?$/i)
  if (!m) return false
  return knownSlugs.has(m[1])
}
