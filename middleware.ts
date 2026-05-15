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
  const publicPaths = ['/login', '/visitor', '/visitor-select', '/register', '/change-password', '/terms', '/privacy', '/signup', '/account-cancelled']
  const isPublic = pathname === '/' || publicPaths.some(path => pathname.startsWith(path))

  // Not logged in — redirect to login
  if (!user && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
