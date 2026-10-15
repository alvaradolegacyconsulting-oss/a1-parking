// ════════════════════════════════════════════════════════════════════
// GATE — the login-setup flyer (/claim), and the flag that hides it
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: the CA's existing QR screen offers a SECOND flyer
// pointing at /claim, visible only when the company's
// bulk_onboarding_enabled is true. Flag off → the screen is unchanged.
//
// 🔴 WHAT THIS GATE CAN AND CANNOT PROVE, SAID UP FRONT.
// The visibility decision and the URL are pure functions, so the truth
// table and the encoding are asserted BY EXECUTION here. Whether the
// JSX honours them is a RENDER question, and rendering the CA portal
// needs a logged-in CA session — which is the next piece of work (the
// CA HTTP gate). So this gate asserts:
//   • the decision, executed, including both gates and all four cases;
//   • the URL, executed, against a property name containing the
//     characters that break an unencoded link;
//   • that the live /claim page accepts exactly the URL this builds —
//     end to end, against a real server;
//   • that BOTH call sites go through the shared decision rather than
//     inlining it, counted, so one of them cannot later lose a gate;
//   • that the printed sign does NOT say "approval required".
// The flag-off render assertion is carried into the CA HTTP gate.
//
// Usage: npm run verify:flyer

import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import { showClaimFlyer, claimFlyerUrl } from '../app/lib/claim-flyer'
import { qrSignCopy, type QRSignKind } from '../app/lib/qr-print'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const PORT = 3991
const BASE = `http://127.0.0.1:${PORT}`
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

let server: ChildProcess | null = null
const stop = () => { if (server && !server.killed) { server.kill('SIGTERM'); console.log('   ↩ stopped the server this gate started') } }
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true; stop(); process.exit(2) })
}

const portBusy = () => new Promise<boolean>(res => {
  const s = net.createServer()
  s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false)))
  s.listen(PORT, '127.0.0.1')
})

