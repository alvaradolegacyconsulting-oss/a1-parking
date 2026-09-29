'use client'
import { useState, useEffect } from 'react'
import Image from 'next/image'
import { readAttribution } from '../lib/lead-attribution'

// ════════════════════════════════════════════════════════════════════
// /videos — the public walkthrough library. Commit 1 of 3 (2026-09-28)
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
// ---------------
// The home page footer's "Video Guides" link pointed at /help/videos,
// which 307s to /login for anyone not signed in. A prospect clicking
// "Videos" hit a login screen. This is the page that link should have
// gone to.
//
// 🔴 THIS DOES NOT REOPEN /help. 136bb46 (2026-07-12) gated the help
// centre by DECISION — it is a subscriber-operator manual, and a towed
// owner googling into the tow-ticket doc reaches a support inbox with no
// remit to help them. That ruling stands and this commit does not touch
// publicPaths for /help. A separate route listing only the four
// walkthroughs is the whole point of the shape.
//
// 🔴 THE EMBEDS WERE ALREADY PUBLIC. Every HeyGen URL returns 200 to an
// anonymous request, and the ids are in docs/videos/*.md in a public
// repo. Measured, not assumed. So this page changes what is LISTED, not
// what is REACHABLE — worth knowing before anyone treats "not on the
// page" as "not available".
//
// 🔴 COPY IS FRESH, NOT THE HELP BLURBS. The help-doc text for the
// driver video says "the evidence Chapter 2308 expects" — a compliance
// claim, which public marketing pages do not carry. The one-liners
// below were written for this page: what you'll see, no compliance
// language, no pricing, no feature that has since moved.

const NAVY = '#0E2434'
const GOLD = '#BA9233'
const GOLD_LIGHT = '#D9AE45'
const CREAM = '#F4F2EC'
const INK = '#2B3F4E'

type Vid = { slug: string; title: string; blurb: string; embed: string }

// Embed ids mirror docs/videos/*.md. The gate reads THOSE files and
// asserts each id here is anonymously fetchable, so a drift between the
// two fails rather than silently shipping a dead player.
const PM: Vid = {
  slug: 'getting-started-property-manager',
  title: 'Property Manager',
  blurb: 'The day-to-day: what lands in your approval queue, clearing it one at a time or in bulk, assigning reserved spaces, and the mobile view for walking the property.',
  embed: 'e7acc4e1df314631b13130b09fc1b4ee',
}
const RESIDENT: Vid = {
  slug: 'getting-started-resident',
  title: 'Resident',
  blurb: 'What your residents see: adding their own vehicles from a phone, requesting a visitor pass, and keeping their own details current.',
  embed: 'ccad274bf94544a9b33dc3002167acf7',
}
const DRIVER: Vid = {
  slug: 'getting-started-driver',
  title: 'Driver',
  blurb: 'A walk through a shift: reading a plate lookup, what each status badge means, and building a violation record with the photos attached at the vehicle.',
  embed: '0ffe814453374ae5aef3ab8b99af06bc',
}
const COMPANY_ADMIN: Vid = {
  slug: 'getting-started-company-admin',
  title: 'Company Admin',
  blurb: 'Setting the company up: adding properties, inviting managers and drivers, and finding activity across every property you run.',
  embed: '34cc7d9a02cc43839a4a26ed49b2ab43',
}

