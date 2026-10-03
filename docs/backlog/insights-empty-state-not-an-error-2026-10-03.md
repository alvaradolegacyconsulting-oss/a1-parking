# Backlog — a brand-new account's Insights tab shows a red error

**Date filed:** 2026-10-03
**Ruling:** Jose, after the live two-line acceptance run (seen on the
fresh ZZ Two Line Acceptance account before teardown).
**File:** app/company_admin/page.tsx:4016-4025

## Symptom

A brand-new company admin opens Insights before adding a property and
is met with a **red error box** reading *"No properties match this
filter."* Nothing is broken and nothing was filtered — they simply have
no properties yet. Their first impression of the product is a failure
message for having just signed up.

## 🔴 The actual defect is the channel, not the wording

```ts
const messages: Record<string, string> = {
  unauthenticated:        'Session expired. Please log in again.',
  no_role_assigned:       'Your account has no role assigned. Contact your admin.',
  role_not_authorized:    'Insights are available to company admins only.',
  no_company_assigned:    'Your account has no company assigned. Contact your admin.',
  no_properties_in_scope: 'No properties match this filter.',   // ← not an error
}
setInsightsError(messages[data.error] || `Error: ${data.error}`)
```

`no_properties_in_scope` arrives through `data.error` and is handed to
`setInsightsError` — **the same channel as a dead session and a
permissions refusal.** There is one severity for five conditions, so an
ordinary empty state is rendered with the styling reserved for
something going wrong. Rewriting the string alone leaves it red.

This is the pattern already recorded in
[[feedback_severity_from_text_hides_downstream_failures]]: severity must
be **passed explicitly**, never inferred from the message or from which
setter happened to be reached.

Note the inversion worth naming: elsewhere the recurring bug is absence
being swallowed. Here absence is correctly *reported* — and then
**miscategorised as a failure.** Both come from one channel carrying two
meanings.

## The fix

1. Separate the empty state from the error states before the message
   map, so `no_properties_in_scope` never reaches `setInsightsError`.
   Give the Insights panel an explicit empty state alongside its error
   state — `setInsightsEmpty(...)` or a `kind` on the existing state.
2. Render a friendly **"Add your first property"** state: neutral
   styling, one line of explanation, and a button into the existing
   add-property flow so the next step is one click, not a hunt.
3. Keep the four genuine errors exactly as they are. They are correctly
   errors and correctly red.

## 🔴 Distinguish empty-because-new from empty-because-filtered

The RPC returns the same `no_properties_in_scope` for both *"this
company has no properties"* and *"your filter excluded them all"*. They
need different copy — "Add your first property" is wrong and slightly
insulting for an admin who has twelve properties and picked a narrow
filter. If the RPC cannot distinguish them, the client can: it already
knows the company's property count and whether a filter is active.

## Check the sibling surfaces in the same pass

Same construction, same question to ask:

- app/company_admin/page.tsx:6726 — `'No properties match'`
- app/admin_console/page.tsx:1411 — already branches on whether a
  search is active (`'No properties match this search.'` vs
  `'No properties to show.'`). **This one is the model** — it makes the
  exact distinction the Insights path does not.

## Verification when picked up

A new-account fixture is the test: a company with zero properties must
render the empty state, and the four error codes must still render as
errors. Asserting only "the red box is gone" would pass for a change
that silently hides real failures too.
