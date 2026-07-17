# A1 — Root-layout page scroll (html.h-full) — mobile scroll unblock

**Status:** BACKLOG · report-first · not built
**Filed:** 2026-07-17
**Precursor:** Fix A / Option A2 (drawer wrap for PM resident-detail) — SHIPPED 471efec (2026-07-17). A2 was the scoped safety fix for the highest-visibility instance. This is the structural close behind it.

## The class of bug

Every portal in this app inherits `app/layout.tsx`, which has:

```tsx
<html lang="en" className="... h-full antialiased">
  <body className="min-h-full flex flex-col">
```

- `<html>` has Tailwind `h-full` → `height: 100%` (bounded to viewport height).
- `<body>` has `min-h-full flex flex-col`.

Under normal browser semantics, `html { height: 100% }` + tall body content should let the viewport scroll (the viewport is the ultimate scrolling context). **Jose's real-phone repro on 2026-07-17 contradicted this on mobile:**
- `/manager` → Residents tab → tap a resident → **portrait:** only the list is visible, the resident detail (rendered below the fold as an inline panel) was unreachable. **Landscape:** ~25% of detail visible, rest cut off, no way to scroll to it.

The A2 drawer wrap (471efec) works because it creates its own scroll context via `position:fixed; inset:0` + `overflowY:auto` — bypassing whatever is blocking page scroll. But the underlying question remains: **why doesn't the page scroll on mobile?**

Candidate cause: the combination of `html.h-full` + `body.min-h-full flex flex-col` on iOS Safari (or on some mobile-Chrome variants) has been reported to interact badly — the body's flex sizing plus html's bounded height can trap content instead of letting the viewport scroll. Not confirmed against a spec; needs device-verify.

## Why it matters

Every OTHER inline panel that grows tall on mobile could hit the same class:
- **Manager modals (7 sites):** `[app/manager/page.tsx:3324, 3367, 3429, 3515, 3533, 4623, 4672]` — all `position:fixed; inset:0` outer with **no `maxHeight` or `overflowY:auto` on the inner card.** They "happen to work" only because their content is short. A future taller modal at mobile width would clip below the fold with no scroll.
- **CA portal equivalents** — not exhaustively audited yet. Same file-shape as manager (portal-container inside `<main minHeight:100vh>`). Likely same exposure.
- **Any inline detail panel added later** across any portal.

A2 fixed the highest-visibility instance. A1 stops the next one being born.

## Design options (pick when opening A1)

**Option 1 — Remove `h-full` from `<html>` entirely.** Let html size to content naturally. The body's `min-h-full` becomes `min-height: 100%` of the viewport (100vh effectively) which still gives the "full-height background" behavior currently achieved. Test on every portal + landing page for regression. One-line change, high-blast-radius.

**Option 2 — Replace `h-full` with `min-h-full` on `<html>`.** Same behavior for content shorter than viewport; adds nothing over Option 1 in practice but preserves the "at least 100% tall" intent explicitly.

**Option 3 — Move the bounded-height requirement off the root.** If `h-full` is needed for a specific full-height page (landing?), scope it to that page's layout instead of the root. Requires auditing which pages relied on the current root behavior.

**Option 4 — Keep `h-full`, drop `flex flex-col` from body.** If the flex is the actual culprit (not h-full), removing it may unblock scroll while preserving html bounds. Requires layout regression check for anything relying on body being a flex parent (NavBar positioning, etc.).

**Recommendation:** Option 1 as the first attempt (simplest, most likely correct). Report-first with the exact diff. Device-verify on real phones across every portal + landing page. If any regressions surface, fall back to Option 4.

## What to check when building A1

- **Device matrix:** iOS Safari (14, 15, 16, 17), Android Chrome, Android Samsung Internet, iPad Safari (portrait + landscape).
- **Per portal:** load a page with content taller than viewport, confirm the whole page scrolls. Check: `/manager` Residents (with detail panel unwrapped for the test, or just a long list), `/company_admin` Users tab, `/driver` plate history if long, `/resident` history, `/admin_console` subscriber list.
- **Landing page + marketing routes:** `/`, `/terms`, `/privacy`, `/saas` — these are long-scroll pages that CURRENTLY scroll fine (evidence: A1 users read them on mobile). Confirm still scrolling after the fix.
- **Modals:** the 7 manager modals + CA equivalents. After A1 lands, if a taller-than-viewport modal is opened, does its content scroll (via natural page scroll) or clip? If the drawer pattern is still needed for tall modals, note that A1 doesn't obviate the drawer for MODAL use — just for inline panels.

## What this does NOT retire

- **A2 (drawer wrap for PM resident-detail):** stays as-is even after A1. Drawer is arguably nicer UX than a scroll-to-bottom-of-page for a detail view anyway.
- **Fix B (responsive pass):** independent concern (design polish, gridTemplateColumns responsive, touch targets, no fixed widths).
- **Trim triggers, rename-lock, consent gate, etc.:** completely unrelated arcs.

## Cross-references

- `docs/backlog/Fix-B-PM-CRM-responsive-pass.md` — design polish for the drawer inside once A1 lands
- `docs/backlog/modal-scroll-class.md` — same class in manager's 7 modal wrappers
- 471efec (PM Bible view A2 drawer wrap) — the scoped precursor
- app/layout.tsx:47-49 — the root-layout rules to change
- app/globals.css:39-49 — .portal-container (no overflow rules, ready to inherit whatever html/body do)

## Priority

**Near-term.** Not tonight — needs its own report-first + device-matrix verify + deploy window. But before the next "why doesn't this scroll on mobile" report arrives; A2 bought time on the resident-detail instance, not on the class.
