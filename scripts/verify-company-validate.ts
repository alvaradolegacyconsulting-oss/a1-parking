// ════════════════════════════════════════════════════════════════════
// C3 gate — validateCompanyExists (2026-09-18)
// ════════════════════════════════════════════════════════════════════
//
// Jose's gate spec: "attempt the typo, read the real error, assert on
// what the operator sees."
//
// So every gate below asserts on the MESSAGE STRING, not on a boolean.
// `ok === false` is satisfied by a validator that rejects everything,
// including the legitimate company — the message is the only thing that
// proves it rejected for the right reason and named the right company.
//
// G1–G5 run against a stub client (deterministic, no network).
// G6 runs against LIVE `companies` and is the positive control: a
// refusal from G1–G5 and a refusal from a broken fixture look identical
// unless something also proves a real company still passes.
//
// Read-only throughout. This script creates nothing and writes nothing.
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import { validateCompanyExists } from '../app/lib/company-validate'

let failures = 0
const pass = (id: string, note: string) => console.log(`✅ ${id}  ${note}`)
const fail = (id: string, note: string) => { failures++; console.log(`❌ ${id}  ${note}`) }

// Stub shaped like the real client's from().select() thenable.
const stub = (rows: { name: string | null }[] | null, error: { message: string } | null = null) => ({
  from: () => ({ select: async () => ({ data: rows, error }) }),
})

const COMPANIES = [{ name: 'A1 Wrecker, LLC' }, { name: 'Test Legacy Towing' }, { name: 'A_1 Underscore Co' }]

async function main() {
  // ── G1 — the typo. The operator must see the string THEY supplied. ──
  {
    const r = await validateCompanyExists(stub(COMPANIES) as any, 'A1 Wreckr, LLC')
    const msg = r.ok ? '(accepted)' : r.message
    if (!r.ok && msg.includes('A1 Wreckr, LLC') && /No company named/.test(msg) && /Nothing was created/.test(msg)) {
      pass('G1', `typo rejected, operator sees: "${msg}"`)
    } else {
      fail('G1', `expected a named rejection, got: ${msg}`)
    }
  }

  // ── G2 — the typo message must NOT name a DIFFERENT company. A
  //         validator that suggests "did you mean A1 Wrecker, LLC?" by
  //         quietly substituting it is how the wrong scope gets written.
  {
    const r = await validateCompanyExists(stub(COMPANIES) as any, 'A1 Wreckr, LLC')
    const msg = r.ok ? '' : r.message
    if (!r.ok && !msg.includes('A1 Wrecker, LLC')) pass('G2', 'rejection names only the supplied value, no silent substitution')
    else fail('G2', `rejection leaked another company name: ${msg}`)
  }

  // ── G3 — case + whitespace variants resolve, and resolve to the
  //         STORED spelling. This is the drift the canonical value exists
  //         to stop: two spellings must not become two scopes.
  {
    const r = await validateCompanyExists(stub(COMPANIES) as any, '  a1 wrecker, llc ')
    if (r.ok && r.canonical === 'A1 Wrecker, LLC') pass('G3', `"  a1 wrecker, llc " → canonical "${r.canonical}"`)
    else fail('G3', `expected canonical "A1 Wrecker, LLC", got ${JSON.stringify(r)}`)
  }

  // ── G4 — underscore is a LIKE wildcard. If this validator had been
  //         written with .ilike(), "A11 Underscore Co" would match the
  //         stored "A_1 Underscore Co" and validate a company that does
  //         not exist. This gate fails loudly if anyone reintroduces it.
  {
    const r = await validateCompanyExists(stub(COMPANIES) as any, 'A11 Underscore Co')
    if (!r.ok) pass('G4', 'underscore not treated as a wildcard — "A11 Underscore Co" correctly rejected')
    else fail('G4', `wildcard semantics leaked back in: "A11 Underscore Co" accepted as ${JSON.stringify(r.canonical)}`)
  }
  {
    // ...and the literal name still resolves, so G4 is not passing by
    // rejecting everything containing an underscore.
    const r = await validateCompanyExists(stub(COMPANIES) as any, 'A_1 Underscore Co')
    if (r.ok && r.canonical === 'A_1 Underscore Co') pass('G4b', 'literal underscore name still resolves')
    else fail('G4b', `literal underscore name rejected: ${JSON.stringify(r)}`)
  }

  // ── G5 — a lookup FAILURE must not read as "company is fine", and its
  //         message must be distinguishable from the not-found message.
  //         Absence must not be the failure output.
  {
    const r = await validateCompanyExists(stub(null, { message: 'network down' }) as any, 'A1 Wrecker, LLC')
    const msg = r.ok ? '(accepted)' : r.message
    if (!r.ok && /Could not verify/.test(msg) && !/No company named/.test(msg)) {
      pass('G5', `lookup failure fails CLOSED and says so: "${msg}"`)
    } else {
      fail('G5', `expected a distinct could-not-verify refusal, got: ${msg}`)
    }
  }

  // ── G5b — blank is legitimate ("None" in the form), not an error. ──
  {
    const r = await validateCompanyExists(stub(COMPANIES) as any, '')
    if (r.ok && r.canonical === null) pass('G5b', 'blank company accepted as null, not reported as a typo')
    else fail('G5b', `blank mishandled: ${JSON.stringify(r)}`)
  }

  // ── G6 — POSITIVE CONTROL against the live table. ──────────────────
  try {
    const env = fs.readFileSync('.env.local', 'utf8')
    const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
    const sb = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'))
    const { data } = await sb.from('companies').select('name').limit(1)
    const real = data?.[0]?.name
    if (!real) { fail('G6', 'could not read a real company name — positive control INCONCLUSIVE, not passed'); }
    else {
      const good = await validateCompanyExists(sb as any, real)
      const bad = await validateCompanyExists(sb as any, real + ' ZZZ-does-not-exist')
      if (good.ok && good.canonical === real.trim() && !bad.ok) {
        pass('G6', `live: "${real}" accepted, "${real} ZZZ-does-not-exist" rejected`)
      } else {
        fail('G6', `live control failed — good=${JSON.stringify(good)} bad=${JSON.stringify(bad)}`)
      }
    }
  } catch (e: any) {
    fail('G6', `live positive control could not run: ${e.message} — treat as INCONCLUSIVE, not pass`)
  }

  console.log('')
  console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
