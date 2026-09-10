import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'

// ════════════════════════════════════════════════════════════════════
// Signed-URL issuer for tow-log media.
//
// vehicle_removal_media stores a PATH, never a URL, and the
// `vehicle-removal-photos` bucket is PRIVATE. This route is the only
// thing that turns a stored path into something a browser can render.
//
// ── 🔴 CALLER'S SESSION, NEVER SERVICE ROLE ─────────────────────────
// createSupabaseServerClient() builds a client from the request's
// cookies, so every query and the signing call itself run AS THE
// CALLER. That is the point: `removal_photos_manager_all` and
// `removal_photos_ca_all` on storage.objects are the access control,
// and signing through the caller means those policies actually
// execute.
//
// Routing around them with the service-role key would work, and would
// leave the policies never exercised and their correctness unknown —
// which is exactly how the proposal-PDF storage policy stayed broken
// from May to September without anyone noticing. A policy no request
// path exercises is a policy nobody has tested.
//
// ── TWO INDEPENDENT GATES, ON PURPOSE ───────────────────────────────
//   1. The path must resolve to a LIVE row in vehicle_removal_media
//      that the caller can SELECT. That table's RLS scopes a manager to
//      assigned properties and a company_admin to their company, so an
//      arbitrary path — including one uploaded but never attached
//      (the path_mismatch case) — is refused here.
//   2. createSignedUrl runs as the caller, so storage.objects RLS must
//      independently allow the read.
//
// Either gate alone would be defensible. Both means a regression in one
// does not silently become an access leak, and gate 1 gives a clean
// 403 instead of a bare storage error.
//
// ── TTL ─────────────────────────────────────────────────────────────
// A signed URL is BEARER ACCESS for its whole lifetime — anyone holding
// the link can fetch the object, session or not. These are displayed
// immediately on a detail panel, so the window only has to cover the
// render. Three minutes. There is no reason to mint an hour-long token
// for a photo that is about to appear on screen.
//
// ── BOUNDARY (DECISION_tow_log_is_a_log_sept9_2026) ─────────────────
// This route serves MANAGERS AND COMPANY ADMINS looking at their own
// records. It is not a resident- or owner-facing retrieval path, and it
// must not become one — no unauthenticated token, no share link, no
// "send the owner their photos". That is the line the decision doc
// draws, and a read path is exactly where someone will want to cross it.
// ════════════════════════════════════════════════════════════════════

const BUCKET = 'vehicle-removal-photos'
const TTL_SECONDS = 180
const MAX_PATHS = 25

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()

  // ── 1. Auth ───────────────────────────────────────────────────────
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // ── 2. Input ──────────────────────────────────────────────────────
  let paths: string[]
  try {
    const body = await req.json()
    paths = Array.isArray(body?.paths) ? body.paths.filter((p: unknown) => typeof p === 'string' && p.length > 0) : []
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (paths.length === 0) {
    return NextResponse.json({ error: 'no_paths' }, { status: 400 })
  }
  if (paths.length > MAX_PATHS) {
    return NextResponse.json({ error: 'too_many_paths' }, { status: 400 })
  }

  // ── 3. Gate 1 — the path must be an attachment this caller can read.
  // RLS on vehicle_removal_media does the scoping. A path the caller
  // cannot see comes back as an ABSENT ROW, not an error
  // (feedback_rls_denials_return_empty_not_error), so absence is
  // treated as a denial rather than as a lookup failure.
  const { data: rows, error: mediaErr } = await supabase
    .from('vehicle_removal_media')
    .select('storage_path')
    .in('storage_path', paths)
    .is('removed_at', null)
  if (mediaErr) {
    console.error('[tow-log media-url] media lookup failed', mediaErr)
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 })
  }
  const allowed = new Set((rows ?? []).map(r => r.storage_path as string))

  const refused = paths.filter(p => !allowed.has(p))
  if (refused.length > 0) {
    // Path only — never the caller's email or the reason. The console
    // line is for us; the response says nothing about why.
    console.warn('[tow-log media-url] refused paths (not attached, or out of scope)', { count: refused.length })
  }

  // ── 4. Gate 2 — sign AS THE CALLER. storage.objects RLS runs here.
  const urls: Record<string, string> = {}
  const failed: string[] = []
  for (const path of paths) {
    if (!allowed.has(path)) { failed.push(path); continue }
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, TTL_SECONDS)
    if (error || !data?.signedUrl) {
      // Reaching here with gate 1 passed means the two boundaries
      // disagree — the attachment row is visible but the object is not.
      // Worth a loud log: it is a policy-drift signal, not routine.
      console.error('[tow-log media-url] signing refused by storage RLS despite a visible media row', {
        path, message: error?.message,
      })
      failed.push(path)
      continue
    }
    urls[path] = data.signedUrl
  }

  return NextResponse.json({ urls, failed, expiresInSeconds: TTL_SECONDS })
}
