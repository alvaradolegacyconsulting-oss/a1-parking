// ════════════════════════════════════════════════════════════════════
// qr-print — shared QR print-sign template used by CA + Manager portals
// 2026-07-16 — extracted from app/company_admin/page.tsx to eliminate
// the drift class that produced last night's cluster (Bug 1/5 crossed
// resident-header). Both portals now import from this module; a fix in
// one file benefits both surfaces forever.
//
// ── ORIGIN ──────────────────────────────────────────────────────────
// Pre-2026-07-15, the CA portal had TWO QR-print templates that had
// drifted apart (visitor + inline resident), causing the resident-
// signup sign to render with the visitor header. Commit e8797a6
// consolidated the two CA templates into a single parameterized
// printQRSign function.
//
// Then we found the Manager portal had its OWN two inline
// tw.document.write templates — a THIRD and FOURTH copy of the
// same shape. Extracting to this shared module means:
//   • Both portals render identical visitor / resident signs
//   • Bug fixes land once, apply everywhere
//   • Future portals (leasing_agent view, e.g.) get the same UX free
//
// ── STILL INLINE (deliberately, for a followup) ─────────────────────
// app/company_admin/page.tsx `printAllPropertyQRSigns` — CA-only bulk
// print that renders N cards in one print doc. Has its own copy of
// the visitor card HTML. Consolidating it with this module would
// require extracting a shared buildQRCardHtml() helper. Filed as
// followup (see project_qr_consolidation_followup memory).
//
// ── SCOPE — this module does NOT know ──────────────────────────────
//   • The DOM (only reads a canvas by id via document.getElementById)
//   • React (plain TS function, no hooks)
//   • Auth / role / tenancy (no DB access; caller supplies `company`)
//   • Any portal-specific state
// If it grows dependencies on any of those, revisit the split.
// ════════════════════════════════════════════════════════════════════

export type QRSignKind = 'visitor' | 'resident' | 'claim'

// ════════════════════════════════════════════════════════════════════
// The copy table, extracted so a gate can assert it WITHOUT a DOM
// ════════════════════════════════════════════════════════════════════
// printQRSign reads a canvas and opens a window, so it cannot be called
// from a test runner. The part worth asserting is the copy — which sign
// says "approval required" and which does not — so that part is a pure
// function and the gate calls it directly.
export interface QRSignCopy {
  pageTitle: string
  heading:   string
  subhead:   string
  noteTitle: string
  noteBody:  string
  /** Visitor-only. Residents being onboarded have not parked yet. */
  warn:      boolean
}

export function qrSignCopy(kind: QRSignKind): QRSignCopy {
  switch (kind) {
    case 'resident':
      return {
        pageTitle: 'Resident Registration Sign',
        heading:   'Resident Registration',
        subhead:   'Scan to register your unit',
        noteTitle: 'One-time setup',
        noteBody:  'Manager approval required before access',
        warn:      false,
      }
    // 🔴 A THIRD KIND, NOT A REUSE OF 'resident', FOR ONE REASON: the
    // resident sign says "Manager approval required before access", and
    // for a bulk-loaded resident that is FALSE. Their record was created
    // and approved by their own property during the import — the only
    // thing they lack is a login. Printing "approval required" on their
    // flyer would tell them to wait for something that already happened,
    // and the likeliest result is a call to the office.
    //
    // It also must not promise a link to someone with no record: the
    // claim route mails nothing to an unknown address, so the copy says
    // what the resident should EXPECT ("if your property added you"),
    // not what will happen.
    case 'claim':
      return {
        pageTitle: 'Resident Login Setup Sign',
        heading:   'Set Up Your Login',
        subhead:   'Scan and enter your email',
        noteTitle: 'Already added by your property',
        noteBody:  'Nothing to fill in — if your property added you, a setup link arrives by email',
        warn:      false,
      }
    default:
      return {
        pageTitle: 'Visitor Parking Sign',
        heading:   'Visitor Parking',
        subhead:   'Scan to get your parking pass',
        noteTitle: 'Required before parking',
        noteBody:  'Valid up to 24 hours · No app download needed',
        warn:      true,
      }
  }
}

// ════════════════════════════════════════════════════════════════════
// buildQRCardHtml — the card itself, so there is one of it
// ════════════════════════════════════════════════════════════════════
// Extracted 2026-10-16, on the third consumer rather than the second.
// printQRSign had this markup inline, and the CA's bulk print
// (printAllPropertyQRSigns) had its own copy with the visitor strings
// hardcoded instead of read from qrSignCopy. Piece 2's printable
// visitor pass would have been the third. The module header already
// recorded the first consolidation — four copies down to two — and
// named this extraction as the remaining followup.
//
// 🔴 The two copies had not drifted, which is the only reason this is a
// pure move: qrSignCopy('visitor') returns exactly the strings the bulk
// template had hardcoded, and `company || heading` is `company ||
// 'Visitor Parking'` when kind is visitor. Verified string-by-string
// before extracting rather than assumed from their looking alike.
//
// Returns the <div class="card"> only. The surrounding document — its
// <style>, its page-break rules, its print trigger — stays with each
// caller, because that is where they genuinely differ: one card
// centred on a page, or N cards with a break after each.
export interface QRCardOptions {
  /** Picks the heading, subhead, note and whether the tow warning shows. */
  kind?: QRSignKind
  /** Tenant name for the header strip. Falls back to the kind's heading. */
  company?: string
  /** The QR image, already rendered to a data URL by the caller. */
  dataUrl: string
  /** Property name, or whatever names this card's subject. */
  title: string
  /** Address line under the title. */
  subtitle: string
  /** Printed as fallback text under the code, so a failed scan is typable. */
  url?: string
}

