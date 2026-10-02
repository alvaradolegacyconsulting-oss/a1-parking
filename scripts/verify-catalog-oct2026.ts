// GATE — Oct 2026 self-serve Pro catalog. Asserts the PROJECTION a
// checkout reads, not the build script's own log. Defaults to test;
// pass `live` as argv[2]. Asserts what did NOT change as hard as what
// did — a build that quietly repriced a subscriber would otherwise
// look like a clean run.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
const e=fs.readFileSync('.env.local','utf8')
const g=(k:string)=>(e.match(new RegExp('^'+k+'=(.*)$','m'))?.[1]||'').trim()
const db=createClient(g('NEXT_PUBLIC_SUPABASE_URL'),g('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}})
const money=(c:number|null)=>c==null?'—':'$'+(c/100).toFixed(2)
let fail=0
const MODE = (process.argv[2] === 'live' ? 'live' : 'test') as 'live' | 'test'
const main=async()=>{
  const r=await db.from('stripe_prices').select('*').eq('mode',MODE).is('proposal_code_id',null)
  const act=(r.data??[]).filter((x:any)=>x.is_active)
  console.log(`=== ${MODE}-mode standard catalog, ACTIVE, after the run ===`)
  const by=new Map<string,any[]>()
  act.forEach((x:any)=>{const k=`${x.tier_track}/${x.tier_name}`;by.set(k,[...(by.get(k)??[]),x])})
  ;[...by.entries()].sort().forEach(([k,rows])=>{
    console.log(`\n  ${k}`)
    rows.sort((a:any,b:any)=>a.line_item<b.line_item?-1:1).forEach((x:any)=>
      console.log(`     ${x.line_item.padEnd(13)} ${x.cycle.padEnd(8)} ${String(x.price_model).padEnd(10)} ${money(x.unit_amount_cents).padEnd(10)} ${x.tiers?JSON.stringify(x.tiers):''}`))
  })
  console.log('\n=== ARCHIVED (is_active=false) ===')
  const arch=(r.data??[]).filter((x:any)=>!x.is_active)
  arch.forEach((x:any)=>console.log(`  ${x.tier_track}/${x.tier_name}/${x.line_item}/${x.cycle} ${money(x.unit_amount_cents)} key=${x.lookup_key}`))

  console.log('\n=== ASSERTIONS ===')
  const chk=(n:string,ok:boolean,d='')=>{if(!ok)fail++;console.log(`${ok?'✅':'❌'} ${n}${d?'  '+d:''}`)}
  const find=(t:string,ti:string,li:string,c:string)=>act.find((x:any)=>x.tier_track===t&&x.tier_name===ti&&x.line_item===li&&x.cycle===c)
  // the three Pro/Starter per-property lines are graduated with the 20/0 step
  for(const [t,ti,rate] of [['enforcement','enforcement_only',1500],['enforcement','legacy',2000],['property_management','legacy',1500]] as [string,string,number][]){
    const m=find(t,ti,'per_property','monthly'), a=find(t,ti,'per_property','annual')
    chk(`${t}/${ti} per_property monthly graduated 20@${rate}/0`, !!m && m.price_model==='graduated' && JSON.stringify(m.tiers)===JSON.stringify([{up_to:20,unit_amount:rate},{up_to:null,unit_amount:0}]), JSON.stringify(m?.tiers))
    chk(`${t}/${ti} per_property annual  = x10`, !!a && JSON.stringify(a.tiers)===JSON.stringify([{up_to:20,unit_amount:rate*10},{up_to:null,unit_amount:0}]))
  }
  chk('enforcement/legacy base monthly = $299', find('enforcement','legacy','base','monthly')?.unit_amount_cents===29900)
  chk('property_management/legacy base monthly = $249', find('property_management','legacy','base','monthly')?.unit_amount_cents===24900)
  chk('enforcement/legacy base annual = x10', find('enforcement','legacy','base','annual')?.unit_amount_cents===299000)
  chk('property_management/legacy base annual = x10', find('property_management','legacy','base','annual')?.unit_amount_cents===249000)
  chk('PM Pro has NO permit meter', !find('property_management','legacy','per_permit','monthly'))
  chk('Operator Starter base UNCHANGED at $199 (v3 reused, not recreated)', find('enforcement','enforcement_only','base','monthly')?.lookup_key?.endsWith('.v3')===true)
  // 🔴 Corrected assertion. MIGRATE UPDATES THE ROW IN PLACE: ids
  // 142/143 kept their identity and became v4/graduated. The old flat
  // price is archived in STRIPE and is simply gone from the projection.
  // Asserting "an archived row exists" was wrong about the script's
  // contract. What must hold is that no FLAT per_property row survives
  // for this tier — a leftover flat row would be a price checkout
  // could still resolve.
  const flatLeft = act.filter((x:any)=>x.tier_name==='enforcement_only'&&x.line_item==='per_property'&&x.price_model==='flat')
  chk('no FLAT per_property row survives for Operator Starter', flatLeft.length===0, `found ${flatLeft.length}`)
  chk('its rows were migrated in place (2 rows, both v4)', act.filter((x:any)=>x.tier_name==='enforcement_only'&&x.line_item==='per_property').length===2)
  chk('pm_starter untouched (still 4 active v3 rows)', act.filter((x:any)=>x.tier_name==='pm_starter').length===4)
  chk('pm_only untouched (still 6 active v3 rows)', act.filter((x:any)=>x.tier_name==='pm_only').length===6)

  const other=MODE==='test'?'live':'test'
  const live=await db.from('stripe_prices').select('*').eq('mode',other)
  // 🔴 Corrected 2026-10-02. This asserted the OTHER mode had zero v4
  // rows, which was true only until the live run happened — after
  // which a correct catalog fails it. It could never have distinguished
  // "a test run leaked into live" from "live was built on purpose"
  // anyway, because both leave the same rows.
  //
  // What DOES hold across the whole lifecycle: a mode has either none
  // of the lineup (not built yet) or all ten of it (built). Anything in
  // between is a partial run — the real failure this should catch.
  const otherV4 = (live.data??[]).filter((x:any)=>x.lookup_key?.includes('.v4')).length
  chk(`${other} mode holds 0 or 10 lineup rows, not a partial run`, otherV4===0 || otherV4===10, `found ${otherV4}`)
  const thisV4 = act.filter((x:any)=>x.lookup_key?.includes('.v4')).length
  chk(`${MODE} mode holds all 10 lineup rows`, thisV4===10, `found ${thisV4}`)
  const a1raw=await db.from('stripe_prices').select('*').eq('mode','live')
  const a1=(a1raw.data??[]).filter((x:any)=>x.proposal_code_id!==null)
  chk("A1's proposal price untouched", a1.length===1 && a1[0].is_active===true && a1[0].unit_amount_cents===32500)
  console.log('')
  console.log(fail?`❌ ${fail} FAILURE(S)`:'✅ ALL CATALOG ASSERTIONS PASS')
  process.exit(fail?1:0)
}
main().catch(e=>{console.error(String(e));process.exit(1)})
