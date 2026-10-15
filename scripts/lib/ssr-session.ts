// ════════════════════════════════════════════════════════════════════
// ssr-session — give a gate the cookie header a real browser would send
// ════════════════════════════════════════════════════════════════════
// Every /api/bulk-onboarding route authorizes through
// createSupabaseServerClient(), which reads the session from COOKIES.
// So an HTTP gate cannot use a bearer token: it has to present the
// cookie @supabase/ssr would have written.
//
// 🔴 THE LIBRARY WRITES THE COOKIE, NOT THIS FILE. The name is
// sb-<project-ref>-auth-token and the value is 'base64-' + the encoded
// session, and it is CHUNKED into .0/.1/... past ~3180 bytes. Hardcoding
// any of that would make the gate pass or fail on a @supabase/ssr
// version bump rather than on the thing under test. Instead a server
// client is created with an in-memory jar, setSession() is called, and
// whatever it writes is what gets sent — so chunking, renaming and
// format changes are handled by the same code the app uses.
//
// 🔴 AND THE SESSION COMES FROM A MAGIC LINK, NOT A PASSWORD.
// signInWithPassword is captcha-gated on this project and answers
// "captcha protection: request disallowed" before it looks at
// credentials. generateLink + verifyOtp is the same path the bulk
// rehearsal uses.

import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'

/**
 * Sign `email` in as a real user and return the Cookie header value.
 * `db` must be a service-role client (it mints the magic link).
 */
export async function cookieHeaderFor(
  db: SupabaseClient, url: string, anon: string, email: string,
): Promise<{ cookie: string; accessToken: string }> {
  const link = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error || !link.data?.properties?.hashed_token) {
    throw new Error(`generateLink(${email}): ${link.error?.message ?? 'no token'}`)
  }
  const cl = createClient(url, anon, { auth: { persistSession: false } })
  const v = await cl.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token, type: 'magiclink',
  })
  if (v.error || !v.data.session) throw new Error(`verifyOtp(${email}): ${v.error?.message ?? 'no session'}`)

  const jar = new Map<string, string>()
  const sc = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: list => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  })
  const ss = await sc.auth.setSession({
    access_token: v.data.session.access_token,
    refresh_token: v.data.session.refresh_token,
  })
  if (ss.error) throw new Error(`setSession: ${ss.error.message}`)
  if (jar.size === 0) throw new Error('setSession wrote no cookies — the adapter contract changed')

  return {
    cookie: [...jar].map(([n, v2]) => `${n}=${v2}`).join('; '),
    accessToken: v.data.session.access_token,
  }
}
