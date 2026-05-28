import * as React from 'react'
import { Text } from '@react-email/components'
import { DunningChrome, dunningBodyText, type ChromeOwnerProps } from './_chrome/DunningChrome'

// Recovery — Payment received, positive and brief.
// Fires from invoice-payment-succeeded.ts when account was past_due or
// suspended (the recovery path; not on normal active-state payments).
//
// Intentionally short — Recovery shouldn't include billing CTAs that
// imply ongoing concern. Per greenlight: "Don't change. Length + tone
// is exactly right."

export type DunningRecoveryProps = ChromeOwnerProps

export function DunningRecovery(props: DunningRecoveryProps): React.ReactElement {
  const previewText = `Payment cleared. ${props.company_name} restored.`

  return (
    <DunningChrome {...props} preview={previewText}>
      <Text style={dunningBodyText}>Hi,</Text>
      <Text style={dunningBodyText}>
        Good news — <strong>{props.company_name}</strong>&apos;s payment cleared, and the ShieldMyLot
        subscription is fully restored.
      </Text>
      <Text style={dunningBodyText}>
        All portals are accessible again. No further action is needed.
      </Text>
      <Text style={dunningBodyText}>
        Thanks for staying with ShieldMyLot.
      </Text>
      <Text style={dunningBodyText}>— The ShieldMyLot Team</Text>
    </DunningChrome>
  )
}
