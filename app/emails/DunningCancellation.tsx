import * as React from 'react'
import { Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Cancellation — Subscription terminated. Professional, terminal.
// Fires from cron sweep concurrent with suspended → cancelled state
// transition (atomic per-row inside Sweep 2).
//
// "Thank you for being part of ShieldMyLot" closing per greenlight tweak
// — affirms they were a real customer (vs the "trying" framing that
// reads beta-product-y).

export type DunningCancellationProps = ChromeOwnerProps

export function DunningCancellation(props: DunningCancellationProps): React.ReactElement {
  const previewText = `${props.company_name} cancelled. 30 days to restore.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        <strong>{props.company_name}</strong>&apos;s ShieldMyLot subscription has been cancelled.
        This happened because the past due payment wasn&apos;t resolved within the 14-day grace
        period (7 days past due + 7 days suspended).
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>What this means</Text>
      <Text style={dunningBodyText}>
        • All portals are no longer accessible<br />
        • Your data is retained for 30 days from today, in case you&apos;d like to restore the account<br />
        • After 30 days, account data is removed per our standard retention policy
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>If you&apos;d like to come back</Text>
      <Text style={dunningBodyText}>
        You can start a new subscription at any time during the 30-day window: just contact
        support@shieldmylot.com and we&apos;ll help you restore access without losing your existing data.
      </Text>
      <Text style={dunningBodyText}>
        After the 30-day window, you can sign up again as a new account, but historical data
        won&apos;t carry over.
      </Text>
      <Text style={dunningBodyText}>
        Thank you for being part of ShieldMyLot.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
