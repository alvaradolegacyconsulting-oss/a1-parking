'use client'
import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
import { guardEmail, suggestEmailCorrection } from '../lib/email-guard'
import { readAttribution, buildLeadPayload, type AskedFields } from '../lib/lead-attribution'
import type { LeadSource } from '../lib/leads'

// ════════════════════════════════════════════════════════════════════
// /operators — ad landing page. Commit 3 of 4 (2026-09-23)
// ════════════════════════════════════════════════════════════════════
//
// The front door for print and email advertising run through a trade
// association. The form here is THE SAME INTAKE as the full public form
// will be: same table, same POST route. There is no second lead path.
//
// 🔴 MOBILE IS THE PRIMARY VIEW, not the fallback. Print QR scans are
// effectively all phone traffic and the print ad is half the campaign.
// Where the two conflict, mobile wins — which is why the layout is
// written mobile-first and desktop is the media query.
//
// 🔴 BOTH SURFACES ASK THE SAME QUESTIONS. Timeline was cut from the
// desktop comp rather than added to mobile. If desktop asked it and
// mobile did not, `timeline IS NULL` would mean "did not answer" on one
// surface and "was never asked" on the other — the same absence
// conflation as the three-state booleans and the cleanCount('') bug,
// through a third door. Two surfaces of one intake differ only by
// deliberate decision, and this one was decided the other way.
//
// NO PRICING ANYWHERE. No figure, no range, no "starting at".
// NO NAV BAR — this page is the continuation of an ad, and a nav bar
// invites people out of it mid-argument. One outbound link, in the
// footer, as designed.

const NAVY = '#0E2434'
const GOLD = '#BA9233'
const GOLD_LIGHT = '#D9AE45'
const CREAM = '#F4F2EC'
const INK = '#2B3F4E'

// Track is DERIVED, never selected. The ads that drive this traffic aim
// at operators, so this surface pre-answers "which describes your
// business" and never shows the question.
const TRACK = 'enforcement' as const

// What THIS surface asks. Read by buildLeadPayload so an unticked box
// the page presented is sent as an explicit false rather than omitted.
const ASKED: AskedFields = { texas_confirmed: true, wants_demo: true }

export default function OperatorsPage() {
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
          nav bar: this is an ad landing page and the demo button is the
          only call to action. Adding links here gives a cold reader
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
          For Texas towing operators
        </div>
        <h1 className="op-h1" style={{ margin: '16px 0 0', fontWeight: 700, textTransform: 'uppercase' }}>
          This is what you&rsquo;d <span style={{ color: GOLD_LIGHT }}>bring them.</span>
        </h1>
        <p className="op-lede" style={{ margin: '20px 0 0', color: '#D3DFE8', maxWidth: 780 }}>
          You already have the trucks, the drivers and the relationships. This is the part a property has
          never been offered by its towing company &mdash; somewhere their residents register, their office
          issues passes, and their parking stops being a thing they call you about.
        </p>
        <a href="#start" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 54, marginTop: 26,
          background: GOLD, color: NAVY, fontWeight: 700, fontSize: 20, letterSpacing: '0.04em',
          textTransform: 'uppercase', textDecoration: 'none', maxWidth: 420,
        }}>Request a 15-minute demo</a>
      </div>

      <div style={{ background: CREAM, color: NAVY }}>
        <div className="op-wrap op-pad">
          <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>What the property gets</h2>
          <p style={{ margin: '10px 0 0', fontSize: 17, lineHeight: 1.45, color: INK }}>
            Set up under your company, handed to them by you.
          </p>
          <div className="op-grid" style={{ marginTop: 24 }}>
            {[
              ['Resident registration', 'Residents add their own vehicles from a phone. The office stops keeping the list by hand, and the list is right because the resident made it.'],
              ['Visitor passes', 'Issued by the property, or by residents within limits the property sets. No more calls to your dispatcher about a guest car.'],
              ['A current permit list', 'Spaces, assignments and who parks where — visible to the property and to your drivers at the same time.'],
            ].map(([h, b]) => (
              <div key={h} style={{ background: '#fff', borderTop: `4px solid ${GOLD}`, padding: '20px 18px 22px' }}>
                <div style={{ fontWeight: 700, fontSize: 24, lineHeight: 1.05, textTransform: 'uppercase' }}>{h}</div>
                <div style={{ fontSize: 16, lineHeight: 1.5, color: INK, marginTop: 8 }}>{b}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="op-wrap op-pad">
        <h2 className="op-h2" style={{ margin: 0, fontWeight: 700, textTransform: 'uppercase' }}>What your side looks like</h2>
        <div className="op-two" style={{ marginTop: 24 }}>
          {[
            ['On the truck', 'Your driver enters or scans the plate, attaches photos and video at the vehicle, and completes the ticket from a phone. It files against the right property the moment it is submitted.'],
            ['In the office', 'Every property, every ticket, every driver in one searchable history — and you can still pull it up six months later when someone asks about a call.'],
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
            Operators running both sides of this are on our Legacy plan &mdash; enforcement and property
            management together, priced to the size of your operation rather than off a menu. Tell us what
            you cover and we will come back with next steps.
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
              <label htmlFor="op-properties" style={lbl}>Properties you cover</label>
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
          </div>
        </div>
      </div>

      {/* One outbound link, in the footer, as designed. */}
      <div className="op-wrap" style={{ padding: '24px 22px', borderTop: `4px solid ${GOLD}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <a href="https://shieldmylot.com" style={{ color: GOLD_LIGHT, fontWeight: 600, fontSize: 19, letterSpacing: '0.03em', textTransform: 'uppercase', textDecoration: 'none' }}>
          Everything else we do &rarr;
        </a>
        <div style={{ fontSize: 11, letterSpacing: '0.09em', textTransform: 'uppercase', color: '#9FB3C2', lineHeight: 1.6 }}>
          ShieldMyLot&trade; &middot; Alvarado Legacy Consulting LLC<br />Built in Texas for Texas operators
        </div>
      </div>
    </main>
  )
}
