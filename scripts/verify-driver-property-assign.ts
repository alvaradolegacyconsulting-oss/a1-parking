// ════════════════════════════════════════════════════════════════════
// verify-driver-property-assign — gates for the additive assignment.
//
// USAGE:
//   npx tsx --env-file=.env.local scripts/verify-driver-property-assign.ts
//
// RE-RUNNABLE. Offline: a fake Supabase stands in for the drivers
// table, so the ARRAY SEMANTICS are proven element-wise with no
// database and no probe rows in production.
//
// ── 🔴 G1 IS ELEMENT-WISE, NOT A COUNT ─────────────────────────────
// A length check passes on an implementation that REPLACED one property
// name with another — array in, array out, same size, wrong contents.
// On a table where assigned_properties IS the driver's entire scope,
// that silently revokes access to a property and the symptom is
// "driver can't see a property", which is the complaint that started
// this feature. It would look exactly like the bug it was meant to fix,
// and nobody would connect it for months.
//
// So G1 compares index by index: every prior element present, in the
// same position, with the same string, and the new property appended
// at the end.
// ════════════════════════════════════════════════════════════════════
import { assignPropertyToDrivers, alreadyAssigned } from '../app/lib/driver-property-assign'

type Row = { id: string; name: string; assigned_properties: string[]; is_active: boolean }
type Result = { gate: string; status: 'PASS' | 'FAIL'; detail: string }
const results: Result[] = []
const pass = (g: string, d: string) => results.push({ gate: g, status: 'PASS', detail: d })
const fail = (g: string, d: string) => results.push({ gate: g, status: 'FAIL', detail: d })

// Minimal fake of the two calls the lib makes. Records every UPDATE so
// a gate can assert a driver was NEVER written to — which a
// before/after array comparison alone cannot distinguish from a write
// that happened to produce the same value.
function fakeSupabase(rows: Row[], opts: { failWriteFor?: string } = {}) {
  const updatesIssued: string[] = []
  // Mirrors the two real chains exactly:
  //   read : from().select().eq().maybeSingle()
  //   write: from().update().eq().select()
  // Built as separate builders rather than one mutable object — a
  // shared-state fake is how a test starts passing for a reason the
  // production chain does not share.
  const from = () => ({
    select: () => ({
      eq: (_c: string, val: any) => ({
        maybeSingle: async () => {
          const r = rows.find(x => x.id === String(val))
          return r
            ? { data: { id: r.id, name: r.name, assigned_properties: [...r.assigned_properties] }, error: null }
            : { data: null, error: null }
        },
      }),
    }),
    update: (patch: any) => ({
      eq: (_c: string, val: any) => ({
        select: async () => {
          const id = String(val)
          updatesIssued.push(id)
          // RLS-filtered UPDATE: Supabase returns zero rows and NO error.
          if (opts.failWriteFor === id) return { data: [], error: null }
          const r = rows.find(x => x.id === id)
          if (!r) return { data: [], error: null }
          r.assigned_properties = patch.assigned_properties
          return { data: [{ id: r.id, assigned_properties: [...r.assigned_properties] }], error: null }
        },
      }),
    }),
  })
  return { api: { from } as any, updatesIssued }
}

const NEW_PROP = 'Mcclendon park village'

function baseRows(): Row[] {
  return [
    { id: '83', name: 'Jose Rosales',       is_active: true,  assigned_properties: ['Green Acres', 'Miramar Apartments', 'Southfork Lake Apartments'] },
    { id: '84', name: 'Prince fair',        is_active: true,  assigned_properties: ['Sugarberry Place'] },
    { id: '85', name: 'Alexsandra hidalgo', is_active: false, assigned_properties: ['Green Acres'] },
  ]
}

