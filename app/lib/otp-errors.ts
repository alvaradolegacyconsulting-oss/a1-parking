// B162 — recognize Supabase Auth errors indicating the OTP/PKCE token
// was already consumed OR has expired. The Supabase Auth API uses
// ErrorCode 'otp_expired' for BOTH cases — there is no distinguishing
// client-side signal. Recovery card copy must cover both scenarios.
//
// MATCH STRATEGY (layered, defensive):
//
//   1. Primary: duck-type on error.code === 'otp_expired'. Works
//      regardless of which export path (supabase-js vs auth-js) the
//      error class came from. No import dependency.
//
//   2. Fallback: case-insensitive message match. Catches transitional
//      SDK versions or server-side variants that don't populate the
//      code field on this code path.
//
// KNOWN FRAGILITY: if Supabase ever renames 'otp_expired' or stops
// setting it on verifyOtp() failures, layer 1 breaks. Layer 2 still
// catches the common message phrasings. If both fail, we fall through
// to the existing generic verifyOtp error UX (raw message displayed) —
// degraded but not worse than pre-B162.

export function isOtpExpiredOrUsed(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 'otp_expired'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (!message) return false
  return (
    message.includes('otp expired') ||
    message.includes('token has expired') ||
    message.includes('token expired') ||
    (message.includes('expired') && message.includes('token'))
  )
}
