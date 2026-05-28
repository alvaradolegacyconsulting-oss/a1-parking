import * as React from 'react'
import { Link, Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, dunningCTAButton, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Day 7 — Suspension notice. Informational, not punitive.
// Fires from cron sweep concurrent with past_due → suspended state
// transition (atomic per-row inside Sweep 1).
//
// "Your data remains intact and ready for restoration" framing per
// greenlight tweak — avoids the "we didn't delete your stuff" defensive
// energy.

export interface DunningDay7Props extends ChromeOwnerProps {
  update_payment_url: string
}

export function DunningDay7(props: DunningDay7Props): React.ReactElement {
  const previewText = `${props.company_name} suspended. 7 days to restore.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        <strong>{props.company_name}</strong>&apos;s ShieldMyLot subscription has been suspended because
        the past due payment wasn&apos;t resolved within the 7-day grace period.
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>What this means</Text>
      <Text style={dunningBodyText}>
        • Drivers, residents, and managers temporarily can&apos;t access their portals<br />
        • Your data remains intact and ready for restoration<br />
        • You have 7 days to restore the account by completing the past due payment
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>How to restore access</Text>
      <Link href={props.update_payment_url} style={dunningCTAButton}>
        Sign in to update payment
      </Link>
      <Text style={dunningBodyText}>
        Once the payment clears, all portal access is restored automatically.
      </Text>
      <Text style={dunningBodyText}>
        If you&apos;d like to discuss your situation before paying, contact support@shieldmylot.com.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
