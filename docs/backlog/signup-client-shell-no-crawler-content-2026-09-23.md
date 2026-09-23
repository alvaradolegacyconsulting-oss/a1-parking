# BACKLOG — `/signup` returns an empty shell to crawlers

**Filed:** 2026-09-23
**Author:** Mateo
**Priority:** P3 — intent/behaviour disagreement, no user-facing breakage
**Status:** Filed, not built. Deliberately not opened while a routing change was in flight.

---

## What was observed

`https://shieldmylot.com/signup` returns **200 with ~15 KB of HTML and no headings**. The
only marketing-ish string in the response is the site-wide title meta ("Texas Parking
Enforcement Platform"). The tier picker, the prices and the copy are not in it.

Cause: [app/signup/page.tsx](../../app/signup/page.tsx) is a client component whose dormancy
branch resolves from a `fetch('/api/signup/dormancy')` in an effect ([:89](../../app/signup/page.tsx#L89)).
Nothing renders server-side.

## Why it is a disagreement rather than a preference

[app/robots.ts](../../app/robots.ts) explicitly allows `/signup`:

```
allow: ['/', '/help', '/help/', '/terms', '/privacy', '/signup'],
```

So the site tells crawlers to index a page that has nothing in it to index. One of the two
is wrong: either `/signup` should render server-side, or it should not be in the allow list.

## Same shape as the `/operators` R5 defect, lower stakes

`/operators` had the identical failure (there via `useSearchParams()` forcing a Suspense
bailout) and it mattered, because `/operators` is an ad landing page whose whole job is to
be read by someone arriving cold. `/signup` is reached from navigation, a price page, or a
printed code — not from organic search — so the cost is much smaller.

It is filed because the *class* keeps recurring and because the fix is cheap: render the
static marketing half of the page on the server and let the interactive picker hydrate over
it. The dormancy fetch does not have to be the thing that gates first paint.

## Not in scope here

The sitemap does not list `/signup` at all ([app/sitemap.ts](../../app/sitemap.ts)), which is
a separate staleness question and belongs with whatever decides the `/robots.txt` +
`/sitemap.xml` reachability work.
