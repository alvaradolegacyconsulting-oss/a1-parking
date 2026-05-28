// B66.5 commit 4.2 — Shared chrome component for all 6 dunning email
// templates (DunningDay0 / DunningDay3 / DunningDay5 / DunningDay7 /
// DunningRecovery / DunningCancellation).
//
// Renders the brand header (logo + wordmark) + the body slot + the
// 4-section footer (account context, support contact, manage prefs,
// legal entity + copyright).
//
// The folder is underscore-prefixed (_chrome) per Next.js convention:
// non-routable colocation. .tsx files in app/ don't route unless they're
// page.tsx / route.ts, but the underscore makes the intent explicit and
// protects against accidental future route file additions inside.
// See [[feedback-next-private-folder-routing-convention]].
//
// Brand asset: /public/logo.jpeg referenced as absolute URL because
// email clients can't resolve relative paths. The asset is immutable
// (no versioning) — preview deploys reference the production logo, which
// is acceptable since the brand mark doesn't change per-deploy.

import * as React from 'react'
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
const LOGO_URL = `${APP_URL}/logo.jpeg`
const SUPPORT_EMAIL = 'support@shieldmylot.com'
const LEGAL_ENTITY = 'Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™'

// Conservative inline styles — most email clients don't honor external CSS
// or modern selectors. Bg + container + neutrals keep light/dark client
// rendering predictable.
const main: React.CSSProperties = {
  backgroundColor: '#f6f6f6',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  margin: 0,
  padding: 0,
}
const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '20px auto',
  padding: '24px',
  maxWidth: '560px',
  borderRadius: '6px',
}
const header: React.CSSProperties = {
  borderBottom: '1px solid #e5e5e5',
  paddingBottom: '16px',
  marginBottom: '20px',
  display: 'flex',
  alignItems: 'center',
}
const logoStyle: React.CSSProperties = {
  height: '36px',
  width: 'auto',
  marginRight: '12px',
  borderRadius: '4px',
}
const wordmark: React.CSSProperties = {
  fontSize: '18px',
  fontWeight: 700,
  color: '#1f2937',
  margin: 0,
}
const bodyText: React.CSSProperties = {
  color: '#1f2937',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 12px',
}
const footer: React.CSSProperties = {
  borderTop: '1px solid #e5e5e5',
  paddingTop: '16px',
  marginTop: '24px',
}
const footerText: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '0 0 6px',
}
const footerLink: React.CSSProperties = {
  color: '#6b7280',
  textDecoration: 'underline',
}

export interface DunningChromeProps {
  // Used by template subject lines + body; passed through so the chrome
  // doesn't need to re-resolve the company name.
  company_name: string
  // Tier label via TIER_DISPLAY_NAME canonical mapping (per B140 lesson).
  // Displayed in the footer's account-context line.
  tier_display: string
  // Recipient email — used by the chrome's "you are receiving this" line
  // so the recipient can confirm the email matches their account.
  recipient_email: string
  // Preview text: the snippet email clients show in inbox listings,
  // separate from the subject. Each template should pass a short
  // (~80 char) action-oriented preview.
  preview: string
  // Body slot.
  children: React.ReactNode
}

export function DunningChrome(props: DunningChromeProps): React.ReactElement {
  return (
    <Html>
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Img src={LOGO_URL} alt="ShieldMyLot" style={logoStyle} />
            <Text style={wordmark}>ShieldMyLot</Text>
          </Section>

          <Section>{props.children}</Section>

          <Section style={footer}>
            <Text style={footerText}>
              This message is about <strong>{props.company_name}</strong>&apos;s ShieldMyLot subscription
              ({props.tier_display} tier). It was sent to {props.recipient_email}.
            </Text>
            <Text style={footerText}>
              Questions? <Link href={`mailto:${SUPPORT_EMAIL}`} style={footerLink}>{SUPPORT_EMAIL}</Link>
            </Text>
            <Text style={footerText}>
              <Link
                href={`mailto:${SUPPORT_EMAIL}?subject=Dunning%20email%20preferences`}
                style={footerLink}
              >
                Manage email preferences
              </Link>
            </Text>
            <Hr style={{ borderColor: '#e5e5e5', margin: '12px 0' }} />
            <Text style={footerText}>
              {LEGAL_ENTITY}
            </Text>
            <Text style={footerText}>
              &copy; {new Date().getFullYear()} ShieldMyLot. All rights reserved.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

// Shared style export for templates that want consistent body-paragraph
// styling without re-declaring the rule.
export const dunningBodyText = bodyText

// Type-only helper: the props a TEMPLATE owns (the orchestration layer
// passes these in). Excludes preview + children, which each template
// supplies internally to the chrome wrapper.
export type ChromeOwnerProps = Omit<DunningChromeProps, 'preview' | 'children'>

// Shared CTA button style — used by Day0/3/5/7 for payment-update CTA.
// Day7 + Cancellation may use different visual weight; the templates
// can override locally.
export const dunningCTAButton: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: '#C9A227',
  color: '#0a0d14',
  fontSize: '14px',
  fontWeight: 700,
  textDecoration: 'none',
  padding: '12px 20px',
  borderRadius: '6px',
  margin: '8px 0',
}
