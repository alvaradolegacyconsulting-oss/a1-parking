# Fix B — PM CRM responsive pass (design polish for phone widths)

**Status:** BACKLOG · design pass · P2
**Filed:** 2026-07-17
**Precursor:** Fix A / Option A2 (drawer wrap) — SHIPPED 471efec. A2 made the resident-detail *reachable* on mobile ("usable but ugly" per Mateo directive). Fix B makes it *usable well*.

## Scope

The PM CRM was designed desktop-primary. On phone widths, several patterns are cramped or awkward — none blocking, but rough for PMs standing in a lot on a phone.

### Concrete issues to address

1. **Resident-detail drawer's internal grid** at [app/manager/page.tsx:3761](app/manager/page.tsx#L3761):
   ```jsx
   <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
   ```
   Unconditional 2-column grid. Inside the A2 drawer (380px on desktop, 90vw on phone), two columns per row of fields is cramped. Should be 1-column at phone widths (< 480px), 2-column at wider.

2. **Vehicles subsection inside the detail** at [app/manager/page.tsx:3820](app/manager/page.tsx#L3820):
   ```jsx
   <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'6px' ...}}>
   ```
   3-column mini-grid (Space, State, Permit Expiry) for each vehicle. At phone widths, 3 columns of small text is unreadable. Should collapse to 1 or 2 columns at phone widths.

3. **"Add Vehicle" form grid** at [app/manager/page.tsx:3780](app/manager/page.tsx#L3780):
   Same `gridTemplateColumns:'1fr 1fr'` pattern with 8 fields (plate, state, make, model, year, color, space, permit_expiry). Cramped on phone.

4. **Vehicle action buttons** at [app/manager/page.tsx:3825-3831](app/manager/page.tsx#L3825-L3831):
   Three inline buttons (Edit Space, Edit Plate, Remove). Each is ~50-70px wide; on a 380px drawer they fit but are close to accidental-tap distance. Larger touch targets (~44×44 min per WCAG) would be safer.

5. **Modal wrappers (7 sites, PM portal)** at [3324, 3367, 3429, 3515, 3533, 4623, 4672](app/manager/page.tsx#L3324):
   Each has `padding:'20px'` on the fixed backdrop + `maxWidth:'400px', width:'100%'` on the inner. On phones the modal fits, but tap targets inside (buttons, form fields) mostly use 10px/11px font + tight padding. Same treatment as above.

### Also apply the same pattern to CA CRM (parallel audit)

- `app/company_admin/page.tsx` has similar inline detail patterns for user editing + property editing. Same 2-column-grids-at-any-width story. Same fix.

## Design shape (report-first when opening)

**Media-query breakpoint discipline** — pick one and reuse:
- `@media (min-width: 480px)` — "phablet+" (2-column layouts, larger buttons acceptable).
- Below that — 1-column stacks, buttons full-width, form fields full-width.

**Options for implementation:**

**Option 1 — Inline `@media` via style tag or CSS classes.**
Least invasive. Add a `.pm-crm-2col` class in `globals.css` that's `1fr` below 480px, `1fr 1fr` above. Replace the inline `gridTemplateColumns` with the class. Doesn't require restructuring components.

**Option 2 — CSS Grid `auto-fill` / `minmax`.**
`gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))'`. Fields automatically wrap to 1 column at narrow widths, 2+ at wide. No breakpoint required; browser handles it. Cleanest.

**Recommendation:** Option 2 (auto-fill minmax) — no explicit breakpoints, degrades naturally on any device. Ship as a small utility class in `globals.css` (`.pm-form-grid` with the minmax pattern) and swap the inline `gridTemplateColumns` at each site.

## What Fix B does NOT do

- **Does NOT touch the A2 drawer wrapper** (position/overflow/maxHeight). That's structural, already in place.
- **Does NOT try to make the drawer full-width on phones.** The 380px / 90vw drawer is intentional — leaves a sliver of the list visible for context. Just makes what's INSIDE the drawer read better.
- **Does NOT restructure the detail into a multi-tab layout** (fields/vehicles/history as separate tabs on mobile). That's a bigger UX change deserving its own design pass — file separately if wanted.
- **Does NOT ship inside the A1 root-layout commit** — orthogonal concern; A1 is scroll-blocking, Fix B is visual polish.

## Verify plan

Real-phone verify (not devtools device-toggle):
- iPhone SE (small viewport), iPhone 15 (standard), Android Pixel (standard), iPad portrait + landscape.
- Per device: PM logs in → Residents tab → tap a resident → confirm the detail reads well (single-column fields, readable buttons, no clipping).
- Same for the 7 modals — trigger each, confirm it reads well at each viewport width.

## Priority

**Backlog · P2.** Not blocking; PMs can use the current drawer post-A2 for mobile. This is comfort/professionalism, not incident. Cluster with any other "make the PM CRM feel like it was designed for a phone" items when the PM-partner engagement demands it.

## Cross-references

- 471efec (PM Bible view A2 drawer wrap) — the precursor that made this possible
- `docs/backlog/A1-root-layout-page-scroll.md` — structural page-scroll fix (independent; ship in either order)
- `docs/backlog/modal-scroll-class.md` — the tall-modal-clipping class in the 7 manager modals
