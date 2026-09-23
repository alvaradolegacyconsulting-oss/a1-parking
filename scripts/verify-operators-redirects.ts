// ════════════════════════════════════════════════════════════════════
// GATE — /operators ad short paths (2026-09-23), Commit 4 of 4
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THIS STARTS A REAL SERVER AND MAKES REAL REQUESTS. Reading
// next.config.ts would prove the config is written; it would not prove
// Next behaves the way the config reads. The thing being asserted here
// is BEHAVIOUR, so the gate has to exercise it.
//
// WHY IT MATTERS MORE THAN A REDIRECT NORMALLY WOULD
// The printed QR encodes /morethantruck?src=swto-print. If the query is
// dropped, the reader still lands on a working page, still submits, and
// the lead still SAVES — with source null. Print and email attribution
// both collapse into "direct", and nothing anywhere reports an error:
// every surface says success. Zero print-attributed leads is
// indistinguishable from an ad nobody answered.
//
// Next preserves the incoming query when the destination carries none,
// so this is very likely already correct — and "likely correct, nothing
// checks" is exactly the condition that lets an edit break it silently
// later. That is what this file is for.
//
// Usage:  npm run build && npx tsx scripts/verify-operators-redirects.ts
import { spawn, type ChildProcess } from 'child_process'

const PORT = 3987
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }

// 🔴 Refuse to measure a server this gate did not start. `spawn('npx',
// ['next','start'])` creates a WRAPPER; SIGTERM to it leaves the real
// server listening, so a later run can bind-fail, connect to the STALE
// server and report green against an older build. That is not
// hypothetical — it happened to the route-exposure gate's positive
// control, which passed while probing a previous run's server.
async function portIsOccupied(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/operators`, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    return r.status > 0
  } catch { return false }
}

async function waitForServer(ms = 45000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${BASE}/operators`, { redirect: 'manual' })
      if (r.status > 0) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function hop(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  return { status: res.status, location: res.headers.get('location') }
}

async function main() {
  if (await portIsOccupied()) {
    console.log(`❌ S0  something is already listening on :${PORT}. Refusing to probe a server this gate did not`)
    console.log('      start — it would likely be a stale server on an older build, and every result below would')
    console.log(`      be a green light for code that is not running. Nothing measured. lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
    process.exit(2)
  }

  console.log(`starting production server on :${PORT} …`)
  // detached so the whole process GROUP can be killed, wrapper included.
  const server: ChildProcess = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: process.cwd(), stdio: 'ignore', detached: true,
  })
  const stop = () => {
    try { if (server.pid) process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  process.on('exit', stop)

  try {
    if (!await waitForServer()) {
      // 🔴 Not a pass. A gate that cannot run has measured nothing.
      fail('S0', 'server never came up — nothing below was measured. Run `npm run build` first.')
      return
    }
    pass('S0', 'production server responding')

    // ── R1 — 🔴 the QR path, query intact. The headline. ────────────
    for (const short of ['/morethantruck', '/swtowop']) {
      const r = await hop(`${short}?src=swto-print`)
      const ok = r.status >= 300 && r.status < 400 && r.location === '/operators?src=swto-print'
      if (ok) pass('R1', `${short}?src=swto-print → ${r.status} ${r.location} (query FORWARDED)`)
      else fail('R1', `🔴 ${short}?src=swto-print → ${r.status} ${r.location} — expected 30x to /operators?src=swto-print. Attribution would be LOST SILENTLY.`)
    }

    // ── R1b — a full campaign URL, every parameter forwarded ────────
    {
      const qs = 'utm_source=assoc&utm_medium=print&utm_campaign=fall26&src=swto-print'
      const r = await hop(`/morethantruck?${qs}`)
      if (r.location === `/operators?${qs}`) pass('R1b', 'all four campaign parameters forwarded in order')
      else fail('R1b', `got ${r.location}`)
    }

    // ── R2 — permanent, as specified ────────────────────────────────
    for (const short of ['/morethantruck', '/swtowop']) {
      const r = await hop(short)
      if (r.status === 308 || r.status === 301) pass('R2', `${short} → ${r.status} (permanent)`)
      else fail('R2', `${short} → ${r.status}; expected a permanent 308/301`)
    }

    // ── R3 — no query in means no empty `?` out ─────────────────────
    for (const short of ['/morethantruck', '/swtowop']) {
      const r = await hop(short)
      if (r.location === '/operators') pass('R3', `${short} → /operators exactly, no trailing '?'`)
      else fail('R3', `${short} → ${r.location}; expected bare /operators`)
    }

    // ── R4 — 🔴 the middleware must not eat any of it ───────────────
    // publicPaths is PREFIX-matched (middleware.ts: pathname.startsWith),
    // so one entry covers a whole subtree — but each of these three paths
    // is its own top-level string and none is a prefix of another. If any
    // is missing from the list, anonymous traffic is 307'd to /login — a
    // campaign landing every reader on a login screen. The tell is a
    // Location containing /login.
    // (An earlier version of this comment claimed publicPaths was an
    // explicit non-prefix list. It is not, and the difference matters:
    // it is why gating the whole /help tree in 136bb46 was one string.)
    for (const path of ['/morethantruck?src=swto-print', '/swtowop', '/operators?src=swto-print']) {
      const r = await hop(path)
      const toLogin = (r.location ?? '').includes('/login')
      if (!toLogin) pass('R4', `anonymous ${path} is not sent to /login`)
      else fail('R4', `🔴 anonymous ${path} → ${r.location}. Every ad reader would land on a login screen.`)
    }

    // ── R5 — /operators serves anonymously AND with real content ────
    // 🔴 This caught a live defect. The page originally read attribution
    // with useSearchParams(), which forces the nearest Suspense boundary
    // to bail out of server rendering: the response was 200 OK with an
    // EMPTY SHELL. On a page deliberately left indexable that is
    // indexable in name only — a crawler, a link preview and a
    // no-JavaScript reader would all have seen nothing, and a status
    // check alone would have called it healthy.
    //
    // So this asserts CONTENT, not status. A 200 that renders nothing is
    // not a working page.
    {
      const res = await fetch(`${BASE}/operators?src=swto-print`, { redirect: 'manual' })
      const html = res.status === 200 ? await res.text() : ''
      // Asserting on copy that only this page carries, so a 200 from
      // some other page could not pass this.
      const looksRight = /This is what you/.test(html) && /Send this over/i.test(html)
      if (res.status === 200 && looksRight) pass('R5', '/operators returns 200 and renders the form, anonymously')
      else fail('R5', `status=${res.status}, page markers found=${looksRight}`)
    }
  } finally {
    stop()
    await new Promise(r => setTimeout(r, 1200))
    if (await portIsOccupied()) {
      console.log(`\n⚠  :${PORT} is STILL listening after teardown. The next run would probe a stale server and`)
      console.log(`   could report a false pass. Kill it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
    }
    await new Promise(r => setTimeout(r, 400))
    if (!server.killed) server.kill('SIGKILL')
    console.log('server stopped')
  }

  console.log('')
  console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
  console.log('')
  console.log('── Still Jose\'s, on the Vercel deployment ──────────────────')
  console.log('   Test the QR path end to end: /morethantruck?src=swto-print')
  console.log('   — not /operators directly, because the redirect is what the')
  console.log('   printed code actually hits. Then: real submit through a real')
  console.log('   challenge, row lands with source={"src":"swto-print"}, and the')
  console.log('   alert arrives with alert_email_sent true on that row.')
  process.exit(failures === 0 ? 0 : 1)
}
main()
