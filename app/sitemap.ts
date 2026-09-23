import type { MetadataRoute } from 'next'

// Sitemap for the PUBLIC site. One rule decides what belongs here:
//
//   🔴 A URL goes in the sitemap only if an anonymous visitor gets the
//      page itself — not a login redirect, and not an empty shell.
//
// A sitemap is a request to crawl. Listing a URL that answers with
// something other than the page spends crawl budget to learn nothing and
// teaches the crawler that this site's sitemap is unreliable.
//
// ── 2026-09-23: /help removed, /operators added ─────────────────────
//
// This file used to emit /help plus every non-noindex help doc — 21 of
// its 24 entries. All 21 have answered `307 → /login` since 136bb46
// (2026-07-12) deliberately removed /help from the middleware allowlist:
// the help center is a subscriber-operator manual, and a towed vehicle
// owner who googles into the tow-ticket doc and mails support@ reaches an
// inbox with no remit to help them. That gating is the ruling and stands.
//
// It went unnoticed because /sitemap.xml was ITSELF redirected to /login
// for anonymous traffic, so nothing ever read the list. Opening the route
// (see the matcher note in middleware.ts) is what made its contents
// matter, so both changes ship together — routing a stale file would have
// published 21 dead URLs on the first crawl after deploy.
//
// /operators is added: it is the ad landing page the printed campaign
// codes redirect to, it renders server-side, and it is the one page we
// actively want crawled.
//
// /signup is deliberately ABSENT even though app/robots.ts allows it. It
// is a client component that serves a ~15 KB shell with no copy to a
// crawler — listing it would advertise an empty page. Filed as
// docs/backlog/signup-client-shell-no-crawler-content-2026-09-23.md; it
// becomes a sitemap candidate when it renders something.
//
// 🔴 Before adding a URL here, check it anonymously. Adding one that a
// human cannot reach logged out is the defect this file just had.

const BASE = 'https://shieldmylot.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${BASE}/operators`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/saas`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ]
}
