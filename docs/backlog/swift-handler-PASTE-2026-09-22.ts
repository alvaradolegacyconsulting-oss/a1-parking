// @ts-nocheck
//
// swift-handler Edge Function — Item 2 Commit 2 (2026-08-29 revised)
// COPY-PASTE TARGET. Deploy via Supabase Dashboard → Edge Functions → swift-handler.
//
// ── 🔴 THIS IS A DENO TARGET FILE, NOT A NODE FILE ─────────────────
// @ts-nocheck at the top of this file is intentional. It exists at
// docs/backlog/swift-handler-index-2026-08-29.ts so tsc parses it
// (catches syntax errors like accidental markdown paste — Mateo Aug 29
// "shape problem" that killed the first deploy attempt), but @ts-nocheck
// disables type checking against Deno globals (Deno.serve, Deno.env),
// against the esm.sh import (won't resolve under Node module resolution),
// and against the Supabase admin types (some fields lag runtime).
// This file is NOT bundled by Vercel — it lives only as the paste
// source for the Supabase dashboard Edge Function editor.
//
// ── 🔴 THIS IS THE PASTE TARGET — 2026-09-22 AUTHORIZATION FIX ──────
// Generated from the 281-line source Jose confirmed IS the live
// dashboard function, with the caller-authorization gate inserted. It
// was BUILT by script from that source, not retyped, so every line
// outside the two marked gate regions is byte-identical to what is
// running now.
//
// TWO REGIONS ARE NEW. Both are wrapped in banner comments saying so:
//   1. module scope, after jsonHeaders  — the rank ladder + helpers
//   2. inside Deno.serve, after the service-role client — the gate
//
// NO ACTION BODY CHANGED. create_user, deactivate_user, activate_user
// and reset_password are untouched. The gate runs before the
// `if (action === …)` ladder is reached, which is what made that
// possible.
//
// 🔴 BEFORE PASTING: save the current live source verbatim to a file.
// There is no git revert for a dashboard function. That copy is the
// rollback.
//
// PREREQUISITE, ALREADY MET: the client commit f6f0f53 must be live, or
// the two manager call sites that used to send the anon key will 401 on
// the first use. Confirmed Ready on 792afe8, 2026-09-22.
//
// ── CHECKLIST (from Mateo Aug 29) ───────────────────────────────────
//  1. ban_duration: '876600h' literally. No '100y' anywhere. ✅
//  2. activate_user uses ban_duration: 'none'. ✅
//  3. All three branches converted. Zero remaining listUsers() calls. ✅
//  4. lookupError → 500, !userId → 404. Two distinct returns. ✅
//  5. Guard uses get_user_role_by_email + returns on guardError before
//     the role check (fail-closed). ✅
//  6. ...corsHeaders spread into EVERY response — including new ones. ✅
//  7. OPTIONS preflight block intact at the top. ✅
//  8. create_user branch present — CONFIRMED live by Jose 2026-09-21. ✅
//  9. Caller authorization gate added 2026-09-22 (two regions below). ✅
//
// ── PREREQ MIGRATIONS (both applied + PASS on 7 gates before paste) ─
//   20260829_get_auth_user_id_by_email.sql       (Commit 1)
//   20260829_get_user_role_by_email.sql          (Commit 1.5)
// G4 grants clean on both: service_role=1, all others=0.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

// Rank ladder, high to low. Mutation (reset / deactivate / activate) is
// allowed only DOWNWARD — see mutationAllowed().
const ROLE_RANK = {
  admin: 4,
  company_admin: 3,
  manager: 2,
  leasing_agent: 1,
  driver: 0,
  resident: 0,
}

// Roles permitted to create ANY user. The function cannot be finer than
// this: create_user carries no target role in its body (the auth row is
// minted first, the user_roles row written separately by
// insert_user_role). The per-target-role ladder lives THERE, where the
// role is actually known, and already implements it.
const CREATE_ALLOWED_ROLES = ['admin', 'company_admin', 'manager']

