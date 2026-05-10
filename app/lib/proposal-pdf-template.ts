// PDF HTML renderer for proposal codes. Inline CSS only (Puppeteer
// embeds whatever <img> URLs it can fetch, so the platform logo is
// referenced by absolute URL in <img src>).

import { TIER_PRICING, TIER_DISPLAY_NAME, TierType } from './tier-config'

export type ProposalForPdf = {
  code: string
  client_name: string | null
  client_email: string | null
  base_tier_type: string | null
  base_tier: string | null
  expires_at: string | null
  custom_base_fee: number | null
  custom_per_property_fee: number | null
  custom_per_driver_fee: number | null
  feature_overrides: Record<string, boolean | number> | null
  generated_at: string | null
}

function tierDefaultPerProperty(tt: string, t: string): number {
  if (tt === 'enforcement') return t === 'starter' ? 15 : t === 'growth' ? 12 : 10
  return t === 'essential' ? 20 : t === 'professional' ? 15 : 10
}
function tierDefaultPerDriver(tt: string, t: string): number {
  if (tt !== 'enforcement') return 0
  return t === 'starter' ? 10 : t === 'growth' ? 8 : 6
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—'
  return `$${Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch { return iso }
}
function escape(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function renderProposalPdfHtml(p: ProposalForPdf, opts: { logoUrl: string | null; appUrl: string }): string {
  const tt = (p.base_tier_type || 'enforcement') as TierType
  const t = p.base_tier || 'legacy'
  const isEnf = tt === 'enforcement'
  const tierLabel = TIER_DISPLAY_NAME[tt]?.[t] || t
  const trackLabel = isEnf ? 'Enforcement' : 'Property Management'

  const baseDefault = TIER_PRICING[tt]?.[t] ?? 0
  const propDefault = tierDefaultPerProperty(tt, t)
  const drvDefault = tierDefaultPerDriver(tt, t)

  const baseFee = p.custom_base_fee != null ? p.custom_base_fee : baseDefault
  const propFee = p.custom_per_property_fee != null ? p.custom_per_property_fee : propDefault
  const drvFee = p.custom_per_driver_fee != null ? p.custom_per_driver_fee : drvDefault

  const overrides = p.feature_overrides && Object.keys(p.feature_overrides).length ? p.feature_overrides : null
  const acceptanceUrl = `${opts.appUrl}/proposal/${p.code}`

  const logoBlock = opts.logoUrl
    ? `<img src="${escape(opts.logoUrl)}" alt="ShieldMyLot" style="height:48px;width:48px;border-radius:6px;border:1px solid #C9A227;object-fit:contain" />`
    : ''

  const overrideRows = overrides
    ? Object.entries(overrides).map(([k, v]) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:Courier,monospace;font-size:11px;color:#333">${escape(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:11px;color:#111;text-align:right">${escape(String(v))}</td></tr>`
      ).join('')
    : ''

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>ShieldMyLot Subscription Proposal — ${escape(p.code)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#111;background:white;padding:36px 40px;font-size:12px;line-height:1.55}
  .hdr{display:flex;align-items:center;gap:14px;padding-bottom:14px;border-bottom:3px solid #C9A227;margin-bottom:18px}
  .hdr-text{flex:1}
  .brand{color:#C9A227;font-weight:700;font-size:16px;letter-spacing:0.02em}
  .legal{color:#555;font-size:10px;margin-top:2px}
  .title{font-size:20px;font-weight:700;color:#0a1f3d;margin:6px 0 0}
  .sec{margin:18px 0}
  .sh{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#C9A227;border-bottom:1px solid #eee;padding-bottom:4px;margin-bottom:8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
  .f label{display:block;font-size:9px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.05em}
  .f span{display:block;font-size:13px;color:#111;margin-top:2px}
  .pricing{background:#fafafa;border:1px solid #eee;border-radius:6px;padding:12px 14px}
  .price-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #eee}
  .price-row:last-child{border-bottom:none}
  .price-label{color:#333;font-size:12px}
  .price-val{color:#111;font-size:12px;font-weight:600;font-family:Arial}
  .price-default{color:#888;font-size:10px;font-style:italic;margin-left:6px}
  .badge{display:inline-block;background:#0a1f3d;color:#C9A227;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:0.05em}
  .accept{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
  .accept-card{border:1px solid #ccc;border-radius:6px;padding:14px}
  .accept-card h4{font-size:11px;font-weight:700;color:#C9A227;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px}
  .accept-url{font-family:Courier,monospace;font-size:10px;color:#0a1f3d;word-break:break-all}
  .sig-line{border-bottom:1px solid #333;height:28px;margin-top:8px}
  .sig-label{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px}
  .ftr{margin-top:24px;padding-top:10px;border-top:2px solid #C9A227;font-size:9px;color:#666;text-align:center;line-height:1.6}
  table{width:100%;border-collapse:collapse}
</style>
</head>
<body>
  <div class="hdr">
    ${logoBlock}
    <div class="hdr-text">
      <div class="brand">ShieldMyLot™</div>
      <div class="legal">Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™</div>
      <div class="title">Subscription Proposal</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.05em">Proposal Code</div>
      <div style="font-family:Courier,monospace;font-size:14px;font-weight:700;color:#C9A227">${escape(p.code)}</div>
      <div style="font-size:9px;color:#888;margin-top:6px;text-transform:uppercase;letter-spacing:0.05em">Issued</div>
      <div style="font-size:11px;color:#111">${escape(fmtDate(p.generated_at))}</div>
    </div>
  </div>

  <div class="sec">
    <div class="sh">1. Client</div>
    <div class="grid">
      <div class="f"><label>Company / Client Name</label><span>${escape(p.client_name || '—')}</span></div>
      <div class="f"><label>Primary Contact Email</label><span>${escape(p.client_email || '—')}</span></div>
    </div>
  </div>

  <div class="sec">
    <div class="sh">2. Subscription Terms</div>
    <div style="margin-bottom:10px"><span class="badge">${escape(trackLabel)} · ${escape(tierLabel)}</span></div>
    <div class="pricing">
      <div class="price-row">
        <span class="price-label">Base Subscription Fee
          ${p.custom_base_fee != null ? '<span class="price-default">(custom — overrides tier default)</span>' : ''}
        </span>
        <span class="price-val">${fmtUsd(baseFee)} / month</span>
      </div>
      <div class="price-row">
        <span class="price-label">Per-Property Fee
          ${p.custom_per_property_fee != null ? '<span class="price-default">(custom)</span>' : ''}
        </span>
        <span class="price-val">${fmtUsd(propFee)} / property / month</span>
      </div>
      ${isEnf ? `
      <div class="price-row">
        <span class="price-label">Per-Driver Fee
          ${p.custom_per_driver_fee != null ? '<span class="price-default">(custom)</span>' : ''}
        </span>
        <span class="price-val">${fmtUsd(drvFee)} / driver / month</span>
      </div>` : ''}
      <div class="price-row">
        <span class="price-label">Annual Discount</span>
        <span class="price-val">2 months free (pay 10, get 12)</span>
      </div>
    </div>
  </div>

  ${overrides ? `
  <div class="sec">
    <div class="sh">3. Feature Overrides</div>
    <p style="font-size:10px;color:#555;margin-bottom:8px">The following features deviate from the standard <strong>${escape(tierLabel)}</strong> tier defaults:</p>
    <table>
      <thead>
        <tr><th style="text-align:left;padding:6px 8px;background:#fafafa;border-bottom:1px solid #ccc;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em">Feature Flag</th><th style="text-align:right;padding:6px 8px;background:#fafafa;border-bottom:1px solid #ccc;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em">Value</th></tr>
      </thead>
      <tbody>${overrideRows}</tbody>
    </table>
  </div>` : ''}

  <div class="sec">
    <div class="sh">${overrides ? '4' : '3'}. Expiration</div>
    <p style="font-size:12px;color:#111">
      This proposal must be accepted by <strong>${escape(fmtDate(p.expires_at))}</strong>
      or it will automatically expire.
    </p>
  </div>

  <div class="sec">
    <div class="sh">${overrides ? '5' : '4'}. Acceptance</div>
    <div class="accept">
      <div class="accept-card">
        <h4>Option A — Accept Online</h4>
        <p style="font-size:11px;color:#333;margin-bottom:8px">Visit the secure link below to accept and activate this proposal:</p>
        <p class="accept-url">${escape(acceptanceUrl)}</p>
      </div>
      <div class="accept-card">
        <h4>Option B — Sign and Return</h4>
        <div class="sig-line"></div>
        <div class="sig-label">Client Signature</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <div style="flex:1">
            <div class="sig-line"></div>
            <div class="sig-label">Print Name</div>
          </div>
          <div style="width:90px">
            <div class="sig-line"></div>
            <div class="sig-label">Date</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="ftr">
    Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ · support@shieldmylot.com<br/>
    Texas Transportation Code Chapter 2308 compliant · Licensed for Texas operations
  </div>
</body>
</html>`
}
