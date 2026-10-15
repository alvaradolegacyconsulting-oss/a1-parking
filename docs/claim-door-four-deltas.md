# /claim — built, plus four things that do not hold as stated

Built, committed, gated: `07127de`. `verify:claim` 52 checks green,
`verify:routes` all declared with `/claim` serving 200 anonymously.

Four premises in the ruling needed changing or qualifying. Three are
closed in the build; **one needs you in the Supabase dashboard**.

---

## 1. 🔴 There is no property token, so the link is `?property=&company=`

The ruling says "a per-property claim link/QR (e.g. `/claim/[property
token]`)". **No property token exists anywhere in this codebase.** Every
property QR link today is:

    /register?property=<name>&company=<name>

generated at `manager/page.tsx:5751`, `company_admin/page.tsx:6566` and
`:7008` — plain names in query params, no token column, no token table.

`/claim` reuses that exact shape. Three reasons:

- The CA's existing QR generator can emit it with a one-word change.
- The "Register here →" fallback lands on the **same property** the
  flyer was for, which is the whole point of the fallback.
- A token buys an attacker nothing here. The page returns one answer to
  every input and mails no unknown address, so guessing a property name
  gets you the same blank screen either way.

What a token **would** buy is revocability of a printed flyer: a
property reprints, the old flyer stops working. That is a real want and
a separate piece of work (a `properties.claim_token` column, rotatable
from the CA portal). Not assumed — your call whether it is wanted.

## 2. 🔴 The invite email cannot name the property yet — one dashboard edit

The route now passes the metadata:

```ts
data: {
  claim_property: match.property,
  claim_unit:     match.unit ?? null,
  claim_vehicle_count: vehicleCount ?? 0,
}
```

**But the Invite template is shared by four senders and the metadata is
currently inert.** The other three — `/api/admin/invite-user`,
`/api/admin/resend-invite`, `/api/billing/bulk-invite` — pass **no
`data` at all**, which is what makes a conditional block safe: for them
the field is empty and the existing paragraph renders unchanged.

The template lives in the Supabase dashboard, not the repo. Replace the
"Your administrator has set up…" paragraph in **Authentication → Email
Templates → Invite user** with:

```html
{{ if .Data.claim_property }}
      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">
        <strong>{{ .Data.claim_property }}</strong> has already set up your parking
        account for <strong>{{ .Email }}</strong>{{ if .Data.claim_unit }}, unit
        <strong>{{ .Data.claim_unit }}</strong>{{ end }}.{{ if .Data.claim_vehicle_count }}
        {{ .Data.claim_vehicle_count }} vehicle(s) are already on file for you —
        you do not need to add them again.{{ end }}
        Click below to set your password and sign in:
      </p>
{{ else }}
      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">
        Your administrator has set up a ShieldMyLot account for <strong>{{ .Email }}</strong>. Click the button below to accept the invitation and set your password:
      </p>
{{ end }}
```

`{{ if .Data.claim_vehicle_count }}` is false for `0`, so a resident
imported without a vehicle does not get told about zero vehicles.

**No plates, by design** — the gate asserts the metadata contains no
plate, so a wrong recipient learns nothing about a car. Count only.

🔴 **And nothing security-bearing may ever go in that `data` block.**
`user_metadata` is client-writable: the invited user can change their
own after accepting. Property, unit and a count are display-only and a
user rewriting their own copy of them harms nobody. A version pin or a
consent flag there would be a hole — the same rule as the SaaS-agreement
pin.

Until the template is edited this is **cosmetic**: the invite still
works, still sets a password, still lands in the right portal. It just
does not name the property.

## 3. 🔴 "Identical timing class" is a floor, not constant time

The route pads every answer to a 900ms floor. That makes nothing
distinguishably **fast**, which is the attack that matters: the
send-nothing branches are the ones a prober reaches for an address they
are guessing, and they measured 2ms apart.

It does **not** make them constant. A send is a Supabase round-trip and
came in 32ms slower than the fastest send-nothing branch; no padding
hides that. The gate asserts the floor and the send-nothing group, and
says plainly in its own output that the send may be slower. True
constant time would mean moving the invite off the request path onto a
queue — available if you want it, not built.

Worth being clear about what the slower branch leaks: it is only
observable for an address that **is** a records-bearing resident at that
property who **has not yet claimed**. Someone who can already measure
that has to have guessed the address and the property.

## 4. ✅ Bulk upload cannot create a staff role — confirmed, with a gap

- The template has **11 columns and no role column**.
- `app/lib/bulk-onboarding.ts` and `app/lib/bulk-validator.ts` contain
  **zero occurrences of the string "role"**.
- The claim route's only role literal is `role: 'resident'`.

So nothing in the ingest path can express a staff role.

🔴 **The loader does not exist yet**, so this is confirmed for the
template and validator and *asserted by construction* for the loader —
it becomes a gate assertion when the loader is built, which is two items
down the queue.

Separately, the staff case is now closed at the claim route itself: an
address holding a staff role beside a live resident record gets the
identical answer and **no invite**. The gate builds that canary in the
`amandacanchol@gmail.com` shape — a manager role next to a resident
record — because the route checks the record first, so a staff address
with *no* record exits through the no-match branch and would have proved
nothing about the exclusion.

---

## One thing the gate caught in my own work

The non-regression check for "/register still renders the full form"
first keyed on the plate input's placeholder, which I took off a grep
line. It is on **step 3**; a GET never renders it. The check failed.

The marker that is actually in the initial render is the better one:
`Step 1 of 3 — Account Info`. That string **is** the three-screen flow
the complaint was about, so its presence on `/register` and absence on
`/claim` is exactly the difference the ruling asked for.

Same class of mistake as control 9 — an assertion read off text rather
than off the code path. The rule held this time.
