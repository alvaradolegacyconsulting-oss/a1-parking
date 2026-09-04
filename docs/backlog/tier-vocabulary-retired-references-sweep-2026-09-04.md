# Backlog — tier-vocabulary retired-references sweep

**Date filed:** 2026-09-04
**Trigger:** pm_starter portal-gap enumeration during Sep 4 rehearsal follow-up

## Pattern

Code paths that branch on tier NAMES accumulate references to vocabulary
that was later retired. The 3-tier remap (June 26 Slice 1 Commit 5)
consolidated `starter`/`growth`/`legacy` and `essential`/`professional`/`enterprise`
into the current `enforcement_only`/`pm_only`/`legacy` set. Then the
Aug 31 rewrite added `pm_starter`/`custom_quote` for the public catalog.

**Two file-level instances survive** where `tier === 'retired_value'`
comparisons still run at runtime. Both are inert with the current live
catalog (no company row carries the retired tier name), so they don't
produce user-visible bugs — but they're the same rot class as the
pm_starter portal miss:

> *vocabulary changed, the code that branches on it didn't.*

Third instance in one week, argues for a sweep.

## Instance 1 — theme-show gate

**File:** app/company_admin/page.tsx:4196-4197
**Live behavior:** matches ZERO subscribers today.

```ts
const showTheme = (tierType === 'enforcement' && (tier === 'growth' || tier === 'legacy')) ||
                  (tierType === 'property_management' && (tier === 'professional' || tier === 'enterprise'))
```

`growth`, `professional`, `enterprise` are all retired. `legacy` is the
only live tier in the gate — but the compound `tierType === 'enforcement' && tier === 'legacy'`
matches only enforcement-track Legacy companies (rare in the live
catalog).

**Triage question:** dead code, or a feature no live subscriber can
access? Themes may have been intended for a paid tier that got
consolidated away. Answer before either fixing or removing.

## Instance 2 — TierUpgradeModal.nextWithinTrackTier

**File:** app/components/TierUpgradeModal.tsx:405-412
**Live behavior:** returns `null` for every live self-serve tier
(pm_starter, pm_only, enforcement_only) because none appear in the
retired-vocab order arrays. Callers correctly handle null by falling
through to the "Contact support to expand" message at
company_admin/page.tsx:1515.

```ts
const order = track === 'enforcement'
  ? ['starter', 'growth', 'legacy']
  : ['essential', 'professional', 'enterprise']
```

**Coincidentally correct** — no self-serve upgrade target exists for
any current tier (Starter and Enforcement-Only are singletons in their
tracks; pm_only is negotiated-only). But it's coincidence, not
intention.

**Fix shape when triaged:** replace with a config-driven read from
TIER_LADDER (which was updated for the 3-tier remap and is the
current source of truth for within-track upgrade paths).

## Sweep proposal

After the public_signup_open flip, grep every `tier === '` and
`tier == '` reference across app/ and audit each for retired
vocabulary. Expected findings:

- app/company_admin/page.tsx (multiple)
- app/lib/*.ts (tier.ts, tier-config.ts, tier-display.ts)
- app/components/TierUpgradeModal.tsx
- app/api/**/route.ts (any tier-gated routes)
- Migration files (SQL — CHECK constraints, get_company_property_limit CASE)

Cross-reference against the current TIER_CONFIG live set. Any tier
name in an app-code comparison that isn't in the live set is either
dead code (delete) or a feature nobody can access (triage + fix or
remove).

## Related standing rules

- [[feedback_tier_pricing_omission_audit]] — sibling class: TIER_PRICING
  omission + `?? 0` fallthrough produces fabricated pricing. Same
  root cause: silent fallthrough on a tier the code doesn't recognize.
- [[project_b34_tier_config_drift]] — TS tier config drift vs SQL
  helpers is the same pattern in cross-boundary form.

## Priority

Post-flip. Not blocking Bar-2 launch. The pm_starter portal fix
(2026-09-04) handles the ONE case that would have hit a live
subscriber; the two instances above stay inert until a company row
carries a retired tier name (which never happens post-remap).
