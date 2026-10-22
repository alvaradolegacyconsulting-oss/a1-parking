// ════════════════════════════════════════════════════════════════════
// /pass/[token] — four facts to whoever scanned the code
// ════════════════════════════════════════════════════════════════════
//
// The card this points at sits on a windscreen. Anyone walking past can
// photograph the code, so this page is written for a stranger, not for
// the guest: plate, property, valid until, status. No visitor name, no
// unit, no vehicle description, no id.
//
// 🔴 ONE REFUSAL FOR FOUR CASES. Unknown, expired, revoked and
// malformed all render the same "This pass is not valid". The server
// returns an identical {valid:false} for all of them, and this page
// must not reintroduce a distinction — the moment the screens differ,
// anyone can probe whether a token ever existed.
//
// 🔴 AND IT IS NOT A PERMIT. The page proves nothing to enforcement:
// a driver's lookup reads visitor_passes directly. The card exists so a
// manager passing the car can see a pass exists without calling the
// office, which is why "valid until" is the largest thing on it.
//
// Server component. No session, no cookies, one RPC call with the anon
// key — the same thing a browser does.

import { createClient } from '@supabase/supabase-js'
import { formatTimestamp } from '../../lib/format-time'

const GOLD = '#C9A227'
const BG = '#0f1117'
const CARD = '#161b26'
const BORDER = '#2a2f3d'
const TEXT = '#e2e8f0'
const MUTED = '#8a93a5'
const RED = '#f44336'

export const dynamic = 'force-dynamic'

type PassAnswer =
  | { valid: true; status: string; plate: string; property: string; valid_until: string }
  | { valid: false }

async function readPass(token: string): Promise<PassAnswer> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  // 🔴 A misconfiguration must not read as "your pass is invalid". It
  // is the same screen either way, but the log distinguishes them so
  // nobody debugs a guest's pass when the env is the problem.
  if (!url || !anon) {
    console.error('[pass] NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing — cannot read any pass')
    return { valid: false }
  }
  try {
    const db = createClient(url, anon, { auth: { persistSession: false } })
    const { data, error } = await db.rpc('get_visitor_pass_by_token', { p_token: token })
    if (error) {
      console.error('[pass] reader failed:', error.message)
      return { valid: false }
    }
    return (data ?? { valid: false }) as PassAnswer
  } catch (e) {
    console.error('[pass] reader threw:', (e as Error).message)
    return { valid: false }
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{
      minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'Arial, sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>
      <div style={{ maxWidth: 380, width: '100%' }}>
        <p style={{ color: GOLD, fontSize: 20, fontWeight: 'bold', margin: '0 0 20px', textAlign: 'center' }}>
          ShieldMyLot&trade;
        </p>
        {children}
      </div>
    </main>
  )
}

export default async function PassPage({ params }: { params: Promise<{ token: string }> }) {
  // Next 16: route params are a Promise and must be awaited.
  const { token } = await params
  const pass = await readPass(token)

  if (!pass.valid) {
    return (
      <Shell>
        <div style={{ background: CARD, border: `1px solid #4a2020`, borderRadius: 12, padding: 24, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${RED}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" role="img" aria-label="Not valid" focusable="false">
              <path d="M12 3.2 1.8 20.4h20.4L12 3.2Z" fill="none" stroke={RED} strokeWidth="2" strokeLinejoin="round" />
              <rect x="11" y="9" width="2" height="6" rx="1" fill={RED} />
              <rect x="11" y="16.6" width="2" height="2" rx="1" fill={RED} />
            </svg>
          </div>
          {/* 🔴 ONE SENTENCE, FOR ALL FOUR CASES. Do not add "expired",
              "revoked" or "no such pass" branches here: the server
              cannot tell this page which it was, deliberately. */}
          <h1 style={{ color: RED, fontSize: 17, fontWeight: 'bold', margin: '0 0 10px' }}>
            This pass is not valid
          </h1>
          <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            Ask the resident you are visiting to issue a new visitor pass, or contact the property office.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div style={{ background: CARD, border: `2px solid ${GOLD}`, borderRadius: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <p style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', margin: 0 }}>
            Visitor Pass
          </p>
          <span style={{
            background: '#1a3a1a', color: '#4caf50', border: '1px solid #2e7d32',
            borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 'bold',
          }}>✓ Active</span>
        </div>

        <p style={{ color: GOLD, fontSize: 16, fontWeight: 'bold', margin: '0 0 12px', lineHeight: 1.3 }}>
          {pass.property}
        </p>
        <p style={{
          color: 'white', fontFamily: 'Courier New, monospace', fontSize: 34, fontWeight: 'bold',
          letterSpacing: '0.12em', margin: '0 0 18px',
        }}>{pass.plate}</p>

        {/* The largest fact on the card, because it is the one a manager
            walking past needs. */}
        <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '12px 10px' }}>
          <p style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
            Valid until
          </p>
          <p style={{ color: GOLD, fontSize: 15, fontWeight: 'bold', margin: 0 }}>
            {formatTimestamp(pass.valid_until)}
          </p>
        </div>
      </div>
      {/* No visitor name, no unit. Deliberate: see the header. */}
      <p style={{ color: MUTED, fontSize: 11, textAlign: 'center', margin: '14px 0 0', lineHeight: 1.6 }}>
        Checked live. This page reflects the pass as it stands now.
      </p>
    </Shell>
  )
}
