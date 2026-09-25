'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

// 🔴 2026-09-25 — was '/logo.jpeg', which is A1 WRECKER LLC'S LION: a
// customer's mark, sitting at the platform's fallback path. Every
// surface that fell through to it rendered a customer's logo as ours —
// /login, the home page, terms, privacy, /saas and the super-admin
// portal among them. A brand and trademark problem, and SWTO prospects
// arriving from the ad hit /login.
//
// It had a second failure on top of the first: /logo.jpeg was matched by
// middleware and answered 307 → /login to anonymous traffic, so the
// logo on the LOGIN PAGE never loaded for a logged-out visitor at all.
// /brand/ is in the matcher exclusion (see middleware.ts), so this path
// serves to anyone.
//
// This is the LAST-RESORT value. Order of preference is company logo →
// platform_settings.default_logo_url → this.
export const STATIC_LOGO_FALLBACK = '/brand/shieldmylot-shield.png'

let cachedPlatformLogo: string | null | undefined = undefined
let inflightPromise: Promise<string | null> | null = null

export async function getPlatformLogoUrl(): Promise<string | null> {
  if (cachedPlatformLogo !== undefined) return cachedPlatformLogo
  if (inflightPromise) return inflightPromise
  inflightPromise = (async (): Promise<string | null> => {
    // B155.3 — anon RPC replaces direct platform_settings SELECT.
    // RPC returns 5 default-* fields; we use only default_logo_url here.
    const { data: rows, error } = await supabase.rpc('get_platform_defaults')
    const row = rows?.[0] as { default_logo_url: string | null } | undefined
    const resolved: string | null = !error && row?.default_logo_url ? row.default_logo_url : null
    cachedPlatformLogo = resolved
    inflightPromise = null
    return resolved
  })()
  return inflightPromise
}

export function getCachedLogoUrl(companyLogo?: string | null): string {
  return companyLogo || cachedPlatformLogo || STATIC_LOGO_FALLBACK
}

export function useResolvedLogo(companyLogo?: string | null): string {
  const initial = companyLogo || cachedPlatformLogo || STATIC_LOGO_FALLBACK
  const [logo, setLogo] = useState<string>(initial)
  useEffect(() => {
    let cancelled = false
    if (companyLogo) {
      setLogo(companyLogo)
      return () => { cancelled = true }
    }
    getPlatformLogoUrl().then(platformLogo => {
      if (cancelled) return
      setLogo(platformLogo || STATIC_LOGO_FALLBACK)
    })
    return () => { cancelled = true }
  }, [companyLogo])
  return logo
}
