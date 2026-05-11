# Hand-Generating Proposal PDFs

## When this applies

Until the Phase 2 web acceptance page lands, proposal PDFs cannot be
generated automatically on Vercel. The bundled-Chromium and runtime-
download approaches (`@sparticuz/chromium` and `@sparticuz/chromium-min`)
both fail with `libnss3.so` load errors on Vercel's serverless runtime.
Five attempts (commits `c7a6115`, `46ec4af`, `a661159`, and `3524c8d`)
confirmed this is structural; the decision (May 13) is to hand-generate
PDFs for now.

Applies to:

- Custom proposals issued to subscriber companies
- Founding Member offers (e.g., A1 Wrecker LLC pre-launch pricing)
- Any one-off deal that doesn't fit the standard tier ladder

Self-service customers who accept tier pricing without overrides do
NOT need a PDF — they'll subscribe through the standard signup flow.

## Workflow

### 1. Create and issue the proposal code

1. Log in as super admin → `/admin/proposal-codes`.
2. Click **+ New Proposal Code**, fill out client + tier + overrides,
   submit → redirects to `/admin/proposal-codes/<CODE>`.
3. Verify the fields look right, then click **Issue Code** and confirm.
   - Status transitions `draft` → `issued`.
   - `issued_at` and `issued_by` are stamped.
   - `pdf_url` stays `NULL` — that's the signal that a PDF is still
     needed.

Make a note of the full code (`<PREFIX>-<XXXX>`, e.g. `A1WRECKER-X9F2`).
You'll need it for the rest.

### 2. Render the HTML locally

From the repo root:

```bash
export NEXT_PUBLIC_SUPABASE_URL=…              # from .env.local
export SUPABASE_SERVICE_ROLE_KEY=…             # service-role key (Dashboard → Settings → API)
export NEXT_PUBLIC_APP_URL=https://shieldmylot.com

npx tsx scripts/render-proposal.ts A1WRECKER-X9F2
```

This queries the `proposal_codes` row plus
`platform_settings.default_logo_url` and runs the same
`renderProposalPdfHtml()` template that was supposed to run
server-side. Output lands at `./output/<CODE>.html`.

> **Why service-role:** the script reads `proposal_codes` directly,
> which has admin-only RLS on the underlying table. Service-role
> bypasses RLS. **Do not commit the service-role key.** Source it
> from your local shell or `.env.local` only.

### 3. Print to PDF via browser

1. Open `output/<CODE>.html` in Chrome (or any Chromium browser).
2. `⌘P` → **Save as PDF**.
3. Settings:
   - Layout: Portrait
   - Paper size: US Letter
   - Margins: Default
   - Background graphics: **ON** (the template uses navy/gold accents)
4. Save as `<CODE>.pdf` somewhere local.

### 4. Upload to Supabase Storage

1. Supabase Dashboard → Storage → bucket **`proposal-pdfs`**.
2. Navigate into the `proposals/` folder (create it if it doesn't
   exist).
3. Upload your file. The path must be **`proposals/<CODE>.pdf`** —
   case-sensitive, matches the code on the row.

### 5. Wire the PDF to the proposal row

In Supabase SQL Editor:

```sql
UPDATE proposal_codes
SET pdf_url = 'proposals/A1WRECKER-X9F2.pdf'
WHERE code = 'A1WRECKER-X9F2';
```

(The `pdf_url` column stores the storage path, not a signed URL. The
`/api/proposal-codes/[id]/pdf-url` endpoint generates short-lived
signed URLs on each click — see commit `a6b069a`.)

### 6. Verify on the detail page

Reload `/admin/proposal-codes/<CODE>`. The **PDF Pending** button
should now read **View PDF** and open the file in a new tab. You can
also forward this URL to the client OR send the PDF you saved locally
out-of-band (email, signed paper copy, etc.).

The client-facing **Apply to Company** flow continues to work
regardless of whether the PDF exists; the PDF is supplementary
documentation, not a prerequisite for redemption.

## When this goes away

The Phase 2 plan ships a `/proposal/<code>` web acceptance page —
client clicks the link in the email/text we send them, signs in-place,
and the proposal is auto-applied. No PDF needed for that path. PDFs
will still be useful for archive purposes and any client who wants
paper, but they'll be optional.

Until then: hand-gen.

## Troubleshooting

- **`npx tsx` fails with module-resolution errors:** the script
  imports from `app/lib/proposal-pdf-template.ts` using a relative
  path. Run from the repo root, not from `scripts/`.
- **Output HTML missing the logo:** the template embeds the platform
  logo via `<img src="…">` — your browser must be online when you
  open it (or download the logo and inline it manually).
- **Service-role key error:** the script falls back to the anon key
  if `SUPABASE_SERVICE_ROLE_KEY` isn't set, but anon will return
  `null` for the `proposal_codes` row because of RLS. Use the
  service-role key.
- **Storage upload fails on path collision:** the upload is set to
  not overwrite by default. Delete the existing file or change the
  path before re-uploading.
