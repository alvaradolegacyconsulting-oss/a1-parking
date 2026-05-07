'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

export const STATIC_LOGO_FALLBACK = '/logo.jpeg'

let cachedPlatformLogo: string | null | undefined = undefined
let inflightPromise: Promise<string | null> | null = null

export async function getPlatformLogoUrl(): Promise<string | null> {
  if (cachedPlatformLogo !== undefined) return cachedPlatformLogo
  if (inflightPromise) return inflightPromise
  inflightPromise = (async (): Promise<string | null> => {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('default_logo_url')
      .eq('id', 1)
      .single()
    const resolved: string | null = !error && data?.default_logo_url ? data.default_logo_url : null
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
