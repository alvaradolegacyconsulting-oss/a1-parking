import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // setAll fails when called from a Server Component — fine in API routes.
          }
        },
      },
    }
  )
}

export type AuthResult =
  | { ok: true; email: string; role: string }
  | { ok: false; status: number; error: string }

/**
 * An ACTIVE super-admin, or a refusal.
 *
 * 🔴 is_active ADDED 2026-10-16. Until then this read `select('role')`
 * and never looked at it, so a deactivated admin still resolved as an
 * admin — the same gap step 3 closed in the SQL identity helpers
 * (get_my_role and friends), left open in the TypeScript one.
 *
 * What that reached, by sweep:
 *   /api/admin/stripe-mode                    GET  reads the Stripe mode
 *   /api/proposal-codes/[id]/issue            POST issues a code (writes)
 *   /api/proposal-codes/[id]/preview-pdf      POST a 501 stub today
 * So a revoked operator could still read the Stripe mode and issue a
 * proposal code. Deactivation is supposed to mean deactivated; a role
 * check that ignores the flag makes the flag advisory.
 *
 * 🔴 `!== true`, not `=== false`: a NULL is_active must fail closed.
 * There are no NULL rows today, and "today" is not a guard.
 *
 * The deactivated case gets its own error string. These are operator
 * routes and the caller has already proved they hold the session, so
 * distinguishing "you are not an admin" from "your account is off"
 * discloses nothing and is the difference between an operator
 * diagnosing it in a second and filing a ticket.
 */
export async function requireAdmin(): Promise<AuthResult> {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user?.email) return { ok: false, status: 401, error: 'unauthenticated' }
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role, is_active')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) return { ok: false, status: 403, error: 'no role assigned' }
  if (roleRow.role !== 'admin') return { ok: false, status: 403, error: 'admin required' }
  if (roleRow.is_active !== true) return { ok: false, status: 403, error: 'account deactivated' }
  return { ok: true, email: user.email, role: 'admin' }
}

export type AnyAuthResult =
  | { ok: true; email: string; role: string; companyName: string | null }
  | { ok: false; status: number; error: string }

export async function requireAuthenticated(): Promise<AnyAuthResult> {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user?.email) return { ok: false, status: 401, error: 'unauthenticated' }
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  return {
    ok: true,
    email: user.email,
    role: roleRow?.role || '',
    companyName: roleRow?.company || null,
  }
}
