import * as React from 'react'
import { Link, Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, dunningCTAButton, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Day 0 — Payment failed, informational + reassuring.
// Fires immediately on invoice.payment_failed webhook + by the
// subscription-updated.ts defensive populator path.

export interface DunningDay0Props extends ChromeOwnerProps {
  update_payment_url: string
}

export function DunningDay0(props: DunningDay0Props): React.ReactElement {
  const previewText = `We weren't able to process payment for ${props.company_name}. Stripe will retry automatically.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        We weren&apos;t able to process the payment for <strong>{props.company_name}</strong>&apos;s
        ShieldMyLot subscription. This sometimes happens — an expired card, an updated billing address,
        or a bank issue.
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>What happens next</Text>
      <Text style={dunningBodyText}>
        Stripe will retry the payment automatically over the next few days. If those retries succeed,
        you&apos;ll receive a payment confirmation and no action is required.
      </Text>
      <Text style={{ ...dunningBodyText, fontWeight: 700, marginTop: '16px' }}>What you can do now</Text>
      <Text style={dunningBodyText}>
        If your payment information has changed, you can update it in your account. The fastest path is
        to sign in and visit the Billing tab on your dashboard.
      </Text>
      <Link href={props.update_payment_url} style={dunningCTAButton}>
        Sign in to update payment
      </Link>
      <Text style={dunningBodyText}>
        Questions? Reply to this email or contact support@shieldmylot.com.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
