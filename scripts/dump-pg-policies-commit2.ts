// Commit 2 preflight — dump live pg_policies for every table in scope
// so Dashboard-created policies don't get missed like driver_read_spaces /
// resident_read_own_spaces did in Commit 1.
//
// PostgREST doesn't expose pg_policies via .from(). Best we can do from
// JS is check what tables the tool CAN query and print them; the actual
// pg_policies enumeration needs a one-liner in the SQL Editor.
//
// Run: npx tsx --env-file=.env.local scripts/dump-pg-policies-commit2.ts

const TABLES = [
  'vehicles',
  'violations',
  'visitor_passes',
  'dispute_requests',
  'guest_authorizations',
  'space_residents',
  'space_assignment_history',
  'space_requests',
]

console.log('Paste this into the Supabase SQL Editor:\n')
console.log(`SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (${TABLES.map(t => `'${t}'`).join(', ')})
ORDER BY tablename, cmd, policyname;`)
console.log('\nExpected: full policy set for each table. Look for:')
console.log('  • un-hoisted get_my_role() / get_my_company() / get_my_properties()')
console.log('  • un-hoisted auth.jwt() calls')
console.log('  • EXISTS(user_roles) patterns (worst per-row cost)')
console.log('  • Dashboard-created policies (any policyname that\'s not in migrations grep)')
