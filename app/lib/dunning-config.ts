import 'server-only'

// B66.5 — dunning lifecycle grace durations.
//
// Single source of truth for the two grace clocks. Lands in commit 3
// (hourly cron) but also refactors the 2 commit-2 callsites that had
// SEVEN_DAYS_MS inline (invoice-payment-failed.ts + subscription-
// updated.ts populator) to import these constants — eliminates the
// duplicate-magic-number risk if we ever change the durations.
//
// Today both grace periods are 7 days. Defined as separate constants
// (vs. one shared SEVEN_DAYS_MS) because they're semantically distinct
// clocks — the dunning lifecycle could grow asymmetric (e.g., 7-day
// past-due grace but 14-day suspension grace) without renaming either.

export const PAST_DUE_GRACE_MS   = 7 * 24 * 60 * 60 * 1000  // 7 days
export const SUSPENSION_GRACE_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
