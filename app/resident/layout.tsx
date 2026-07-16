// ════════════════════════════════════════════════════════════════════
// /resident/layout.tsx — server-side consent-gate for the Resident portal
// P1 CONSENT HARD-GATE Commit 3b · 2026-07-16
//
// Propagated verbatim from /company_admin/layout.tsx (613b045).
// hasCurrentConsents returns 2 docs for resident (tos + privacy). Loop
// prevention is structural: /consent is a sibling route.
// ════════════════════════════════════════════════════════════════════

import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '../lib/server-auth'
import { hasCurrentConsents, type Role } from '../lib/consent-gate'

export default async function ResidentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createSupabaseServerClient()

  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user?.email) {
    redirect('/login')
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role')
    .ilike('email', user.email)
    .maybeSingle()
  if (roleErr || !roleRow?.role) {
    redirect('/login')
  }
  const role = roleRow.role as Role

  const status = await hasCurrentConsents(supabase, user.id, role)
  if (!status.consented) {
    redirect(`/consent?missing=${status.missing.join(',')}`)
  }

  return <>{children}</>
}
