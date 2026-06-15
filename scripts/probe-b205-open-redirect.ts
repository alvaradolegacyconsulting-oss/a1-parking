// B205 — open-redirect smoke for /auth/accept's isAllowedNext validator.
//
// Tests TWO candidate validators against a battery of malicious + legitimate
// `next` inputs and reports:
//   (a) what the validator decides
//   (b) what the URL constructor ACTUALLY resolves the input to against
//       the same base URL the browser would use
//
// A bypass = validator says ALLOW but resolved URL is off-origin. That's
// the case the static reasoning table can miss (especially backslash
// normalization in special-scheme URLs per the WHATWG URL Standard).
//
// Node's URL constructor implements WHATWG URL — same semantics as
// Chrome / Firefox / Safari for path resolution. Backslash normalization
// in http/https URLs is part of the spec, so what Node resolves here is
// what the browser will navigate to on window.location.href = next.

const BASE = 'https://shieldmylot.com/auth/accept'
const BASE_ORIGIN = new URL(BASE).origin

// ── CANDIDATE 1 — current shipped validator (from B198) ────────────────────
function validatorV1(next: string): boolean {
  if (!next || typeof next !== 'string') return false
  if (!next.startsWith('/')) return false
  if (next.startsWith('//')) return false
  return true
}

// ── CANDIDATE 2 — first proposed (origin string compare on bare URL) ───────
function validatorV2(next: string): boolean {
  if (!next || typeof next !== 'string') return false
  if (next.startsWith('/') && !next.startsWith('//')) return true
  try {
    return new URL(next).origin === BASE_ORIGIN
  } catch {
    return false
  }
}

// ── CANDIDATE 3 — resolve against base + origin check + protocol gate ──────
// The intended ship. Resolves next as a URL relative to the current page's
// URL (which is what window.location.href = next does), then asserts:
//   (a) protocol is http: or https: (excludes javascript:, data:, file:, etc.)
//   (b) resolved.origin matches the base origin
// This matches the browser's actual navigation semantics, so any input that
// would navigate off-origin is correctly rejected — including backslash
// normalization edge cases.
function validatorV3(next: string): boolean {
  if (!next || typeof next !== 'string') return false
  try {
    const resolved = new URL(next, BASE)
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return false
    return resolved.origin === BASE_ORIGIN
  } catch {
    return false
  }
}

interface Case {
  input: string
  label: string
  // Expected outcome: REJECT means the validator must say no (or what
  // it allows must resolve to same-origin — for the legitimate cases).
  expect: 'ALLOW_SAME_ORIGIN' | 'REJECT'
  notes?: string
}

const cases: Case[] = [
  // Legitimate same-origin paths
  { label: 'relative path (canonical)',                input: '/signup/redeem/verify',                              expect: 'ALLOW_SAME_ORIGIN' },
  { label: 'relative path (canonical, self-serve)',    input: '/signup/verify',                                     expect: 'ALLOW_SAME_ORIGIN' },
  { label: 'absolute same-origin (Supabase template)', input: 'https://shieldmylot.com/signup/redeem/verify',       expect: 'ALLOW_SAME_ORIGIN' },
  { label: 'absolute same-origin (self-serve)',        input: 'https://shieldmylot.com/signup/verify',              expect: 'ALLOW_SAME_ORIGIN' },

  // Off-origin / open-redirect candidates
  { label: 'protocol-relative cross-origin',           input: '//evil.com',                                         expect: 'REJECT' },
  { label: 'absolute cross-origin (https)',            input: 'https://evil.com/x',                                 expect: 'REJECT' },
  { label: 'lookalike subdomain (BASE.evil.com)',      input: 'https://shieldmylot.com.evil.com/x',                 expect: 'REJECT' },
  { label: 'same-origin string but wrong port',        input: 'https://shieldmylot.com:8443/x',                     expect: 'REJECT' },

  // Backslash tricks — the high-value test cases
  { label: 'backslash to evil (single \\)',            input: '/\\evil.com',                                        expect: 'REJECT', notes: 'browser may normalize \\ → / in special URLs' },
  { label: 'backslash to evil (\\/)',                  input: '/\\/evil.com',                                       expect: 'REJECT' },
  { label: 'double-backslash to evil',                 input: '\\\\evil.com',                                       expect: 'REJECT' },
  { label: 'leading backslash bare',                   input: '\\evil.com',                                         expect: 'REJECT' },
  { label: 'path-with-backslash-then-domain',          input: '/foo\\evil.com',                                     expect: 'REJECT' },

  // Non-http schemes
  { label: 'javascript: URI',                          input: 'javascript:alert(1)',                                expect: 'REJECT' },
  { label: 'data: URI',                                input: 'data:text/html,<script>alert(1)</script>',           expect: 'REJECT' },
  { label: 'file: URI',                                input: 'file:///etc/passwd',                                 expect: 'REJECT' },
  { label: 'vbscript: URI',                            input: 'vbscript:msgbox(1)',                                 expect: 'REJECT' },

  // Empty / falsy
  { label: 'empty string',                             input: '',                                                   expect: 'REJECT' },
  { label: 'whitespace only',                          input: '   ',                                                expect: 'REJECT', notes: 'spaces should not resolve to anything' },

  // Edge cases worth a look
  { label: 'lowercase scheme upcased',                 input: 'HTTPS://shieldmylot.com/signup/verify',              expect: 'ALLOW_SAME_ORIGIN', notes: 'URL normalizes scheme casing' },
  { label: 'fragment-only',                            input: '#frag',                                              expect: 'ALLOW_SAME_ORIGIN', notes: 'navigates within current document' },
  { label: 'query-only',                               input: '?q=1',                                               expect: 'ALLOW_SAME_ORIGIN', notes: 'navigates within current document' },
  { label: 'CRLF in input',                            input: '/safe\r\nhttps://evil.com',                          expect: 'REJECT', notes: 'header-splitting / control char' },
]

