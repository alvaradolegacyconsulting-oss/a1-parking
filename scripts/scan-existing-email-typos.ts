// Read-only scan of every stored address against the typo rules.
// REPORTS ONLY — corrects nothing. Changing an email on an existing
// account touches the auth spine and every value-join that carries the
// address; that is a separate decision per row.
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import { checkDeadTld, suggestEmailCorrection, normalizeEmail, findBlockedEmailChar } from '../app/lib/email-guard'

const env=fs.readFileSync('.env.local','utf8')
const g=(k:string)=>(env.match(new RegExp('^'+k+'=(.*)$','m'))?.[1]||'').trim()
const sb=createClient(g('NEXT_PUBLIC_SUPABASE_URL'),g('SUPABASE_SERVICE_ROLE_KEY'))

async function all(t:string,c:string){const o:any[]=[];for(let f=0;;f+=1000){const{data,error}=await sb.from(t).select(c).range(f,f+999);if(error)throw new Error(`${t}: ${error.message}`);o.push(...(data||[]));if(!data||data.length<1000)break}return o}

type Hit = { source: string; email: string; kind: string; detail: string }

async function main(){
  const hits: Hit[] = []
  let scanned = 0

  for (const [table, col] of [['user_roles','email'],['residents','email'],['drivers','email']] as const) {
    const rows = await all(table, `${col}`)
    scanned += rows.length
    for (const r of rows) {
      const raw = (r as any)[col]; if (!raw) continue
      const e = normalizeEmail(raw)
      const dead = checkDeadTld(e)
      if (!dead.ok) hits.push({ source: table, email: raw, kind: '🔴 DEAD TLD', detail: dead.tld })
      const s = suggestEmailCorrection(e)
      if (s) hits.push({ source: table, email: raw, kind: '⚠ LIKELY TYPO', detail: `→ ${s}` })
      const ch = findBlockedEmailChar(e)
      if (ch) hits.push({ source: table, email: raw, kind: '🔴 METACHAR', detail: ch })
    }
    console.log(`scanned ${table}: ${rows.length} rows`)
  }

  // auth.users — not a public table; reached through the admin API.
  try {
    let page = 1, n = 0
    for (;;) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new Error(error.message)
      const users = data?.users ?? []
      n += users.length
      for (const u of users) {
        if (!u.email) continue
        const e = normalizeEmail(u.email)
        const dead = checkDeadTld(e)
        if (!dead.ok) hits.push({ source: 'auth.users', email: u.email, kind: '🔴 DEAD TLD', detail: dead.tld })
        const s = suggestEmailCorrection(e)
        if (s) hits.push({ source: 'auth.users', email: u.email, kind: '⚠ LIKELY TYPO', detail: `→ ${s}` })
        const ch = findBlockedEmailChar(e)
        if (ch) hits.push({ source: 'auth.users', email: u.email, kind: '🔴 METACHAR', detail: ch })
      }
      if (users.length < 1000) break
      page++
    }
    scanned += n
    console.log(`scanned auth.users: ${n} rows`)
  } catch (e:any) {
    // 🔴 Must not print as clean. A failed scan is not an empty result.
    console.log(`🔴 COULD NOT SCAN auth.users — ${e.message}. This is NOT a pass; that source is UNSCANNED.`)
  }

  console.log(`\n══ ${hits.length} match(es) across ${scanned} stored addresses ══`)
  if (hits.length === 0) { console.log('  (none)'); return }
  const seen = new Set<string>()
  for (const h of hits) {
    const k = `${h.source}|${h.email}|${h.kind}`
    if (seen.has(k)) continue
    seen.add(k)
    console.log(`  ${h.kind.padEnd(16)} ${h.source.padEnd(12)} ${h.email.padEnd(46)} ${h.detail}`)
  }
  console.log('\n  REPORT ONLY — nothing corrected. Each row is its own decision.')
}
main().catch(e=>{console.error('FAILED —',e.message);process.exit(1)})
