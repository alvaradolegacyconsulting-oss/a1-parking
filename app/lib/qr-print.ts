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

export type QRSignKind = 'visitor' | 'resident'

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

  const isResident = kind === 'resident'
  const pageTitle  = isResident ? 'Resident Registration Sign' : 'Visitor Parking Sign'
  const heading    = isResident ? 'Resident Registration'      : 'Visitor Parking'
  const subhead    = isResident ? 'Scan to register your unit' : 'Scan to get your parking pass'
  const noteHtml   = isResident
    ? '<div class="note"><p style="color:#856404;font-size:12px;font-weight:bold;margin-bottom:2px">One-time setup</p><p style="color:#856404;font-size:11px">Manager approval required before access</p></div>'
    : '<div class="note"><p style="color:#856404;font-size:12px;font-weight:bold;margin-bottom:2px">Required before parking</p><p style="color:#856404;font-size:11px">Valid up to 24 hours · No app download needed</p></div>'
  // Tow warning is visitor-only. Residents are being onboarded — a "your
  // car will be towed" banner on their signup sign is jarring and
  // semantically wrong (they haven't registered yet).
  const warnHtml = isResident
    ? ''
    : '<div class="warn"><p style="color:#721c24;font-size:12px;font-weight:bold;margin-bottom:2px">⚠ Unregistered vehicles will be towed</p><p style="color:#721c24;font-size:11px">without notice at owner\'s expense</p></div>'
  const urlFallback = url
    ? `<p style="font-size:10px;color:#666;margin-top:14px;word-break:break-all;font-family:'Courier New',monospace">${url}</p>`
    : ''

  tw.document.write(`<!DOCTYPE html><html><head><title>${pageTitle}</title><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:380px;width:100%;text-align:center;border:3px solid #C9A227;border-radius:16px;padding:32px;margin:0 auto}
    .hdr{background:#0f1117;border-radius:8px;padding:12px;margin-bottom:20px}
    .note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;margin-top:14px}
    .warn{background:#f8d7da;border:1px solid #f5c6cb;border-radius:6px;padding:10px;margin-top:10px}
    @media print{body{min-height:auto}}
  </style></head><body>
    <div class="card">
      <div class="hdr">
        <p style="color:#C9A227;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em">${company || heading}</p>
      </div>
      <p style="font-size:22px;font-weight:bold;color:#111;margin-bottom:4px">${heading}</p>
      <p style="font-size:14px;color:#333;margin-bottom:20px">${subhead}</p>
      <img src="${dataUrl}" style="width:200px;height:200px;display:block;margin:0 auto 16px" />
      <p style="font-size:15px;font-weight:bold;color:#111;margin-bottom:4px">${title}</p>
      <p style="font-size:11px;color:#555;margin-bottom:0">${subtitle}</p>
      ${noteHtml}
      ${warnHtml}
      ${urlFallback}
    </div>
    <script>window.onload=function(){window.print()}</script>
  </body></html>`)
  tw.document.close()
}
