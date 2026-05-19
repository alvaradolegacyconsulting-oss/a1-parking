import type { MetadataRoute } from 'next'

// B85: app-router robots.txt. /help is openly indexable; per-page
// noindex meta gates specific docs (attorney-gated). Internal portals
// (/admin, /company_admin, /manager, /driver, /resident, etc.) are
// disallowed to prevent search engines from indexing auth-required surfaces
// even if they leak via inadvertent links.

const BASE = 'https://shieldmylot.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/help', '/help/', '/terms', '/privacy', '/signup'],
        disallow: [
          '/admin',
          '/company_admin',
          '/manager',
          '/driver',
          '/resident',
          '/history',
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
