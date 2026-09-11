// ════════════════════════════════════════════════════════════════════
// PROBE — will Supabase Auth accept an email whose local part contains
//         an ILIKE metacharacter, on the ADMIN-CREATE path?
//
// USAGE:
//   PROBE_INBOX=you@yourdomain.com npx tsx --env-file=.env.local \
//     scripts/probe-email-wildcard-createuser-2026-09-11-ONE-TIME.ts
//
// ONE-TIME. Revert same day.
//
// ── THE QUESTION AND WHY IT SETS SEVERITY ───────────────────────────
// 24 RLS policy sites compare `email ~~* (auth.jwt() ->> 'email')`.
// `~~*` is ILIKE, so the CALLER'S OWN EMAIL IS USED AS A PATTERN.
//
//   `_` matches ONE character → targeted exposure. A resident holding
//        john_smith@x.com also matches johnasmith@x.com.
//   `%` matches ANY SEQUENCE → wholesale. An account at `%@gmail.com`
//        would match EVERY gmail address in those tables.
//
// `%` is valid in an RFC 5322 local part. Whether Supabase Auth accepts
// it CANNOT BE DETERMINED FROM SOURCE — GoTrue is hosted. Hence a probe.
//
// ── 🔴 WHY admin.createUser AND NOT signUp ──────────────────────────
// Residents self-register through app/api/register/create-user/route.ts,
// which does server-side supabase.auth.admin.createUser(). Confirmed in
// the tree 2026-09-11: that route validates only that email is non-empty
// (trim + lowercase), then hands it straight to createUser. Turnstile is
// the only gate. THAT is the live, ungated, public ingress.
//
// signUp and admin.createUser do not necessarily validate identically,
// and admin-create is generally the more permissive of the two. Probing
// the public signUp path could return "rejected" and tell us nothing
// about the route that is actually exposed.
//
// ── SIDE EFFECTS, AND WHAT IS NOT PROVEN ────────────────────────────
//   · email_confirm: FALSE and NO generateLink call. admin.createUser is
//     not documented to send mail on its own — inviteUserByEmail and
//     generateLink are the senders.
//   · ⚠ NOT PROVEN FROM SOURCE. GoTrue is hosted; if this project has
//     "Confirm email" enabled, an unconfirmed admin-create could queue a
//     confirmation. Mitigation: every deliverable candidate is a +alias
//     of PROBE_INBOX, so anything that does send lands in the operator's
//     own inbox. The pure-wildcard candidate is not deliverable at all.
//   · NO user_roles row is created, and the probe ASSERTS that. The
//     policies match a table's email column against the JWT — an
//     auth.users row with no role row and no session exercises nothing.
//     The exposure window is therefore closed by construction, not just
//     by the delete.
//   · Every created user is deleted immediately and the deletion is
//     VERIFIED by re-query, not assumed.
//
// ── REPORTING ───────────────────────────────────────────────────────
// Verbatim results. Not "accepted" / "rejected" — the exact error code,
// status and message string, so assertions get written from what the
// system said rather than what we expected.
// ════════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const inbox      = process.env.PROBE_INBOX

// 🔴 GUARD CLAUSE, NOT A PLACEHOLDER. A template with an unfilled
// address produces a plausible-wrong result rather than an error —
// createUser would either fail on a malformed address (reading as
// "metacharacters rejected") or succeed against someone else's domain.
// Fail loudly instead.
if (!inbox || !inbox.includes('@')) {
  console.error('FIXTURE FAIL: set PROBE_INBOX to an address you monitor, e.g.')
  console.error('  PROBE_INBOX=you@yourdomain.com npx tsx --env-file=.env.local scripts/probe-email-wildcard-createuser-2026-09-11-ONE-TIME.ts')
  process.exit(1)
}
const [inboxLocal, inboxDomain] = inbox.split('@')

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Candidate = { label: string; email: string; proves: string; skipIfPercentAccepted?: boolean }

