// ════════════════════════════════════════════════════════════════════
// GATE — /visitor phantom-property guard (2026-09-18)
// ════════════════════════════════════════════════════════════════════
//
// Three-part gate as specified: no param, garbage param, valid param.
// The first two must write NO visitor_passes row. The third must create
// a pass whose stored property matches a real properties row AND which
// the driver-side lookup returns as active.
//
// 🔴 THE THIRD ASSERTION IS THE ONE THAT MATTERS. A guard that refuses
// everything passes the first two. Without the positive control this
// suite would go green on a page that had simply been bricked.
//
// This gate exercises the DECISION LOGIC lifted from app/visitor/page.tsx
// plus the real database for resolution and the real driver-visible read.
// It does NOT drive a browser — the parts it cannot reach (that the form
// actually renders, that the button is wired) are listed at the bottom as
// the manual half, rather than being quietly implied to have passed.
//
// Writes: G3 creates ONE visitor pass on Test Legacy Property and
// deletes it again, verifying the delete with RETURNING-equivalent.
// Nothing touches A1, Demo, or any live customer property.
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const TEST_PROPERTY = 'Test Legacy Property'
const TEST_PLATE = 'GATE918X'

let failures = 0
const pass = (id: string, note: string) => console.log(`✅ ${id}  ${note}`)
const fail = (id: string, note: string) => { failures++; console.log(`❌ ${id}  ${note}`) }

function client() {
  const env = fs.readFileSync('.env.local', 'utf8')
  const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
  return createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'))
}

// ── The decision logic, transcribed from app/visitor/page.tsx ────────
// Kept in the same order the page evaluates it: param presence, then
// resolution, then the submit backstop.
type Decision = { willRender: 'form' | 'invalid-link'; willWrite: boolean; propertyWritten: string | null }
function decide(rawProperty: string | null, resolved: boolean | null): Decision {
  const hasPropertyParam = !!(rawProperty && rawProperty.trim() !== '')
  const propertyResolved = hasPropertyParam ? resolved : false   // no-param resolves to false immediately
  const willRender = propertyResolved === false ? 'invalid-link' : 'form'
  const willWrite = hasPropertyParam && propertyResolved === true
  return { willRender, willWrite, propertyWritten: willWrite ? rawProperty!.trim() : null }
}

