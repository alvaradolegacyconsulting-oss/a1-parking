// ════════════════════════════════════════════════════════════════════
// STANDING GATE — what every build route gives an ANONYMOUS visitor
// ════════════════════════════════════════════════════════════════════
//
// 🔴 STARTS A REAL SERVER AND MAKES REAL REQUESTS. Reading middleware.ts
// would prove the allowlist contains a string. It would not prove the
// route answers the way the string implies — middleware ordering, the
// matcher exclusion, route handlers' own guards and Next's own redirects
// all sit between the list and the response.
//
// WHAT IT IS FOR
// --------------
// Three routes were omitted from the middleware allowlist in one week:
// /api/visitor/refusal-log, /api/leads, then /robots.txt + /sitemap.xml
// + /saas. Every time, the route was built, the list was forgotten,
// nothing errored, and the route quietly 307'd to /login until somebody
// happened to look. A manual sweep finds today's; it does nothing about
// the next route someone adds.
//
// So: every route the BUILD emits must carry a declared expectation in
// scripts/route-exposure-map.ts, and a route with no declaration FAILS.
// Forgetting stops being possible; only declaring is.
//
// Usage:  npm run build && npx tsx scripts/verify-route-exposure.ts
//
// Exit 0 all declared and all matching · 1 a mismatch or an undeclared
// route · 2 could not measure (no manifest, port occupied, server never
// came up). 🔴 2 is NOT a pass. A gate that could not run has measured
// nothing.
//
// ── WHY THERE IS A PORT CHECK ───────────────────────────────────────
// Because a green run once meant "we measured last week's build."
//
// The port check is not hygiene. This gate's own positive control —
// reverting the middleware fix to prove the gate would catch it —
// reported ALL ROUTES DECLARED AND MATCHING. It had connected to a
// leftover server from the previous run, serving the build that still
// had the fix in it.
//
// That is the shape of nearly every defect this codebase's recent builds
// have turned up, and it is worth naming because it will happen again in
// a form nobody predicted:
//
//   • alert_email_sent recorded an absence as a success
//   • a probe row survived because cleanup was the last statement
//   • cleanCount('') returned 0, so a blank field stored "0 properties"
//   • a policy gate asserted a role value it never actually tested
//
// In every one, the healthy result and the broken result produced
// IDENTICAL output. Nothing errored. The only way to tell them apart was
// to make the broken case happen on purpose and check that something
// screamed — which is why controls are not optional here, and why a gate
// that cannot measure must exit 2 instead of saying nothing is wrong.

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { ROUTE_EXPOSURE, NON_MANIFEST_ROUTES, type Expectation } from './route-exposure-map'

const PORT = 3988
const BASE = `http://127.0.0.1:${PORT}`
const MANIFEST = '.next/app-path-routes-manifest.json'

let failures = 0
const pass = (n: string, d = '') => console.log(`✅ ${n}${d ? '  ' + d : ''}`)
const fail = (n: string, d: string) => { failures++; console.log(`❌ ${n}  ${d}`) }

// ── The build's own enumeration ──────────────────────────────────────
// NOT a filesystem walk and NOT parsed build stdout. The first version of
// this sweep read stdout and filtered out anything containing '[' — which
// silently dropped every dynamic route and missed 24 of the 26 help
// routes. A gate must not inherit its author's filter, so it reads the
// manifest the build writes, brackets and all.
function buildRoutes(): string[] {
  if (!fs.existsSync(MANIFEST)) return []
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, string>
  return [...new Set(Object.values(m))].sort()
}

// 🔴 REFUSE TO MEASURE A SERVER WE DID NOT START.
//
// This is not defensive padding — it is the defect this gate's own
// positive control caught. `spawn('npx', ['next','start'])` creates a
// WRAPPER process; SIGTERM to it leaves the actual Next server listening.
// The next run then finds the port occupied, `next start` fails to bind,
// waitForServer() connects to the STALE server from the previous run, and
// every probe reports green against an old build.
//
// That happened here: the fix was reverted on purpose to prove the gate
// would fail, and the gate said ALL ROUTES DECLARED AND MATCHING. A gate
// that measures the wrong server is worse than no gate, because it
// launders a stale result as a fresh pass.
async function portIsOccupied(): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(2000)
    const r = await fetch(`${BASE}/login`, { redirect: 'manual', signal: ctl })
    return r.status > 0
  } catch { return false }
}

async function waitForServer(ms = 60000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: 'manual' })
      if (r.status > 0) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

// A dynamic pattern cannot be fetched, so it must declare a concrete
// sample. Declaring the pattern without one is not a verified route.
function probePath(route: string, exp: Expectation): string | null {
  const sample = 'sample' in exp ? exp.sample : undefined
  if (sample) return sample
  if (route.includes('[')) return null
  return route
}

