'use client'
// ════════════════════════════════════════════════════════════════════
// /claim — the separate door for a bulk-loaded property
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15. The normal QR /register flow is UNCHANGED for
// everyone, and its tokenless-card handoff stays as the safety net for
// anyone who arrives there instead. This is an ADDITIONAL entry point
// the CA prints as its own flyer for a property it bulk-loaded.
//
// 🔴 EMAIL AND A CAPTCHA. NOTHING ELSE. The complaint this closes is
// that an imported resident filled three screens — password, unit,
// every vehicle — and was then told they were already on file. Here
// nothing typed can be discarded, because almost nothing is typed.
//
// 🔴 ONE ON-SCREEN ANSWER FOR EVERY INPUT. Records-bearing, unknown,
// already has a login, holds a staff role — all identical. The branch
// is server-side and visible only in the mailbox, which is the one
// place that proves who is asking. If this page ever said "we found
// you", it would be an enumeration oracle for any address someone
// cared to try — and the addresses here are residents of a named
// property, so the answer would disclose where a person lives.
//
// 🔴 AND NO EMAIL REACHES AN UNKNOWN ADDRESS, which is what stops the
// page being a way to mail strangers. The identical answer is about
// disclosure; send-nothing is about abuse. Different properties, both
// required — an identical screen that still mailed everyone would be
// a spam relay with good manners.
//
// ── WHY ?property= AND NOT A TOKEN ──────────────────────────────────
// 🔴 No property token exists in this codebase. Every property QR link
// today is /register?property=<name>&company=<name> (manager/page.tsx,
// company_admin/page.tsx). This page reuses that exact shape so the
// CA's existing QR generator can emit it, and so the "Register here →"
// fallback lands on the SAME property the flyer was for.
//
// A token would add nothing here: the page returns one answer to every
// input and mails no unknown address, so guessing a property name buys
// an attacker the same blank screen. What a token WOULD buy is revoke-
// ability of a printed flyer, which is a real but separate want —
// reported, not assumed.
// ════════════════════════════════════════════════════════════════════

