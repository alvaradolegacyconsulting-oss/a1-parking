// ════════════════════════════════════════════════════════════════════
// DECLARED ANONYMOUS EXPOSURE — one entry per route the build emits
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS FILE EXISTS
// --------------------
// Three routes were omitted from the middleware allowlist in a single
// week — /api/visitor/refusal-log, /api/leads, then /robots.txt +
// /sitemap.xml + /saas. The failure mode was identical every time: build
// the route, forget the list, nothing errors, the route quietly 307s to
// /login, and it is found by accident whenever someone happens to look.
//
// A sweep finds today's omissions. It does nothing about the next route
// someone adds. So the sweep is committed, and this is its contract:
//
//   🔴 Every route in the build must appear below. A route with no
//      declared expectation FAILS the gate.
//
// That is the whole mechanism. Adding a route now forces a decision about
// who can reach it, at the moment the route is written, by someone who
// knows the answer — instead of leaving it to be discovered later by a
// person with no context reading a 307.
//
// Entries are keyed by the route pattern as the BUILD names it, dynamic
// segments included (`/help/[slug]`, not `/help/visitor-passes`). The
// gate reads .next/app-path-routes-manifest.json rather than walking the
// filesystem or parsing build stdout, because that manifest IS the
// build's own enumeration — the first version of this sweep filtered
// bracketed routes out of build stdout and missed 24 of 26 help routes.
//
// HOW TO ADD A ROUTE
// ------------------
// Pick the kind that describes what an ANONYMOUS visitor should get:
//
//   page          200 HTML. Anyone may load it. Content not asserted —
//                 use for client components that hydrate their content.
//   content       200 HTML that must contain `marker`. Use where the
//                 server-rendered copy is the point (crawlers, link
//                 previews, no-JS readers). /operators is `content`
//                 because it once returned 200 with an EMPTY SHELL.
//   asset         200 with a non-HTML content type. Machine-read files.
//   method-guard  405. The route exists and is public, but GET is not
//                 one of its methods — a POST endpoint answering 405
//                 proves it is reachable AND that it rejects the wrong
//                 verb. A 307 here would mean the allowlist forgot it.
//   auth-required 401/403 from the route's OWN check, not middleware.
//   login         30x to /login. Middleware gated it. This is the
//                 correct answer for every portal and every authed API.
//   redirect      30x to `to`. Declared destination is asserted.
//   skip          Not probeable over HTTP. MUST carry `why`.
//
// Dynamic routes carry `sample` — a concrete path to actually request,
// since `/help/[slug]` cannot be fetched. Declaring the pattern without
// a sample fails the gate: a pattern nobody can hit is not verified.
//
// 🔴 `login` is not a safe default. It is the answer for authenticated
// surfaces. If you are reaching for it because you are unsure, the route
// is not ready to ship.

export type Expectation =
  | { kind: 'page'; sample?: string; note?: string }
  | { kind: 'content'; marker: string; sample?: string; note?: string }
  | { kind: 'asset'; contentType: string; sample?: string; note?: string }
  | { kind: 'method-guard'; sample?: string; note?: string }
  | { kind: 'auth-required'; sample?: string; note?: string }
  | { kind: 'login'; sample?: string; note?: string }
  | { kind: 'redirect'; to: string; sample?: string; note?: string }
  | { kind: 'skip'; why: string }

// Routes that exist but are NOT app-router pages — next.config.ts
// redirects. Declared here so they are gated too; the stale-entry check
// knows to expect their absence from the build manifest.
export const NON_MANIFEST_ROUTES = new Set(['/morethantruck', '/swtowop'])

