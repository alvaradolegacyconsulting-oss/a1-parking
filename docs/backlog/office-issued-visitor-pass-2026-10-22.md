# Feature: the office issues a visitor pass

**Filed:** 2026-10-22 · **Ruled a real need by Jose** · Not started

## What's missing

There is no way for a property manager, leasing agent or company admin to issue a visitor pass.
`issue_visitor_pass` has exactly two callers:

- `app/api/visitor/create-pass/route.ts` — the anonymous QR path, called as service_role
- `app/resident/page.tsx` — the resident portal

The manager portal reads `visitor_passes` (for the limit check and the list) and never writes it.
There is no revoke action either: the only revocation is the plate-prohibition trigger.

This was found because the public comparison table claimed "office-issued" passes in all four
columns, and the v2 help docs described a manager-portal issue form in detail. Both were describing
something that does not exist. The claim is now off the home page (this commit's sibling), and
`verify:homepageclaims` ties the two together — if a writer lands, the gate says the table should
say "office" again.

## Why it's wanted

Walk-ins and contractors. A guest with no phone, a dead battery, or no signal in a garage cannot
use the QR path, and on Operator Starter there is no resident portal to fall back on — that plan is
QR only today.

## Shape of the work

The RPC already exists and takes everything needed; this is a caller plus a form.

- `issue_visitor_pass(p_plate, p_visitor_name, p_visiting_unit, p_property, p_vehicle_desc, p_duration_hours)`
- Grants are `authenticated` + `service_role`, so a manager session can already call it. **Check
  the role gate inside the function before assuming** a manager passes it.
- 🔴 It is **not** track-gated and is one of the five deliberate hybrid exclusions, so it is
  reachable from the PM track by design.
- The rolling-30 limit, the double-tap window and the single audit row are all inside the RPC. A
  new caller inherits them — do not reimplement any of it client-side.
- A manager form needs the refusal branches the resident portal already handles: `limit_reached`
  (with the live pass's real expiry) and the double-tap case.

## Don't forget

- The help docs describe two ways to get a pass. When this ships, doc 09 gains a third and the
  home-page cells get "office" back — and `verify:homepageclaims` fails until both move.
- Operator Starter's cell becomes "QR and office-issued"; the other three become "QR, office and
  resident-issued".
- A revoke action is a **separate** decision, not a freebie with this. Today revocation exists only
  as a side effect of prohibiting a plate, and the rolling-30 count deliberately keeps counting
  revoked passes so a prohibit-then-reissue loop cannot clear it.
