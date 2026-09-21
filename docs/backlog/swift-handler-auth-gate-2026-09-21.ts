// @ts-nocheck
// ════════════════════════════════════════════════════════════════════
// swift-handler AUTHORIZATION GATE — additive block (2026-09-21)
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THIS IS NOT A FULL-FILE REPLACEMENT. It is two blocks to INSERT
// into the source already in the Supabase dashboard. Nothing existing is
// rewritten. Paste a full file and you risk silently replacing a working
// branch with a draft of it.
//
// 🔴 BEFORE PASTING ANYTHING: save the current live source verbatim to a
// file. There is no git revert for a dashboard function. That saved copy
// IS the rollback.
//
// 🔴 DEPLOY ORDER IS A HARD CONSTRAINT:
//   1. Ship the client commit first (manager:2745 + manager:2876 switch
//      from the anon key to the session token). Harmless while the
//      function still ignores the token — nothing changes for users.
//      Confirm both manager flows still work.
//   2. THEN paste this. The gate turns on with every caller already
//      sending a real token.
// Reverse the order and both manager flows 401 the moment you paste.
//
// Leave platform verify_jwt OFF. Turning it on is a second gate that
// would also reject anon-key callers; it is a defence-in-depth follow-up
// for after every caller sends a token, not now.
//
// ── WHAT CHANGES ────────────────────────────────────────────────────
// NOTHING inside create_user / deactivate_user / activate_user /
// reset_password changes. Not one line. All gating happens before the
// `if (action === …)` ladder is reached, which is why the confirmed-live
// bodies can stay exactly as they are.
//
// One deliberate consequence: reset_password will look up the target
// role TWICE — once in BLOCK 2 below, once in its own existing body.
// That is a duplicate read of a cheap, side-effect-free DEFINER function,
// chosen over editing a working branch. Do not "optimise" it by deleting
// the guard inside reset_password; that guard is the one piece of
// authorization this function already had.
// ════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════
// BLOCK 1 — INSERT AT MODULE SCOPE
//
// Insertion point: immediately AFTER
//     const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }
// and BEFORE
//     Deno.serve(async (req) => {
// ════════════════════════════════════════════════════════════════════

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


// ════════════════════════════════════════════════════════════════════
// BLOCK 2 — INSERT INSIDE Deno.serve
//
// Insertion point: immediately AFTER the existing service-role client
//     const supabase = createClient(
//       Deno.env.get('SUPABASE_URL') ?? '',
//       Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
//       { auth: { autoRefreshToken: false, persistSession: false } }
//     )
// and BEFORE
//     if (action === 'create_user') {
// ════════════════════════════════════════════════════════════════════

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
