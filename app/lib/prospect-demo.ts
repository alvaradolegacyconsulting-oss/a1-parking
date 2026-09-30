import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'
import crypto from 'crypto'

// ════════════════════════════════════════════════════════════════════
// prospect-demo — one clean demo property per prospect
// ════════════════════════════════════════════════════════════════════
//
// Jose expects to do this often, so the work lives in a function that a
// super-admin button (Phase 2) can wrap unchanged. Phase 1 calls it from
// a script; nothing here is throwaway.
//
// 🔴 EVERYTHING IS SCOPED TO THE DEMO COMPANY, BY LOOKUP, NOT BY NAME.
// The company is resolved by company_env = 'demo'. A naming convention
// would let a renamed or duplicated company slip through; the column is
// the thing that actually means "this is disposable".
//
// 🔴 THE DELETE PATH RE-CHECKS THAT COLUMN ITSELF. endProspectDemo does
// not trust the caller, the property name, or the id's provenance: it
// loads the property, loads its company, and refuses unless
// company_env = 'demo'. That check is the only thing standing between a
// mistyped id and a real tenant's data, so it is not a convention and
// not a comment — it is a hard refusal that returns an error.

export type CreateArgs = {
  prospectName: string
  propertyName?: string
  // Override for the login's local part. Defaults to the prospect's
  // slug; Jose's Sept 30 call is to key it on the PROPERTY instead, so
  // the address survives the prospect's name being mistyped or the demo
  // being handed to a colleague.
  loginSlug?: string
  expiresInDays?: number
  createdBy: string
}

export type CreateResult = {
  propertyId: number
  propertyName: string
  loginEmail: string
  password: string        // returned ONCE; never persisted readable
  expiresAt: string
  counts: Record<string, number>
}

const DEMO_ENV = 'demo'

// Obviously fictional. No name here should be mistakable for a real
// resident if a screenshot of a demo ends up in a deck.
const PEOPLE = [
  { name: 'Rosalind Vega',   unit: '101' },
  { name: 'Desmond Achebe',  unit: '104' },
  { name: 'Ingrid Halvorsen',unit: '208' },
  { name: 'Tobias Fennimore',unit: '212' },
  { name: 'Marisol Quintana',unit: '305' },
]
const CARS = [
  { make: 'Toyota',    model: 'Camry',    color: 'Silver', year: 2019 },
  { make: 'Honda',     model: 'CR-V',     color: 'Blue',   year: 2021 },
  { make: 'Ford',      model: 'F-150',    color: 'White',  year: 2018 },
  { make: 'Subaru',    model: 'Outback',  color: 'Green',  year: 2022 },
  { make: 'Chevrolet', model: 'Malibu',   color: 'Black',  year: 2020 },
  { make: 'Nissan',    model: 'Rogue',    color: 'Red',    year: 2017 },
]

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

// Plates that cannot collide with a real Texas plate pattern in the
// live tenants: a DEM prefix no issuing authority uses.
//
// 🔴 SEEDED FROM THE SLUG, not a fixed series. The first version
// returned DEMO101..DEMO106 for every demo, so two prospect demos
// shared a plate set. RLS still scoped each manager correctly — but a
// plate is the thing an operator searches by, and two demos answering
// to the same plate is a confusing thing to put in front of a
// prospect. It also broke the isolation test, which picked "another
// property's plate" and got the same string back.
function plateSeed(slug: string): number {
  let h = 0
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 900
  return h
}
function demoPlate(seed: number, i: number): string {
  return `DEM${String(100 + ((seed + i * 7) % 900)).padStart(3, '0')}`
}

