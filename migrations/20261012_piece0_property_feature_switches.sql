-- ════════════════════════════════════════════════════════════════════
-- PIECE 0 — per-property feature switches
-- ════════════════════════════════════════════════════════════════════
--
-- Rulings: Jose, 2026-10-12.
--
-- Two switches per property, BOTH OFF BY DEFAULT, writable only by a
-- company admin or super-admin. Managers read them and cannot change
-- them. Pieces 1 and 2 both check these, which is why this lands first:
-- building either piece earlier means writing the check twice.
--
--   parking_tags_enabled               → piece 1
--   printable_visitor_passes_enabled   → piece 2
--
-- ── 🔴 WHY AN RPC AND NOT COLUMN GRANTS ─────────────────────────────
-- properties_manager_update exists (20260911_email_ilike_tier1_equality.sql)
-- and is FOR UPDATE TO authenticated for BOTH manager and
-- leasing_agent on their own properties. So managers are NOT read-only
-- on properties today — a manager could flip either switch, and
-- "managers read-only" is a requirement the current RLS does not meet.
--
-- Two ways to close it:
--   • column-level REVOKE UPDATE (parking_tags_enabled, ...) — works,
--     but column grants do not appear in a pg_policies dump, so the
--     next person auditing this table will not find them and will
--     conclude managers can write these columns.
--   • a DEFINER RPC as the ONLY write path — visible, auditable, and
--     it carries the role check where someone reading the function will
--     see it.
-- The RPC, per ruling. The columns still carry a REVOKE as a second
-- layer, because the RPC is only the only path while nothing else
-- writes them.
--
-- NOT NULL DEFAULT false is correct here, unlike companies.billing_interval
-- where NULL had to mean "unknown". "Off" is a KNOWN state: the feature
-- is off until someone turns it on, and there is no third possibility.
--
-- 🔴 TURNING A SWITCH OFF HIDES UI AND KEEPS DATA (ruled). Nothing here
-- deletes a tag or a token. Piece 2's status page deliberately does NOT
-- check these flags — a pass already in a windscreen must keep
-- resolving after the switch goes off — while the MINT path does. That
-- asymmetry is the point and is restated in piece 2.
--
-- Paired: 20261012_piece0_property_feature_switches_verification.sql

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS parking_tags_enabled             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS printable_visitor_passes_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.properties.parking_tags_enabled IS
  'Piece 1. OFF by default. When false, no parking-tag UI appears for any role and a tag cannot be SET on this property''s vehicles — refused by vehicles_tag_switch_guard, which covers the direct-insert and service-role paths too. Writable ONLY through set_property_feature_switch (company_admin or admin); properties_manager_update would otherwise let a manager flip it. Turning it off hides the UI and KEEPS existing tag data.';
COMMENT ON COLUMN public.properties.printable_visitor_passes_enabled IS
  'Piece 2. OFF by default. When false, no print/QR UI appears and mint_visitor_pass_token refuses. 🔴 The public status page does NOT check this flag — a pass already issued must keep resolving after the switch is turned off. Writable ONLY through set_property_feature_switch.';

