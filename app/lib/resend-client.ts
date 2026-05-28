import 'server-only'
import { Resend } from 'resend'

// B66.5 commit 4.1 (Foundation) — Resend SDK wrapper.
//
// SINGLE-PLACE-OF-TRUTH for Resend SDK access. Every email send in the
// codebase goes through this wrapper; no other module should import
// from 'resend' directly. Why:
//   • Centralizes API key handling + lazy-init pattern
//   • Centralizes structured logging (every send gets a tagged log line
//     with the Resend-side message_id — the verify-after-write equivalent
//     for email delivery)
//   • Centralizes error normalization (Resend SDK can fail in two ways:
//     thrown exception OR returned `{ data: null, error }` — wrapper
//     normalizes both into a discriminated union result)
//   • Single swap point if we ever change provider (Postmark, SES, etc.)
//
// LAZY-INIT pattern mirrors getStripe() — env var resolution + Resend
// instantiation deferred until first send call. This lets unrelated
// routes import this module without triggering a "missing env var"
// throw at module load time. Matches the [[feedback-vercel-env-var-
// workflow]] pattern: fail-loud at use time, not at import time.

const DEFAULT_FROM = 'noreply@mail.shieldmylot.com'

let resendInstance: Resend | null = null

function getResend(): Resend {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      throw new Error(
        'RESEND_API_KEY env var is not set. Configure on Vercel ' +
        '(Production + Preview scopes, Project-linked NOT Shared-orphaned) ' +
        'before deploy. Fails-closed by design.'
      )
    }
    resendInstance = new Resend(apiKey)
  }
  return resendInstance
}

// Discriminated union — at least one of html or text must be provided.
// React Email templates render to html (commit 4.2). Smoke endpoints +
// future text-only sends use either. Resend SDK rejects payloads with
// neither at the type level (CreateEmailOptions requires RequireAtLeast
// One of html/text/react); enforce at our boundary too.
export type SendEmailArgs = {
  to: string
  subject: string
  from?: string
} & (
  | { html: string; text?: string }
  | { html?: string; text: string }
)

export type SendEmailResult =
  | { ok: true; message_id: string }
  | { ok: false; error: string }

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const from = args.from ?? DEFAULT_FROM
  try {
    const resend = getResend()
    // Conditional-spread payload construction so undefined fields don't
    // collide with Resend's RequireAtLeastOne discriminator. Cast at the
    // SDK boundary: SendEmailArgs's discriminated union guarantees at
    // least one of html/text is defined; TS can't infer that across the
    // spread, so we assert to the SDK's parameter type. Runtime invariant
    // holds via the SendEmailArgs shape.
    const payload = {
      from,
      to: args.to,
      subject: args.subject,
      ...(args.html !== undefined && { html: args.html }),
      ...(args.text !== undefined && { text: args.text }),
    }
    const { data, error } = await resend.emails.send(
      payload as Parameters<typeof resend.emails.send>[0]
    )

    // Resend's API can return `error` (validation/auth/rate-limit failures)
    // without throwing. Treat that as a failure path.
    if (error) {
      console.error('[resend-client] send failed (api error)', {
        to: args.to, from, subject: args.subject, error: error.message,
      })
      return { ok: false, error: error.message }
    }

    // Defensive: `data` should be populated when error is null, but
    // guard against an SDK shape change that returns both null.
    if (!data?.id) {
      console.error('[resend-client] send returned no message_id', {
        to: args.to, from, subject: args.subject,
      })
      return { ok: false, error: 'Resend response missing message_id (data.id null)' }
    }

    // Success — log the verify-after-write equivalent (Resend's
    // internal message_id can be cross-referenced in their dashboard
    // logs to confirm delivery vs bounce vs defer).
    console.log('[resend-client] sent', {
      to: args.to, from, subject: args.subject, message_id: data.id,
    })
    return { ok: true, message_id: data.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[resend-client] send threw', {
      to: args.to, from, subject: args.subject, error: msg,
    })
    return { ok: false, error: msg }
  }
}
