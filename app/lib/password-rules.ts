// B66.3 + B99 — shared password validation. Single source of truth used
// by /signup (B66.3 self-serve form), /signup/redeem (B65.3 proposal-
// code form), and /reset-password (B99 password reset form).
//
// Rule today: 8-character minimum, no other constraints. Matches B65.3
// to avoid surprising existing flows; future changes (complexity rules,
// breach-corpus check via HIBP, etc.) happen here once and propagate.
//
// Returns null on success, error string on failure.

export const MIN_PASSWORD_LENGTH = 8

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return null
}
