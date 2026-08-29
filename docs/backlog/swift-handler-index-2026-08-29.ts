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
// ── ⚠ RECONSTRUCTION DISCLOSURE ─────────────────────────────────────
// I do NOT have the current live swift-handler source in the repo — it
// lives only in the Supabase dashboard. This file is a best-effort
// reconstruction based on: (a) fragments Mateo pasted in the Item 2
// diagnosis, (b) call-site behavior in app/**/*.tsx, (c) standard
// Supabase Edge Function conventions, (d) supabase-js@2.105.0
// admin API shape.
//
// 🔴 JOSE: BEFORE PASTING, DIFF THIS FILE AGAINST YOUR BACKUP OF THE
// CURRENT LIVE SOURCE. If any of the following diverge from the
// current live shape, KEEP THE LIVE SHAPE and adjust this file:
//   - `import { createClient }` source URL (esm.sh version pin)
//   - `corsHeaders` exact keys/values
//   - `create_user` branch body (specifically: user_metadata fields,
//     response shape) — Mateo Aug 29 checklist item 8 says
//     "create_user UNTOUCHED"; if my reconstruction drifts from your
//     live version, use the live version verbatim
//   - Outer try/catch shape (whether the live version has one)
//   - Any other unchanged fixture I don't know about
//
// The three CHANGED branches (deactivate_user, activate_user,
// reset_password) are the load-bearing part of this deploy and their
// shapes are checklist-driven per swift-handler-listusers-fix-2026-08-29.md.
// The unchanged create_user + fixtures are my best guess and must be
// verified against your backup.
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
//  8. create_user branch present (reconstruction — verify vs backup). ⚠
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
