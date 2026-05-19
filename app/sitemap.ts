import type { MetadataRoute } from 'next'
import { getAllDocs } from './lib/help-docs'

// B85: app-router sitemap. Adds /help routes alongside the existing public
// surface. Per-doc lastModified pulled from frontmatter last_updated.
// noindex docs are excluded from sitemap entirely (search engines should
// not discover them via sitemap and crawl them only to find noindex meta).

const BASE = 'https://shieldmylot.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${BASE}/help`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ]

  const docs = getAllDocs()
  const docRoutes: MetadataRoute.Sitemap = docs
    .filter((d) => !d.shouldNoIndex)
    .map((d) => ({
      url: `${BASE}/help/${d.slug}`,
      lastModified: new Date(d.frontmatter.last_updated),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    }))

  return [...staticRoutes, ...docRoutes]
}
