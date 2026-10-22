// ════════════════════════════════════════════════════════════════════
// fetchWithTimeout — a submit that cannot hang forever
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY. A resident at Green Acres #9 tapped Submit on 2026-10-17 and
// the page "froze". fetch() has no default timeout: on a dropped mobile
// connection the promise simply never settles, the submitting flag
// stays true, the button stays dead, and the resident is left looking
// at a screen that will never change. Nothing was written, so there was
// nothing to diagnose either.
//
// A timeout turns that into a sentence they can act on. It does NOT
// mean the request failed to reach the server — it means we stopped
// waiting, which is why the copy says "we couldn't reach the server"
// and asks them to try again rather than claiming nothing happened.

/** Thrown when the wait elapsed. Distinguishable from a transport error. */
export class FetchTimeoutError extends Error {
  readonly isTimeout = true
  constructor(public readonly ms: number) {
    super(`Request timed out after ${ms}ms`)
    this.name = 'FetchTimeoutError'
  }
}

export const isFetchTimeout = (e: unknown): boolean =>
  e instanceof FetchTimeoutError || (e as { isTimeout?: boolean })?.isTimeout === true

/**
 * fetch with a wall clock. 20s by default: long enough for a slow
 * mobile round trip through CAPTCHA verification and an admin user
 * create, short enough that nobody concludes the page is broken.
 *
 * 🔴 The timer is always cleared, including on a thrown fetch, so a
 * failed request does not leave a pending abort that fires later
 * against a controller nobody is listening to.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 20_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    // An abort we caused reads as an AbortError; report it as what it
    // is, so the caller can say "we stopped waiting" rather than
    // "something went wrong".
    if (controller.signal.aborted) throw new FetchTimeoutError(ms)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
