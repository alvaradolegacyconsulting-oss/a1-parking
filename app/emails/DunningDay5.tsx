import * as React from 'react'
import { Link, Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, dunningCTAButton, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Day 5 — Suspension warning, clearer urgency, still calm.
// Fires from cron sweep when past_due_since <= NOW() - INTERVAL '5 days'.
//
// Subject line uses the "compact, no awkward verb phrasing" option from
// the greenlight: "{{company_name}}: {{days_remaining}} days until
// suspension". The orchestration layer interpolates at send time.

export interface DunningDay5Props extends ChromeOwnerProps {
  days_remaining_until_suspension: number
  update_payment_url: string
}

export function DunningDay5(props: DunningDay5Props): React.ReactElement {
  const previewText = `Suspension in ${props.days_remaining_until_suspension} days unless payment is updated.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        <strong>{props.company_name}</strong>&apos;s ShieldMyLot subscription is still past due.
        Without payment, the account will be suspended in <strong>{props.days_remaining_until_suspension} days</strong>.
      </Text>
      <Text style={dunningBodyText}>
        When an account is suspended, drivers, residents, and managers lose access to their portals.
        You&apos;ll have an additional 7 days after suspension to restore the account before it&apos;s cancelled.
      </Text>
      <Link href={props.update_payment_url} style={dunningCTAButton}>
        Sign in to update payment
      </Link>
      <Text style={dunningBodyText}>
        Need to talk through options? Email support@shieldmylot.com — we&apos;d rather work with you
        than lose you.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