export default function VideosPage() {
  // Same mount-effect pattern as the home doors and /operators.
  // NOT useSearchParams() — it would bail this page out of static
  // rendering, which is the /operators R5 defect.
  const [qs, setQs] = useState('')
  useEffect(() => {
    const raw = window.location.search
    setQs(raw && raw !== '?' ? raw : '')
    void readAttribution(raw)   // same parser the forms use; kept so the
                                // shape of what we forward is one rule
  }, [])

  // 🔴 Lazy: an iframe is mounted only after its card is clicked. Four
  // HeyGen players on open would be four third-party page loads before
  // anyone has decided to watch anything — on a phone, on cellular,
  // which is where a QR scan lands.
  const [playing, setPlaying] = useState<Record<string, boolean>>({})
  const play = (k: string) => setPlaying(p => ({ ...p, [k]: true }))

  const card = (v: Vid, sectionKey: string) => {
    const k = `${sectionKey}:${v.slug}`
    return (
      <div key={k} style={{ background: '#fff', borderTop: `4px solid ${GOLD}`, padding: '18px 16px 20px' }}>
        <div style={{ fontWeight: 700, fontSize: 22, lineHeight: 1.05, textTransform: 'uppercase', color: NAVY }}>{v.title}</div>
        <div style={{ fontSize: 15, lineHeight: 1.5, color: INK, margin: '8px 0 14px' }}>{v.blurb}</div>
        <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#0B1B27' }}>
          {playing[k] ? (
            <iframe
              src={`https://app.heygen.com/embeds/${v.embed}`}
              title={`ShieldMyLot walkthrough — ${v.title}`}
              allow="encrypted-media; fullscreen"
              allowFullScreen
              loading="lazy"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
            />
          ) : (
            <button
              type="button"
              onClick={() => play(k)}
              aria-label={`Play the ${v.title} walkthrough`}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'flex',
                alignItems: 'center', justifyContent: 'center', gap: 12, background: 'transparent',
                border: 0, cursor: 'pointer', color: '#fff', fontFamily: 'inherit',
              }}
            >
              <span style={{ width: 54, height: 54, borderRadius: '50%', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true" focusable="false">
                  <path d="M2 1.6 18.4 11 2 20.4Z" fill={GOLD} />
                </svg>
              </span>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Play</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  const cta = (href: string, label: string) => (
    <a href={`${href}${qs}`} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 52, marginTop: 22,
      padding: '0 26px', background: GOLD, color: NAVY, fontWeight: 700, fontSize: 18,
      letterSpacing: '0.04em', textTransform: 'uppercase', textDecoration: 'none',
    }}>{label}</a>
  )

  return (
    <main style={{ background: NAVY, color: '#fff', fontFamily: 'Arial, sans-serif', minHeight: '100vh' }}>
      <style>{`
        .op-wrap { max-width: 1180px; margin: 0 auto; }
        .op-pad { padding: 38px 22px 40px; }
        .op-h1 { font-size: 40px; line-height: 1; letter-spacing: -0.01em; }
        .op-mark { height: 32px; width: auto; display: block; }
        .op-h2 { font-size: 30px; line-height: 1.05; }
        .op-lede { font-size: 18px; line-height: 1.5; }
        .op-grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
        @media (min-width: 860px) {
          .op-pad { padding: 56px 56px 60px; }
          .op-mark { height: 40px; }
          .op-h1 { font-size: 64px; }
          .op-h2 { font-size: 40px; }
          .op-lede { font-size: 21px; line-height: 1.45; }
          .op-grid { grid-template-columns: repeat(2, minmax(0,1fr)); gap: 24px; }
        }
      `}</style>

      <div className="op-wrap" style={{ padding: '18px 22px', borderBottom: '1px solid #1E3E54' }}>
        <a href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <Image src="/brand/shieldmylot-shield.png" alt="ShieldMyLot" width={37} height={40} className="op-mark" priority />
          <span style={{ fontWeight: 700, fontSize: 20, textTransform: 'uppercase', letterSpacing: '0.01em' }}>
            ShieldMyLot<span style={{ fontSize: 9, verticalAlign: 'super' }}>&trade;</span>
          </span>
        </a>
      </div>

      <div className="op-wrap op-pad">
        <div style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: GOLD_LIGHT }}>Walkthroughs</div>
        <h1 className="op-h1" style={{ margin: '14px 0 0', fontWeight: 700, textTransform: 'uppercase' }}>
          See it <span style={{ color: GOLD_LIGHT }}>in action.</span>
        </h1>
        <p className="op-lede" style={{ margin: '18px 0 0', color: '#D3DFE8', maxWidth: 760 }}>
          Short walkthroughs of the parts people actually use, filmed in the product. No sign-in needed.
        </p>
      </div>

      <div id="property-managers" style={{ background: CREAM, color: NAVY, scrollMarginTop: 0 }}>
        <div className="op-wrap op-pad">
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>Property managers &amp; leasing agents</h2>
          <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.45, color: INK, maxWidth: 760 }}>
            The first covers your office. The second is what your residents see, so you know what you are asking them to do.
          </p>
          <div className="op-grid" style={{ marginTop: 22 }}>
            {card(PM, 'pm')}
            {card(RESIDENT, 'pm')}
          </div>
          {cta('/property-managers#start', 'Request a demo →')}
        </div>
      </div>

      <div id="operators" className="op-wrap op-pad">
        <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>Towing operators</h2>
        <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.45, color: '#D3DFE8', maxWidth: 760 }}>
          What a shift looks like on the truck, and what running the company side looks like from the office.
        </p>
        <div className="op-grid" style={{ marginTop: 22 }}>
          {card(DRIVER, 'ops')}
          {card(COMPANY_ADMIN, 'ops')}
        </div>
        {cta('/operators#start', 'Request a demo →')}
      </div>

      <div id="residents" style={{ background: CREAM, color: NAVY }}>
        <div className="op-wrap op-pad">
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>Residents</h2>
          <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.45, color: INK, maxWidth: 760 }}>
            If your property sent you here, this is the one to watch.
          </p>
          <div className="op-grid" style={{ marginTop: 22 }}>
            {card(RESIDENT, 'res')}
          </div>
        </div>
      </div>

      <div className="op-wrap" style={{ padding: '24px 22px', borderTop: `4px solid ${GOLD}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <a href="/" style={{ color: GOLD_LIGHT, fontWeight: 600, fontSize: 19, letterSpacing: '0.03em', textTransform: 'uppercase', textDecoration: 'none' }}>
          Everything else we do &rarr;
        </a>
        <div style={{ fontSize: 11, letterSpacing: '0.09em', textTransform: 'uppercase', color: '#9FB3C2', lineHeight: 1.6 }}>
          ShieldMyLot&trade; &middot; Alvarado Legacy Consulting LLC<br />Built in Texas for Texas properties
        </div>
      </div>
    </main>
  )
}
