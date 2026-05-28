import * as React from 'react'
import { Link, Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, dunningCTAButton, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Day 3 — Past due reminder, gentle escalation.
// Fires from cron sweep when past_due_since <= NOW() - INTERVAL '3 days'.

export interface DunningDay3Props extends ChromeOwnerProps {
  days_remaining_until_suspension: number
  update_payment_url: string
}

export function DunningDay3(props: DunningDay3Props): React.ReactElement {
  const previewText = `${props.company_name} is past due. ${props.days_remaining_until_suspension} days until suspension.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        <strong>{props.company_name}</strong>&apos;s ShieldMyLot subscription is still past due. Our
        records show the payment hasn&apos;t gone through yet.
      </Text>
      <Text style={dunningBodyText}>
        Your account remains active for the next <strong>{props.days_remaining_until_suspension} days</strong>.
        If the payment isn&apos;t resolved by then, the account will be suspended automatically.
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>What you can do now</Text>
      <Link href={props.update_payment_url} style={dunningCTAButton}>
        Sign in to update payment
      </Link>
      <Text style={dunningBodyText}>
        If you&apos;ve already updated your payment method, you can ignore this — it may take a few hours
        for the next retry to clear.
      </Text>
      <Text style={dunningBodyText}>
        Questions? We&apos;re here at support@shieldmylot.com.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
