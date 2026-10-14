# Violation media is public-read — filed 2026-10-15, accepted for now

`violation-photos` (832 objects) and `violation-videos` (25) are
`public = true`. Anyone with the object URL can read tow evidence
without authenticating.

Jose: known and accepted for now. This item is the evaluation, not a
change.

## Why it is the way it is

The tow-ticket recipient gets `/ticket/view/<token>` with no login — the
token IS the credential — and the page renders the evidence. A public
bucket is the simplest way to put an image in front of someone who has
no account. `getPublicUrl()` is used directly at
`driver/page.tsx:1286` and `company_admin:3706`.

## What is actually exposed

Object names are `<unix-ms>-<original filename>`, e.g.
`1778382585162-IMG_2695 (1).jpeg`. The timestamp is guessable to within
a window and the filename often is not, so this is obscurity rather than
a boundary — but it is not an enumerable sequence either. There is no
listing exposure: `anon` cannot `list()` a bucket it has no SELECT
policy for, and the public flag grants read-by-URL, not discovery.

🔴 The real exposure is that a URL, once shared, is permanent and
unauthenticated. A tow dispute email forwarded onward carries the
evidence with it, forever, to anyone.

## The change, when ruled

Move both buckets to `public = false` and serve through signed URLs
issued by a route that validates the ticket token — the pattern
`app/api/properties/[id]/authorization-pdf-url/route.ts` already uses
for authorization PDFs, with `createSignedUrl(path, ttl)`.

Work involved:

1. A route that takes the view token, validates it the way
   `get_violation_by_view_token` does (length ≥ 32, not expired), and
   returns short-lived signed URLs for that violation's media only.
2. Replace `getPublicUrl()` at the two upload sites and wherever the
   ticket page renders media.
3. 🔴 **Back-fill concern:** 857 existing objects. Any URL already sent
   to a vehicle owner, an insurer or a court stops working the moment
   the bucket flips. That is the decision this item exists to surface —
   a disputed tow from six months ago may have its evidence linked in
   correspondence we cannot see.
4. SELECT policies for staff, since flipping `public` removes the
   blanket read that the portals currently rely on. A writer sweep
   first, per the binding rule — the read sites are a different list
   from the 9 write sites and have not been swept.

## Recommendation

Not a hotfix. Flipping it breaks every link already in the wild, and
the privacy gain is real but gradual. Worth doing **before** the first
enforcement dispute that turns on evidence provenance, and worth
scoping with A1 so they know old links die.
