# /register accepts three submits in the same minute

**Filed:** 2026-11-16 · **Low priority** (data noise, not a blocked resident)

## Observed

In the 30 days to 2026-11-16, two of five people produced same-minute bursts:

- one submitted **3 times at 03:38**, then failed a captcha 20 minutes later;
- one submitted successfully at 00:49, then **3 more times at 00:56** and twice at 01:04.

Those 15 `existing_records_for_email` audit rows are really 5 people, and the bursts are
why the raw count reads 3× worse than reality.

## Likely cause

The submit button has a `disabled` prop, but the precheck branch calls
`turnstileRef.current?.reset()` and `setCaptchaToken(null)` — and the error path sets
`setSubmitting(false)`. A fresh captcha solve can re-enable the button while the previous
response is still settling, so a second click goes through.

## Why it is low priority

Nobody is blocked by it: every one of the five ended with a working portal. It inflates
the attempt counts and makes the funnel look worse than it is, and it costs a duplicate
captcha verification per extra click.

## Shape

Guard on the in-flight request rather than on captcha presence — one `submitting` ref
checked at the top of `submit()`, released only when the response has been handled. Do not
disable the claim button on the same flag: that one legitimately needs a fresh solve.