function isLoginRedirect(status: number, location: string | null): boolean {
  if (status !== 301 && status !== 302 && status !== 307 && status !== 308) return false
  if (!location) return false
  try {
    return new URL(location, BASE).pathname === '/login'
  } catch { return false }
}

async function checkRoute(route: string, exp: Expectation): Promise<void> {
  if (exp.kind === 'skip') { pass(route.padEnd(46), `skipped — ${exp.why.slice(0, 70)}…`); return }

  const path = probePath(route, exp)
  if (!path) {
    fail(route.padEnd(46), 'dynamic route declared without a `sample` — a pattern nobody can request is not verified')
    return
  }

  let status: number, location: string | null, ctype: string, body = ''
  try {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
    status = res.status
    location = res.headers.get('location')
    ctype = res.headers.get('content-type') ?? ''
    if (exp.kind === 'content') body = await res.text()
  } catch (e) {
    fail(route.padEnd(46), `request threw: ${(e as Error).message}`)
    return
  }

  const got = `${status}${location ? ' → ' + location : ''}`
  const redirected = isLoginRedirect(status, location)

  switch (exp.kind) {
    case 'page':
      if (status === 200) pass(route.padEnd(46), '200')
      else if (redirected) fail(route.padEnd(46), `expected a page, got a LOGIN REDIRECT (${got}) — missing from middleware publicPaths?`)
      else fail(route.padEnd(46), `expected 200, got ${got}`)
      return

    case 'content':
      if (status !== 200) {
        fail(route.padEnd(46), redirected ? `expected a page, got a LOGIN REDIRECT (${got})` : `expected 200, got ${got}`)
      } else if (!body.includes(exp.marker)) {
        // 🔴 The /operators defect: 200 OK, zero copy. Status alone
        // called it healthy while crawlers got an empty shell.
        fail(route.padEnd(46), `200 but the server-rendered HTML does NOT contain ${JSON.stringify(exp.marker)} (${body.length} bytes) — a 200 that renders nothing is not a working page`)
      } else pass(route.padEnd(46), `200 + content (${body.length} bytes)`)
      return

    case 'asset':
      if (status !== 200) fail(route.padEnd(46), redirected ? `machine-read file got a LOGIN REDIRECT (${got}) — belongs in the middleware matcher exclusion` : `expected 200, got ${got}`)
      else if (!ctype.includes(exp.contentType)) fail(route.padEnd(46), `200 but content-type is ${JSON.stringify(ctype)}, expected ${JSON.stringify(exp.contentType)} — an HTML body here means a page was served in place of the file`)
      else pass(route.padEnd(46), `200 ${exp.contentType}`)
      return

    case 'method-guard':
      if (status === 405) pass(route.padEnd(46), '405 (reachable, GET refused)')
      else if (redirected) fail(route.padEnd(46), `public endpoint got a LOGIN REDIRECT (${got}) — missing from middleware publicPaths`)
      else fail(route.padEnd(46), `expected 405, got ${got}`)
      return

    case 'auth-required':
      if (status === 401 || status === 403) pass(route.padEnd(46), String(status))
      else if (redirected) fail(route.padEnd(46), `expected the handler's own 401, got a LOGIN REDIRECT (${got}) — middleware is gating it before the handler runs`)
      else fail(route.padEnd(46), `expected 401/403, got ${got}`)
      return

    case 'login':
      if (redirected) pass(route.padEnd(46), `${status} → /login`)
      else fail(route.padEnd(46), `expected a login redirect, got ${got} — this route is EXPOSED to anonymous traffic`)
      return

    case 'redirect': {
      const dest = location ? new URL(location, BASE).pathname : null
      if ((status === 301 || status === 302 || status === 307 || status === 308) && dest === exp.to) pass(route.padEnd(46), `${status} → ${exp.to}`)
      else fail(route.padEnd(46), `expected 30x → ${exp.to}, got ${got}`)
      return
    }
  }
}