async function main() {
  const sb = client()

  // ── G1 — no ?property= at all ────────────────────────────────────
  {
    const d = decide(null, null)
    if (d.willRender === 'invalid-link' && !d.willWrite) pass('G1', 'no param → invalid-link screen, NO row written')
    else fail('G1', `no param produced ${JSON.stringify(d)}`)
  }
  {
    // empty and whitespace-only count as absent, not as a value
    const d = decide('   ', null)
    if (d.willRender === 'invalid-link' && !d.willWrite) pass('G1b', 'whitespace-only param treated as absent')
    else fail('G1b', `whitespace param produced ${JSON.stringify(d)}`)
  }

  // ── G2 — garbage ?property= ──────────────────────────────────────
  {
    const garbage = 'Not A Real Property ZZZ'
    const { data } = await sb.rpc('get_property_for_visitor', { p_name: garbage })
    const resolvedInDb = !!(data as any[] | null)?.[0]?.company
    const d = decide(garbage, resolvedInDb ? true : false)
    if (!resolvedInDb && d.willRender === 'invalid-link' && !d.willWrite) {
      pass('G2', `"${garbage}" does not resolve in the DB → invalid-link, NO row written`)
    } else {
      fail('G2', `garbage param resolvedInDb=${resolvedInDb} decision=${JSON.stringify(d)}`)
    }
  }

  // ── G2b — the regression itself: the old placeholder must be inert ──
  {
    // 'Managed Property' arriving as a LITERAL param is just an
    // unresolvable name now; it must not get special treatment either way.
    //
    // Note on what is NOT asserted here: decide('Managed Property', null)
    // renders the form, and that is CORRECT — null means resolution is
    // still in flight, and falling through to the form on null is
    // deliberate existing behaviour so a slow RPC doesn't blank the page.
    // An earlier version of this gate asserted against that and failed a
    // working fix. Loading is not the same state as resolved-false, and a
    // gate that conflates them is testing its own confusion.
    const { data } = await sb.rpc('get_property_for_visitor', { p_name: 'Managed Property' })
    const resolvesInDb = !!(data as any[] | null)?.[0]?.company
    const d2 = decide('Managed Property', resolvesInDb ? true : false)
    if (!resolvesInDb && d2.willRender === 'invalid-link' && !d2.willWrite) {
      pass('G2b', '"Managed Property" as a literal param resolves nowhere and writes nothing')
    } else {
      fail('G2b', `placeholder still special-cased: resolvesInDb=${resolvesInDb} ${JSON.stringify(d2)}`)
    }
  }

  // ── G3 — 🔴 POSITIVE CONTROL. A valid property must still work. ──
  let createdId: number | null = null
  try {
    const { data: rpcData, error: rpcErr } = await sb.rpc('get_property_for_visitor', { p_name: TEST_PROPERTY })
    const row = (rpcData as any[] | null)?.[0]
    if (rpcErr || !row?.company) {
      fail('G3', `fixture property "${TEST_PROPERTY}" did not resolve (${rpcErr?.message ?? 'no row'}) — INCONCLUSIVE, not a pass`)
    } else {
      const canonical = row.name as string
      const d = decide(TEST_PROPERTY, true)
      if (!d.willWrite) { fail('G3a', `valid property was REFUSED: ${JSON.stringify(d)}`) }
      else {
        pass('G3a', `valid property "${TEST_PROPERTY}" → form renders, write permitted (canonical "${canonical}")`)

        const expires = new Date(Date.now() + 4 * 3600 * 1000).toISOString()
        const { data: ins, error: insErr } = await sb.from('visitor_passes').insert([{
          plate: TEST_PLATE, visitor_name: 'Gate 918', visiting_unit: '1',
          property: canonical, is_active: true, expires_at: expires,
        }]).select('id, property, expires_at, is_active')
        if (insErr || !ins?.[0]) {
          fail('G3b', `could not create the control pass: ${insErr?.message ?? 'no row returned'} — INCONCLUSIVE`)
        } else {
          createdId = ins[0].id
          // (i) stored property matches a REAL properties row
          const { data: props } = await sb.from('properties').select('name')
          const matches = (props || []).some((p: any) => String(p.name).trim().toLowerCase() === String(ins[0].property).trim().toLowerCase())
          if (matches) pass('G3b', `stored property ${JSON.stringify(ins[0].property)} matches a real properties row`)
          else fail('G3b', `stored property ${JSON.stringify(ins[0].property)} matches NO properties row — this is the original bug`)

          // (ii) the driver-visible read returns it as an ACTIVE pass.
          // Both predicates, per the standing rule: is_active AND not expired.
          const { data: seen } = await sb.from('visitor_passes')
            .select('id, plate, property, is_active, expires_at')
            .eq('property', ins[0].property)
            .eq('is_active', true)
            .gt('expires_at', new Date().toISOString())
          const found = (seen || []).some((r: any) => r.id === createdId)
          if (found) pass('G3c', 'driver-side lookup returns the pass as ACTIVE — enforcement can see it')
          else fail('G3c', 'pass was created but the enforcement-shaped query does NOT return it')
        }
      }
    }
  } finally {
    if (createdId !== null) {
      const { data: del } = await sb.from('visitor_passes').delete().eq('id', createdId).select('id')
      if (del && del.length === 1) pass('G4', `control pass ${createdId} deleted (confirmed by returned row)`)
      else fail('G4', `control pass ${createdId} may still exist — delete returned ${JSON.stringify(del)}`)
    }
  }

  console.log('')
  console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
  console.log('')
  console.log('── NOT covered here (manual, in a browser) ──────────────────')
  console.log('   • that the invalid-link screen actually renders and reads well')
  console.log('   • that the resident-plate block still fires (needs a resident plate')
  console.log('     at a real property + the Turnstile widget)')
  console.log('   • the end-to-end submit through /api/visitor/create-pass')
  process.exit(failures === 0 ? 0 : 1)
}
main()
