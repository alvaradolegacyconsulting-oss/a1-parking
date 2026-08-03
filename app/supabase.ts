import { createBrowserClient } from '@supabase/ssr'
import { interceptedFetch } from './lib/supabase-fetch-interceptor'

// 2026-08-03 — global.fetch wired to the interceptor. Handles:
//   • 401 on /rest/v1/* + /rpc/*    → session-dead flag + auth-expired event
//   • 429 on /auth/v1/token         → rate-limited event with retry-after
//   • Any call after session dead   → synthetic 401 (no network) to
//                                     prevent refresh amplification
// See app/lib/supabase-fetch-interceptor.ts for the full rationale.
// AuthExpiredBanner mounts in app/layout.tsx to consume the events.
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    global: { fetch: interceptedFetch },
  },
)