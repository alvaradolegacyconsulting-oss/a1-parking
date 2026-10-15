// ════════════════════════════════════════════════════════════════════
// GATE — the `next` parameter cannot navigate off-origin
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. The guard already existed and was already correct —
// B205 built it and probed it 23/23 — but it lived in a probe-* file
// nobody runs. A defence that is only exercised by a script somebody
// has to remember is one regression away from being gone, so this is
// the same logic as a registered gate.
//
// ── THE SURFACE, SWEPT ──────────────────────────────────────────────
//   /auth/accept            🔴 the ONLY page that assigns
//                           window.location from a URL parameter.
//                           Guarded by isAllowedNext.
//   /auth/callback          does not exist in this codebase.
//   /reset-password-required reads only ?email= and navigates to a
//                           hardcoded '/consent'. No redirect param.
//   everything else         no page reads next / redirect / returnTo.
//
// ── 🔴 WHY THE GUARD IS WRITTEN THE WAY IT IS ───────────────────────
// It resolves `next` against the page's own URL and then checks the
// protocol and the origin — which is exactly what the browser does on
// `window.location.href = next`. Matching the browser's semantics is
// the point, because the bypasses are all parser behaviour:
//
//   '/\\evil.com'   starts with '/' and not '//', so a naive
//                  startsWith('/') check ALLOWS it — and the WHATWG URL
//                  parser normalises '\\' to '/' in special schemes, so
//                  the browser navigates to https://evil.com/.
//   '//evil.com'   protocol-relative: inherits https and changes host.
//   absolute URLs  have to be allowed when same-origin, because
//                  Supabase's {{ .RedirectTo }} substitutes a full URL.
//
// So the test is not "does it look relative" but "where would the
// browser actually go".
//
// 🔴 This gate reimplements the predicate rather than importing it,
// because it lives inside a 'use client' page component that cannot be
// imported from Node. The source is read and compared, so a change to
// the page that this copy does not reflect FAILS rather than passing
// against a stale duplicate.
//
// Usage: npm run verify:openredirect

import { say, warn } from './lib/safe-log'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const PAGE = 'app/auth/accept/page.tsx'
const HERE = 'https://shieldmylot.com/auth/accept?token_hash=x&type=invite'

// The predicate as shipped, transcribed. Compared against the page
// below so it cannot drift silently.
function isAllowedNext(next: string, pageUrl: string): boolean {
  if (!next || typeof next !== 'string') return false
  try {
    const resolved = new URL(next, pageUrl)
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return false
    return resolved.origin === new URL(pageUrl).origin
  } catch {
    return false
  }
}

const main = () => {
  // ── the page still has the guard, and this copy still matches ────
  const src = fs.readFileSync(PAGE, 'utf8')
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  chk('the page still guards `next` with isAllowedNext',
    /setNext\(isAllowedNext\(nx\) \? nx : /.test(body),
    'an unguarded assignment is the whole vulnerability')
  chk('🔴 the shipped predicate resolves against the page URL and checks protocol AND origin',
    /new URL\(next, window\.location\.href\)/.test(body)
    && /resolved\.protocol !== 'https:'/.test(body)
    && /resolved\.origin === window\.location\.origin/.test(body),
    'this gate\'s copy of the predicate mirrors those three lines; if the page changes shape, this fails rather than testing a stale duplicate')
  chk('   ...and nothing else in the page assigns location from a raw param',
    (body.match(/window\.location\.href = /g) ?? []).length === 2,
    `${(body.match(/window\.location\.href = /g) ?? []).length} assignment(s): one to the guarded \`next\`, one hardcoded. A third would need reading.`)

  // ── 🔴 the four ruled payloads ───────────────────────────────────
  console.log('\n── 🔴 the four ruled payloads ──')
  const ruled: [string, string, boolean][] = [
    ['a valid relative path',            '/resident',                              true],
    ['an absolute off-origin URL',       'https://evil.example.com/x',             false],
    ['protocol-relative //evil.com',     '//evil.example.com',                     false],
    ['backslash /\\evil.com',            '/\\evil.example.com',                    false],
  ]
  for (const [label, payload, want] of ruled) {
    const got = isAllowedNext(payload, HERE)
    const where = (() => { try { return new URL(payload, HERE).href } catch { return '(unparseable)' } })()
    chk(`${want ? 'ALLOW' : 'REJECT'}  ${label}`,
      got === want,
      `${JSON.stringify(payload)} → the browser would go to ${where}${got === want ? '' : ` — got ${got ? 'ALLOW' : 'REJECT'}`}`)
  }

  // ── the rest of the B205 matrix, so the gate is not narrower ─────
  console.log('\n── the rest of the matrix ──')
  const more: [string, string, boolean][] = [
    ['an absolute SAME-origin URL (Supabase substitutes these)',
      'https://shieldmylot.com/signup/redeem/verify', true],
    ['a lookalike subdomain',          'https://shieldmylot.com.evil.example.com/x', false],
    ['a lookalike prefix host',        'https://evilshieldmylot.com/x',              false],
    ['the www host (a DIFFERENT origin)', 'https://www.shieldmylot.com/resident',    false],
    ['javascript:',                    'javascript:alert(1)',                        false],
    ['data:',                          'data:text/html,<script>alert(1)</script>',   false],
    ['file:',                          'file:///etc/passwd',                         false],
    ['double backslash',               '/\\\\evil.example.com',                      false],
    ['backslash-slash',                '/\\/evil.example.com',                       false],
    ['empty',                          '',                                           false],
    ['a fragment only',                '#top',                                       true],
    ['a query only',                   '?tab=billing',                               true],
    ['a nested path',                  '/resident/vehicles?added=1',                 true],
    ['whitespace-padded off-origin',   '  https://evil.example.com/x',               false],
    ['an http same-host URL (scheme downgrade)', 'http://shieldmylot.com/resident',  false],
  ]
  for (const [label, payload, want] of more) {
    const got = isAllowedNext(payload, HERE)
    chk(`${want ? 'ALLOW ' : 'REJECT'} ${label}`, got === want,
      got === want ? '' : `🔴 ${JSON.stringify(payload)} got ${got ? 'ALLOW' : 'REJECT'}, want ${want ? 'ALLOW' : 'REJECT'}`)
  }

  // ── 🔴 and the fallback is a real page, not nothing ──────────────
  console.log('\n── the fallback when `next` is rejected ──')
  const defaults = [...body.matchAll(/defaultNext:\s*'([^']+)'/g)].map(m => m[1])
  chk('every link type has a defaultNext to fall back to',
    defaults.length >= 3, `${defaults.length}: ${defaults.join(', ')}`)
  chk('🔴 ...and every one of them is a same-origin relative path',
    defaults.length > 0 && defaults.every(d => isAllowedNext(d, HERE)),
    `${defaults.join(', ')} — a fallback that itself failed the guard would be the vulnerability with extra steps`)

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

try { main() } catch (e) { warn(`🔴 ${(e as Error).message}`); process.exit(2) }
