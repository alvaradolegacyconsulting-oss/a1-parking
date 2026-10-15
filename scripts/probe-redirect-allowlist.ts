// ════════════════════════════════════════════════════════════════════
// Probe — what does GoTrue's Redirect URLs allowlist actually accept?
// ════════════════════════════════════════════════════════════════════
// The allowlist is dashboard state and /auth/v1/settings does not
// expose it. But GoTrue VALIDATES redirectTo against it, so it can be
// asked directly: generate a link with a given redirectTo and read what
// comes back. An allowlisted value survives into the link; a rejected
// one is either refused or silently replaced with SITE_URL — and which
// of those happens is itself worth knowing.
//
// 🔴 generateLink, NOT inviteUserByEmail. magiclink generation returns
// the link without mailing anyone, so nothing lands in a real inbox.
// The throwaway user it creates is deleted at the end.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { say, warn } from './lib/safe-log'

// 🔴 THIS PROBE CREATES AN AUTH USER AND MUST DELETE IT EVEN WHEN ITS
// OUTPUT IS CUT OFF. The first version printed with console.log and
// deleted at the end of main(); run as `npx tsx ... | head -6` it took
// SIGPIPE on the fourth line and left the user behind — the same
// head/tail mistake that has now bitten three times in one day. Writes
// go through safe-log, and the delete is in a signal handler as well as
// at the end.

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const S = Date.now()
const EMAIL = `zz-redirect-probe-${S}@test.invalid`

let createdUid = ''
let cleaned = false
async function cleanup() {
  if (cleaned || !createdUid) return
  cleaned = true
  const d = await db.auth.admin.deleteUser(createdUid).catch(e => ({ error: e }))
  if ((d as { error?: unknown }).error) warn(`   🔴 could not delete the probe user ${createdUid} — DELETE IT BY HAND`)
  else say(`cleanup: deleted the probe user`)
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup().then(() => process.exit(2)).catch(() => process.exit(2)) })
}

const main = async () => {
  const u = await db.auth.admin.createUser({ email: EMAIL, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) { console.error('🔴 createUser:', u.error?.message); process.exit(1) }
  createdUid = u.data.user.id

  // 🔴 SITE_URL IS THE redirect_to OF A BARE LINK, NOT THE LINK'S OWN
  // ORIGIN. The first version of this probe printed
  // new URL(action_link).origin and labelled it SITE_URL — which is
  // always the project's GoTrue verify endpoint
  // (https://<ref>.supabase.co/auth/v1/verify), the same for every
  // project and nothing to do with the site. A plausible-looking value
  // under a wrong label is worse than no value.
  const bare = await db.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  const bareLink = bare.data?.properties?.action_link ?? ''
  const siteUrl = bareLink ? (new URL(bareLink).searchParams.get('redirect_to') ?? '(none)') : '(unreadable)'
  say(`verify endpoint (always the project URL): ${bareLink ? new URL(bareLink).origin : '?'}`)
  say(`SITE_URL (the redirect_to of a link with no redirectTo): ${siteUrl}\n`)

  const cases = [
    ['the production host',               'https://shieldmylot.com/reset-password-required'],
    ['the www production host',           'https://www.shieldmylot.com/reset-password-required'],
    ['🔴 localhost:3000',                 'http://localhost:3000/reset-password-required'],
    ['🔴 a Vercel preview host',          'https://a1-parking-git-main-x.vercel.app/reset-password-required'],
    ['🔴 an unrelated origin',            'https://evil.example.com/reset-password-required'],
    ['🔴 a lookalike subdomain',          'https://shieldmylot.com.evil.example.com/x'],
  ] as const

  say('redirectTo                                                        → what GoTrue did')
  say('─'.repeat(104))
  for (const [label, redirectTo] of cases) {
    const r = await db.auth.admin.generateLink({ type: 'magiclink', email: EMAIL, options: { redirectTo } })
    let verdict: string
    if (r.error) {
      verdict = `REFUSED — ${r.error.message.slice(0, 60)}`
    } else {
      const link = r.data?.properties?.action_link ?? ''
      const sent = new URL(link).searchParams.get('redirect_to') ?? '(none)'
      verdict = sent === redirectTo
        ? '✅ ACCEPTED — carried into the link verbatim'
        : `replaced with ${sent}`
    }
    say(`${label.padEnd(30)} ${redirectTo.slice(0, 48).padEnd(50)} ${verdict}`)
  }

  await cleanup()
  const back = await db.auth.admin.listUsers({ perPage: 1000 })
  const left = (back.data?.users ?? []).filter(x => (x.email ?? '') === EMAIL)
  say(`verified: ${left.length} probe user(s) left`)
}
main().catch(e => { console.error('🔴', e); process.exit(1) })
