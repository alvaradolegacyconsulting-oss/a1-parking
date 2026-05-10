// Cryptographically-secure temp password generator. Used when manager /
// admin / company_admin creates a resident — the resident is shown the
// temp password ONCE and forced to change it on first login.
//
// Charset excludes look-alikes (0/O/o, 1/l/I) and quote / shell-special
// chars to keep the credentials safe to copy-paste, type, or read aloud.

const CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' +
  'abcdefghjkmnpqrstuvwxyz' +
  '23456789' +
  '!@#$%&*+-_=?'

export function generateTempPassword(length: number = 12): string {
  if (length < 8) length = 8
  const buf = new Uint32Array(length)
  crypto.getRandomValues(buf)
  const out: string[] = new Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = CHARSET[buf[i] % CHARSET.length]
  }
  return out.join('')
}
