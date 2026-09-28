'use client'
import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
import { guardEmail, suggestEmailCorrection } from '../lib/email-guard'
import { readAttribution, buildLeadPayload, type AskedFields } from '../lib/lead-attribution'
import type { LeadSource } from '../lib/leads'
import { probeSelfServeOpen } from '../lib/self-serve-door'

// ════════════════════════════════════════════════════════════════════
// /property-managers — PM landing page. The twin of /operators.
// ════════════════════════════════════════════════════════════════════
//
// The PM-facing half of the same campaign machinery: HAA one-pager,
// monitor loop and event banner point here, /everyspace is the printable
// short path, and the form is THE SAME INTAKE — same table, same POST
// route, same Turnstile. There is still no second lead path.
//
// 🔴 DERIVED FROM app/operators/page.tsx ON PURPOSE. Layout, styles,
// class names (`op-*`), form markup and submit logic are identical
// BYTE FOR BYTE where they can be. Only copy and TRACK differ. Keeping
// the class prefix — rather than renaming it to something PM-flavoured —
// is what lets the two files be diffed against each other, which is how
// a future change to one gets checked against the other. Divergence
// here should be a decision, not a drift.
//
// 🔴 MOBILE IS THE PRIMARY VIEW. Same reason as /operators: a printed
// QR scan is phone traffic, and print is half this campaign too.
//
// 🔴 CLAIMS CONSTRAINTS (Jose 2026-09-28) — these are not style notes:
//   • NO ENFORCEMENT CLAIMS. PM-track subscribers do not issue
//     violations or tow tickets. Nothing about tickets, driver plate
//     scanning, or "fewer disputes".
//   • THE TOW LOG IS A RECORD, NOT A TRACKER. No "find your car", no
//     location claims. See feedback_tow_log_is_a_log_not_enforcement.
//   • NO COMPLIANCE CLAIMS (no Chapter 2308).
//   • NO PRICING. No figure, no range, no "starting at".
// NO NAV BAR, for the same reason as /operators.

const NAVY = '#0E2434'
const GOLD = '#BA9233'
const GOLD_LIGHT = '#D9AE45'
const CREAM = '#F4F2EC'
const INK = '#2B3F4E'

// Track is DERIVED, never selected — same rule as /operators, other
// value. The campaign that drives this traffic aims at property
// managers, so the surface pre-answers "which describes your business"
// and never shows the question. The row lands with
// track = 'property_management', one of the two values
// leads_track_valid permits.
const TRACK = 'property_management' as const

// What THIS surface asks. Read by buildLeadPayload so an unticked box
// the page presented is sent as an explicit false rather than omitted.
const ASKED: AskedFields = { texas_confirmed: true, wants_demo: true }

