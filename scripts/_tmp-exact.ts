import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
const env = fs.readFileSync('.env.local','utf8')
const g=(k:string)=>(env.match(new RegExp('^'+k+'=(.*)$','m'))?.[1]||'').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} })
async function all(t:string,c:string){const o:any[]=[];let f=0;for(;;){const{data,error}=await db.from(t).select(c).range(f,f+999);if(error)throw new Error(error.message);o.push(...(data??[]));if((data??[]).length<1000)break;f+=1000}return o}
const norm=(s:any)=>(s??'').toString().trim().toLowerCase()
const main=async()=>{
  const vehs=await all('vehicles','id, plate, property, unit, resident_email, status, is_active')
  const res =await all('residents','email, property, unit, is_active')
  const live=vehs.filter(v=>v.is_active===true&&v.status==='active')
  const activeRes=res.filter(r=>r.is_active===true)

  // EXACT tuple (what the cosmetic RPC does): (v.property, v.unit) IN (SELECT r.property, r.unit)
  const exactSet=new Set(activeRes.map(r=>`${r.property}||${r.unit}`))
  // NORMALIZED tuple
  const normSet=new Set(activeRes.map(r=>`${norm(r.property)}||${norm(r.unit)}`))
  // email index (exact-lower vs lower+trim)
  const emailLower=new Set(activeRes.map(r=>(r.email??'').toLowerCase()))
  const emailLowerTrim=new Set(activeRes.map(r=>norm(r.email)))

  let exactTuple=0, normTuple=0, emailL=0, emailLT=0
  for(const v of live){
    if(exactSet.has(`${v.property}||${v.unit}`)) exactTuple++
    if(normSet.has(`${norm(v.property)}||${norm(v.unit)}`)) normTuple++
    if(emailLower.has((v.resident_email??'').toLowerCase())) emailL++
    if(emailLowerTrim.has(norm(v.resident_email))) emailLT++
  }
  console.log(`live active vehicles: ${live.length}`)
  console.log(`  (property,unit) EXACT  match an active resident row : ${exactTuple}`)
  console.log(`  (property,unit) lower+trim match                    : ${normTuple}`)
  console.log(`  resident_email lower() match                        : ${emailL}`)
  console.log(`  resident_email lower(trim()) match                  : ${emailLT}`)

  // Show what exact-tuple misses
  const misses=live.filter(v=>!exactSet.has(`${v.property}||${v.unit}`) && normSet.has(`${norm(v.property)}||${norm(v.unit)}`))
  console.log(`\nrows EXACT would wrongly reject but lower+trim accepts: ${misses.length}`)
  for(const m of misses.slice(0,8)) console.log(`   veh ${m.id} ${m.plate}: property=${JSON.stringify(m.property)} unit=${JSON.stringify(m.unit)}`)
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(2)})
