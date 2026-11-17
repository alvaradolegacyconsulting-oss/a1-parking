// ════════════════════════════════════════════════════════════════════
// GATE — the precheck message leads with Log in, and every claim exit
//        leaves exactly one audit row
// ════════════════════════════════════════════════════════════════════
//
// Both halves are SOURCE-SHAPED invariants and this gate says so
// plainly: the claim route cannot be exercised end-to-end from here
// because it is behind a Turnstile solve, so there is no honest
// execution leg to write. What it CAN prove is that the one-write-site
// structure holds and that no exit bypasses it — which is the property
// that decayed before (the route audited only its success path).
//
// Usage: npx tsx scripts/verify-register-claim-funnel.ts

import fs from 'fs'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
/** Comments quote the strings being asserted, so strip them first. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

console.log('\n══ /register precheck copy + /api/register/claim audit funnel ══\n')

// ── §1 the precheck message ─────────────────────────────────────────
const reg = strip(fs.readFileSync('app/register/page.tsx', 'utf8'))
const LOGIN = 'If you already have a sign-in, use the Log in page and then reopen this registration link.'
const FAILED = 'We could not set up a new account for this email here.'
const FORGOT = 'If you were already sent a link and it expired or went missing, use Forgot password instead.'
const FILE_ON = 'Otherwise, if your property has your details on file, use the button below and we will email you a setup link.'

for (const [label, frag] of [['the Log in sentence', LOGIN], ['the could-not sentence', FAILED],
                             ['the Forgot password sentence', FORGOT], ['the on-file sentence', FILE_ON]] as [string, string][]) {
  chk(`${label} is still in the message`, reg.includes(frag), frag.slice(0, 54) + '…')
}
// 🔴 The ORDER is the change. Asserting presence alone would have been
// green before the fix too.
const iLogin = reg.indexOf(LOGIN), iFailed = reg.indexOf(FAILED)
chk('🔴 the Log in sentence comes FIRST', iLogin > -1 && iFailed > -1 && iLogin < iFailed,
  `Log in at ${iLogin}, "could not" at ${iFailed}`)

// One message for every records-bearing address: the branch that sets
// it must still be the single !json.token_hash branch.
const tokenBranches = (reg.match(/if \(!json\.token_hash\)/g) ?? []).length
chk('one branch still serves every records-bearing address', tokenBranches === 1,
  `${tokenBranches} token_hash branch(es) — more than one would mean the message split by case, which is the enumeration change`)

// ── §2 the claim funnel ─────────────────────────────────────────────
const raw = fs.readFileSync('app/api/register/claim/route.ts', 'utf8')
const claim = strip(raw)

const inserts = (claim.match(/from\('audit_logs'\)\.insert/g) ?? []).length
chk('🔴 exactly ONE audit write site', inserts === 1, `${inserts} insert site(s)`)

// Every exit must go through done(). The only bare `return answer(` left
// may be the one INSIDE done.
const bare = (claim.match(/return answer\(/g) ?? []).length
chk('🔴 no exit bypasses done() — the only return answer( is inside it', bare === 1,
  `${bare} occurrence(s); >1 means a branch returns without leaving a row`)

const dones = (claim.match(/return done\(/g) ?? []).length
chk('every post-captcha exit routes through done()', dones >= 9,
  `${dones} done() exits (9 branches: 3 no-ops, 5 failure paths, 1 success)`)

// The three branches the ruling named, by name.
for (const o of ['already_has_login', 'staff_role', 'no_match'] as const) {
  chk(`🔴 the ${o} branch records its outcome`, new RegExp(`'${o}'`).test(claim), `outcome '${o}' present`)
}
// And the ones that were already silent failures.
for (const o of ['invite_sent', 'invite_failed', 'role_row_failed', 'auth_lookup_failed',
                 'residents_read_failed', 'roles_read_failed'] as const) {
  chk(`   ...and ${o}`, new RegExp(`'${o}'`).test(claim), '')
}

// 🔴 NO USER-FACING CHANGE. One response body, and the timing floor
// intact — the audit write must not have become an oracle.
const bodies = (claim.match(/NextResponse\.json\(SAME_ANSWER\)/g) ?? []).length
chk('🔴 still exactly one identical-answer body', bodies === 1, `${bodies} site(s)`)
chk('   ...and the response floor is untouched', /const FLOOR_MS = 900/.test(claim), 'FLOOR_MS = 900')
chk('   ...and the audit write precedes answer(), so the floor absorbs it',
  /await db\.from\('audit_logs'\)\.insert[\s\S]*?return answer\(startedAt\)/.test(claim),
  'insert, then answer() — equal cost on every branch')

// The write must never break the route.
chk('the audit write cannot throw out of done()', /catch \(e\) \{[\s\S]{0,160}outcome audit failed/.test(claim),
  'wrapped in try/catch')

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)