async function main() {
  const routes = buildRoutes()
  if (!routes.length) {
    console.log(`❌ S0  ${MANIFEST} not found or empty — nothing was measured. Run \`npm run build\` first.`)
    process.exit(2)
  }
  console.log(`build emits ${routes.length} routes; map declares ${Object.keys(ROUTE_EXPOSURE).length}\n`)

  // ── D1 — every build route is declared ─────────────────────────────
  // This is the gate's whole reason for existing. A new route with no
  // entry fails here, before anything is requested.
  const undeclared = routes.filter(r => !(r in ROUTE_EXPOSURE))
  if (undeclared.length) {
    fail('D1 undeclared routes', `${undeclared.length} route(s) in the build with no declared anonymous expectation:`)
    undeclared.forEach(r => console.log(`      • ${r}`))
    console.log('      Add each to scripts/route-exposure-map.ts. Decide who should reach it;')
    console.log('      do not reach for `login` because you are unsure.')
  } else pass('D1 undeclared routes', 'every build route is declared')

  // ── D2 — no stale declarations ─────────────────────────────────────
  // A map entry for a route that no longer exists is a claim nothing
  // tests, and it hides the count from anyone auditing this file.
  const stale = Object.keys(ROUTE_EXPOSURE).filter(r => !routes.includes(r) && !NON_MANIFEST_ROUTES.has(r))
  if (stale.length) {
    fail('D2 stale declarations', `${stale.length} declared route(s) the build no longer emits: ${stale.join(', ')}`)
  } else pass('D2 stale declarations', 'none')

  if (await portIsOccupied()) {
    console.log(`❌ S1  something is already listening on :${PORT}. Refusing to probe a server this gate did not start —`)
    console.log('      it would very likely be a stale server from an earlier run, serving an older build, and every')
    console.log('      result below would be a green light for code that is not running. Nothing was measured.')
    console.log(`      Free it first:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
    process.exit(2)
  }

  console.log(`\nstarting production server on :${PORT} …`)
  // detached so the whole process GROUP can be killed — see above.
  const server: ChildProcess = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: process.cwd(), stdio: 'ignore', detached: true,
  })
  const stop = () => {
    try { if (server.pid) process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  process.on('exit', stop)

  try {
    if (!await waitForServer()) {
      console.log('❌ S1  server never came up — no route below was measured. Run `npm run build` first.')
      stop()
      process.exit(2)
    }
    console.log('server up — probing each route anonymously (no cookies, no Authorization)\n')

    const declared = Object.keys(ROUTE_EXPOSURE).sort()
    for (const route of declared) await checkRoute(route, ROUTE_EXPOSURE[route])

    // ── D3/D4 — what we ADVERTISE must match what we SERVE ──────────
    // robots.txt and sitemap.xml are promises to a crawler: "this URL is
    // worth fetching". Until 2026-09-23 both files were themselves
    // redirected to /login, so nobody ever read them and nothing noticed
    // that the sitemap had been advertising 21 /help URLs for ten weeks
    // after 136bb46 gated the help centre. Opening the files is what made
    // their contents matter, so the contents get asserted here.
    //
    // The invariant: every URL either file points a crawler at must be
    // declared in this map as something an anonymous visitor actually
    // GETS — `page` or `content`. Anything else is an invitation to a
    // login redirect.
    const servesAnonymously = (path: string): boolean => {
      const exp = ROUTE_EXPOSURE[path]
      return !!exp && (exp.kind === 'page' || exp.kind === 'content')
    }

    {
      const xml = await (await fetch(`${BASE}/sitemap.xml`)).text()
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
      const bad = locs.filter(u => {
        try { return !servesAnonymously(new URL(u).pathname.replace(/\/$/, '') || '/') } catch { return true }
      })
      if (!locs.length) fail('D3 sitemap advertises only reachable URLs', 'sitemap.xml contained no <loc> entries — it should list the public pages')
      else if (bad.length) {
        fail('D3 sitemap advertises only reachable URLs', `${bad.length} of ${locs.length} sitemap URL(s) are not declared as anonymously reachable:`)
        bad.forEach(u => console.log(`      • ${u}`))
        console.log('      A sitemap is a request to crawl. Listing a URL that answers with a login')
        console.log('      redirect spends crawl budget to learn nothing and teaches the crawler that')
        console.log('      this sitemap is unreliable.')
      } else pass('D3 sitemap advertises only reachable URLs', `${locs.length} URL(s), all serve anonymously`)
    }

    {
      const txt = await (await fetch(`${BASE}/robots.txt`)).text()
      const allows = txt.split('\n')
        .map(l => l.trim())
        .filter(l => /^allow:/i.test(l))
        .map(l => l.replace(/^allow:\s*/i, '').trim())
        .filter(p => p && p !== '/')
      const bad = allows.filter(p => !servesAnonymously(p.replace(/\/$/, '') || '/'))
      if (bad.length) {
        fail('D4 robots.txt allows only reachable paths', `${bad.length} Allow: entr(ies) point at paths that do not serve anonymously: ${bad.join(', ')}`)
        console.log('      `Allow` is a claim that an anonymous visitor gets the page.')
      } else pass('D4 robots.txt allows only reachable paths', `${allows.length} non-root Allow entr(ies), all serve anonymously`)
    }
  } finally {
    stop()
    // Confirm the port actually freed. If it did not, say so loudly: the
    // NEXT run is the one that would be poisoned, and it would look fine.
    await new Promise(r => setTimeout(r, 1200))
    if (await portIsOccupied()) {
      console.log(`\n⚠  :${PORT} is STILL listening after teardown. The next run of this gate would probe a stale`)
      console.log(`   server and could report a false pass. Kill it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
    }
  }

  console.log('')
  if (failures) {
    console.log(`❌ ${failures} FAILURE(S). Anonymous exposure does not match what is declared.`)
    process.exit(1)
  }
  console.log('✅ ALL ROUTES DECLARED AND MATCHING.')
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
