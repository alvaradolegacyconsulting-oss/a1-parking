# Property Settings surface — preflight, 2026-08-20

**Filed:** 2026-08-20. Preflight for a proposed arc (Mateo Aug 20 design):
build a property-level Settings surface, with house rules as its first
tenant, sequenced ahead of `visitor_pass_at_cap_view` and rolling-30
visitor passes which are already blocked on it.

**Status:** REPORT ONLY. Nothing built. Two items surface for immediate
action independent of the arc — see §1.

---

## 1. 🔴 URGENT — `docs/help/04-adding-properties.md` doc-accuracy verdict

**Ship a doc correction today.** Three claims in the help doc will send A1 into dead-ends during Miramar / Sugarberry / Southfork onboarding.

| Doc step | Verdict | Evidence |
|---|---|---|
| Step 1: "Company Admin portal, click the Manage tab" | ✅ EXISTS | [app/company_admin/page.tsx:5851](../../app/company_admin/page.tsx#L5851) (`activeTab === 'manage'`) |
| Step 2: "+ Add Property button in the Manage tab" | ✅ EXISTS | [app/company_admin/page.tsx:5930](../../app/company_admin/page.tsx#L5930) (CRM) / [:6334](../../app/company_admin/page.tsx#L6334) (legacy) |
| Step 3 required: **Property type** ("Apartment, retail, office, etc.") | 🔴 **DOESN'T EXIST** | No `property_type` column in schema; form fields at [:5935-5944](../../app/company_admin/page.tsx#L5935-L5944) and [:6356-6367](../../app/company_admin/page.tsx#L6356-L6367) are name / address / city / state / zip / visitor_capacity / pm_name / pm_phone / pm_email only |
| Step 3 optional: **Notes** — tow-zone geometry example | 🔴 **MISLEADING** | Only field is `authorization_notes` at [:5956-5957](../../app/company_admin/page.tsx#L5956-L5957), scoped to towing-authorization renewal terms + displayed inside a "Towing Authorization" card. A CA following the doc would misfile tow-zone rules into a renewal-notes field |
| §Exempt plates: "Navigate to property's settings page… find the Exempt Plates section" | 🔴 **DOESN'T EXIST IN CA** | CA portal has no Settings tab and no exempt-plates section. Explicit code comment at [app/company_admin/page.tsx:12](../../app/company_admin/page.tsx#L12): "CA has no Visitor Pass Quota Exemptions section here (that's manager-…". Section lives ONLY on manager portal Settings at [app/manager/page.tsx:5065-5102](../../app/manager/page.tsx#L5065-L5102). Also **renamed 2026-07-23** to "Visitor Pass Quota Exemptions" (comment [:5058-5064](../../app/manager/page.tsx#L5058-L5064)) — doc still says "Exempt Plates" |
| §Visitor pass settings framing | ⚠ WRONG PORTAL | `visitor_pass_limit` editable only in manager Settings ([:4956-4982](../../app/manager/page.tsx#L4956-L4982), writer `savePassLimit` [:876-882](../../app/manager/page.tsx#L876-L882)); doc frames as a CA task |
| §Assigning managers | ✅ EXISTS | [:6586-6612](../../app/company_admin/page.tsx#L6586-L6612) |
| §Deactivating a property | ✅ EXISTS | `togglePropertyActive` [:1689](../../app/company_admin/page.tsx#L1689); button [:6444-6447](../../app/company_admin/page.tsx#L6444-L6447) |
| FAQ: "Can a property name be changed? Yes." | 🔴 **PARTIAL** | Rename is LOCKED once ≥1 user is assigned (non-admin only). UI [:6232-6238](../../app/company_admin/page.tsx#L6232-L6238); DB trigger `trg_properties_name_block_rename` (migration 20260715_property_name_block_rename.sql). A1 renaming any of the three new properties after seeding managers will hit an error the doc says can't happen |

**Same-day correction targets:** the property-type "required field" claim (delete), the exempt-plates workflow instruction (rewrite to point at manager Settings + rename to "Visitor Pass Quota Exemptions"), the rename FAQ (add the assignment lock), the visitor-pass-settings section (redirect to manager portal), and the tow-zone Notes example (move out of `authorization_notes`).

---

## 2. Q1 — editable-fields inventory

| Field | Edit path | Where | SQL-only? |
|---|---|---|---|
| `name` | Create + Edit (rename-locked ≥1 assignment) | CA Add/Edit ([:5936](../../app/company_admin/page.tsx#L5936), [:6211](../../app/company_admin/page.tsx#L6211), [:6357](../../app/company_admin/page.tsx#L6357), [:6453](../../app/company_admin/page.tsx#L6453)) | No |
| `address / city / state / zip` | Create + Edit | CA Add/Edit ([:5937-5940](../../app/company_admin/page.tsx#L5937-L5940), [:6212-6215](../../app/company_admin/page.tsx#L6212-L6215)) | No |
| `visitor_capacity` | Create + Edit | CA Add/Edit ([:5941](../../app/company_admin/page.tsx#L5941), [:6216](../../app/company_admin/page.tsx#L6216)) | No |
| `pm_name / pm_phone / pm_email` | Create + Edit | CA Add/Edit ([:5942-5944](../../app/company_admin/page.tsx#L5942-L5944), [:6217-6219](../../app/company_admin/page.tsx#L6217-L6219)) | No |
| `authorization_pdf_path` | Edit only | CA upload/replace/remove ([:6260-6279](../../app/company_admin/page.tsx#L6260-L6279) CRM, [:6469-6496](../../app/company_admin/page.tsx#L6469-L6496) legacy); Manager VIEW ONLY ([app/manager/page.tsx:3458-3475](../../app/manager/page.tsx#L3458-L3475)) | No |
| `authorization_expiration_date` | Create + Edit | CA | No |
| `authorization_notes` | Create + Edit | CA | No |
| `is_active` (deactivate/reactivate) | Edit | CA only, `togglePropertyActive` ([:1689](../../app/company_admin/page.tsx#L1689)) | No |
| `logo_url` (property-level) | Edit — **LEGACY ONLY** | Legacy CA edit [:6505-6510](../../app/company_admin/page.tsx#L6505-L6510); **dropped in CRM redesign** ([:6207-6314](../../app/company_admin/page.tsx#L6207-L6314) rebuilds without it) | Partial (regression) |
| `visitor_pass_limit` | Manager Settings tab | [app/manager/page.tsx:4956-4982](../../app/manager/page.tsx#L4956-L4982); NOT in CA | **NO — contradicts Aug 3 doc** |
| `exempt_plates` | Manager Settings tab | [app/manager/page.tsx:5065-5102](../../app/manager/page.tsx#L5065-L5102); NOT in CA | **NO — contradicts Aug 3 doc** |
| `authorized_plates` | Own tab in both portals | Shared `AuthorizedPlatesManager`; manager button [:3542](../../app/manager/page.tsx#L3542) | No |
| Reserved space pool | Add + Edit | Add-only counts ([:5965-5978](../../app/company_admin/page.tsx#L5965-L5978), [:6292-6305](../../app/company_admin/page.tsx#L6292-L6305), [:6515-6528](../../app/company_admin/page.tsx#L6515-L6528)) | No |
| Registration / Visitor QR | Manager Settings (readonly display) | [app/manager/page.tsx:4985-5054](../../app/manager/page.tsx#L4985-L5054) | Display only |
| **`house_rules`** | — | **NOT PRESENT anywhere in codebase** (0 grep hits across `app/`, `migrations/`, `docs/`) | n/a |

---

## 3. Q3 — manager vs CA vs both

Two hard splits:

- **Manager-only**: `visitor_pass_limit`, `exempt_plates` (never in CA — explicit exclusion at [app/company_admin/page.tsx:12](../../app/company_admin/page.tsx#L12))
- **CA-only**: property `is_active`, `authorization_pdf_path` upload (manager gets a view-only signed URL)

Manager's Authorized Plates tab is adjacent to Settings ([:3542](../../app/manager/page.tsx#L3542)); it uses a shared component so CA can reuse.

**Answer to Mateo's specific question — legacy vs CRM regression**: `logo_url` (property-level) exists in the LEGACY CA edit path at [:6505-6510](../../app/company_admin/page.tsx#L6505-L6510) but was **dropped in the CRM redesign** ([:6207-6314](../../app/company_admin/page.tsx#L6207-L6314) never rebuilds it). Behind `CA_CRM_REDESIGN=on` (production), a CA cannot set a property logo. Everything else Q1 lists is reachable in both legacy and CRM paths.

---

## 4. Q4 — file-upload reuse

**Two upload paths exist; they diverge.**

**Path A — Authorization PDF** ([app/company_admin/page.tsx:1628-1647](../../app/company_admin/page.tsx#L1628-L1647), `uploadAuthPdf`):
- Bucket: `property-authorizations` (**private**, migration `20260519_b51a_storage_bucket_authorization.sql:35`)
- Path shape: `${propertyId}/${Date.now()}.pdf`
- Constraints: 10MB max, `application/pdf` MIME check ([:1629-1630](../../app/company_admin/page.tsx#L1629-L1630))
- Write: direct `.update()` on `properties.authorization_pdf_path`
- Retrieval: **server-side signed URL** `/api/properties/{id}/authorization-pdf-url` ([:1660](../../app/company_admin/page.tsx#L1660), also [app/manager/page.tsx:3462](../../app/manager/page.tsx#L3462)) — re-checks RLS before signing
- Eager-write model — orphan files accepted for MVP ([:1622-1627](../../app/company_admin/page.tsx#L1622-L1627))

**Path B — Company logo** ([app/company_admin/page.tsx:1670-1687](../../app/company_admin/page.tsx#L1670-L1687), `uploadLogo`):
- Bucket: `logos` (**public**)
- Path shape: `${pathPrefix}-${Date.now()}.${ext}`
- Constraints: 2MB max, `upsert:true`
- Retrieval: `getPublicUrl` ([:1683](../../app/company_admin/page.tsx#L1683)), no signing
- Write: **DEFINER RPC `set_company_logo`** ([:2531-2588](../../app/company_admin/page.tsx#L2531-L2588), migration `20260709_set_company_logo_rpc.sql`) because RLS has no company_admin UPDATE policy on `companies` (comment at [:2534-2543](../../app/company_admin/page.tsx#L2534-L2543) — direct `.update()` was silently RLS-denied before)
- Property logos (legacy edit [:6505-6510](../../app/company_admin/page.tsx#L6505-L6510)) reuse the `uploadLogo` helper but write through the regular `saveProperty` `.update()` — no RPC gate

**Divergences**: private+signed vs public+direct; MIME/size limits differ 5×; three different write patterns (direct-RLS / DEFINER-RPC / direct-no-RPC). No shared helper.

For a house-rules PDF attachment: pattern-fit is Path A (private, signed URL — residents should see it only when scoped to their property). ~10 LOC to reuse if needed.

---

## 5. Additional gaps found

- **House rules has zero surface area.** No column, no migration, no UI, no docs. `grep -rn "house_rule|houseRule|House Rule"` across `app/`, `migrations/`, `docs/` returns 0 hits. Full greenfield.
- **Manager cannot upload an authorization PDF** — view-only ([app/manager/page.tsx:3455-3479](../../app/manager/page.tsx#L3455-L3479) comment: "cannot edit (per RLS + UI scope decision)"). If A1's on-site manager receives a signed PDF first, they must email it to the CA.
- **`property_type` field advertised in doc, doc-only.** Neither schema nor form.
- **Legacy `logo_url` control** only reachable when `CA_CRM_REDESIGN` is off — production is behind the flag.
- **Rename-lock silent surprise** — trigger-enforced, UI mirrors it, help doc doesn't.
- **Three plate concepts, "never merge or migrate"** ([docs/CURRENT_STATE.md:480-482](../../docs/CURRENT_STATE.md#L480)): `exempt_plates`, `authorized_plates`, `do_not_tow_plates` (parked). House rules must not become a fourth conflated concept.
- **CA "settings" surface, if built, would be a fifth `manageSection`** — currently typed `'properties' | 'users' | 'drivers' | 'storage' | 'company' | 'auditlog'` ([app/company_admin/page.tsx:273](../../app/company_admin/page.tsx#L273)). Zero plumbing exists.
- **Property-scoped Notes** (non-authorization) does not exist as a column — the doc's tow-zone example has no home.

---

## 6. Aug 3 doc claim — CONTRADICTED for manager portal, VALID for CA

The Aug 3 `visitor_pass_at_cap_view_design_aug3_2026.md` claim that `addExemptPlate` / `removeExemptPlate` / `savePassLimit` are "legacy-only / SQL-only / only Jose can set them, via SQL" is **contradicted** by the code — all three have full UI + writer functions in the manager Settings tab:

| Aug 3 claim | Reality |
|---|---|
| `savePassLimit` SQL-only | UI [app/manager/page.tsx:4956-4982](../../app/manager/page.tsx#L4956-L4982), writer [:876-882](../../app/manager/page.tsx#L876-L882), audit `SET_PASS_LIMIT` |
| `addExemptPlate` SQL-only | UI [:5087-5101](../../app/manager/page.tsx#L5087-L5101), writer [:886-895](../../app/manager/page.tsx#L886-L895), audit `ADD_EXEMPT_PLATE` |
| `removeExemptPlate` SQL-only | UI [:5077-5081](../../app/manager/page.tsx#L5077-L5081), writer [:898-905](../../app/manager/page.tsx#L898-L905), audit `REMOVE_EXEMPT_PLATE` |
| "Only Jose can set them" | Any manager (non-`leasing_agent`, `isReadOnly=false`) can |

**Partial validity — CA portal:** if Aug 3 was inspecting the CA portal only, the claim is correct there (0 UI hits, [app/company_admin/page.tsx:12](../../app/company_admin/page.tsx#L12) explicit exclusion). Reframe: **the Settings surface gap is on the CA side, not the manager side.** Managers already have these controls today.

That changes the arc's shape:
- Rolling-30 + at-cap view aren't blocked on new manager UI — the controls exist. They're blocked on **CA visibility** of the same controls (or on the RPC being reachable from CA, if the design puts CA-side administration in scope).
- House rules is greenfield on both portals — no legacy to inherit.

`docs/CURRENT_STATE.md:340` supports this indirectly: "every property still has `visitor_pass_limit = NULL`" — because A1 hasn't touched the manager Settings control that already exists, not because no control exists.

---

## Related

- [visitor_pass_at_cap_view_design_aug3_2026.md] — the "Settings gap" claim this preflight audits
- [BACKLOG_visitor_pass_rolling30_DESIGNED_july28_2026.md] — the other feature reportedly waiting on Settings
- [BACKLOG_paid_visitor_parking_feasibility_aug9_2026.md] — same Ch. 92 / Ch. 94 caveat that would apply to house-rules acknowledgment
- [b148_resident_bulletin_backlog_entry.md] — adjacent surface, deliberately kept separate per Mateo Aug 20
- `docs/CURRENT_STATE.md:480-482` — three-plate-concepts invariant ("Never merge or migrate")
