// ════════════════════════════════════════════════════════════════════
// self-serve-door — should the "start on your own" line render?
// ════════════════════════════════════════════════════════════════════
//
// The decision lives here, as a pure function, so both states are
// provable without a browser. The landing page just calls it.
//
// 🔴 FAILS CLOSED. Anything that is not an explicit `{ open: true }`
// hides the line: a non-200, a thrown fetch, a malformed body, an empty
// object. Showing a self-serve link when we could not confirm signup is
// open would send a prospect into a "coming soon" dead end at the exact
// moment they decided to buy — the worst place to spend their goodwill.
//
// The same absence rule as everywhere else in this codebase: "we could
// not check" is not "yes", and it must not be allowed to read as yes.

export function shouldShowSelfServe(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  return (body as { open?: unknown }).open === true
}

// The probe the page runs. Never throws — a failure is `false`, which
// the rule above already defines as "hide".
export async function probeSelfServeOpen(
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/signup/dormancy')
    if (!res.ok) return false
    return shouldShowSelfServe(await res.json())
  } catch {
    return false
  }
}
