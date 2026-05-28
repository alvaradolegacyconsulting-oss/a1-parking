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

// B66.5 commit 4.2 — Day 3 + Day 5 email scan thresholds. Used by
// app/api/cron/dunning/route.ts to compute "past_due_since <= NOW() - N"
// predicates for the Day 3 + Day 5 dunning email scans. Co-located here
// so future day-threshold tweaks (e.g., adding a Day 6 scan or shifting
// to Day 4 / Day 6) touch one file, not two.
export const DUNNING_DAY_3_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000  // 3 days
export const DUNNING_DAY_5_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000  // 5 days