const CANDIDATES: Candidate[] = [
  {
    label: 'percent-in-local',
    email: `${inboxLocal}+probe%test@${inboxDomain}`,
    proves: 'THE SEVERITY QUESTION — `%` in the local part means wholesale, not targeted, disclosure',
  },
  {
    label: 'underscore-in-local',
    email: `${inboxLocal}+probe_test@${inboxDomain}`,
    proves: 'the baseline vector is real rather than theoretical',
  },
  {
    label: 'pure-wildcard',
    email: `%@${inboxDomain}`,
    proves: 'worst case — a pattern matching every address at the domain',
    // Once `%` is known to be accepted in a local part, creating a bare
    // wildcard adds no information and is the single most dangerous row
    // this probe could write. Skip it.
    skipIfPercentAccepted: true,
  },
]

async function roleRowExists(email: string): Promise<number> {
  const { data, error } = await admin.from('user_roles').select('email').eq('email', email)
  if (error) { console.error('  user_roles check failed:', error.message); return -1 }
  return (data ?? []).length
}

async function userStillExists(id: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(id)
  if (error) return false
  return !!data?.user?.id
}

async function main() {
  console.log(`probing admin.createUser against ${url}`)
  console.log(`inbox: ${inbox}\n`)

  let percentAccepted = false
  const summary: string[] = []

  for (const c of CANDIDATES) {
    if (c.skipIfPercentAccepted && percentAccepted) {
      console.log(`── ${c.label} — SKIPPED`)
      console.log(`   % is already known accepted; creating a bare wildcard adds no information.\n`)
      summary.push(`SKIPPED  ${c.label} (redundant once % is known accepted)`)
      continue
    }

    console.log(`── ${c.label}`)
    console.log(`   email  : ${c.email}`)
    console.log(`   proves : ${c.proves}`)

    const { data, error } = await admin.auth.admin.createUser({
      email: c.email,
      email_confirm: false,
    })

    if (error) {
      // VERBATIM. Every field the SDK gives us.
      console.log(`   RESULT : REJECTED`)
      console.log(`     name    : ${(error as any).name}`)
      console.log(`     status  : ${(error as any).status}`)
      console.log(`     code    : ${(error as any).code}`)
      console.log(`     message : ${JSON.stringify(error.message)}`)
      summary.push(`REJECTED ${c.label} — status=${(error as any).status} code=${(error as any).code} message=${JSON.stringify(error.message)}`)
      console.log()
      continue
    }

    const id = data?.user?.id
    console.log(`   RESULT : ACCEPTED — auth user created, id=${id}`)
    if (c.label === 'percent-in-local' || c.label === 'pure-wildcard') percentAccepted = true

    // Prove the probe did not open the vector it is testing for.
    const roleRows = await roleRowExists(c.email)
    console.log(`   user_roles rows for this email: ${roleRows} (expected 0 — the probe creates none)`)

    // Delete, then VERIFY the delete. A cleanup nobody checked is a
    // cleanup that may not have happened.
    if (id) {
      const { error: delErr } = await admin.auth.admin.deleteUser(id)
      const stillThere = await userStillExists(id)
      if (delErr || stillThere) {
        console.log(`   🔴 CLEANUP FAILED — user ${id} may still exist. ${delErr?.message ?? ''}`)
        console.log(`      DELETE IT MANUALLY before leaving this probe.`)
        summary.push(`ACCEPTED ${c.label} — id=${id} 🔴 CLEANUP FAILED, delete manually`)
      } else {
        console.log(`   cleanup: deleted and verified gone`)
        summary.push(`ACCEPTED ${c.label} — created and deleted cleanly (role rows: ${roleRows})`)
      }
    }
    console.log()
  }

  console.log('── SUMMARY ──')
  summary.forEach(l => console.log('  ' + l))

  if (percentAccepted) {
    console.log('\n🔴 `%` IS ACCEPTED ON THE ADMIN-CREATE PATH.')
    console.log('   /api/register/create-user is public, ungated beyond Turnstile, and performs')
    console.log('   no email validation. Every `email ~~*` policy is wholesale-matchable.')
    console.log('   STOP AND REPORT — do not proceed to the policy audit on the assumption')
    console.log('   that this is scheduled work.')
  } else {
    console.log('\n`%` was NOT accepted on this path. Exposure is bounded by whichever')
    console.log('characters ARE accepted — report the verbatim results; the `_` line decides')
    console.log('whether the targeted vector is real.')
  }
}

main().catch(e => { console.error('probe threw:', e); process.exit(1) })
