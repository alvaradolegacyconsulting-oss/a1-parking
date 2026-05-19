'use client'
// B85 Phase 2: lazy-loaded search input for /help index. flexsearch
// Document index built client-side from the static JSON emitted at
// build time (public/help-search-index.json). Both flexsearch and the
// index are loaded ONLY on first input focus — keeps the bundle off
// the critical path for users who don't search.
//
// Result UX: list rendered below input. Title match links to /help/<slug>;
// heading match deep-links to /help/<slug>#<anchor-id> (the slugified
// heading IDs from help-docs.ts marked renderer).

import { useState, useRef, useCallback } from 'react'
import Link from 'next/link'

const GOLD = '#C9A227'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type IndexedDoc = {
  slug: string
  title: string
  category: string
  audience: string[]
  excerpt: string
  headings: { id: string; text: string }[]
}

type SearchResult = {
  doc: IndexedDoc
  matchType: 'title' | 'heading' | 'excerpt'
  matchedHeading?: { id: string; text: string }
}

type FlexIndex = {
  search: (query: string, opts?: { enrich?: boolean; limit?: number }) => unknown
  add: (doc: { slug: string; title: string; headings: string; excerpt: string }) => void
}

export default function HelpSearchInput() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const indexRef = useRef<FlexIndex | null>(null)
  const docsRef = useRef<IndexedDoc[]>([])
  const focusedOnceRef = useRef(false)

  // Lazy-load flexsearch + index JSON on first focus. Subsequent focuses
  // skip the load — index lives in module scope until page navigation.
  const ensureIndex = useCallback(async () => {
    if (indexRef.current || focusedOnceRef.current) return
    focusedOnceRef.current = true
    setLoading(true)
    try {
      // Dynamic imports — flexsearch + the static JSON ship lazily.
      const [{ default: FlexSearch }, indexFile] = await Promise.all([
        import('flexsearch'),
        fetch('/help-search-index.json').then((r) => r.json() as Promise<{ docs: IndexedDoc[] }>),
      ])
      // flexsearch Document API — field-weighted search over title,
      // headings (joined as a string), and excerpt. id field = slug.
      // Cast: flexsearch's v0.8 types don't cleanly model the Document
      // builder, so we use a narrow local FlexIndex shape.
      const FS = FlexSearch as unknown as {
        Document: new (opts: unknown) => FlexIndex
      }
      const idx = new FS.Document({
        document: {
          id: 'slug',
          index: [
            { field: 'title', tokenize: 'forward' },
            { field: 'headings', tokenize: 'forward' },
            { field: 'excerpt', tokenize: 'forward' },
          ],
        },
        tokenize: 'forward',
      })
      for (const d of indexFile.docs) {
        idx.add({
          slug: d.slug,
          title: d.title,
          headings: d.headings.map((h) => h.text).join(' '),
          excerpt: d.excerpt,
        })
      }
      indexRef.current = idx
      docsRef.current = indexFile.docs
    } finally {
      setLoading(false)
    }
  }, [])

  const runSearch = useCallback((q: string) => {
    if (!indexRef.current || q.trim().length === 0) {
      setResults([])
      return
    }
    // flexsearch returns: [{ field, result: [<id>, ...] }, ...] when not enriched.
    // We do field-by-field lookup to determine match type for the result UX
    // (title hits show plain link; heading hits get deep-link anchor).
    const raw = indexRef.current.search(q, { limit: 8 }) as Array<{
      field: string
      result: string[]
    }>

    const seen = new Set<string>()
    const out: SearchResult[] = []

    for (const fieldResult of raw) {
      for (const slug of fieldResult.result) {
        if (seen.has(slug)) continue
        const doc = docsRef.current.find((d) => d.slug === slug)
        if (!doc) continue
        // Determine match type
        let matchType: SearchResult['matchType'] = 'excerpt'
        let matchedHeading: SearchResult['matchedHeading']
        if (fieldResult.field === 'title') {
          matchType = 'title'
        } else if (fieldResult.field === 'headings') {
          matchType = 'heading'
          // Find the most-relevant heading for the query (simple substring match)
          const ql = q.toLowerCase()
          matchedHeading = doc.headings.find((h) => h.text.toLowerCase().includes(ql)) || doc.headings[0]
        }
        out.push({ doc, matchType, matchedHeading })
        seen.add(slug)
        if (out.length >= 8) break
      }
      if (out.length >= 8) break
    }
    setResults(out)
  }, [])

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value
    setQuery(q)
    runSearch(q)
  }

  function onFocus() {
    void ensureIndex()
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="search"
        placeholder={loading ? 'Loading search…' : 'Search help docs…'}
        aria-label="Search help docs"
        value={query}
        onChange={onChange}
        onFocus={onFocus}
        style={{
          width: '100%', background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10,
          padding: '12px 16px', color: TEXT, fontSize: 14, fontFamily: 'inherit', outline: 'none',
        }}
      />

      {results.length > 0 && (
        <div
          style={{
            marginTop: 8,
            background: '#0f1117',
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          {results.map((r) => {
            const href = r.matchType === 'heading' && r.matchedHeading
              ? `/help/${r.doc.slug}#${r.matchedHeading.id}`
              : `/help/${r.doc.slug}`
            return (
              <Link
                key={`${r.doc.slug}-${r.matchType}`}
                href={href}
                style={{
                  display: 'block', padding: '12px 16px',
                  borderTop: `1px solid ${BORDER}`,
                  textDecoration: 'none',
                }}
              >
                <p style={{ color: TEXT, fontSize: 14, fontWeight: 600, margin: '0 0 2px' }}>{r.doc.title}</p>
                <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>
                  {r.doc.category}
                  {r.matchType === 'heading' && r.matchedHeading && (
                    <>
                      {' · '}
                      <span style={{ color: GOLD }}>→ {r.matchedHeading.text}</span>
                    </>
                  )}
                </p>
              </Link>
            )
          })}
        </div>
      )}

      {query.trim().length > 0 && results.length === 0 && !loading && indexRef.current && (
        <div style={{
          marginTop: 8, padding: '12px 16px',
          background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10,
          color: MUTED, fontSize: 13,
        }}>
          No results for &ldquo;{query}&rdquo;. Try different keywords or{' '}
          <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none' }}>contact support</a>.
        </div>
      )}
    </div>
  )
}
