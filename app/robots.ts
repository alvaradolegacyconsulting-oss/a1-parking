import type { MetadataRoute } from 'next'

// robots.txt for the public site.
//
// ── 2026-09-23: this file finally reaches crawlers ──────────────────
//
// Until today /robots.txt was itself matched by middleware and
// 307-redirected to /login for anonymous traffic, so none of these rules
// reached anyone. A robots.txt that resolves to an HTML login page is read
// as allow-all — the effect was the OPPOSITE of the gate this file looks
// like. Nothing leaked, because every disallowed portal below is
// login-gated in its own right, but the belt B85 wrote was not fastened.
// See the matcher note in middleware.ts for why it lives in the exclusion
// rather than in publicPaths.
//
// 🔴 Because the file now takes effect, its contents have to be true.
//
// /help moved allow → disallow. B85 wrote "/help is openly indexable",
// and it was, until 136bb46 (2026-07-12) deliberately gated the help
// center behind auth: it is a subscriber-operator manual, and a towed
// vehicle owner who googles into the tow-ticket doc and mails support@
// reaches an inbox with no remit to help them. That ruling stands, so
// inviting a crawler to /help would invite it to a login redirect.
//
// /operators added: the ad landing page the printed campaign codes
// redirect to. It renders server-side and is the one page we actively
// want crawled.
//
// Per-page `noindex` meta still exists on help docs, but it is NOT a
// gate — it sets a crawler hint and renders the page in full. Do not rely
// on it to withhold anything. See
// docs/backlog/help-attorney-review-flag-does-not-withhold-2026-09-23.md.
//
// 🔴 `allow` is a claim that an anonymous visitor gets the page. Check a
// route logged out before listing it here.

const BASE = 'https://shieldmylot.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/operators', '/terms', '/privacy', '/saas', '/signup'],
        disallow: [
          '/admin',
          '/company_admin',
          '/manager',
          '/driver',
          '/resident',
          '/history',
          '/help',
          '/login',
          '/change-password',
          '/qr',
          '/visitor',
          '/visitor-select',
          '/api/',
          '/account-cancelled',
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  }
}
