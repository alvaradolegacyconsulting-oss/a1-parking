// ════════════════════════════════════════════════════════════════════
// decodeParamUntilStable — a link that was encoded twice still works
// ════════════════════════════════════════════════════════════════════
//
// searchParams.get() decodes once. A property name that went through an
// encoder twice — a QR generator, a link shortener, an email client
// rewriting the URL — arrives still holding "%20" or "%26", and an
// exact-name lookup then misses a property that exists. On /visitor
// that miss is expensive: the guest is told their link is invalid and
// is left parked with no pass.
//
// 🔴 CAPPED, BECAUSE DECODING IS NOT GUARANTEED TO CONVERGE. A string
// of literal percent-escapes could be peeled forever, and a malformed
// escape makes decodeURIComponent throw. Three passes covers every
// real double- and triple-encoding; beyond that the input is not a
// name we should be guessing at, so the last good value is returned.
export function decodeParamUntilStable(raw: string | null, cap = 3): string {
  if (!raw) return ''
  let value = raw
  for (let i = 0; i < cap; i++) {
    let next: string
    try {
      next = decodeURIComponent(value)
    } catch {
      // Malformed escape — the current value is the best answer we have.
      return value
    }
    if (next === value) return value   // stable; nothing left to peel
    value = next
  }
  return value
}
