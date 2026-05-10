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

export async function requireAdmin(): Promise<AuthResult> {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user?.email) return { ok: false, status: 401, error: 'unauthenticated' }
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) return { ok: false, status: 403, error: 'no role assigned' }
  if (roleRow.role !== 'admin') return { ok: false, status: 403, error: 'admin required' }
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