export default function PropertyManagersPage() {
  const [source, setSource] = useState<LeadSource | null>(null)
  const [values, setValues] = useState({
    company_name: '', contact_name: '', email: '', phone: '', property_count: '',
    texas_confirmed: false, wants_demo: false,
  })
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const turnstileRef = useRef<TurnstileHandle>(null)

  // Attribution is captured once on mount, from the URL the ad pointed
  // at. Kept in state so it survives the visitor editing the form.
  //
  // 🔴 window.location.search, NOT useSearchParams(). useSearchParams()
  // forces the nearest Suspense boundary to bail out of server
  // rendering, so the whole page came back to a crawler as an EMPTY
  // SHELL — indexable in name only, on a page we deliberately left
  // indexable. The redirect gate's R5 caught it: 200 OK, zero copy.
  //
  // Reading it here instead costs nothing (this only ever runs in the
  // browser, where the URL is available) and the marketing content now
  // renders server-side where a crawler can see it.
  useEffect(() => {
    setSource(readAttribution(window.location.search))
  }, [])

  // Self-serve door. Hidden until public signup is actually open —
  // same check /signup itself uses, so the two can never disagree.
  // Starts false, so the line is absent while the probe is in flight
  // and never flashes a link we might have to take away.
  const [selfServeOpen, setSelfServeOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    probeSelfServeOpen().then(open => { if (!cancelled) setSelfServeOpen(open) })
    return () => { cancelled = true }
  }, [])

  const set = (k: keyof typeof values) => (v: string | boolean) =>
    setValues(s => ({ ...s, [k]: v }))

  const suggestion = suggestEmailCorrection(values.email)

  async function submit() {
    setError('')
    if (!values.email.trim()) { setError('Please enter the email address we should reply to.'); return }
    // Same rule the route enforces, surfaced here so a `.con` is caught
    // before submit rather than coming back as a server error.
    const eg = guardEmail(values.email)
    if (!eg.ok) { setError(eg.message); return }
    if (!captchaToken) { setError('Please complete the challenge below, then send.'); return }

    setSubmitting(true)
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildLeadPayload({ asked: ASKED, values, track: TRACK, source, captchaToken })),
      })
      const body = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) {
        // The challenge token is single-use; reset so a retry can
        // re-challenge without a page reload.
        turnstileRef.current?.reset()
        setCaptchaToken(null)
        setError(body?.error ?? 'We could not send that just now. Please try again in a moment.')
        return
      }
      setDone(true)
    } catch {
      turnstileRef.current?.reset()
      setCaptchaToken(null)
      setError('We could not reach the server. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <main style={{ minHeight: '100vh', background: NAVY, color: '#fff', fontFamily: 'Arial, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ fontSize: 30, lineHeight: 1.15, margin: 0, textTransform: 'uppercase', letterSpacing: '-0.01em' }}>
            Got it — thank you.
          </h1>
          <p style={{ fontSize: 18, lineHeight: 1.55, color: '#D3DFE8', marginTop: 16 }}>
            We have your details and someone will get back to you.
            {values.wants_demo ? ' We will reach out to schedule your 15-minute demo.' : ''}
          </p>
          <p style={{ marginTop: 28 }}>
            <a href="https://shieldmylot.com" style={{ color: GOLD_LIGHT, fontSize: 17 }}>Everything else we do &rarr;</a>
          </p>
        </div>
      </main>
    )
  }

  const lbl: React.CSSProperties = {
    display: 'block', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: '#4A5D6B', marginBottom: 7, fontWeight: 500,
  }
  // 48px min height on every control — above the 44px touch-target floor
  // with room for the border, because this form IS the page.
  const inp: React.CSSProperties = {
    display: 'block', width: '100%', minHeight: 48, border: '1px solid #B9BDB4',
    background: '#fff', padding: '0 13px', fontSize: 17, color: NAVY,
    boxSizing: 'border-box', borderRadius: 0,
  }

  return (
    <main style={{ background: NAVY, color: '#fff', fontFamily: 'Arial, sans-serif', minHeight: '100vh' }}>
      <style>{`
        .op-wrap { max-width: 1180px; margin: 0 auto; }
        .op-pad { padding: 38px 22px 40px; }
        .op-h1 { font-size: 46px; line-height: 0.95; letter-spacing: -0.01em; }
        .op-mark { height: 32px; width: auto; display: block; }
        .op-h2 { font-size: 34px; line-height: 1; }
        .op-lede { font-size: 18px; line-height: 1.5; }
        .op-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
        .op-two { display: grid; grid-template-columns: 1fr; gap: 16px; }
        @media (min-width: 860px) {
          .op-pad { padding: 64px 56px 68px; }
          .op-mark { height: 40px; }
          .op-h1 { font-size: 78px; }
          .op-h2 { font-size: 48px; }
          .op-lede { font-size: 22px; line-height: 1.45; }
          .op-grid { grid-template-columns: repeat(3, minmax(0,1fr)); gap: 26px; }
          .op-two { grid-template-columns: repeat(2, minmax(0,1fr)); gap: 22px; }
        }
      `}</style>

      {/* Masthead — shield + wordmark, linked home. Deliberately NOT a
          nav bar: this is a campaign landing page and the demo button is
          the only call to action. Adding links here gives a cold reader
          somewhere else to go. */}
      <div className="op-wrap" style={{ padding: '18px 22px', borderBottom: '1px solid #1E3E54' }}>
        <a
          href="/"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}
        >
          {/* 🔴 /brand/shieldmylot-shield.png, NOT /logo.jpeg — that file
              is A1 Wrecker's lion, a customer's mark. The shield is
              RGBA with an antialiased edge band, so it sits on the navy
              masthead without a white plate behind it.
              width/height are the intrinsic ratio (148×160 → 37×40);
              .op-mark scales by height with width:auto, which is what
              keeps next/image from warning and keeps the ratio true. */}
          <Image
            src="/brand/shieldmylot-shield.png"
            alt="ShieldMyLot"
            width={37}
            height={40}
            className="op-mark"
            priority
          />
          <span style={{ fontWeight: 700, fontSize: 20, textTransform: 'uppercase', letterSpacing: '0.01em' }}>
            ShieldMyLot<span style={{ fontSize: 9, verticalAlign: 'super' }}>&trade;</span>
          </span>
        </a>
      </div>

      <div className="op-wrap op-pad">
        <div style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: GOLD_LIGHT }}>
          For Texas property managers
        </div>
        <h1 className="op-h1" style={{ margin: '16px 0 0', fontWeight: 700, textTransform: 'uppercase' }}>
          Know who belongs in <span style={{ color: GOLD_LIGHT }}>every space.</span>
        </h1>
        <p className="op-lede" style={{ margin: '20px 0 0', color: '#D3DFE8', maxWidth: 780 }}>
          Parking your office can run, without the spreadsheet. Residents register their own vehicles,
          visitor passes take seconds, and spaces and permits stay current in one place.
        </p>
        <a href="#start" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 54, marginTop: 26,
          background: GOLD, color: NAVY, fontWeight: 700, fontSize: 20, letterSpacing: '0.04em',
          textTransform: 'uppercase', textDecoration: 'none', maxWidth: 420,
        }}>Request a 15-minute demo</a>
      </div>

      <div style={{ background: CREAM, color: NAVY }}>
        <div className="op-wrap op-pad">
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>What your office gets</h2>
          <div className="op-grid" style={{ marginTop: 24 }}>
            {[
              ['Resident registration', 'Residents add and update their own vehicles from a phone. The list is right because the resident made it.'],
              ['Visitor passes', 'Your office issues a pass in seconds, or lets residents issue their own within limits you set.'],
              ['Spaces & permits', 'Spaces, assignments and who parks where, kept current in one place.'],
            ].map(([h, b]) => (
              <div key={h} style={{ background: '#fff', borderTop: `4px solid ${GOLD}`, padding: '20px 18px 22px' }}>
                <div style={{ fontWeight: 700, fontSize: 24, lineHeight: 1.05, textTransform: 'uppercase' }}>{h}</div>
                <div style={{ fontSize: 16, lineHeight: 1.5, color: INK, marginTop: 8 }}>{b}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── The tow log. ─────────────────────────────────────────────
          🔴 A RECORD, NOT A TRACKER. This panel describes what the
          property already authorized and can look back at. It must not
          imply the platform locates a vehicle, tells an owner where
          their car went, or does anything at the moment of a tow — the
          boundary erodes one reasonable-sounding sentence at a time.
          PM-track subscribers do not issue tickets; nothing here says
          or suggests they do. */}
      <div className="op-wrap op-pad">
        <div style={{ borderLeft: `5px solid ${GOLD}`, background: 'rgba(186,146,51,0.08)', padding: '22px 20px 24px' }}>
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>The tow log</h2>
          <p style={{ margin: '14px 0 0', fontSize: 18, lineHeight: 1.55, color: '#E8EEF3', maxWidth: 820 }}>
            What happened on your lot, and why. Every removal on record: what the property authorized,
            when, by whom, and which towing company was called. When a resident asks, the answer is one
            lookup away.
          </p>
        </div>
      </div>

      <div className="op-wrap op-pad">
        <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>Your system, not the operator&rsquo;s</h2>
        <div className="op-grid" style={{ marginTop: 24 }}>
          {[
            ['Train your staff once', 'Your office learns one system, and the routine doesn\u2019t change when the towing company does.'],
            ['Any towing company', 'Work with whoever you choose. Switch without starting over.'],
            ['Own your data', 'Residents, permits and removal history stay with the property.'],
          ].map(([h, b]) => (
            <div key={h} style={{ borderTop: `3px solid ${GOLD}`, paddingTop: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: GOLD_LIGHT }}>{h}</div>
              <div style={{ fontSize: 17, lineHeight: 1.55, color: '#E8EEF3', marginTop: 10 }}>{b}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── THE FORM. The entire point of the page. ── */}
      <div id="start" style={{ background: CREAM, color: NAVY }}>
        <div className="op-wrap op-pad">
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>Interested in getting started?</h2>
          <p style={{ margin: '12px 0 0', fontSize: 17, lineHeight: 1.5, color: INK, maxWidth: 780 }}>
            Tell us what you manage and we will come back with next steps. A 15-minute demo is usually
            enough to see whether this fits how your office already works.
          </p>

          <div style={{ maxWidth: 880, marginTop: 26, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="op-two">
              <div>
                <label htmlFor="op-company" style={lbl}>Company</label>
                <input id="op-company" name="company_name" type="text" autoComplete="organization" style={inp}
                  value={values.company_name} onChange={e => set('company_name')(e.target.value)} />
              </div>
              <div>
                <label htmlFor="op-contact" style={lbl}>Your name</label>
                <input id="op-contact" name="contact_name" type="text" autoComplete="name" style={inp}
                  value={values.contact_name} onChange={e => set('contact_name')(e.target.value)} />
              </div>
            </div>

            <div className="op-two">
              <div>
                <label htmlFor="op-email" style={lbl}>Email</label>
                <input id="op-email" name="email" type="email" inputMode="email" autoComplete="email" style={inp}
                  value={values.email} onChange={e => set('email')(e.target.value)} />
                {/* The email IS the lead. A typo here loses it outright,
                    which is why the suggestion is on this form and not
                    only on /register. Never rewrites silently. */}
                {suggestion && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: '#fff', border: `1px solid ${GOLD}` }}>
                    <p style={{ margin: '0 0 8px', fontSize: 15, lineHeight: 1.45 }}>
                      Did you mean <strong style={{ color: '#8A6B1E' }}>{suggestion}</strong>?
                    </p>
                    <button type="button" onClick={() => set('email')(suggestion)} style={{
                      minHeight: 44, padding: '0 14px', background: GOLD, color: NAVY, border: 'none',
                      fontWeight: 700, fontSize: 15, cursor: 'pointer',
                    }}>Yes, use {suggestion}</button>
                    <span style={{ fontSize: 14, color: '#56605A', marginLeft: 10 }}>or keep what you typed</span>
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="op-phone" style={lbl}>Phone</label>
                <input id="op-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" style={inp}
                  value={values.phone} onChange={e => set('phone')(e.target.value)} />
              </div>
            </div>

            <div>
              <label htmlFor="op-properties" style={lbl}>Properties you manage</label>
              <input id="op-properties" name="property_count" type="text" inputMode="numeric" style={{ ...inp, maxWidth: 260 }}
                value={values.property_count} onChange={e => set('property_count')(e.target.value)} />
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: '#fff', borderLeft: `5px solid ${GOLD}`, padding: 16 }}>
              <input id="op-demo" name="wants_demo" type="checkbox" style={{ width: 22, height: 22, margin: '2px 0 0', accentColor: GOLD }}
                checked={values.wants_demo} onChange={e => set('wants_demo')(e.target.checked)} />
              <label htmlFor="op-demo" style={{ fontSize: 17, lineHeight: 1.45 }}>
                Yes &mdash; set up a 15-minute demo. Someone from our team will reach out to schedule it.
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <input id="op-texas" name="texas_confirmed" type="checkbox" style={{ width: 20, height: 20, margin: '2px 0 0', accentColor: GOLD }}
                checked={values.texas_confirmed} onChange={e => set('texas_confirmed')(e.target.checked)} />
              <label htmlFor="op-texas" style={{ fontSize: 16, lineHeight: 1.45, color: INK }}>
                I have properties in Texas. (ShieldMyLot operates in Texas only.)
              </label>
            </div>

            <TurnstileWidget ref={turnstileRef} onVerify={setCaptchaToken}
              onExpire={() => setCaptchaToken(null)} onError={() => setCaptchaToken(null)} />

            {error && (
              <div role="alert" style={{ background: '#FFF4F4', border: '1px solid #b71c1c', padding: '12px 14px' }}>
                <p style={{ margin: 0, color: '#8A1A1A', fontSize: 16, lineHeight: 1.45 }}>{error}</p>
              </div>
            )}

            <button type="button" onClick={submit} disabled={submitting} style={{
              minHeight: 54, padding: '0 30px', background: submitting ? '#4A5D6B' : NAVY, color: '#fff',
              border: 'none', fontWeight: 700, fontSize: 21, letterSpacing: '0.04em', textTransform: 'uppercase',
              cursor: submitting ? 'not-allowed' : 'pointer', alignSelf: 'flex-start',
            }}>{submitting ? 'Sending…' : 'Send this over'}</button>

            {/* ── Privacy notice, not a consent checkbox. ──────────────
                Nobody here is buying anything and no account is minted,
                so there is no service whose terms they could be
                accepting — a ToS checkbox would be meaningless and a
                conversion tax on a cold reader. What they do need is to
                be told what happens to what they typed.

                🔴 The "and to follow up about our service" clause is
                load-bearing. Advertising is already running through a
                trade association and a captured list is the obvious
                thing to mail later; these people have to have been told
                at capture that follow-up was the point. One clause now,
                or the whole list later. */}
            <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.55, color: '#56605A', maxWidth: 640 }}>
              We&rsquo;ll use this to reply to you about ShieldMyLot and to follow up about our service.
              We won&rsquo;t sell or share it. See our{' '}
              <a href="/privacy" style={{ color: '#6B5A1E' }}>Privacy Policy</a>.
            </p>

            {/* ── Self-serve door ──────────────────────────────────────
                Secondary on purpose: the demo is the primary action and
                a single-property manager is the exception, not the
                pitch. Links to plain /signup — the tier picker has NO
                URL preselect today (app/signup/page.tsx:99 hardcodes
                'enforcement_only'), so a ?tier= would be ignored and a
                PM would land on the wrong card believing we had chosen
                for them. Silently-ignored is worse than absent. */}
            {selfServeOpen && (
              <p style={{ margin: '2px 0 0', fontSize: 16, lineHeight: 1.55, color: INK, maxWidth: 640 }}>
                Managing a single property?{' '}
                <a href="/signup" style={{ color: '#6B5A1E', fontWeight: 700 }}>Start on your own &rarr;</a>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* One outbound link, in the footer, as designed. */}
      <div className="op-wrap" style={{ padding: '24px 22px', borderTop: `4px solid ${GOLD}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <a href="https://shieldmylot.com" style={{ color: GOLD_LIGHT, fontWeight: 600, fontSize: 19, letterSpacing: '0.03em', textTransform: 'uppercase', textDecoration: 'none' }}>
          Everything else we do &rarr;
        </a>
        <div style={{ fontSize: 11, letterSpacing: '0.09em', textTransform: 'uppercase', color: '#9FB3C2', lineHeight: 1.6 }}>
          ShieldMyLot&trade; &middot; Alvarado Legacy Consulting LLC<br />Built in Texas for Texas properties
        </div>
      </div>
    </main>
  )
}