export function buildQRCardHtml(opts: QRCardOptions): string {
  const { kind = 'visitor', company, dataUrl, title, subtitle, url } = opts
  const copy = qrSignCopy(kind)
  const noteHtml = `<div class="note"><p style="color:#856404;font-size:12px;font-weight:bold;margin-bottom:2px">${copy.noteTitle}</p><p style="color:#856404;font-size:11px">${copy.noteBody}</p></div>`
  // Tow warning is visitor-only. Residents are being onboarded — a "your
  // car will be towed" banner on their signup sign is jarring and
  // semantically wrong (they haven't registered yet).
  const warnHtml = copy.warn
    ? '<div class="warn"><p style="color:#721c24;font-size:12px;font-weight:bold;margin-bottom:2px">⚠ Unregistered vehicles will be towed</p><p style="color:#721c24;font-size:11px">without notice at owner\'s expense</p></div>'
    : ''
  const urlFallback = url
    ? `<p style="font-size:10px;color:#666;margin-top:14px;word-break:break-all;font-family:'Courier New',monospace">${url}</p>`
    : ''

  return `<div class="card">
      <div class="hdr">
        <p style="color:#C9A227;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em">${company || copy.heading}</p>
      </div>
      <p style="font-size:22px;font-weight:bold;color:#111;margin-bottom:4px">${copy.heading}</p>
      <p style="font-size:14px;color:#333;margin-bottom:20px">${copy.subhead}</p>
      <img src="${dataUrl}" style="width:200px;height:200px;display:block;margin:0 auto 16px" />
      <p style="font-size:15px;font-weight:bold;color:#111;margin-bottom:4px">${title}</p>
      <p style="font-size:11px;color:#555;margin-bottom:0">${subtitle}</p>
      ${noteHtml}
      ${warnHtml}
      ${urlFallback}
    </div>`
}

export interface PrintQRSignOptions {
  /** DOM id of the container holding the on-screen <canvas> (from QRCodeCanvas). */
  canvasId: string
  /** Bold heading UNDER the QR — typically the property name. */
  title: string
  /** Smaller text under the title — typically the property address or a short caption. */
  subtitle: string
  /**
   * Which sign flavor to render. Determines page title, header, subhead,
   * note copy, and whether the tow-warning renders.
   *   visitor  → "Visitor Parking" / "Scan to get your parking pass"
   *              + "Required before parking · Valid up to 24 hours"
   *              + tow-warning
   *   resident → "Resident Registration" / "Scan to register your unit"
   *              + "One-time setup · Manager approval required"
   *              + NO tow-warning (jarring on a signup sign)
   *   claim    → "Set Up Your Login" / "Scan and enter your email"
   *              + "Already added by your property"
   *              + NO tow-warning, and 🔴 NO "approval required": a
   *                bulk-loaded resident was approved by their own
   *                property at import time. See qrSignCopy.
   * Default: 'visitor'.
   */
  kind?: QRSignKind
  /**
   * Optional human-readable fallback URL rendered under the QR image.
   * The camera-can't-focus insurance. If omitted, no URL text renders.
   */
  url?: string
  /**
   * Header company/brand text at the top of the card. Falls back to
   * the kind's default heading ('Visitor Parking' / 'Resident Registration')
   * if omitted. CA portal passes `role?.company`; Manager passes the
   * manager's derived company name.
   */
  company?: string
}

export function printQRSign(opts: PrintQRSignOptions): void {
  const {
    canvasId,
    title,
    subtitle,
    kind = 'visitor',
    url,
    company,
  } = opts

  const container = document.getElementById(canvasId)
  const canvas = container?.querySelector('canvas') as HTMLCanvasElement | null
  const dataUrl = canvas?.toDataURL('image/png') || ''
  const tw = window.open('', '_blank')
  if (!tw) return

  // The copy table still answers pageTitle here; the card itself comes
  // from buildQRCardHtml, which the CA's bulk print also uses.
  const { pageTitle } = qrSignCopy(kind)
  const cardHtml = buildQRCardHtml({ kind, company, dataUrl, title, subtitle, url })

  tw.document.write(`<!DOCTYPE html><html><head><title>${pageTitle}</title><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:380px;width:100%;text-align:center;border:3px solid #C9A227;border-radius:16px;padding:32px;margin:0 auto}
    .hdr{background:#0f1117;border-radius:8px;padding:12px;margin-bottom:20px}
    .note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;margin-top:14px}
    .warn{background:#f8d7da;border:1px solid #f5c6cb;border-radius:6px;padding:10px;margin-top:10px}
    @media print{body{min-height:auto}}
  </style></head><body>
    ${cardHtml}
    <script>window.onload=function(){window.print()}</script>
  </body></html>`)
  tw.document.close()
}
