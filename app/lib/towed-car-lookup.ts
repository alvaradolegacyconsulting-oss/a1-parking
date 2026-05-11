// We link out to a third-party tow lookup so users can search themselves.
// We do NOT pass a plate or state — the third-party service defaults to
// Alabama when state is missing, and there's no documented Texas-wide
// URL form. Letting the user search on the third-party site keeps us
// out of the business of asserting where someone's car is.
// See backlog May 13 2026 entry B8.
export const TOWED_CAR_LOOKUP_URL = 'https://www.findmytowedcar.org'
