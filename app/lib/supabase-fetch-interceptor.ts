// ══════════════════════════════════════════════════════════════════════
// supabase-fetch-interceptor — central 401/429 handling for the
// browser Supabase client
// ══════════════════════════════════════════════════════════════════════
//
// Motivation (Mateo diagnostic 2026-08-03):
//
// Amanda's console showed: 429 on /auth/v1/token → token refresh
// failed → subsequent /rest/v1 calls returned 401 → 15+ 401s
// piled up → each error surfaced as "Couldn't approve. Try again"
// which told the user to retry (which fires another refresh which
// fails again which piles up more 401s). Amanda spent a weekend
// making the problem worse by following our instructions.
//
// Fix has two parts:
//   1. Detect 401 from data endpoints centrally (this file's fetch
//      wrapper) and signal the app to route to /login with honest
//      copy.
//   2. Set a session-dead flag on first detection so subsequent
//      calls short-circuit locally — no further network requests,
//      no 429 amplification.
//
// ── PostgREST semantics that make this simpler than it looks ──
//
// | failure                    | response                          |
// |----------------------------|-----------------------------------|
// | RLS filters a SELECT       | 200, fewer/zero rows, error: null |
// | RLS blocks INSERT/UPDATE   | 403, code 42501                   |
// | Missing table GRANT        | 403                               |
// | Invalid/expired/missing JWT| 401                               |
//
// So a 401 from /rest/v1/* or /rpc/* essentially always means the
// token is dead. We don't need to guard against "some 401s are
// RLS-authorization" because that's not how PostgREST behaves.
// This lets us route synchronously, no session-inspection recursion
// hazard in the interceptor.
//
// ── The /auth/v1/* exclusion ──
//
// 401 on /auth/v1/* is a failed sign-in attempt (wrong password,
// etc). The login form owns those. Routing "your session expired"
// on the sign-in page would be nonsense. Skip /auth/v1/* entirely.
//
// ── The session-dead flag semantics ──
//
// - Module-level (not React state) because the interceptor runs
//   outside React's lifecycle. React batching would make a state-
//   read-after-set race (same class as the 7fdbcf9 useRef fix and
//   the warnAcknowledged bug from Finding 3 mid-implementation).
// - Must reset on SIGNED_IN or TOKEN_REFRESHED — otherwise a signed-
//   in user is stuck against the flag until they hard-reload, and
//   the symptom is "the app silently does nothing" (the exact
//   failure mode this weekend has been eliminating).
// - Every short-circuited call logs quietly. If this ever fires
//   when it shouldn't, console is where we'll find out.

// Module-level mutable ref-shaped object. Direct mutation from the
// interceptor + banner component is intentional — no React state
// involved.
const sessionState = {
  dead: false,
}

/** For consumers (auth-state listener) to reset on successful re-auth. */
export function markSessionAlive(): void {
  if (sessionState.dead) {
    console.info('[supabase-fetch-interceptor] session revived — clearing session-dead flag')
    sessionState.dead = false
  }
}

/** Read-only inspection. Used by the banner component's short-circuit render. */
export function isSessionDead(): boolean {
  return sessionState.dead
}

/**
 * Custom fetch passed to `createBrowserClient({ global: { fetch } })`.
 *
 * Never rejects on its own — always returns a Response (real or
 * synthetic) so the Supabase client sees a well-formed reply and
 * callers still get their `{ data, error }` shape.
 */
export async function interceptedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url

  // ── Short-circuit: session already dead ─────────────────────────
  // Any subsequent Supabase call after the first 401 detection
  // returns a synthetic 401 without touching the network. Prevents
  // the 429-amplification pattern from Amanda's incident. Applies
  // ONLY to /rest/v1/* and /rpc/* — /auth/v1/* still needs the
  // network (sign-in flow needs to try again).
  if (sessionState.dead && (url.includes('/rest/v1/') || url.includes('/rpc/'))) {
    console.info('[supabase-fetch-interceptor] short-circuit (session dead)', { url })
    return synthetic401Response(url)
  }

  const response = await fetch(input, init)

  // ── 401 detection on data endpoints ─────────────────────────────
  // /auth/v1/* excluded — a wrong-password 401 there is normal;
  // routing "session expired" on the login page would be nonsense.
  if (
    response.status === 401
    && (url.includes('/rest/v1/') || url.includes('/rpc/'))
    && !sessionState.dead  // idempotent — dispatch once
  ) {
    sessionState.dead = true
    console.error('[supabase-fetch-interceptor] 401 on data endpoint — session-dead flag set + auth-expired dispatched', { url })
    dispatchCustomEvent('supabase-auth-expired')
  }

  // ── 429 detection on refresh endpoint ───────────────────────────
  // Distinct signal, distinct copy, distinct handling (no redirect —
  // redirecting to /login triggers another refresh which triggers
  // another 429).
  if (response.status === 429 && url.includes('/auth/v1/token')) {
    const retryAfter = response.headers.get('retry-after')
    console.error('[supabase-fetch-interceptor] 429 on token refresh — rate-limited event dispatched', { url, retryAfter })
    dispatchCustomEvent('supabase-refresh-rate-limited', { retryAfter })
  }

  return response
}

function synthetic401Response(url: string): Response {
  return new Response(
    JSON.stringify({
      code: 'session_dead_local',
      message: 'Session expired — request short-circuited locally to prevent refresh amplification. See supabase-fetch-interceptor.ts.',
    }),
    {
      status: 401,
      statusText: 'Unauthorized (session_dead_local)',
      headers: { 'content-type': 'application/json', 'x-session-dead-local': '1', 'x-original-url': url },
    },
  )
}

function dispatchCustomEvent(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  } catch (e) {
    console.error('[supabase-fetch-interceptor] dispatchEvent failed', { name, error: e })
  }
}