const main = async () => {
  // ── 🔴 the visibility truth table, executed ───────────────────────
  console.log('── 🔴 who sees the flyer (all four cases, executed) ──')
  const T = (b: boolean, r: boolean) => showClaimFlyer({ bulkOnboardingEnabled: b, residentPortal: r })
  chk('flag on + resident portal → shown', T(true, true) === true)
  chk('🔴 flag OFF → hidden, whatever else is true',
    T(false, true) === false && T(false, false) === false,
    'the ruling: a company that never uploaded a file has nobody to claim, and its screen must be unchanged')
  chk('🔴 no resident portal → hidden even with the flag ON',
    T(true, false) === false,
    'the claim would SUCCEED and land them in a portal their tier does not include — worse than no flyer')
  // A missing value must not read as permission. Both fields arrive
  // from `=== true` comparisons today, but a future caller passing a
  // possibly-undefined flag must fail closed, not open.
  chk('   ...and a missing flag fails CLOSED, not open',
    showClaimFlyer({ bulkOnboardingEnabled: undefined as unknown as boolean, residentPortal: true }) === false,
    'absence is not permission')

  // ── 🔴 the URL, executed, on a name that breaks a naive link ──────
  console.log('\n── 🔴 the URL the flyer carries ──')
  const nasty = 'Oak & Vine #2'
  const url = claimFlyerUrl('https://shieldmylot.com', nasty, 'A1 Wrecker llc')
  chk('🔴 `&` in a property name is encoded, not left to truncate the link',
    url.includes('Oak%20%26%20Vine') && !url.includes('Oak & Vine'),
    `${url}\n       an unencoded & would end the property at "Oak" and send the resident to a property that does not exist`)
  chk('   ...and so is the company, and `#` (which would otherwise become a fragment)',
    url.includes('A1%20Wrecker%20llc') && url.includes('%232'), url)
  chk('the shape is the one with no token — ?property=&company=',
    /\/claim\?property=[^&]+&company=[^&]+$/.test(url),
    'no property token exists in this codebase; /claim reuses the existing QR shape so its "Register here" fallback lands on the same property')

  // ── 🔴 the printed sign must not promise an approval ──────────────
  console.log('\n── 🔴 what the printed sign says ──')
  const claim = qrSignCopy('claim')
  const resident = qrSignCopy('resident')
  const visitor = qrSignCopy('visitor')
  chk('🔴 the claim sign does NOT say approval is required',
    !/approv/i.test(claim.noteBody + claim.noteTitle + claim.subhead + claim.heading),
    `"${claim.noteTitle} — ${claim.noteBody}". A bulk-loaded resident was approved by their own property at import. Telling them to wait for an approval that already happened is a call to the office.`)
  chk('   ...while the registration sign still DOES (it is still true there)',
    /approval required/i.test(resident.noteBody),
    `"${resident.noteBody}" — unchanged, which is the non-regression half`)
  chk('🔴 neither onboarding sign carries the tow warning; the visitor sign still does',
    claim.warn === false && resident.warn === false && visitor.warn === true,
    'a "your car will be towed" banner on a signup flyer is semantically wrong — they have not parked yet')
  const kinds: QRSignKind[] = ['visitor', 'resident', 'claim']
  chk('all three kinds are distinct signs, not one with a reworded note',
    new Set(kinds.map(k => qrSignCopy(k).heading)).size === 3
    && new Set(kinds.map(k => qrSignCopy(k).pageTitle)).size === 3,
    kinds.map(k => qrSignCopy(k).heading).join(' · '))
  chk('the claim sign tells the resident to expect an EMAIL, not an instant login',
    /email/i.test(claim.subhead + ' ' + claim.noteBody),
    `"${claim.subhead}" / "${claim.noteBody}" — the route mails nothing to an unknown address, so the sign promises what they should expect, not what will happen`)

  // ── 🔴 both call sites go through the shared decision ─────────────
  // Counted, not merely present: a surviving mention at one site must
  // not hide a gate deleted at the other.
  console.log('\n── 🔴 both CA call sites share one decision ──')
  const ca = fs.readFileSync('app/company_admin/page.tsx', 'utf8')
  const decisions = (ca.match(/\bshowClaimFlyer\(/g) ?? []).length
  const urls = (ca.match(/\bclaimFlyerUrl\(/g) ?? []).length
  const inlineClaimUrl = (ca.match(/\/claim\?property=/g) ?? []).length
  chk('🔴 every /claim card is gated through showClaimFlyer()',
    decisions === 3,
    `${decisions} call(s): the QR-tab section, the detail card, and the detail grid's column count. Inlining the && at each site is how one of them later loses a gate.`)
  chk('🔴 ...and every /claim URL is built by claimFlyerUrl(), none inline',
    urls === 2 && inlineClaimUrl === 0,
    `claimFlyerUrl=${urls} inline "/claim?property="=${inlineClaimUrl}`)
  chk('the registration QR is untouched — still two sites, still kind:\'resident\'',
    (ca.match(/\/register\?property=/g) ?? []).length === 2
    && (ca.match(/kind: 'resident'/g) ?? []).length === 2,
    `the ruling keeps the normal flyer for everyone: a bulk-loaded property still gets residents who were never in the file`)

  // ── 🔴 the link actually works, end to end ───────────────────────
  if (await portBusy()) {
    console.error(`\n🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }
  console.log(`\n── 🔴 the link the flyer prints, fetched for real (port ${PORT}) ──`)
  server = spawn('npx', ['next', 'dev', '-p', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`   [server] ${s}`) })
  const until = Date.now() + 90_000
  let up = false
  while (Date.now() < until && !up) {
    try { up = (await fetch(`${BASE}/claim`)).status === 200 } catch {}
    if (!up) await new Promise(r => setTimeout(r, 700))
  }
  if (!up) { console.error('🔴 server did not come up'); stop(); process.exit(2) }

  // The SAME builder the flyer uses, against the awkward name.
  const live = claimFlyerUrl(BASE, nasty, 'A1 Wrecker llc')
  const r = await fetch(live)
  const html = await r.text()
  chk('🔴 the printed URL resolves to the claim page', r.status === 200, `HTTP ${r.status} · ${live}`)
  chk('🔴 ...and the page names the property the flyer was printed for, ampersand intact',
    html.includes('Oak &amp; Vine #2') || html.includes('Oak & Vine #2'),
    'if the encoding were wrong the resident would see a different property name than the one on the sign in their hand')
  chk('   ...and asks for an email and nothing else',
    html.includes('claim-email') && !/Step 1 of 3/.test(html) && !/type="password"/.test(html))

  stop()
  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('🔴', (e as Error).message); stop(); process.exit(2) })
