# Backlog — CA CRM redesign dropped the property `logo_url` control

**Filed:** 2026-08-20. Surfaced by Property Settings surface preflight
([docs/backlog/property-settings-surface-preflight-2026-08-20.md](property-settings-surface-preflight-2026-08-20.md)).
**Priority:** LOW. Product regression; no data loss. Deferred UI addition.

## What's missing

The property-level `logo_url` control exists in the legacy CA edit
path at [app/company_admin/page.tsx:6505-6510](../../app/company_admin/page.tsx#L6505-L6510):

```tsx
{logoField('Property logo', editingProperty.logo_url, url => ...)}
```

The CRM Edit form at
[app/company_admin/page.tsx:6207-6314](../../app/company_admin/page.tsx#L6207-L6314)
does not rebuild it. Behind `CA_CRM_REDESIGN=on` (production), a CA
cannot set or change a property logo through the current UI.

## Not this arc

Reachable via the legacy path (`CA_CRM_REDESIGN=off`) if urgent. `logo_url`
column stays populated for properties that had it set pre-redesign.
No enforcement or billing impact.

Include in the next CA-portal UI pass or fold into the property
Settings surface arc when it lands.

## Broader question this raises

**Was anything else dropped in the CRM redesign that hasn't been
noticed?** A diff of legacy Edit-form fields vs CRM Edit-form fields
would answer it. Worth scoping before the CRM redesign ships as the
only path (i.e., before the legacy fallback is retired per
[pm-crm-enabled-legacy-retirement.md](pm-crm-enabled-legacy-retirement.md)).

## Related

- [property-settings-surface-preflight-2026-08-20.md](property-settings-surface-preflight-2026-08-20.md) — §3 Q3 legacy-vs-CRM comparison
- [pm-crm-enabled-legacy-retirement.md](pm-crm-enabled-legacy-retirement.md) — legacy retirement roadmap