const MUTATION_ACTIONS = ['reset_password', 'deactivate_user', 'activate_user']

// 🔴 FAIL CLOSED TO THE LOWEST RANK on anything unrecognised.
//
// A null target role means "no user_roles row" — an auth user nobody has
// given a role to. It is deliberately ranked 0, NOT -1. At 0 a driver or
// resident (also 0) cannot act on it, because the rule below is STRICTLY
// greater; at -1 they could, which would let any driver reset the
// password of every roleless account in the system. admin /
// company_admin / manager are all above 0 and still reach it, which
// preserves reset_password's existing "targetRole is null → proceed"
// behaviour for exactly the callers that had it.
//
// One email cannot hold two role rows today — user_roles_lower_email_uidx
// is live, confirmed by execution 2026-09-21. This rule is unreachable
// now and costs nothing; if a future migration drops that index, it is
// the difference between a denial and a tenant.
function rankOf(role) {
  if (typeof role !== 'string') return 0
  const r = ROLE_RANK[role.trim().toLowerCase()]
  return typeof r === 'number' ? r : 0
}

// Allow when: caller is admin, OR caller is acting on themselves, OR the
// caller outranks the target STRICTLY. Strictly is the point — same-rank
// is denied, so a manager cannot touch another manager. Equal rank is
// permitted only through the self case.
function mutationAllowed(callerRole, callerEmail, targetRole, targetEmail) {
  if (callerRole === 'admin') return true
  const a = (callerEmail ?? '').trim().toLowerCase()
  const b = (targetEmail ?? '').trim().toLowerCase()
  if (a && a === b) return true                      // acting on self
  return rankOf(callerRole) > rankOf(targetRole)      // strictly higher
}