import { Suspense, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'

const GOLD = '#C9A227'

function ClaimForm() {
  const sp = useSearchParams()
  const property = (sp.get('property') ?? '').trim()
  const company = (sp.get('company') ?? '').trim()

  const [email, setEmail] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState('')
  const turnstileRef = useRef<TurnstileHandle>(null)

  const registerHref = `/register${property ? `?property=${encodeURIComponent(property)}${company ? `&company=${encodeURIComponent(company)}` : ''}` : ''}`

  async function submit() {
    setError('')
    if (!email.trim()) { setError('Please enter your email address.'); return }
    if (!captchaToken) { setError('Please complete the CAPTCHA challenge below before submitting.'); return }
    setState('sending')
    const token = captchaToken
    // The token is single-use and the route consumes it, so it is
    // cleared on every outcome including the error ones.
    turnstileRef.current?.reset()
    setCaptchaToken(null)
    try {
      const res = await fetch('/api/register/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), property, captchaToken: token }),
      })
      // 🔴 ONLY REQUEST-SHAPE FAILURES ARE SURFACED, and none of them
      // depends on whether a record exists: a malformed body, a
      // rejected address, a failed or expired captcha. A user who
      // mistyped or whose challenge went stale needs telling, and
      // telling them leaks nothing about the mailbox.
      //
      // Everything else — 200, a 500, a dropped connection — lands on
      // the identical screen. Surfacing a server error here would be
      // one more bit than a success gives, and the bit would correlate
      // with which branch the server took.
      if (res.status === 400 || res.status === 403 || res.status === 503) {
        const j = await res.json().catch(() => ({} as { message?: string }))
        setError(j.message || 'Please check the address and try again.')
        setState('idle')
        return
      }
    } catch {
      // Identical screen either way. See above.
    }
    setState('sent')
  }

  // A flyer printed without the property is a broken flyer, and the
  // route would answer it with "Please enter your email address" —
  // advice the user cannot act on. Say the real thing instead.
  if (!property) {
    return (
      <Shell title="This setup link is incomplete">
        <p style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.6 }}>
          This link is missing its property, so we cannot tell which community you are
          setting up for. Check the flyer or QR code from your property, or ask the
          office to send it again.
        </p>
        <p style={{ fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          You can also <a href="/register" style={{ color: GOLD }}>register here →</a>
        </p>
      </Shell>
    )
  }

  if (state === 'sent') {
    return (
      <Shell title="Set up your parking login" subtitle={property}>
        {/* 🔴 THIS COPY IS THE RULING, VERBATIM. It is identical for a
            records-bearing resident, an unknown address, a staff role
            and someone who already has a login. Any edit that makes it
            conditional reopens the oracle. */}
        <p style={{ color: '#6cc48e', fontSize: 15, fontWeight: 700, margin: '0 0 10px' }}>Check your email.</p>
        <p style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.6 }}>
          If your property set you up, your setup link arrives within a few minutes.
        </p>
        <p style={{ fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          No email? <a href={registerHref} style={{ color: GOLD }}>Register here →</a>
        </p>
        <p style={{ color: '#888', fontSize: 12, margin: '14px 0 0', lineHeight: 1.6 }}>
          Already have a login, or had a setup link that expired?{' '}
          <a href="/forgot-password" style={{ color: GOLD }}>Forgot password</a>{' '}
          works even if you never finished setting up.
        </p>
      </Shell>
    )
  }

  return (
    <Shell title="Set up your parking login" subtitle={property}>
      <p style={{ color: '#888', fontSize: 13, margin: '0 0 18px', lineHeight: 1.6 }}>
        Your property has already added its residents and vehicles. Enter your email and
        we will send you a link to finish setting up your login — no forms to fill in.
      </p>

      {error && (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{error}</p>
        </div>
      )}

      <label htmlFor="claim-email" style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        Your email
      </label>
      <input
        id="claim-email"
        type="email"
        value={email}
        autoComplete="email"
        onChange={e => setEmail(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && state !== 'sending') void submit() }}
        placeholder="you@example.com"
        style={{ width: '100%', padding: '10px 12px', background: '#0f1117', color: '#e2e8f0', border: '1px solid #2a2f3d', borderRadius: 6, fontSize: 14, marginBottom: 16, boxSizing: 'border-box' }}
      />

      <div style={{ marginBottom: 16 }}>
        <TurnstileWidget
          ref={turnstileRef}
          onVerify={setCaptchaToken}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
          action="claim"
        />
      </div>

      <button
        onClick={() => { void submit() }}
        disabled={state === 'sending' || !captchaToken}
        style={{
          background: captchaToken ? GOLD : '#3a3a3a',
          color: captchaToken ? '#1a1a1a' : '#777',
          border: 'none', borderRadius: 6, padding: '11px 20px',
          fontSize: 14, fontWeight: 700, width: '100%',
          cursor: captchaToken && state !== 'sending' ? 'pointer' : 'not-allowed',
        }}>
        {state === 'sending' ? 'Sending…' : 'Email me a setup link'}
      </button>
      {!captchaToken && (
        <p style={{ color: '#777', fontSize: 11, margin: '8px 0 0', textAlign: 'center' }}>
          Complete the check above to continue
        </p>
      )}

      <p style={{ color: '#888', fontSize: 12, margin: '16px 0 0', lineHeight: 1.6 }}>
        Not added by your property yet?{' '}
        <a href={registerHref} style={{ color: GOLD }}>Register here →</a>
      </p>
    </Shell>
  )
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', color: '#e2e8f0', fontFamily: 'Arial, sans-serif', padding: '40px 20px' }}>
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <h1 style={{ color: GOLD, fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>{title}</h1>
        {subtitle && <p style={{ color: '#aaa', fontSize: 14, fontWeight: 600, margin: '0 0 20px' }}>{subtitle}</p>}
        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 22, marginTop: subtitle ? 0 : 16 }}>
          {children}
        </div>
      </div>
    </main>
  )
}

export default function ClaimPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0f1117' }} />}>
      <ClaimForm />
    </Suspense>
  )
}
