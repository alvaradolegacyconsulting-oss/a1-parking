// ════════════════════════════════════════════════════════════════════
// GATE — the printable pass page shows four facts and keeps one secret
// ════════════════════════════════════════════════════════════════════
//
// Piece 2. The card goes on a windscreen, so the page is written for
// whoever photographs the code, not for the guest.
//
// 🔴 THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT SAMENESS. Unknown,
// expired, revoked and malformed must return an IDENTICAL answer. If
// any pair ever differs, the page becomes an oracle: anyone can probe
// whether a token existed, or whether a plate was ever here. The tow-
// ticket reader deliberately DOES distinguish its refusals, because its
// audience is the vehicle's owner — the difference is the audience, and
// this gate exists so nobody copies that pattern across.
//
// 🔴 CALLED AS anon, holding nothing but the anon key, because that is
// what a phone in a car park has. A SECURITY DEFINER function looks the
// same from a service-role client, so a service-role check could not
// notice a lost GRANT — and a lost GRANT breaks every printed card.
//
// Probes: two throwaway properties at a test tenant, one with the
// printable switch on and one off, removed and read back.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-pass-token.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })

const S = Date.now()
const ON = `zzpass-on-${S}`
const OFF = `zzpass-off-${S}`
const WANT = ['plate', 'property', 'status', 'valid', 'valid_until'].sort()
/** Named individually so a failure says WHICH field leaked. */
const BANNED = ['visitor_name', 'visiting_unit', 'vehicle_desc', 'id', 'created_at',
                'pass_token', 'duration_hours', 'is_active', 'company']
const ids: number[] = []
const propIds: number[] = []

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const read = async (token: string | null) =>
  (await anon.rpc('get_visitor_pass_by_token', { p_token: token })).data as Record<string, unknown> | null

async function cleanup() {
  if (ids.length) await db.from('visitor_passes').delete().in('id', ids)
  const { data: aud } = await db.from('audit_logs').select('id,new_values').eq('action', 'VISITOR_TOS_ACCEPTED')
  const mine = (aud ?? []).filter(a => [ON, OFF].includes(String((a.new_values as Record<string, unknown>)?.property)))
  if (mine.length) await db.from('audit_logs').delete().in('id', mine.map(a => a.id))
  if (propIds.length) await db.from('properties').delete().in('id', propIds)
  const left = await db.from('visitor_passes').select('id').in('property', [ON, OFF])
  const leftProps = await db.from('properties').select('id').in('id', propIds.length ? propIds : [-1])
  chk('probes removed, read back',
    (left.data ?? []).length === 0 && (leftProps.data ?? []).length === 0,
    `${(left.data ?? []).length} pass(es), ${(leftProps.data ?? []).length} propert(ies)`)
}