function describeResolve(next: string): { protocol: string; origin: string; href: string } | null {
  try {
    const u = new URL(next, BASE)
    return { protocol: u.protocol, origin: u.origin, href: u.href }
  } catch {
    return null
  }
}

function checkAllowed(allow: boolean, c: Case, resolved: ReturnType<typeof describeResolve>): boolean {
  if (c.expect === 'ALLOW_SAME_ORIGIN') {
    if (!allow) return false
    if (!resolved) return false
    return resolved.origin === BASE_ORIGIN && (resolved.protocol === 'https:' || resolved.protocol === 'http:')
  }
  // REJECT — pass either if (a) validator rejected, or (b) validator allowed
  // BUT the actual resolution is still safe (same-origin + http/https).
  // The latter is unusual (means the validator is over-permissive but the
  // input was harmless); we flag it as PASS but the FAIL case is "validator
  // ALLOW + resolved off-origin" which is the bypass.
  if (allow && resolved && resolved.origin === BASE_ORIGIN &&
      (resolved.protocol === 'https:' || resolved.protocol === 'http:')) {
    // unusual but safe
    return true
  }
  return !allow
}

interface Verdict { v1: boolean; v2: boolean; v3: boolean; safe: boolean; expect: string }

const verdicts: Array<Verdict & { label: string; input: string }> = []

console.log(`B205 open-redirect smoke · base=${BASE}`)
console.log(`base origin: ${BASE_ORIGIN}\n`)

for (const c of cases) {
  const v1 = validatorV1(c.input)
  const v2 = validatorV2(c.input)
  const v3 = validatorV3(c.input)
  const r  = describeResolve(c.input)

  const okV1 = checkAllowed(v1, c, r)
  const okV2 = checkAllowed(v2, c, r)
  const okV3 = checkAllowed(v3, c, r)

  verdicts.push({ label: c.label, input: c.input, v1: okV1, v2: okV2, v3: okV3, safe: okV3, expect: c.expect })

  const tag = okV3 ? '✓ PASS' : '✗ FAIL'
  console.log(`  ${tag}  ${c.label}`)
  console.log(`           input:     ${JSON.stringify(c.input)}`)
  console.log(`           expect:    ${c.expect}`)
  console.log(`           V1 (current ship): ${v1 ? 'ALLOW' : 'REJECT'}  ${okV1 ? '✓' : '✗'}`)
  console.log(`           V2 (origin-bare):  ${v2 ? 'ALLOW' : 'REJECT'}  ${okV2 ? '✓' : '✗'}`)
  console.log(`           V3 (resolve+gate): ${v3 ? 'ALLOW' : 'REJECT'}  ${okV3 ? '✓' : '✗'}`)
  if (r) {
    console.log(`           resolves: ${r.href} (protocol=${r.protocol}, origin=${r.origin})`)
  } else {
    console.log(`           resolves: <URL constructor threw>`)
  }
  if (c.notes) console.log(`           notes:    ${c.notes}`)
  console.log()
}

const v1Failures = verdicts.filter(v => !v.v1).length
const v2Failures = verdicts.filter(v => !v.v2).length
const v3Failures = verdicts.filter(v => !v.v3).length

console.log('── SUMMARY ──')
console.log(`  V1 (current ship):  ${verdicts.length - v1Failures}/${verdicts.length} pass · ${v1Failures} fail`)
console.log(`  V2 (origin-bare):   ${verdicts.length - v2Failures}/${verdicts.length} pass · ${v2Failures} fail`)
console.log(`  V3 (resolve+gate):  ${verdicts.length - v3Failures}/${verdicts.length} pass · ${v3Failures} fail`)

process.exit(v3Failures === 0 ? 0 : 1)