// 🔴 Generated, never the shared test password. Handing an outsider the
// shared one would expose every test account in the project.
function generatePassword(): string {
  // Ambiguity-free alphabet: no O/0, no I/l/1. This gets read aloud or
  // typed from a message, and a demo that fails on a misread character
  // wastes the meeting it was created for.
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(20)
  return Array.from(bytes, b => A[b % A.length]).join('')
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString()

async function demoCompany() {
  const db = createSupabaseServiceClient()
  const { data, error } = await db
    .from('companies')
    .select('id, name, company_env, stripe_subscription_id')
    .eq('company_env', DEMO_ENV)
  if (error) throw new Error(`could not resolve the demo company: ${error.message}`)
  if (!data || data.length === 0) throw new Error(`no company has company_env='${DEMO_ENV}'`)
  if (data.length > 1) {
    // Ambiguity is a refusal, not a guess. Picking one would make every
    // later scope check meaningless.
    throw new Error(`${data.length} companies have company_env='${DEMO_ENV}' — refusing to guess which is the demo tenant`)
  }
  return data[0]
}

export async function createProspectDemo(args: CreateArgs): Promise<CreateResult> {
  // 🔴 NOT TRANSACTIONAL. These are separate PostgREST calls, so a
  // failure part-way leaves a half-built property behind — which is
  // exactly what happened the first time this ran (vehicle_removals has
  // a NOT NULL authorized_by_email, and by then the property, spaces,
  // residents, vehicles and passes had all landed).
  //
  // A half-built demo is worse than none: it looks like a real property
  // in the Demo Company and nobody knows it is debris. So the whole
  // body runs inside a try that tears its own work down on any failure,
  // through the same delete path a deliberate end uses.
  try {
    return await createProspectDemoInner(args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const cleaned = await bestEffortCleanup(args)
    throw new Error(`${msg}${cleaned ? ` — partial demo rolled back (${cleaned})` : ''}`)
  }
}

// Tears down whatever the failed attempt managed to create. Best
// effort: it reports what it removed and never masks the original
// error, because the original error is the thing worth reading.
async function bestEffortCleanup(args: CreateArgs): Promise<string> {
  try {
    const db = createSupabaseServiceClient()
    const co = await demoCompany()
    const propertyName = (args.propertyName?.trim() || `${args.prospectName.trim()} Demo`)
    const p = await db.from('properties').select('id').eq('name', propertyName).eq('company', co.name).maybeSingle()
    if (!p.data) return ''
    const removed = await endProspectDemo(p.data.id as number, args.createdBy)
    return Object.entries(removed).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ')
  } catch {
    return 'cleanup ALSO failed — inspect the Demo Company by hand'
  }
}

async function createProspectDemoInner(args: CreateArgs): Promise<CreateResult> {
  const db = createSupabaseServiceClient()
  const co = await demoCompany()

  // 🔴 Billing guard. The demo company has no subscription today, but
  // this must not silently start charging if that ever changes —
  // adding properties to a subscribed company drives a quantity sync.
  if (co.stripe_subscription_id) {
    throw new Error(`the demo company now has a Stripe subscription (${co.stripe_subscription_id}); adding properties would drive a quantity sync. Refusing.`)
  }

  const prospect = args.prospectName.trim()
  if (!prospect) throw new Error('prospectName is required')
  // Guard against an unfilled template reaching production data.
  if (/^\[.*\]$/.test(prospect)) throw new Error(`prospectName looks like an unfilled placeholder: ${prospect}`)

  const propertyName = (args.propertyName?.trim() || `${prospect} Demo`)
  if (/^\[.*\]$/.test(propertyName)) throw new Error(`propertyName looks like an unfilled placeholder: ${propertyName}`)

  const days = args.expiresInDays ?? 14
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString()
  const slug = slugify(args.loginSlug?.trim() || prospect)
  if (!slug) throw new Error('could not derive a login slug')
  const loginEmail = `demo-pm-${slug}@test.shieldmylot.com`
  const counts: Record<string, number> = {}
  const pseed = plateSeed(slug)

  // ── property ──────────────────────────────────────────────────────
  const prop = await db.from('properties').insert([{
    name: propertyName, company: co.name, is_active: true,
    visitor_pass_limit: 10, visitor_capacity: 25,
  }]).select('id, name').single()
  if (prop.error) throw new Error(`property insert failed: ${prop.error.message}`)
  const propertyId = prop.data.id as number
  counts.properties = 1

  // ── spaces (12 regular + 3 carport) ───────────────────────────────
  // Inserted directly rather than through generate_spaces_from_pool:
  // that RPC derives the actor from auth.jwt(), and a service-role
  // caller has no JWT, so it would raise. The rows are the same shape.
  const spaceRows = [
    ...Array.from({ length: 12 }, (_, i) => ({ label: `R-${i + 1}`, type: 'regular' })),
    ...Array.from({ length: 3 }, (_, i) => ({ label: `CP-${i + 1}`, type: 'carport' })),
  ].map(s => ({
    company: co.name, property: propertyName, label: s.label, type: s.type,
    status: 'available', is_active: true, created_by_email: args.createdBy,
    created_at: daysAgo(9),
  }))
  const sp = await db.from('spaces').insert(spaceRows).select('id, label')
  if (sp.error) throw new Error(`spaces insert failed: ${sp.error.message}`)
  counts.spaces = sp.data.length

  // ── residents: 4 active + 1 pending self-registration ─────────────
  const residentRows = PEOPLE.map((p, i) => ({
    name: p.name,
    email: `demo-${slug}-r${i + 1}@test.shieldmylot.com`,
    phone: null, unit: p.unit, property: propertyName, company: co.name,
    is_active: i < 4, status: i < 4 ? 'active' : 'pending',
    created_at: daysAgo(10 - i),
  }))
  const res = await db.from('residents').insert(residentRows).select('id, email, unit, status')
  if (res.error) throw new Error(`residents insert failed: ${res.error.message}`)
  counts.residents = res.data.length
  counts.residents_pending = res.data.filter(r => r.status === 'pending').length

  // ── vehicles: 5 active + 1 pending approval ───────────────────────
  const vehicleRows = res.data.map((r, i) => {
    const c = CARS[i % CARS.length]
    const pending = i === 3          // one ACTIVE resident with a pending car
    const residentPending = r.status === 'pending'
    return {
      plate: demoPlate(pseed, i + 1), state: 'TX', ...c,
      unit: r.unit, property: propertyName, company: co.name,
      resident_email: r.email,
      is_active: !(pending || residentPending),
      status: (pending || residentPending) ? 'pending' : 'active',
      created_at: daysAgo(9 - i),
    }
  })
  // a second car for one household, so the list isn't one-per-unit
  vehicleRows.push({
    plate: demoPlate(pseed, 9), state: 'TX', ...CARS[5],
    unit: res.data[0].unit, property: propertyName, company: co.name,
    resident_email: res.data[0].email, is_active: true, status: 'active',
    created_at: daysAgo(4),
  })
  const veh = await db.from('vehicles').insert(vehicleRows).select('id, plate, status')
  if (veh.error) throw new Error(`vehicles insert failed: ${veh.error.message}`)
  counts.vehicles = veh.data.length
  counts.vehicles_pending = veh.data.filter(v => v.status === 'pending').length

  // ── two reserved spaces assigned to active residents ──────────────
  const assign = sp.data.slice(0, 2)
  for (let i = 0; i < assign.length; i++) {
    const up = await db.from('spaces').update({
      status: 'assigned',
      assigned_to_resident_email: res.data[i].email,
      assigned_at: daysAgo(6 - i),
      assigned_by_email: args.createdBy,
    }).eq('id', assign[i].id).select('id')
    if (up.error) throw new Error(`space assign failed: ${up.error.message}`)
  }
  counts.spaces_assigned = assign.length

  // ── visitor passes: 3, at least one LIVE right now ────────────────
  // Liveness is is_active AND expires_at > now() — BOTH. A pass with
  // is_active=true and a past expiry is not live, and a demo that shows
  // "3 active passes" while enforcement sees none teaches the wrong
  // thing about the product.
  const now = Date.now()
  const passRows = [
    { plate: `DMV${String(100 + (pseed % 900)).padStart(3, '0')}`, visitor_name: 'Guest of 101', visiting_unit: res.data[0].unit, duration_hours: 24,
      created_at: new Date(now - 2 * 3600_000).toISOString(), expires_at: new Date(now + 22 * 3600_000).toISOString(), is_active: true },
    { plate: `DMV${String(100 + ((pseed + 11) % 900)).padStart(3, '0')}`, visitor_name: 'Guest of 208', visiting_unit: res.data[2].unit, duration_hours: 8,
      created_at: new Date(now - 30 * 3600_000).toISOString(), expires_at: new Date(now - 22 * 3600_000).toISOString(), is_active: true },
    { plate: `DMV${String(100 + ((pseed + 23) % 900)).padStart(3, '0')}`, visitor_name: 'Guest of 104', visiting_unit: res.data[1].unit, duration_hours: 12,
      created_at: new Date(now - 4 * 86400_000).toISOString(), expires_at: new Date(now - 3.5 * 86400_000).toISOString(), is_active: true },
  ].map(p => ({ ...p, property: propertyName, vehicle_desc: 'Sedan' }))
  const vp = await db.from('visitor_passes').insert(passRows).select('id, expires_at, is_active')
  if (vp.error) throw new Error(`visitor_passes insert failed: ${vp.error.message}`)
  counts.visitor_passes = vp.data.length
  counts.visitor_passes_live = vp.data.filter(p => p.is_active && new Date(p.expires_at).getTime() > now).length

  // ── one tow-log entry, so the tow log is not empty ────────────────
  const rem = await db.from('vehicle_removals').insert([{
    company: co.name, property: propertyName, property_id: propertyId,
    removal_type: 'tow', plate: `DMX${String(100 + ((pseed + 41) % 900)).padStart(3, '0')}`, plate_state: 'TX',
    make: 'Dodge', model: 'Charger', color: 'Grey',
    reason_code: 'unauthorized', reason_notes: 'Parked in a reserved space without a permit.',
    towed_at: daysAgo(3), recorded_by_email: args.createdBy,
    // NOT NULL on this table — a removal has to name who authorised it,
    // which is the point of the log.
    authorized_by_email: loginEmail, authorized_by_name: `${prospect} (demo)`,
    operator_name: 'Demo Towing Co.', operator_phone: '555-0100',
    created_at: daysAgo(3),
  }]).select('id')
  if (rem.error) throw new Error(`vehicle_removals insert failed: ${rem.error.message}`)
  counts.vehicle_removals = rem.data.length

  // ── the PM login ──────────────────────────────────────────────────
  const password = generatePassword()
  const { data: created, error: authErr } = await db.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,            // 🔴 backend-confirmed: no mail leaves
    user_metadata: { prospect_demo: true, property: propertyName, expires_at: expiresAt },
  })
  if (authErr) throw new Error(`auth createUser failed: ${authErr.message}`)

  const role = await db.from('user_roles').insert([{
    email: loginEmail, role: 'manager', company: co.name,
    property: [propertyName],       // 🔴 THIS property only
    is_active: true, name: `${prospect} (demo)`,
  }]).select('email')
  if (role.error) {
    // Do not leave an auth user with no role — that is the orphan shape
    // the add-resident rollback exists to clean up.
    if (created.user?.id) await db.auth.admin.deleteUser(created.user.id)
    throw new Error(`user_roles insert failed (auth user rolled back): ${role.error.message}`)
  }
  counts.logins = 1

  await db.from('audit_logs').insert([{
    user_email: args.createdBy,
    action: 'PROSPECT_DEMO_CREATED',
    table_name: 'properties',
    record_id: String(propertyId),
    new_values: {
      prospect, property: propertyName, property_id: propertyId,
      login_email: loginEmail, created_by: args.createdBy,
      expires_at: expiresAt, company: co.name, counts,
      note: 'Prospect demo. Password generated and delivered out-of-band; never stored readable.',
    },
  }])

  return { propertyId, propertyName, loginEmail, password, expiresAt, counts }
}

