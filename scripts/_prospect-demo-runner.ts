// Phase-1 runner. Throwaway: deleted after use.
import { createProspectDemo, endProspectDemo } from '../app/lib/prospect-demo'
import fs from 'fs'
const env = fs.readFileSync('.env.local', 'utf8')
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  process.env[k] = (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
}
const BY = 'alvaradolegacyconsulting@gmail.com'
const main = async () => {
  const mode = process.argv[2]
  if (mode === 'create') {
    const r = await createProspectDemo({
      prospectName: process.argv[3],
      propertyName: process.argv[4],
      loginSlug: process.argv[5],
      expiresInDays: Number(process.argv[6] ?? 14),
      createdBy: BY,
    })
    console.log(JSON.stringify({ ...r, password: '(withheld from stdout)' }, null, 1))
    fs.writeFileSync(process.argv[7], `${r.loginEmail}\n${r.password}\n`, { mode: 0o600 })
    console.log('password written to', process.argv[7])
  } else if (mode === 'end') {
    console.log(JSON.stringify(await endProspectDemo(Number(process.argv[3]), BY), null, 1))
  } else if (mode === 'refuse') {
    try { await endProspectDemo(Number(process.argv[3]), BY); console.log('🔴 NO REFUSAL — it deleted something') }
    catch (e) { console.log('✅ REFUSED:', (e as Error).message) }
  }
}
main().catch(e => { console.error('FATAL', String(e)); process.exit(1) })
