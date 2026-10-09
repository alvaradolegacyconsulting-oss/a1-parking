-- ════════════════════════════════════════════════════════════════════
-- proposal_codes_summary — company_admin and super-admin only
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-09, after the plan-names investigation surfaced
-- this.
--
-- THE EXPOSURE. The view is GRANTed to `authenticated` and filtered
-- only by company, with security_invoker = false so it bypasses
-- proposal_codes' admin-only RLS. Any resident, driver, manager or
-- leasing agent at a company with a redeemed code could read that
-- company's proposal row: the code string, client_name, client_email,
-- notes, redeemed_at, expires_at and pdf_url.
--
-- 🔴 WHAT IT ACTUALLY LEAKED, measured rather than assumed. One
-- redeemed code exists in production: A1WRECKER-6NSW, company 91. Its
-- readable fields are client_name 'A1 Wrecker, LLC', client_email
-- 'a1wrecker2023@gmail.com', notes NULL, pdf_url NULL. So an A1
-- resident could read the owner's email address and the code string.
-- No pricing — the view excludes those columns deliberately, and that
-- part of the original design held.
--
-- 🔴 THE PDF HALF IS MOOT. pdf_url is NULL, and the proposal-pdfs
-- bucket does not exist — it was retired 2026-09-07
-- (20260907_retire_proposal_pdfs_verification.sql asserts the bucket is
-- gone). Confirmed against the live storage API: the buckets are
-- violation-photos, violation-videos, logos, property-authorizations
-- and vehicle-removal-photos. There is no storage policy to change.
--
-- THE FIX. Role-gate inside the view. Everyone keeps SELECT on it, and
-- everyone who should not see a row now sees zero rows rather than
-- being refused — which is also what the CA portal's plan card wants,
-- since "no row" legitimately means "no negotiated deal".
--
--   admin         → every redeemed code (they issue them, and they can
--                   already read the base table through
--                   admin_all_proposal_codes)
--   company_admin → their own company's
--   everyone else → nothing
--
-- Also tightened while rewriting: `c.name ILIKE get_my_company()`
-- becomes exact lower(trim()) equality. ILIKE treats the caller's own
-- company name as a PATTERN, so a name containing _ or % would match
-- other companies. Latent rather than live — companies.name has
-- forbidden those since 2026-09-01 — but this view is being replaced
-- anyway and the stricter form costs nothing. Part of the same
-- direction as the email-ILIKE arc.
--
-- 🔴 DROP + CREATE, not CREATE OR REPLACE: the WHERE clause changes
-- shape and CREATE OR REPLACE VIEW cannot alter it. The GRANT must
-- therefore be re-issued — a dropped view takes its grants with it, and
-- forgetting that line is how the CA plan card would silently start
-- reporting "no negotiated deal" for A1.
--
-- Paired: 20261009_proposal_codes_summary_company_admin_only_verification.sql

DROP VIEW IF EXISTS public.proposal_codes_summary;

CREATE VIEW public.proposal_codes_summary
WITH (security_barrier = true, security_invoker = false) AS
SELECT pc.id,
       pc.code,
       pc.status,
       pc.feature_overrides,
       pc.redeemed_at,
       pc.expires_at,
       pc.client_name,
       pc.client_email,
       pc.notes,
       pc.company_id,
       pc.pdf_url
FROM public.proposal_codes pc
WHERE pc.status = 'redeemed'
  AND (
    -- Super-admin: all redeemed codes, no company scope. They have no
    -- companies row of their own, so a company filter would return them
    -- nothing.
    public.get_my_role() = 'admin'
    OR (
      public.get_my_role() = 'company_admin'
      AND pc.company_id IN (
        SELECT c.id FROM public.companies c
        WHERE lower(trim(c.name)) = lower(trim(public.get_my_company()))
      )
    )
  );

-- Re-issued because DROP VIEW took the old grant with it.
GRANT SELECT ON public.proposal_codes_summary TO authenticated;

COMMENT ON VIEW public.proposal_codes_summary IS
  'Redeemed proposal codes, role-gated. admin sees all; company_admin sees their own company''s; every other role sees ZERO ROWS. security_invoker=false so it bypasses proposal_codes'' admin-only RLS deliberately — the role gate in the WHERE clause is what replaces that RLS, so any edit to this view must preserve it. Pricing columns are excluded on purpose and must stay out. 2026-10-09: added the role gate (previously any authenticated user at the company could read client_name/client_email/notes — an A1 resident could read the owner''s email) and replaced the company ILIKE match with exact lower(trim()) equality. Consumed by the CA portal plan card to decide "Tailored rate" vs the published plan name: one row means a negotiated deal, and a tier key cannot answer that question because A1 and a self-serve Operator Pro both carry tier=legacy.';