Deno.serve(async (req) => {
  // ── OPTIONS preflight ─────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { action, email, password, new_password } = body

    // Service-role client — bypasses RLS. NEVER expose these credentials
    // to a browser; this file runs only inside the Edge Function sandbox.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // ══════════════════════════════════════════════════════════════
    // 🔴 CALLER AUTHORIZATION — added 2026-09-21
    //
    // Until today this function had NONE. Probed live: a POST with no
    // Authorization header at all reached admin.createUser and was
    // stopped only by GoTrue's uniqueness check. reset_password takes
    // the new password in the same call, so it was direct takeover of
    // any non-admin account — a company_admin login is the whole tenant.
    //
    // Everything below runs BEFORE the action ladder, so no action body
    // needed to change.
    // ══════════════════════════════════════════════════════════════

    // ── 1. A token must be present ────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!bearer) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: jsonHeaders }
      )
    }

    // ── 2. Resolve WHO is calling, with an ANON client bound to their
    //      token. Not the service-role client above — that one answers
    //      for the service, not for the caller, and asking it who the
    //      caller is would always say "the service". getUser() validates
    //      the JWT signature and expiry, so a forged or stale token dies
    //      here rather than reaching an action.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      }
    )

    const { data: callerData, error: callerErr } = await callerClient.auth.getUser(bearer)
    const callerEmail = callerData?.user?.email ?? null
    if (callerErr || !callerEmail) {
      // Covers the anon key itself: it is a valid JWT but carries no
      // user, so getUser returns no email and we stop here. That is
      // exactly what closes the two manager call sites that used to
      // send it.
      console.error('[swift-handler] caller token did not resolve to a user:', callerErr?.message ?? 'no email on token')
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: jsonHeaders }
      )
    }

    // ── 3. Resolve the caller's ROLE with the SERVICE-ROLE client.
    //      get_user_role_by_email is service_role-only by deliberate
    //      grant — its own comment says granting it to anon or
    //      authenticated "leaks user roles by email". Do NOT widen that
    //      grant to simplify this; it would rebuild the enumeration
    //      oracle the grant exists to prevent.
    //
    //      The RPC matches on lower(email), which is required:
    //      user_roles.email is NOT stored lowercased. A plain equality
    //      lookup here would miss stored-capitals rows and deny a
    //      legitimate admin — the same trap the reset_password comment
    //      documents for the target side.
    const { data: callerRole, error: callerRoleErr } = await supabase
      .rpc('get_user_role_by_email', { p_email: callerEmail })

    if (callerRoleErr) {
      // 🔴 FAIL CLOSED. A check that cannot run must deny.
      console.error('[swift-handler] caller role lookup failed:', callerRoleErr)
      return new Response(
        JSON.stringify({ error: 'Authorization check failed' }),
        { status: 500, headers: jsonHeaders }
      )
    }
    if (!callerRole) {
      // Authenticated, but holds no role row. Fail closed.
      return new Response(
        JSON.stringify({ error: 'Not authorized for this action' }),
        { status: 403, headers: jsonHeaders }
      )
    }

    // ── 4. create_user — coarse gate, by design ───────────────────
    if (action === 'create_user' && !CREATE_ALLOWED_ROLES.includes(callerRole)) {
      return new Response(
        JSON.stringify({ error: 'Not authorized for this action' }),
        { status: 403, headers: jsonHeaders }
      )
    }

    // ── 5. reset / deactivate / activate — rank, with same-rank
    //      protection. Resolves the TARGET's role the same way.
    if (MUTATION_ACTIONS.includes(action)) {
      const { data: gateTargetRole, error: gateTargetErr } = await supabase
        .rpc('get_user_role_by_email', { p_email: email })

      if (gateTargetErr) {
        // 🔴 FAIL CLOSED, same as the caller lookup.
        console.error('[swift-handler] target role lookup failed:', gateTargetErr)
        return new Response(
          JSON.stringify({ error: 'Authorization check failed' }),
          { status: 500, headers: jsonHeaders }
        )
      }

      if (!mutationAllowed(callerRole, callerEmail, gateTargetRole, email)) {
        // One message for every denial reason. Saying "you cannot act on
        // an admin" would turn this endpoint into a role oracle: probe
        // an address, read which refusal comes back, learn their rank.
        return new Response(
          JSON.stringify({ error: 'Not authorized for this action' }),
          { status: 403, headers: jsonHeaders }
        )
      }
    }

    // ══════════════════════════════════════════════════════════════
    // END CALLER AUTHORIZATION — existing action ladder follows,
    // UNCHANGED.
    // ══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    // create_user — UNCHANGED FROM LIVE. Verify vs backup before paste.
    // ═══════════════════════════════════════════════════════════════
    if (action === 'create_user') {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { force_password_reset: true },
      })
      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 400, headers: jsonHeaders }
        )
      }
      return new Response(
        JSON.stringify({ ok: true, user_id: data?.user?.id }),
        { status: 200, headers: jsonHeaders }
      )
    }

    // ═══════════════════════════════════════════════════════════════
    // deactivate_user — Item 2 fix
    // ═══════════════════════════════════════════════════════════════
    if (action === 'deactivate_user') {
      // Deterministic email → auth.users.id via DEFINER RPC.
      // Replaces admin.listUsers().find() O(n) scan that silently
      // failed for 73% of auth.users past the newest-first 50-row
      // window. See migration 20260829_get_auth_user_id_by_email.sql.
      const { data: userId, error: lookupError } = await supabase
        .rpc('get_auth_user_id_by_email', { p_email: email })

      if (lookupError) {
        console.error('[swift-handler] deactivate_user lookup failed:', lookupError)
        return new Response(
          JSON.stringify({ error: 'Lookup failed: ' + lookupError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      if (!userId) {
        // Genuine "no such user." Distinct from a lookup ERROR above —
        // do NOT collapse them into a single 404, that was the shape
        // that produced a month of misleading "User not found".
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: jsonHeaders }
        )
      }

      // Ban duration: '876600h' = 100 years, expressed in the ONLY
      // unit GoTrue's Go time.ParseDuration accepts for large values.
      // Do NOT change to '100y' — parse error → silent ban failure.
      // Every existing 2126-… banned_until value in auth.users was
      // produced by this exact string.
      const { error: banError } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: '876600h',
      })
      if (banError) {
        console.error('[swift-handler] deactivate_user ban failed:', banError)
        return new Response(
          JSON.stringify({ error: banError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: jsonHeaders }
      )
    }

    // ═══════════════════════════════════════════════════════════════
    // activate_user — Item 2 fix (same shape as deactivate_user)
    // ═══════════════════════════════════════════════════════════════
    if (action === 'activate_user') {
      const { data: userId, error: lookupError } = await supabase
        .rpc('get_auth_user_id_by_email', { p_email: email })

      if (lookupError) {
        console.error('[swift-handler] activate_user lookup failed:', lookupError)
        return new Response(
          JSON.stringify({ error: 'Lookup failed: ' + lookupError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: jsonHeaders }
        )
      }

      // 'none' is the valid GoTrue literal to unlift a ban. Do NOT
      // pass an empty string or null — those may not parse as expected.
      const { error: unbanError } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        console.error('[swift-handler] activate_user unban failed:', unbanError)
        return new Response(
          JSON.stringify({ error: unbanError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: jsonHeaders }
      )
    }

    // ═══════════════════════════════════════════════════════════════
    // reset_password — Item 2 fix, plus guard fix
    // ═══════════════════════════════════════════════════════════════
    if (action === 'reset_password') {
      // ── Admin protection guard — via DEFINER RPC ────────────────
      // Case-insensitive role lookup (public.user_roles.email is NOT
      // stored lowercased; UNIQUE (lower(email)) is expression-index
      // only — a PostgREST .eq(email, lower) would miss stored-capitals
      // rows and fail open). See migration
      // 20260829_get_user_role_by_email.sql.
      //
      // 🔴 FAIL-CLOSED on guardError. A protection guard that can't
      // verify must DENY, not proceed. Mirrors GATE_EXEMPT_STATUSES
      // (resident/page.tsx:318) + COALESCE(v_in_scope, false) in
      // deactivate_vehicle.
      const { data: targetRole, error: guardError } = await supabase
        .rpc('get_user_role_by_email', { p_email: email })

      if (guardError) {
        console.error('[swift-handler] reset_password guard lookup failed:', guardError)
        return new Response(
          JSON.stringify({ error: 'Role check failed: ' + guardError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      if (targetRole === 'admin') {
        return new Response(
          JSON.stringify({ error: 'Unauthorized: Cannot reset admin passwords via this handler' }),
          { status: 403, headers: jsonHeaders }
        )
      }
      // targetRole is null (no user_roles row for this email) or a
      // non-admin role → proceed with reset.

      // ── Resolve the auth user id ────────────────────────────────
      const { data: userId, error: lookupError } = await supabase
        .rpc('get_auth_user_id_by_email', { p_email: email })

      if (lookupError) {
        console.error('[swift-handler] reset_password lookup failed:', lookupError)
        return new Response(
          JSON.stringify({ error: 'Lookup failed: ' + lookupError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'User not found' }),
          { status: 404, headers: jsonHeaders }
        )
      }

      // ── Perform the reset ──────────────────────────────────────
      const { error: resetError } = await supabase.auth.admin.updateUserById(userId, {
        password: new_password,
      })
      if (resetError) {
        console.error('[swift-handler] reset_password update failed:', resetError)
        return new Response(
          JSON.stringify({ error: resetError.message }),
          { status: 500, headers: jsonHeaders }
        )
      }
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: jsonHeaders }
      )
    }

    // ═══════════════════════════════════════════════════════════════
    // Unknown action
    // ═══════════════════════════════════════════════════════════════
    return new Response(
      JSON.stringify({ error: 'Unknown action: ' + String(action) }),
      { status: 400, headers: jsonHeaders }
    )

  } catch (e) {
    console.error('[swift-handler] outer catch:', e)
    return new Response(
      JSON.stringify({ error: (e as Error)?.message ?? String(e) }),
      { status: 500, headers: jsonHeaders }
    )
  }
})
