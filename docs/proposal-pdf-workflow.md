# ShieldMyLot™ — Proposal PDF Generation Workflow

**Reference document for hand-gen proposal PDF creation and customer hand-off**

*Last updated: May 19, 2026*
*Owner: Jose Alvarado, Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™*

---

## When to use this workflow

Current workflow is hand-gen only — Phase 2 web acceptance page is not yet built. Use this process when:

- Onboarding a new customer (founding member or standard tier)
- Generating a custom-priced proposal (e.g., founding-member rates, custom volume pricing)
- Re-issuing a revoked or expired code

Future: when the web acceptance page ships, customer signs digitally via `/proposal/<code>` and this manual process becomes the exception, not the rule.

---

## Prerequisites (one-time setup)

Verify each of these exists before your first proposal generation:

- [ ] Local repo cloned to `~/a1-parking`
- [ ] `.env.local` exists in project root with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Chrome installed (Safari does not work — instructions require Chrome's Save-as-PDF specifically)
- [ ] Proposal code already created in Supabase via the admin portal at `/admin/proposal-codes/new`

---

## Step-by-step workflow

### Step 1 — Open terminal and navigate to project

```
cd ~/a1-parking
```

Confirm you're in the right place:

```
pwd
```

Expected output:

```
/Users/ALC/a1-parking
```

If you see a different path, you're in the wrong directory. Don't continue until `pwd` returns the project path.

---

### Step 2 — Run the generator script

```
npx tsx --env-file=.env.local scripts/render-proposal.ts CODE-HERE
```

Replace `CODE-HERE` with the actual proposal code (e.g., `A1WRECKER-001`, `TESTPROP-YT0H`).

Expected output:

```
Wrote /Users/ALC/a1-parking/output/CODE-HERE.html

Next steps:
  1. Open /Users/ALC/a1-parking/output/CODE-HERE.html in Chrome.
  2. ⌘P → Save as PDF (US Letter, default margins, background graphics ON).
  3. Upload to Supabase Storage: bucket 'proposal-pdfs', path 'proposals/CODE-HERE.pdf'.
  4. UPDATE proposal_codes SET pdf_url = 'proposals/CODE-HERE.pdf' WHERE code = 'CODE-HERE';
  5. Reload /admin/proposal-codes/<CODE> → "PDF Pending" should now read "View PDF".
```

If you see errors, jump to the "Common gotchas" section at the end.

---

### Step 3 — Open the HTML in Chrome

```
open output/CODE-HERE.html
```

This opens the file in your default browser. If your default is not Chrome, open Chrome manually and drag the file from Finder into a Chrome window.

---

### Step 4 — Review the HTML in browser

**This is the most important step. Catch problems here, not after the customer has the PDF.**

Verify these render correctly:

- [ ] ShieldMyLot logo at top
- [ ] Navy blue color scheme present
- [ ] Customer name and email populated correctly
- [ ] Tier displayed correctly (e.g., "Enforcement Legacy")
- [ ] Pricing math: base fee + per-property + per-driver math computes correctly
- [ ] Annual pricing language ("pay 10, get 12" or similar)
- [ ] Texas-only restriction (Chapter 2308 references)
- [ ] Standard contract terms (termination, 14-day money-back, 30/60-day notice)
- [ ] Signature fields visible for customer and counter-signature for ShieldMyLot
- [ ] No placeholder strings like `{{name}}` or `{COMPANY}` leaking through
- [ ] No "Lorem ipsum" or test text
- [ ] Effective date and expiration date correct

If anything is wrong, fix the proposal code in admin portal (edit the code's tier, pricing, feature overrides, or notes), then re-run Step 2.

---

### Step 5 — Print to PDF

Press `⌘P` (Cmd+P) in Chrome while viewing the HTML file.

**Critical settings — verify each one:**

| Setting | Value |
|---------|-------|
| Destination | **Save as PDF** |
| Pages | All |
| Paper size | US Letter |
| Margins | Default |
| Scale | Default |

**Click "More settings" to expand the advanced section, then verify:**

| Setting | Value |
|---------|-------|
| **Background graphics** | ☑ **ON** |
| **Headers and footers** | ☐ **OFF** |

**Why these two matter:**

- **Background graphics ON** — without this, the PDF strips all CSS backgrounds. The logo and color scheme disappear. PDF looks unbranded.
- **Headers and footers OFF** — without this, Chrome adds a timestamp top-left and your local filesystem path bottom-left (e.g., `file:///Users/ALC/a1-parking/output/...`). This exposes your username to the customer and looks unprofessional.

Click **Save**.

- Filename: `CODE-HERE.pdf` (replace with actual code)
- Location: Desktop (for staging — will move to Supabase next)

---

### Step 6 — Verify the PDF before uploading

Open the saved PDF from Desktop. Check:

- [ ] Logo renders (not a broken image icon)
- [ ] Colors and shading visible
- [ ] No timestamp anywhere on the page
- [ ] No file path anywhere on the page
- [ ] Layout matches what you saw in Chrome
- [ ] Page count is reasonable

**If the PDF looks "stripped" (no colors, no logo):** Background graphics was OFF. Re-print with it ON.

**If the PDF has timestamp or file path on the edges:** Headers and footers was ON. Re-print with it OFF.

---

### Step 7 — Upload to Supabase Storage

1. Open Supabase Dashboard → your ShieldMyLot project
2. Left sidebar → Storage (folder icon)
3. Click into the `proposal-pdfs` bucket
4. Navigate to (or create) the `proposals/` subfolder
   - **IMPORTANT: lowercase `proposals/`** — paths are case-sensitive
5. Click "Upload file"
6. Select the PDF from your Desktop
7. Wait for upload to complete

Verify the final path is exactly: `proposal-pdfs/proposals/CODE-HERE.pdf`

---

### Step 8 — Wire the pdf_url in the database

Open Supabase Dashboard → SQL Editor and run:

```sql
UPDATE proposal_codes
SET pdf_url = 'proposals/CODE-HERE.pdf'
WHERE code = 'CODE-HERE';
```

Replace `CODE-HERE` with the actual code in both places.

Note: store the **relative path only** (`proposals/CODE-HERE.pdf`), not the full URL. The platform constructs the full URL on demand.

Expected: success message. If "Success. No rows returned" appears, that's actually fine — Supabase UI sometimes shows that for successful UPDATEs. Verify with:

```sql
SELECT code, pdf_url FROM proposal_codes WHERE code = 'CODE-HERE';
```

Should return one row with `pdf_url` populated.

---

### Step 9 — Verify in admin portal

Navigate to:

```
https://www.shieldmylot.com/admin/proposal-codes/CODE-HERE
```

Confirm:

- [ ] Page loads with correct code details
- [ ] "View PDF" button visible (gold outline, bottom of page)
- [ ] Clicking "View PDF" opens the uploaded PDF in a new tab
- [ ] The PDF displays correctly

If "View PDF" 404s when clicked, the most common cause is a case mismatch between `pdf_url` in DB (lowercase) and the actual Storage folder name. Verify both are lowercase `proposals/`.

---

### Step 10 — Send to customer

Right-click the PDF (from Desktop or downloaded from Supabase) to attach to email.

**Suggested email template:**

> Subject: ShieldMyLot — Service Agreement for [COMPANY NAME]
>
> Hi [CUSTOMER FIRST NAME],
>
> Attached is your ShieldMyLot service agreement covering [TIER] tier with the [founding-member / standard / custom] rates we discussed.
>
> Please review, sign, and return the signed copy to support@shieldmylot.com.
>
> Once signed, I'll activate your account and send your admin login credentials.
>
> Let me know if you have any questions before signing.
>
> Best,
> Jose Alvarado
> Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™
> support@shieldmylot.com

---

## After the customer signs and returns

### Step A — Save the signed PDF

Save the customer's signed copy to a known location (e.g., `~/Documents/signed-proposals/`) for your records.

### Step B — Apply the code to their company

1. Navigate to `/admin/proposal-codes/CODE-HERE`
2. Click **"Apply to Company"** (gold button)
3. Select the customer's company from the picker
4. Confirm

This flips status from `issued` to `redeemed` and applies feature_overrides + custom_pricing to that company.

### Step C — Provision the customer's company admin user

1. In admin portal, create a `company_admin` user with the customer's email
2. Generate a secure temporary password (don't reuse passwords)
3. Set `must_change_password = true` (if that flag exists) so they're forced to reset on first login

### Step D — Send the welcome email with credentials

> Subject: ShieldMyLot — Your Account is Active
>
> Hi [CUSTOMER FIRST NAME],
>
> Your ShieldMyLot account is now active. Welcome aboard!
>
> Login URL: https://www.shieldmylot.com/login
> Email: [CUSTOMER EMAIL]
> Temporary password: [PASSWORD]
>
> You'll be prompted to change this password on first login.
>
> Once logged in, head to the **Plan** tab to see your tier overview and limits. The **Manage** tab is where you'll add properties, drivers, and additional users.
>
> If you need anything, reply to this email or contact support@shieldmylot.com.
>
> Best,
> Jose Alvarado

---

## Common gotchas

| Error / Issue | Cause | Fix |
|---------------|-------|-----|
| `ERR_MODULE_NOT_FOUND` when running the script | You're in the wrong directory | `cd ~/a1-parking` then retry |
| "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY" | Missing `--env-file` flag | Add `--env-file=.env.local` before the script path |
| "Proposal code not found" | Typo in code, or code is in unexpected status | Verify with SQL: `SELECT * FROM proposal_codes WHERE code = 'CODE'` |
| PDF has timestamp/file path on edges | Chrome's "Headers and footers" was ON | Re-print with Headers and footers OFF |
| PDF has no colors / no logo | Chrome's "Background graphics" was OFF | Re-print with Background graphics ON |
| "View PDF" returns 404 in admin portal | Path case mismatch between DB and Storage | Verify both are lowercase `proposals/` |
| Apply to Company shows no companies | Company hasn't been created yet, or it's archived | Create the company first via admin portal |
| Customer clicks signature link in PDF and gets 404 | Web acceptance page not yet built (Phase 2 future work) | Add text instruction to PDF: "Sign and return to support@shieldmylot.com" |

---

## Workflow timing reference

Approximate time per phase, assuming everything works:

- Terminal setup + script run: 2 minutes
- HTML review in browser: 3-5 minutes
- Print to PDF + verify: 2 minutes
- Upload to Supabase + UPDATE: 3 minutes
- Verify in admin portal: 1 minute
- Email to customer: 2-3 minutes

**Total per proposal: ~15-20 minutes** for a clean first run. Faster with practice.

---

## Future improvements (tracked in backlog)

- **B15 → Phase 2**: Web acceptance page at `/proposal/<code>` eliminates manual PDF workflow for digital-savvy customers
- **B48**: Remove or redirect the broken signature link in current PDF template
- **B49**: Workflow for proposal code amendments / renewals (when customer terms change mid-contract)
- **Phase 3**: Self-service redemption during `/signup` flow with auto-applied proposal codes

When these ship, this hand-gen workflow becomes the exception (used for one-off custom enterprise deals) rather than the norm.

---

*This document is the source of truth for the hand-gen proposal workflow. Update it whenever the workflow changes — and re-print or re-share if any team members onboard to handle proposal generation.*
