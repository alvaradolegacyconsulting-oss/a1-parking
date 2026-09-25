import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Always public — no login needed.
  // Pattern is prefix-match via startsWith: one entry covers the whole subtree
  // (e.g. '/signup' covers /signup, /signup/redeem, /signup/redeem/verify, etc.).
  // Any future public surface (Stripe success/cancel pages, marketing variants,
  // health-check endpoints) MUST be added here or it will be redirected to /login
  // for anon traffic at middleware before the page renders — exactly the B65
  // production blocker (2026-05-20) that prompted /signup + /account-cancelled
  // being added below.
  const publicPaths = ['/login', '/visitor', '/visitor-select', '/register', '/change-password', '/terms', '/privacy', '/signup', '/account-cancelled', '/deactivated', '/ticket/view', '/api/help-feedback', '/api/stripe/webhook', '/api/cron', '/api/signup', '/api/register/create-user', '/api/register/companion-vehicle', '/api/register/captcha-verify', '/api/visitor/create-pass', '/api/visitor/refusal-log', '/api/leads', '/operators', '/morethantruck', '/swtowop', '/saas', '/forgot-password', '/reset-password', '/auth/accept']
  const isPublic = pathname === '/' || publicPaths.some(path => pathname.startsWith(path))

  // Not logged in — redirect to login
  if (!user && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}

export const config = {
  // 🔴 THE RULE: a route that only MACHINES read belongs in this matcher
  // exclusion, not in publicPaths.
  //
  // publicPaths is evaluated AFTER a Supabase auth.getUser() round-trip
  // that every matched request pays. For a human-facing page that cost is
  // noise against the page render. For a file fetched by crawlers, app
  // installers and link unfurlers at a rate we do not control, it is pure
  // waste on a request that can never be authenticated anyway — there is
  // no session on a crawler, so the guard has nothing to decide.
  //
  // Deciding which list a new route belongs in:
  //   • a person reads it in a browser  → publicPaths  (e.g. /terms, /saas)
  //   • a machine fetches it by convention → this matcher exclusion
  //     (robots.txt, sitemap.xml, favicons, PWA manifest, web app icons)
  //
  // 2026-07-10 — added the platform icon assets + the PWA manifest. Prior
  // form only excluded favicon.ico; every other asset (icon.png,
  // apple-icon.png, icon-192.png, icon-512.png, manifest.webmanifest) was
  // matched by middleware and 307-redirected to /login for anon traffic.
  // Symptom: Android install showed "S on grey" fallback because
  // /icon-192.png returned an HTML redirect instead of a PNG.
  //
  // 2026-09-25 — added the whole `brand/` folder. Static brand assets are
  // fetched by the browser as sub-requests of a page that may itself be
  // anonymous, so gating them breaks the page for exactly the visitor it
  // was built for. 🔴 This is not theoretical: /logo.jpeg has been
  // answering 307 → /login to anonymous traffic, which means the logo on
  // the LOGIN PAGE — the first thing a logged-out visitor sees — has
  // never loaded for them. Only the six assets named in this exclusion
  // have ever worked anonymously. A folder is excluded rather than each
  // file, so adding a brand asset does not repeat the mistake.
  //
  // 2026-09-23 — added robots.txt + sitemap.xml. Same class, missed by the
  // 2026-07-10 pass, and found only because an unrelated routing change
  // prompted a sweep of every build route against production. app/robots.ts
  // carries a deliberate B85 disallow list (/admin, /company_admin,
  // /manager, /driver, /resident, /qr, /visitor, /api/) that was reaching
  // nobody: a robots.txt that resolves to an HTML login page is read as
  // allow-all, so the effect was the OPPOSITE of the gate it looks like.
  // Nothing leaked — those portals are login-gated in their own right —
  // but the belt B85 wrote was not fastened.
  //
  // This is the third omission from the allowlist in a week
  // (/api/visitor/refusal-log, /api/leads, then these). That is what
  // scripts/verify-route-exposure.ts exists to stop: it enumerates the
  // build's own route list and FAILS on any route with no declared
  // expectation, so a new route cannot be forgotten — only declared.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|icon-192.png|icon-512.png|manifest.webmanifest|robots.txt|sitemap.xml|brand/).*)'],
}
