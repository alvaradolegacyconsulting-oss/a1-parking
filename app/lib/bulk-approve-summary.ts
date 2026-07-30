// Bulk-approve summary — shared shape for the manager's bulk approve
// action. Desktop renders the full text as an alert() body; mobile
// (Build 2, incoming) renders lines inline as a list under the bulk
// button.
//
// Callers:
//   • Desktop: app/manager/page.tsx approveAllPendingCrm phase-4
//     — passes .text to alert().
//   • Mobile:  app/manager/mobile (Build 2)
//     — renders .lines inline.
//
// Pure function — no DB / SDK / React dependencies. Testable without
// spinning up Supabase / Next runtime. Same convention as
// app/lib/bulk-upload-helpers.ts and app/lib/plate-status.ts.
//
// The denominator fix (2026-07-30, per Mateo review after Jose's
// Build 1 verify): the vehicles line uses vehicleAttemptedCount
// (the pre-eligibility count the confirmation dialog showed), NOT
// the post-eligibility filtered count. Prior shape ("3 of 4 vehicles
// approved" when 5 were confirmed) silently shifted the denominator's
// meaning between confirmation and summary; a manager asks where the
// fifth went. Sum-to-total by construction now.

export type BulkApproveSummaryInput = {
  residentAttemptedCount: number
  residentSuccessCount: number
  failedResidentLabels: string[]        // name || email || `(id N)`
  vehicleAttemptedCount: number         // PRE-eligibility count (from confirmation dialog)
  vehicleSuccessCount: number
  failedVehicleLabels: string[]         // plate || `(id N)`
  skippedFailedApprovalLabels: string[] // resident in this batch, phase-1 UPDATE errored
  skippedResidentNotApprovedLabels: string[] // resident not in this batch AND not already-active
}

export type BulkApproveSummary = {
  lines: string[]  // for mobile inline render — no header
  text: string     // for desktop alert() — header + '\n\n' + lines.join('\n')
}

// INVARIANT: successes + failures + skips === vehicleAttemptedCount.
// The denominator is the PRE-eligibility count, matching the confirmation
// dialog — otherwise the number silently changes meaning between the two
// prompts and a manager asks where the missing vehicle went. If a fifth
// skip category is ever added, update the caller AND this invariant.
export function buildBulkApproveSummary(i: BulkApproveSummaryInput): BulkApproveSummary {
  const lines: string[] = []
  if (i.residentAttemptedCount > 0) {
    const rPlural = i.residentAttemptedCount === 1 ? '' : 's'
    lines.push(`${i.residentSuccessCount} of ${i.residentAttemptedCount} resident${rPlural} approved`)
    if (i.failedResidentLabels.length > 0) {
      lines.push(`  ↳ Failed: ${i.failedResidentLabels.join(', ')}`)
    }
  }
  if (i.vehicleAttemptedCount > 0) {
    const vPlural = i.vehicleAttemptedCount === 1 ? '' : 's'
    lines.push(`${i.vehicleSuccessCount} of ${i.vehicleAttemptedCount} vehicle${vPlural} approved`)
    if (i.failedVehicleLabels.length > 0) {
      lines.push(`  ↳ Failed: ${i.failedVehicleLabels.join(', ')}`)
    }
    if (i.skippedFailedApprovalLabels.length > 0) {
      lines.push(`  ↳ ${i.skippedFailedApprovalLabels.length} skipped (resident approval failed): ${i.skippedFailedApprovalLabels.join(', ')}`)
    }
    if (i.skippedResidentNotApprovedLabels.length > 0) {
      lines.push(`  ↳ ${i.skippedResidentNotApprovedLabels.length} skipped (resident not approved): ${i.skippedResidentNotApprovedLabels.join(', ')}`)
    }
  }
  const text = `Bulk approval complete.\n\n${lines.join('\n')}`
  return { lines, text }
}