async function main() {
  // ── G1 — ELEMENT-WISE IDENTITY on a checked driver ──────────────
  {
    const rows = baseRows()
    const before = [...rows[0].assigned_properties]
    const { api } = fakeSupabase(rows)
    await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    const after = rows[0].assigned_properties
    const prefixIdentical = before.every((v, i) => after[i] === v)
    const appendedLast = after[after.length - 1] === NEW_PROP
    const lengthGrewByOne = after.length === before.length + 1
    if (prefixIdentical && appendedLast && lengthGrewByOne) {
      pass('G1', `every prior element same index + same string; "${NEW_PROP}" appended last. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    } else {
      fail('G1', `prefixIdentical=${prefixIdentical} appendedLast=${appendedLast} grewByOne=${lengthGrewByOne} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    }
  }

  // ── G2 — CONTROL: an UNCHECKED driver is never written to ───────
  // Asserts BOTH that the array is byte-identical AND that no UPDATE
  // was issued for that id. The array check alone would pass on an
  // implementation that rewrote the array with the same value — which
  // still burns a write, still races a concurrent edit, and still means
  // "unchecked" was not honoured.
  {
    const rows = baseRows()
    const untouchedBefore = JSON.stringify(rows[1].assigned_properties)
    const { api, updatesIssued } = fakeSupabase(rows)
    await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    const untouchedAfter = JSON.stringify(rows[1].assigned_properties)
    if (untouchedAfter === untouchedBefore && !updatesIssued.includes('84')) {
      pass('G2', `unchecked driver 84 byte-identical (${untouchedAfter}) AND no UPDATE issued for it`)
    } else {
      fail('G2', `array ${untouchedBefore} -> ${untouchedAfter}; updatesIssued=${JSON.stringify(updatesIssued)}`)
    }
  }

  // ── G3 — re-running does not duplicate ──────────────────────────
  {
    const rows = baseRows()
    const { api, updatesIssued } = fakeSupabase(rows)
    await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    const s2 = await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    const occurrences = rows[0].assigned_properties.filter(p => p === NEW_PROP).length
    if (occurrences === 1 && s2.already_had_it === 1 && s2.added === 0 && updatesIssued.filter(i => i === '83').length === 1) {
      pass('G3', 're-run: 1 occurrence, reported already_had_it, and the second run issued NO write')
    } else {
      fail('G3', `occurrences=${occurrences} added=${s2.added} already_had_it=${s2.already_had_it} writes=${updatesIssued.filter(i => i === '83').length}`)
    }
  }

  // ── G3b — case/whitespace variant also counts as present ────────
  // Without this, a re-run against a differently-cased stored value
  // appends a near-duplicate that no lookup matches consistently.
  {
    const rows = baseRows()
    rows[0].assigned_properties = ['Green Acres', '  mcclendon PARK village ']
    const { api } = fakeSupabase(rows)
    const s = await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    if (s.already_had_it === 1 && rows[0].assigned_properties.length === 2) {
      pass('G3b', 'case + whitespace variant recognised as already assigned; no near-duplicate appended')
    } else {
      fail('G3b', `already_had_it=${s.already_had_it} array=${JSON.stringify(rows[0].assigned_properties)}`)
    }
  }

  // ── G4 — a silent RLS-filtered write is NOT counted as added ────
  // Supabase returns { data: [], error: null } when RLS filters an
  // UPDATE. Reporting that as success is the silent-write class.
  {
    const rows = baseRows()
    const before = JSON.stringify(rows[0].assigned_properties)
    const { api } = fakeSupabase(rows, { failWriteFor: '83' })
    const s = await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83'] })
    const o = s.outcomes[0]
    if (s.added === 0 && s.failed === 1 && o.result === 'failed' && JSON.stringify(rows[0].assigned_properties) === before) {
      pass('G4', `0 rows + no error reported as failed (not added); array untouched. reason="${o.error}"`)
    } else {
      fail('G4', `added=${s.added} failed=${s.failed} result=${o?.result} array=${JSON.stringify(rows[0].assigned_properties)}`)
    }
  }

  // ── G5 — multi-driver: each array grows by exactly its own one ──
  {
    const rows = baseRows()
    const b83 = [...rows[0].assigned_properties], b84 = [...rows[1].assigned_properties]
    const { api } = fakeSupabase(rows)
    await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: ['83', '84'] })
    const ok83 = b83.every((v, i) => rows[0].assigned_properties[i] === v) && rows[0].assigned_properties.length === b83.length + 1
    const ok84 = b84.every((v, i) => rows[1].assigned_properties[i] === v) && rows[1].assigned_properties.length === b84.length + 1
    const noCrossContamination = !rows[1].assigned_properties.some(p => b83.includes(p) && !b84.includes(p))
    if (ok83 && ok84 && noCrossContamination) {
      pass('G5', `both checked drivers appended independently; no cross-contamination. 83=${JSON.stringify(rows[0].assigned_properties)} 84=${JSON.stringify(rows[1].assigned_properties)}`)
    } else {
      fail('G5', `ok83=${ok83} ok84=${ok84} noCross=${noCrossContamination}`)
    }
  }

  // ── G6 — empty selection writes nothing at all ──────────────────
  // "Assign selected" with nothing checked is Skip. It must not issue
  // a write, and must not report success it did not achieve.
  {
    const rows = baseRows()
    const snapshot = JSON.stringify(rows)
    const { api, updatesIssued } = fakeSupabase(rows)
    const s = await assignPropertyToDrivers(api, { property: NEW_PROP, driverIds: [] })
    if (updatesIssued.length === 0 && s.added === 0 && s.requested === 0 && JSON.stringify(rows) === snapshot) {
      pass('G6', 'empty selection: zero writes issued, nothing changed (Skip is the same write path as assigning nobody)')
    } else {
      fail('G6', `updates=${updatesIssued.length} added=${s.added} changed=${JSON.stringify(rows) !== snapshot}`)
    }
  }

  // ── G7 — alreadyAssigned unit behaviour ─────────────────────────
  {
    const cases: [string[], string, boolean][] = [
      [['Green Acres'], 'Green Acres', true],
      [['green acres'], 'Green Acres', true],
      [[' Green Acres '], 'Green Acres', true],
      [['Green Acres North'], 'Green Acres', false],
      [[], 'Green Acres', false],
    ]
    const bad = cases.filter(([arr, p, want]) => alreadyAssigned(arr, p) !== want)
    if (bad.length === 0) pass('G7', 'alreadyAssigned: exact / case / whitespace match true; prefix-of-longer-name false')
    else fail('G7', `mismatches: ${JSON.stringify(bad)}`)
  }

  console.log('\n── driver-property assignment gates ──')
  for (const r of results) console.log(`${r.status.padEnd(5)} ${r.gate.padEnd(5)} ${r.detail}`)
  const fails = results.filter(r => r.status === 'FAIL').length
  console.log(fails ? `\n🔴 ${fails} FAILURE(S)` : '\n✅ ALL GATES PASS')
  console.log('\n⚠ NOT COVERED HERE — needs a real run, and it is the test that matters:')
  console.log('   a driver assigned through this flow SEES the property in their portal.')
  console.log('   A1 reported a driver not seeing a property; the array being right while')
  console.log('   the portal still does not show it is the failure they would actually hit,')
  console.log('   and no array-only gate can catch it.')
  process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error('threw:', e); process.exit(1) })