export const ROUTE_EXPOSURE: Record<string, Expectation> = {
  // ── Public marketing + legal ──────────────────────────────────────
  '/': { kind: 'page' },
  '/operators': {
    kind: 'content',
    marker: 'Interested in getting started?',
    note: 'Ad landing page. Asserted on CONTENT, not status: it once returned 200 with an empty shell because useSearchParams() forced a Suspense bailout out of server rendering. A 200 that renders nothing is not a working page.',
  },
  '/morethantruck': { kind: 'redirect', to: '/operators', note: 'Printed campaign short path. Query forwarding is proven separately by verify-operators-redirects.ts.' },
  '/swtowop': { kind: 'redirect', to: '/operators' },
  '/terms': { kind: 'page' },
  '/privacy': { kind: 'page' },
  '/saas': {
    kind: 'page',
    note: 'Added to publicPaths 2026-09-23. Built for public viewing (mirrors /terms + /privacy) but was 307ing to /login — the asymmetry with its two siblings was the diagnosis.',
  },

  // ── Machine-read files (matcher exclusion, not publicPaths) ───────
  '/robots.txt': {
    kind: 'asset',
    contentType: 'text/plain',
    note: 'Opened 2026-09-23. A robots.txt that resolves to an HTML login page is read as allow-all, so the B85 disallow list was reaching nobody.',
  },
  '/sitemap.xml': { kind: 'asset', contentType: 'application/xml' },
  '/manifest.webmanifest': { kind: 'asset', contentType: 'application/manifest+json' },
  '/favicon.ico': { kind: 'asset', contentType: 'image/x-icon' },
  '/icon.png': { kind: 'asset', contentType: 'image/png' },
  '/apple-icon.png': { kind: 'asset', contentType: 'image/png' },

  // ── Anonymous user journeys ───────────────────────────────────────
  '/login': { kind: 'page' },
  '/forgot-password': { kind: 'page' },
  '/reset-password': { kind: 'page' },
  '/reset-password-required': { kind: 'page' },
  '/change-password': { kind: 'page' },
  '/register': { kind: 'page' },
  '/visitor': { kind: 'page' },
  '/visitor-select': { kind: 'page' },
  '/auth/accept': { kind: 'page' },
  '/deactivated': { kind: 'page' },
  '/account-cancelled': { kind: 'page' },
  '/signup': {
    kind: 'page',
    note: 'Client component: serves a shell to crawlers. Deliberately NOT `content` — that gap is filed as docs/backlog/signup-client-shell-no-crawler-content-2026-09-23.md. Change to `content` when it renders server-side.',
  },
  '/signup/cancelled': { kind: 'page' },
  '/signup/success': { kind: 'page' },
  '/signup/verify': { kind: 'page' },
  '/signup/redeem': { kind: 'page' },
  '/signup/redeem/verify': { kind: 'page' },
  '/ticket/view/[token]': {
    kind: 'page',
    sample: '/ticket/view/gate-probe-not-a-real-token',
    note: 'Capability URL: the token IS the authorization, so the route must be publicly reachable. An invalid token must still render the route rather than redirect to /login — a login redirect here would break every ticket link we have ever sent.',
  },

  // ── Public POST endpoints (405 proves reachable + verb-guarded) ───
  '/api/leads': { kind: 'method-guard' },
  '/api/visitor/create-pass': { kind: 'method-guard' },
  '/api/visitor/refusal-log': { kind: 'method-guard' },
  '/api/register/create-user': { kind: 'method-guard' },
  '/api/register/companion-vehicle': { kind: 'method-guard' },
  '/api/register/captcha-verify': { kind: 'method-guard' },
  '/api/help-feedback': { kind: 'method-guard' },
  '/api/stripe/webhook': { kind: 'method-guard', note: 'Signature-verified in the handler; middleware must not gate it or Stripe retries would 307.' },
  '/api/signup/accept-saas': { kind: 'method-guard' },
  '/api/signup/attest': { kind: 'method-guard' },
  '/api/signup/create-checkout-session': { kind: 'method-guard' },
  '/api/signup/dormancy': {
    kind: 'page',
    note: 'Anonymous GET by design (B66.3): /signup reads it BEFORE the user reaches the auth-gated flow. Returns only whether public signup is open.',
  },

  // ── Cron: public route, own bearer check ──────────────────────────
  '/api/cron/dunning': { kind: 'auth-required', note: 'In publicPaths so Vercel Cron can reach it; the handler checks CRON_SECRET itself. 401 here is the handler working.' },
  '/api/cron/sync-permits': { kind: 'auth-required' },

  // ── Authenticated portals ─────────────────────────────────────────
  '/dashboard': { kind: 'login' },
  '/admin': { kind: 'login' },
  '/admin_console': { kind: 'login' },
  '/admin/proposal-codes': { kind: 'login' },
  '/admin/proposal-codes/new': { kind: 'login' },
  '/admin/proposal-codes/[code]': { kind: 'login', sample: '/admin/proposal-codes/GATE-PROBE' },
  '/company_admin': { kind: 'login' },
  '/company_admin/bulk-upload': { kind: 'login' },
  '/manager': { kind: 'login' },
  '/manager/mobile': { kind: 'login' },
  '/manager/mobile/tow-log': { kind: 'login' },
  '/driver': { kind: 'login' },
  '/resident': { kind: 'login' },
  '/history': { kind: 'login' },
  '/consent': { kind: 'login' },
  '/qr': { kind: 'login' },
  '/account-suspended': { kind: 'login' },
  '/ticket/pm/[id]': { kind: 'login', sample: '/ticket/pm/1' },

  // ── Help centre — gated on purpose, 136bb46 (2026-07-12) ──────────
  // Not an omission. The help centre is a subscriber-operator manual;
  // a towed vehicle owner googling into the tow-ticket doc and mailing
  // support@ reaches an inbox with no remit to help them. Prefix-match
  // in publicPaths means ONE string would reopen the whole tree — see
  // docs/backlog/help-attorney-review-flag-does-not-withhold-2026-09-23.md
  // for what must ship in the same commit if it ever does.
  '/help': { kind: 'login' },
  '/help/[slug]': { kind: 'login', sample: '/help/visitor-passes' },
  '/help/videos': { kind: 'login' },
  '/help/videos/[slug]': { kind: 'login', sample: '/help/videos/getting-started-driver' },

  // ── Authenticated API ─────────────────────────────────────────────
  '/api/admin/invite-status': { kind: 'login' },
  '/api/admin/invite-user': { kind: 'login' },
  '/api/admin/resend-invite': { kind: 'login' },
  '/api/admin/stripe-mode': { kind: 'login' },
  '/api/billing/bulk-invite': { kind: 'login' },
  '/api/billing/change-tier': { kind: 'login' },
  '/api/billing/portal-session': { kind: 'login' },
  '/api/billing/preview-tier-change': { kind: 'login' },
  '/api/billing/sync-on-add': { kind: 'login' },
  '/api/manager/notify-resident-deactivation': { kind: 'login' },
  '/api/manager/notify-resident-decision': { kind: 'login' },
  '/api/manager/notify-vehicle-deactivation': { kind: 'login' },
  '/api/proposal-codes/start-billing': { kind: 'login' },
  '/api/proposal-codes/[id]/issue': { kind: 'login', sample: '/api/proposal-codes/1/issue' },
  '/api/proposal-codes/[id]/preview-pdf': { kind: 'login', sample: '/api/proposal-codes/1/preview-pdf' },
  '/api/properties/[id]/authorization-pdf-url': { kind: 'login', sample: '/api/properties/1/authorization-pdf-url' },
  '/api/scan-plate': { kind: 'login' },
  '/api/tow-log/media-url': { kind: 'login' },

  // ── Framework internals ───────────────────────────────────────────
  '/_not-found': {
    kind: 'skip',
    why: 'Not addressable — Next serves it for unmatched paths. An anonymous unmatched path 307s to /login (middleware runs before routing), which is a known cosmetic consequence of the auth guard, not a route to assert.',
  },
  '/_global-error': {
    kind: 'skip',
    why: 'Error boundary, not a route. Reachable only by throwing during render.',
  },
}
