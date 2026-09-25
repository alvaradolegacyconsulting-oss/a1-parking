import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ════════════════════════════════════════════════════════════════════
// /api/visitor/refusal-log — record a /visitor refusal (2026-09-18)
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
// ---------------
// The phantom-property guard turns a visible-if-wrong outcome into a
// SILENT refusal. Before it, a visitor with no ?property= got a pass that
// didn't work; now they get a screen and we hear nothing. Without this we
// cannot answer either of the questions that matter: how many people are
// being turned away, and where they came from.
//
// The audit row for pass 1480 recorded {"property":"Managed Property"} —
// the bug's own output rather than what the visitor did, which is exactly
// why the 22 cannot be explained from logs today. This records the INPUT:
// the raw URL as it arrived and the referrer that sent them.
//
// 🔴 ABUSE SURFACE — READ BEFORE EXTENDING
// This is an UNAUTHENTICATED endpoint that writes a row. That is a
// log-flooding vector: anything can POST to it in a loop and grow
// audit_logs without bound. It is accepted here because the row is tiny,
// the shape is fixed, and the alternative is flying blind on a guard we
// just shipped in front of live visitors. Bounds that keep it small:
//   • action string is a constant — the caller cannot choose it
//   • every captured field is truncated to a fixed length
//   • nothing from the request body is echoed back
//   • no caller-supplied table, id or column
// NOT bounded: request rate. If audit_logs growth becomes visible, put a
// rate limit or Turnstile in front of this rather than widening it.
// Reviewed by Jose before this ships is the right order.
//
// Deliberately NOT here: no PII. Plate, name and unit are not recorded —
// this answers "how many, from where", not "who".

const MAX = 500
const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX) : null)

// 🔴 2026-09-25 — the caller may now name a reason, but ONLY from this
// list. The header above promises the caller cannot choose the action
// string; the same discipline applies here. An unrecognised value is
// discarded and the reason falls back to the derived one, so this stays
// a fixed-shape row rather than a free-text sink.
//
// resolver_error is new and is the important one: it means the lookup
// FAILED, not that the property is missing. Five real visitors were
// turned away with 'unresolvable_property' on byte-identical property
// names because those two outcomes could not be told apart.
const REASONS = new Set(['no_property_param', 'unresolvable_property', 'resolver_error'])

// Bounded diagnostic bag. Fixed keys, clipped values — enough to tell a
// dropped connection from a server refusal without becoming a channel.
function detailOf(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const d = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (d.error_message !== undefined) out.error_message = clip(d.error_message)
  if (d.error_code !== undefined) out.error_code = clip(d.error_code)
  if (typeof d.attempts === 'number') out.attempts = Math.min(Math.trunc(d.attempts), 99)
  if (typeof d.online === 'boolean' || d.online === null) out.online = d.online
  if (d.source !== undefined) out.source = clip(d.source)
  return Object.keys(out).length ? out : undefined
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>))

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    await supabase.from('audit_logs').insert([{
      action: 'VISITOR_PASS_REFUSED_NO_PROPERTY',
      table_name: 'visitor_passes',
      record_id: null,
      new_values: {
        // What the visitor actually sent us — the thing the pass-1480
        // audit row failed to capture.
        raw_url: clip(body.rawUrl),
        raw_property_param: clip(body.rawProperty),
        // Referrer from the header, not the body: a client-supplied
        // referrer is whatever the client says it is.
        referrer: clip(request.headers.get('referer')) ?? clip(body.referrer),
        user_agent: clip(request.headers.get('user-agent')),
        reason: (typeof body.reason === 'string' && REASONS.has(body.reason))
          ? body.reason
          : (body.rawProperty ? 'unresolvable_property' : 'no_property_param'),
        detail: detailOf(body.detail),
      },
    }])

    // Always 200, always the same body. A refusal log that reports its own
    // failure to the caller tells a prober what it managed to write.
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }
}