async function main() {
  console.log('\n══ printable visitor pass: token + anonymous page ══\n')
  try {
    const { data: co } = await db.from('companies').select('name').eq('company_env', 'test').order('id').limit(1).maybeSingle()
    if (!co) throw new Error('no test-env company')
    for (const [name, on] of [[ON, true], [OFF, false]] as [string, boolean][]) {
      const r = await db.from('properties').insert({
        name, company: co.name, is_active: true, printable_visitor_passes_enabled: on,
      }).select('id').single()
      if (r.error) throw new Error(`probe property ${name}: ${r.error.message}`)
      propIds.push(r.data.id as number)
    }
    console.log(`probe properties at ${co.name}: switch ON and switch OFF\n`)

    // ── the mint ─────────────────────────────────────────────────────
    const issued = await db.rpc('issue_visitor_pass', {
      p_plate: 'ZZPASS01', p_visitor_name: 'Probe', p_visiting_unit: '9001',
      p_property: ON, p_vehicle_desc: 'probe', p_duration_hours: 4,
    })
    const passId = Number((issued.data as Record<string, unknown>)?.pass_id ?? 0)
    if (passId) ids.push(passId)
    const { data: row } = await db.from('visitor_passes').select('id,pass_token,expires_at').eq('id', passId).maybeSingle()
    const token = String(row?.pass_token ?? '')
    chk('🔴 the printable switch ON mints a token', !!token, token ? `${token.length} chars` : '🔴 none minted')
    chk('   ...43 chars of URL-safe base64, no + / or =',
      token.length >= 40 && !/[+/=]/.test(token),
      token ? `len=${token.length} safe=${!/[+/=]/.test(token)}` : '-')

    const offIssued = await db.rpc('issue_visitor_pass', {
      p_plate: 'ZZPASS02', p_visitor_name: 'Probe', p_visiting_unit: '9002',
      p_property: OFF, p_vehicle_desc: 'probe', p_duration_hours: 4,
    })
    const offId = Number((offIssued.data as Record<string, unknown>)?.pass_id ?? 0)
    if (offId) ids.push(offId)
    const { data: offRow } = await db.from('visitor_passes').select('pass_token').eq('id', offId).maybeSingle()
    chk('🔴 the printable switch OFF mints NOTHING', offRow?.pass_token == null,
      offRow?.pass_token == null ? 'no token — and therefore no page' : `🔴 minted ${offRow?.pass_token}`)

    // ── the anonymous answer ────────────────────────────────────────
    console.log('\n── what an anonymous viewer receives ──')
    const good = await read(token)
    chk('anon can read a live pass — the printed card works',
      good?.valid === true, JSON.stringify(good))
    const got = Object.keys(good ?? {}).sort()
    chk(`🔴 exactly the ${WANT.length} intended keys`,
      got.join(',') === WANT.join(','),
      got.join(',') === WANT.join(',') ? got.join(', ') : `got ${got.join(', ')}`)
    // 🔴 ABSENCE IS NOT A PASS. Written as "none of BANNED is in good"
    // this went green while `good` was null because the reader did not
    // exist yet — it would have reported a clean projection against no
    // projection at all. The leak check only means something once a
    // valid answer has actually been returned.
    if (good?.valid !== true) {
      chk('🔴 no resident name, unit, description, id or token', false,
        '🔴 NOT EXERCISED: no valid answer to inspect, so nothing was checked')
    } else {
      const leaked = BANNED.filter(k => k in good)
      chk('🔴 no resident name, unit, description, id or token',
        leaked.length === 0,
        leaked.length === 0 ? `${BANNED.length} field(s) checked against a real answer, none present` : `🔴 PUBLISHED: ${leaked.join(', ')}`)
    }

    // ── 🔴 the four refusals are indistinguishable ──────────────────
    console.log('\n── 🔴 unknown, malformed, expired and revoked are one answer ──')
    const shapes: Record<string, string> = {}
    shapes.malformed = JSON.stringify(await read('tooshort'))
    shapes.unknown = JSON.stringify(await read('z'.repeat(43)))
    shapes.nullToken = JSON.stringify(await read(null))

    await db.from('visitor_passes').update({ is_active: false }).eq('id', passId)
    shapes.revoked = JSON.stringify(await read(token))
    await db.from('visitor_passes').update({ is_active: true, expires_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', passId)
    shapes.expired = JSON.stringify(await read(token))

    const distinct = [...new Set(Object.values(shapes))]
    chk('all four refusals return the IDENTICAL answer',
      distinct.length === 1 && distinct[0] === '{"valid":false}',
      distinct.length === 1
        ? `every one: ${distinct[0]} — the page cannot be used to probe whether a token existed`
        : `🔴 ${distinct.length} distinct shapes:\n       ` +
          Object.entries(shapes).map(([k, v]) => `${k} → ${v}`).join('\n       '))

    // 🔴 BOTH predicates, proved separately. revoked is is_active=false
    // while still unexpired; expired is is_active=true with a past
    // expiry. Either one alone would let one of these through.
    chk('   ...so liveness really is is_active AND expires_at > now(), both',
      shapes.revoked === '{"valid":false}' && shapes.expired === '{"valid":false}',
      `revoked=${shapes.revoked} expired=${shapes.expired}`)

    // ── grants ──────────────────────────────────────────────────────
    console.log('\n── grants ──')
    // 🔴 "FUNCTION NOT FOUND" IS NOT "PERMISSION DENIED". PGRST202 means
    // the minter does not exist yet, which proves nothing about its
    // grant — and this assertion passed on exactly that before the
    // migration was applied. The two are distinguished so the gate
    // cannot bank an unapplied migration as a security property.
    const mint = await anon.rpc('mint_pass_token_if_printable', { p_property: ON })
    const notFound = mint.error?.code === 'PGRST202' || /Could not find the function/i.test(mint.error?.message ?? '')
    chk('🔴 anon cannot execute the minter',
      !!mint.error && !notFound,
      notFound
        ? '🔴 NOT EXERCISED: the function does not exist yet, so its grant was never tested'
        : mint.error ? `refused: ${mint.error.message.slice(0, 70)}` : `🔴 anon minted ${mint.data}`)
    const iss = await anon.rpc('issue_visitor_pass', {
      p_plate: 'ZZPASS03', p_visitor_name: 'x', p_visiting_unit: '1',
      p_property: ON, p_vehicle_desc: 'x', p_duration_hours: 1,
    })
    chk('🔴 anon still cannot issue a pass — that grant was the CAPTCHA bypass',
      !!iss.error, iss.error ? `refused: ${iss.error.message.slice(0, 70)}` : '🔴 ANON ISSUED A PASS')
  } catch (e) {
    console.log(`🔴 ${(e as Error).message}`)
    fails++
  } finally {
    console.log('')
    await cleanup()
  }

  // ── the page and its exposure ─────────────────────────────────────
  console.log('\n── the page ──')
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  const page = strip(fs.readFileSync('app/pass/[token]/page.tsx', 'utf8'))
  chk('the route is declared in the exposure map',
    /'\/pass\/\[token\]'/.test(fs.readFileSync('scripts/route-exposure-map.ts', 'utf8')),
    "kind: 'page' — a capability URL, reachable anonymously")
  chk('   ...and /pass is in middleware publicPaths',
    /'\/pass'/.test(fs.readFileSync('middleware.ts', 'utf8')),
    'without it every printed card would 307 to /login')
  chk('the params Promise is awaited (Next 16)',
    /await params/.test(page), 'params is a Promise in this version')
  chk('🔴 the page renders ONE refusal, with no expired/revoked branch',
    /This pass is not valid/.test(page)
      && !/\bexpired\b/i.test(page.replace(/valid_until/g, ''))
      && !/\brevoked\b/i.test(page),
    'the server cannot tell the page which case it was, deliberately')
  chk('🔴 the page never renders a name or a unit',
    !/visitor_name|visiting_unit|vehicle_desc/.test(page),
    'the card sits on a windscreen, readable by anyone walking past')

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup(); process.exit(2) })