// ════════════════════════════════════════════════════════════════════
// endProspectDemo — delete a prospect demo, and ONLY a demo
// ════════════════════════════════════════════════════════════════════
export async function endProspectDemo(propertyId: number, endedBy: string): Promise<Record<string, number>> {
  const db = createSupabaseServiceClient()

  const prop = await db.from('properties').select('id, name, company').eq('id', propertyId).maybeSingle()
  if (prop.error) throw new Error(`could not read property ${propertyId}: ${prop.error.message}`)
  if (!prop.data) throw new Error(`no property with id ${propertyId}`)

  // 🔴 THE REFUSAL. Resolve the property's OWN company and check the
  // column — not the property name, not a prefix, not the caller's word
  // for it. company_env='demo' is the only thing that makes a property
  // disposable, so it is the only thing consulted.
  const co = await db.from('companies').select('id, name, company_env').ilike('name', prop.data.company).maybeSingle()
  if (co.error) throw new Error(`could not read the property's company: ${co.error.message}`)
  if (!co.data) throw new Error(`property ${propertyId} names a company that does not exist: ${prop.data.company}`)
  if (co.data.company_env !== DEMO_ENV) {
    throw new Error(
      `REFUSED: property ${propertyId} ("${prop.data.name}") belongs to "${co.data.name}", ` +
      `whose company_env is ${JSON.stringify(co.data.company_env)} — not '${DEMO_ENV}'. ` +
      `endProspectDemo only ever deletes demo-tenant data.`,
    )
  }

  const name = prop.data.name as string
  const removed: Record<string, number> = {}
  const del = async (table: string, col = 'property') => {
    const r = await db.from(table).delete().eq(col, name).select('id')
    if (r.error) throw new Error(`${table} delete failed: ${r.error.message}`)
    removed[table] = r.data.length
  }
  // Children first, then the property.
  await del('visitor_passes')
  await del('vehicle_removals')
  await del('violations')
  await del('vehicles')
  await del('spaces')
  await del('residents')

  // The scoped login(s): any user_roles row whose scope is exactly this
  // one property. A shared account scoped to several properties is NOT
  // a prospect login and must survive.
  const roles = await db.from('user_roles').select('email, property').eq('company', co.data.name)
  const mine = (roles.data ?? []).filter((r: { property: unknown }) =>
    Array.isArray(r.property) && r.property.length === 1 && r.property[0] === name)
  removed.logins = 0
  for (const r of mine as { email: string }[]) {
    const { data: au } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const u = au.users.find(x => String(x.email).toLowerCase() === r.email.toLowerCase())
    if (u) await db.auth.admin.deleteUser(u.id)
    const d = await db.from('user_roles').delete().ilike('email', r.email).select('email')
    if (d.error) throw new Error(`user_roles delete failed: ${d.error.message}`)
    removed.logins += d.data.length
  }

  const dp = await db.from('properties').delete().eq('id', propertyId).select('id')
  if (dp.error) throw new Error(`property delete failed: ${dp.error.message}`)
  removed.properties = dp.data.length

  await db.from('audit_logs').insert([{
    user_email: endedBy,
    action: 'PROSPECT_DEMO_ENDED',
    table_name: 'properties',
    record_id: String(propertyId),
    new_values: { property: name, property_id: propertyId, company: co.data.name, removed, ended_by: endedBy },
  }])
  return removed
}
