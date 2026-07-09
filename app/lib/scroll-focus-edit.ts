// B236 — small utility called after an edit-panel setState() so the
// panel scrolls into view (long lists routinely mount the edit UI
// off-screen) and focus lands in the first form field (keyboard +
// screen-reader affordance).
//
// USAGE
//   onClick={() => {
//     setEditingProperty({ ...prop })
//     scrollAndFocusEditPanel(`ca-edit-property-${prop.id}`)
//   }}
// and put `id={`ca-edit-property-${prop.id}`}` on the edit panel's
// wrapper div. See app/company_admin/page.tsx call sites.
//
// The setTimeout(50) delay lets React commit the panel to the DOM
// before we query for it — using a raf here would be tighter but 50ms
// is dead-reliable across browsers + fast enough to feel synchronous.
// If a call site ever renders slower than that (unlikely at CA
// surfaces), bump the delay in the call.
//
// Focus target is the first `input`, `textarea`, or `select` inside
// the panel — matches what a keyboard-tab-into-the-form user would
// hit anyway. If the panel has none (a display-only detail view),
// scroll still fires and focus is a no-op.

export function scrollAndFocusEditPanel(elementId: string, delayMs = 50): void {
  if (typeof window === 'undefined') return
  window.setTimeout(() => {
    const el = document.getElementById(elementId)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const firstField = el.querySelector<HTMLElement>('input, textarea, select')
    firstField?.focus()
  }, delayMs)
}
