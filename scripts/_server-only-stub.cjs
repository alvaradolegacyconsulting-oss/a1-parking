// Throwaway preload. `server-only` throws outside a Server Component;
// app/lib/prospect-demo.ts imports it deliberately (it holds
// service-role logic and must never reach a client bundle). Stubbing it
// here lets a one-off node runner import the real module WITHOUT
// weakening the guard in the file itself.
const Module = require('module')
const path = require.resolve('server-only')
const m = new Module(path)
m.exports = {}
m.loaded = true
require.cache[path] = m

// supabase-admin reads env at import time, and imports hoist above any
// assignment in the runner — so the env has to be in place here.
const fs = require('fs')
const env = fs.readFileSync('.env.local', 'utf8')
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  const v = (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]
  if (v) process.env[k] = v.trim()
}