-- ══════════════════════════════════════════════════════════════════
-- The only write path
-- ══════════════════════════════════════════════════════════════════
-- 🔴 NO dynamic SQL. The switch name is an allowlist and each branch
-- names its column literally. format()/EXECUTE here would turn a
-- caller-supplied string into a column reference, which is a
-- SQL-injection shape on a function that runs as the owner — and it
-- would buy nothing, because there are exactly two switches.
CREATE OR REPLACE FUNCTION public.set_property_feature_switch(
  p_property TEXT,
  p_switch   TEXT,
  p_enabled  BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller  TEXT;
  v_role    TEXT;
  v_prop_id BIGINT;
  v_before  BOOLEAN;
BEGIN
  v_caller := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_caller = '' THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_role := public.get_my_role();

  -- 🔴 company_admin or admin ONLY. manager and leasing_agent are
  -- deliberately absent: they can read both switches through
  -- manager_read_own_property and must not change them.
  IF v_role NOT IN ('company_admin', 'admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_permitted',
      'hint',  'Only a company admin can change this setting. Ask your company administrator.'
    );
  END IF;

  IF p_switch NOT IN ('parking_tags', 'printable_visitor_passes') THEN
    RETURN jsonb_build_object('error', 'unknown_switch',
      'hint', 'Valid switches are parking_tags and printable_visitor_passes.');
  END IF;
  IF p_enabled IS NULL THEN
    RETURN jsonb_build_object('error', 'enabled_required');
  END IF;

  -- Scope: admin anywhere, company_admin within their own company.
  SELECT p.id INTO v_prop_id
    FROM public.properties p
   WHERE lower(trim(p.name)) = lower(trim(COALESCE(p_property, '')))
     AND (v_role = 'admin'
          OR lower(trim(p.company)) = lower(trim(public.get_my_company())))
   LIMIT 1;
  IF v_prop_id IS NULL THEN
    -- One error for "no such property" and "not yours", so this is not
    -- a property-enumeration oracle for a company admin.
    RETURN jsonb_build_object('error', 'property_not_found_or_not_yours');
  END IF;

  IF p_switch = 'parking_tags' THEN
    SELECT parking_tags_enabled INTO v_before FROM public.properties WHERE id = v_prop_id;
    UPDATE public.properties SET parking_tags_enabled = p_enabled WHERE id = v_prop_id;
  ELSE
    SELECT printable_visitor_passes_enabled INTO v_before FROM public.properties WHERE id = v_prop_id;
    UPDATE public.properties SET printable_visitor_passes_enabled = p_enabled WHERE id = v_prop_id;
  END IF;

  -- Audited with who and when (ruled). Records the PRIOR value too: "CA
  -- turned tags on" and "CA re-saved tags already on" are different
  -- events and only the before/after pair distinguishes them.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values)
  VALUES (v_caller, 'PROPERTY_FEATURE_SWITCH_SET', 'properties', NULL,
    jsonb_build_object('property', p_property, 'switch', p_switch, 'enabled', v_before),
    jsonb_build_object('property', p_property, 'switch', p_switch, 'enabled', p_enabled,
                       'changed', (v_before IS DISTINCT FROM p_enabled)));

  RETURN jsonb_build_object(
    'ok', TRUE, 'property', p_property, 'switch', p_switch,
    'enabled', p_enabled, 'was', v_before,
    'changed', (v_before IS DISTINCT FROM p_enabled)
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.set_property_feature_switch(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_property_feature_switch(TEXT, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.set_property_feature_switch(TEXT, TEXT, BOOLEAN) IS
  'The ONLY write path for properties.parking_tags_enabled and printable_visitor_passes_enabled. company_admin (own company) or admin; manager and leasing_agent are refused even though properties_manager_update would otherwise permit the UPDATE. Switch name is an allowlist with literal column references — deliberately no dynamic SQL in an owner-privileged function. Audited with the prior value so a real change is distinguishable from a re-save.';

-- ══════════════════════════════════════════════════════════════════
-- Second layer: a trigger, NOT a narrowed column grant
-- ══════════════════════════════════════════════════════════════════
--
-- 🔴 I drafted a narrowed `GRANT UPDATE (col, col, ...)` first and
-- rejected it. It works, but it leaves a footgun: every column added to
-- properties afterwards is NOT in the grant list, so the CA's property
-- edit form silently loses the ability to write it, with no error that
-- names the cause. A security control that breaks the next feature is a
-- control someone removes.
--
-- A trigger has none of that: it names exactly the two columns it
-- protects, it is visible in pg_trigger (unlike column grants, which do
-- not appear in a pg_policies dump), and a new column is unaffected.
--
-- 🔴 IT REFUSES ONLY AN AUTHENTICATED NON-CA CALLER. A SQL session or a
-- service-role path has no user JWT and proceeds — migrations and
-- backfills must keep working, and the threat here is a manager's
-- browser sending a PATCH that properties_manager_update would allow,
-- not Jose running SQL.
--
-- The DEFINER RPC still passes: a SECURITY DEFINER function runs as the
-- owner but auth.jwt() is still the CALLER's, so get_my_role() inside
-- this trigger sees 'company_admin' and allows it.
CREATE OR REPLACE FUNCTION public.properties_feature_switch_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email TEXT;
  v_role  TEXT;
BEGIN
  IF NEW.parking_tags_enabled IS NOT DISTINCT FROM OLD.parking_tags_enabled
     AND NEW.printable_visitor_passes_enabled IS NOT DISTINCT FROM OLD.printable_visitor_passes_enabled THEN
    RETURN NEW;   -- neither switch changed; nothing to police
  END IF;

  v_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN NEW;   -- no user JWT: SQL session / service role. See header.
  END IF;

  v_role := public.get_my_role();
  IF v_role IS DISTINCT FROM 'company_admin' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'feature_switch_not_permitted'
      USING HINT = 'Only a company admin can change this setting. Ask your company administrator.';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS properties_feature_switch_guard_trigger ON public.properties;
CREATE TRIGGER properties_feature_switch_guard_trigger
  BEFORE UPDATE ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.properties_feature_switch_guard();
