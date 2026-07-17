# Modal scroll class — 7 PM modals + CA equivalents

**Status:** BACKLOG · latent class · fires when a modal's content grows taller than the viewport
**Filed:** 2026-07-17
**Precursor:** discovered during the PM Bible-view diagnostic session that produced Fix A2 (471efec)

## The class

Every `position:fixed; inset:0` modal in `app/manager/page.tsx` uses this shape:

```jsx
<div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
              display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
  <div style={{ background:'#161b26', border:'1px solid ...', borderRadius:'14px',
                padding:'22px', maxWidth:'400px', width:'100%' }}>
    ...modal content...
  </div>
</div>
```

**The inner card lacks `maxHeight` + `overflowY:auto`.** If content grows taller than the viewport, the inner card overflows the flex container and clips below the fold — with no scroll to reach it.

Today it "happens to work" because every current modal is a short form (5-10 fields, ~500px tall max). But a tall variant (long resident list, long dropdown, error messages piling up, help text) would clip silently.

## Sites — 7 in PM portal

All in [app/manager/page.tsx](app/manager/page.tsx):

| Line | Modal purpose |
|---|---|
| 3324 | Add single ad-hoc space |
| 3367 | Assign resident to space (searchable picker) |
| 3429 | Decommission space |
| 3515 | (destructive confirm) |
| 3533 | (form modal) |
| 4623 | (form modal) |
| 4672 | (destructive confirm) |

Each independently could grow to trip the class. If a PM ever sees "modal button below the fold, can't tap it," this is why.

## CA equivalents

`app/company_admin/page.tsx` has the same pattern in multiple places — Add User, Add Property, various confirms. Not exhaustively grep'd yet; likely at least 5-8 sites with same construction.

Also: the Spaces v1.1 assign-resident modal in the manager Spaces tab has a searchable list. If it renders 100+ residents at a property, the list already grows tall enough that the modal could clip — priority to check.

## The fix (report-first when opening)

**Two-line change per modal:** add `maxHeight:'90vh', overflowY:'auto'` to the inner card style.

Before:
```jsx
<div style={{ background:'#161b26', border:'1px solid ...', borderRadius:'14px',
              padding:'22px', maxWidth:'400px', width:'100%' }}>
```

After:
```jsx
<div style={{ background:'#161b26', border:'1px solid ...', borderRadius:'14px',
              padding:'22px', maxWidth:'400px', width:'100%',
              maxHeight:'90vh', overflowY:'auto' }}>
```

**Why 90vh not 100vh:** leaves a small edge visible above/below so the user sees the modal IS a modal, not a full-page takeover. Aesthetics + gives the backdrop click room to close.

**Batch approach:**
- Extract a shared `ModalCard` helper component or add a `.modal-card` utility class in `globals.css` with the maxHeight+overflowY baked in. Every existing site swaps its inline style for the shared shape. Prevents drift + covers future modals by default.
- If Option Batch is too much scope, do the two-line inline change at each site. Faster, less shared surface, but re-invents the shape on the next modal added.

**Recommendation:** utility class in globals.css (`.modal-card`) — same treatment as `.portal-container` / `.dashboard-grid` / `.reading-container` already living there.

## What this does NOT retire

- **A2 drawer wrap for resident-detail (471efec):** stays. That's a different pattern (right-side slide-in drawer, not a centered modal).
- **A1 root-layout page scroll:** independent — page scroll blocked at root doesn't affect these modals (they scroll independently via their own overflowY once maxHeight is set).

## Verify plan

Real-phone verify:
- Log in as PM → trigger each of the 7 modals → confirm they scroll internally at phone height.
- Force a tall modal for testing: temporarily add 20 fields inside one, confirm still scrollable.
- Regression: desktop — modals still center-align, still tap outside to close (backdrop), still readable.

## Priority

**Backlog · latent P3.** Class hasn't fired in production. Fix is small, could ride along with Fix B (PM CRM responsive pass) as a bundle if both are approved together. Not tonight.

## Cross-references

- 471efec (PM Bible view A2 drawer wrap) — the sibling scroll-context pattern
- `docs/backlog/A1-root-layout-page-scroll.md` — page-scroll root fix (orthogonal)
- `docs/backlog/Fix-B-PM-CRM-responsive-pass.md` — bundle candidate
- app/manager/page.tsx:3324, 3367, 3429, 3515, 3533, 4623, 4672 — the 7 sites
