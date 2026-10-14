# ShieldMyLot — Backlog Reconciliation

**Date:** 2026-06-17
**Prepared by:** Mateo (Claude)
**Purpose:** Cross-reference every item logged across all backlog sources against actual ship evidence in the codebase, so Jose can audit ~200 items in his next session with real data instead of reconstructing from memory.

## Sources consulted

- `~/Downloads/ShieldMyLot_Feature_Backlog_May{13,14,15,16}_2026.md` + EOD delta
- `~/Downloads/engineering_backlog_reset_may30_2026.md`
- `~/Downloads/b119_b120_b121_chapter_2308_backlog.md` (B119–B121 specific entries)
- `~/Downloads/b151_b152_b153_backlog_entries_june1_2026.md` (B151–B153 specific entries)
- `~/Downloads/files-14/b90_b91_b92_backlog_entries.md` (B90–B92 specific entries)
- `~/Downloads/new-chat-kickoff*.md`
- `~/.claude/projects/-Users-ALC-a1-parking/memory/` (MEMORY.md index + 70+ `project_b*.md` closures)
- `git log --oneline` (271 commits, HEAD at `7da03d2`)
- `migrations/` (52 files; filename often encodes the B-number)
- `scripts/probe-*.ts` (9 probe scripts; existence proves the feature shipped)

## Methodology

For every item with a B/A/D/Phase number found in any source:
1. Check `git log` for commit message matching the number (single commit OR multiple commits OR squash group)
2. Check memory `project_*.md` for explicit "SHIPPED YYYY-MM-DD via <SHA>" markers
3. Check `migrations/` for filename containing the number
4. Check probe scripts for the number
5. Classify: SHIPPED (any of the above) / OPEN (none) / UNCLEAR (partial/conflicting) / LIKELY MOOT (direction changed since filing)

PDFs in `~/Downloads/` (May 7 backlog, June 14/15 open backlogs, A1_Wrecker_Feature_Backlog-*.pdf) could NOT be text-extracted without `poppler` installed. The .md sources covered most of the same content; items existing only in those PDFs may not appear here.

## Counts

| Status | Count |
|---|---|
| **SHIPPED** | 109 |
| **OPEN** (genuinely) | 27 |
| **UNCLEAR** | 7 |
| **LIKELY MOOT** (direction changed) | 5 |
| **TOTAL** | 148 |

The ~200 count Jose remembered may include direction-change variants of the same item (e.g., B66.9 Pattern B + Pattern A), pre-rebrand A1-Parking items, sub-item splits (B13/B18 Commits A/B/C1/C2 counted as one in this report), or items that only exist in the un-text-extractable PDFs.

---

## SECTION 1 — SHIPPED

Items with hard ship evidence. **Jose can delete from his open list.** Sorted numerically.

### B-items

| Item | Title | Evidence |
|---|---|---|
| B7 | Vehicle desc helper text on visitor pass forms | `6f051bf` |
| B8 | FindMyTowedCar link-out (Alabama default fix) | `91fb8c0` |
| B9 | Resident vehicle edit UI (cosmetic fields) | `7a0f457` |
| B13/B18 | Two-step submission + photo/video soft-delete (A/B/C1/C2) | `721fcef` + `5d389df` + `2e636fb` + `bf50a18` |
| B14 | Video upload resilience (Phase 1+2 tus uploads) | `986811e` + `8c21957` |
| B19 | Visitor pass per-plate limit (trigger + UI) | `6d4dba8` |
| B28 | Photo input appends instead of replaces | `5e20ab3` |
| B29 | Per-photo X remove button on violation form | `b0742f0` |
| B30 | Photo count cap per violation | `ca9678f` (subsumed by B42; memory note) |
| B31 | Play Video button on driver violations list | `847e18c` |
| B32 | Vehicle color/make/model on resident + history | `e1fdb1b` |
| B36 | Resident vehicle-limit message swap | `3991413` |
| B38 | Driver/CA Discard button + per-draft resume banner | `3991413` |
| B39 | Play Video button on resident violation cards | `e33cbb2` |
| B40 | Violations RLS capture-pass + helpers | `7b9f849` |
| B41 | Resident photo slice cap removed | `915f494` |
| B42 | Photo count cap per violation (tier-gated) | `ca9678f` |
| B43 | (Bundled with B40) violations RLS migration | `7b9f849` |
| B45 | Admin Add User dropdown includes leasing_agent | `915f494` |
| B47 | Proposal PDF workflow doc committed | `915f494` (doc: `docs/proposal-pdf-workflow.md`) |
| B48 | Path 1: clickable /proposal/<code> link removed | `915f494` |
| B50 | Help docs committed (16 markdown files) | `efc476b` |
| B51a | Towing authorization columns + UI | `185f79f` + `a9dcfc4` |
| B55 | Landing page Phase 1 surgical fixes | `e3d1754` |
| B57 | Remove unbuilt AI chatbot flags | `cd635cb` |
| B58 | White-glove + driver performance descope | `cd635cb` |
| B62 (.1-.4) | Landing page Phase 2 restructure | `dd0b8e2` + `cd894f4` + `f235d37` + `a7fa593` |
| B65 (.1-.4) | Self-serve onboarding v1 schema + flow | `db136e9` + `2457ebf` + `e562706` + `d8a024b` + `d87f02a` |
| B66.1 | Stripe dormancy scaffold | `b0c9d56` |
| B66.2a | Stripe Price catalog (30 prices) | `3135cab` + `7e3bd9d` |
| B66.2b | Proposal-code Stripe Price creation | `a0dbfc4` + `2a3d6a5` |
| B66.3 + B99 | Self-serve signup + password reset | `3c6bd8c` + `d9fcf9d` + `84b55dd` |
| B66.4 | Customer Portal embed + 3 sync webhooks | `e4f9b10` + `d9658e9` + `d202d46` |
| B66.5 (commits 1–4.3 + .1/.2) | Dunning arc (full) | `073067f` + `094a85f` + `efed3c3` + `a917ee4` + `93e8cfd` + `fe7f2d4` + `8603ec2` + `2b6821d` + `76d644b` |
| B66.7 | Proposal-code → Stripe Subscription | `3951f4c` + `a3ff3e1` + `638b5be` |
| B70 | PM plate lookup (DEFINER RPC) | `3253850` |
| B71 | Authorized-vehicle violation gap | `3253850` |
| B74 | RLS hardening vehicles + visitor_passes | `fa6ad9a` (replaces `cd76be5`) |
| B75 | MANAGER_PLATE_LOOKUP rename + tier expansion | `8fc3c5f` |
| B76 | Post-activation dashboard bootstrap fix | `4d6a63e` |
| B78 | Tow ticket vehicle fields | `5e18e04` + `01c5231` |
| B80 | Leasing_agent backfill into B40 violations RLS | `010f755` |
| B82 | PUBLIC-grant retrofit phase 2 | `fccb252` (after `2a882b3`) |
| B83 | Resident add-vehicle silently blocked | `87bdf99` |
| B84 | Driver plate lookup pending-vehicle label fix | `8a304e1` (bundled w/ B87) |
| B85 | Help center site routing (Phase 1 + 2) | `efc476b` + `2b987e8` + `5536276` + `e5c174c` |
| B87 | (Bundled w/ B84 small-fixes) | `8a304e1` |
| B89 part 1 | Enforcement Premium tier (4th, contact-sales) | `8814936` |
| B89 part 2 | Help-doc screenshot placeholder cleanup | `de80d6f` |
| B90 v2 | Resident vehicle write guard via DEFINER RPC | `fb7d357` (see UNCLEAR for relationship to original B90 backlog entry) |
| B93 | Help-doc cross-link 404 fix | `b819742` |
| B99 | Password reset code (bundled w/ B66.3) | `3c6bd8c` + `d9fcf9d` |
| B109 | Vercel Stripe env vars Production gap | Resolved in-session 2026-05-23 (memory) |
| B113 | Bulk upload UI + API (drivers + residents) | `247c47c` + `89e73af` + `0611b57` fast-follow |
| B117 phase 2 | OTP fallback on 4 verify pages | `44a80ba` + `b93ab7a` acceptance + `751e063` + `ae0ff3a` + `a7b982b` + `fa0c432` |
| B118 | Self-serve ToS + Privacy consent (version-aware) | `e956f54` + `d897dc4` + `29007d4` + `4898b84` |
| B119 | Soften Chapter 2308 marketing claims | `36c24a2` |
| B120 | Operator licensing data (TDLR + tow-ticket display) | `1cd2f87` + `27e2e29` |
| B122 | Bulk-upload tab styling (B113 fast-follow) | `0611b57` |
| B123→B140 | Tier badge accuracy / post-payment bootstrap | `229041d` (subsumed) |
| B126 | Bulk-upload result-UI state (B113 fast-follow) | `0611b57` |
| B127 | Bulk-upload (B113 fast-follow) | `0611b57` |
| B130 | PM track hide Drivers entity (B113 fast-follow) | `0611b57` |
| B140 | Self-serve post-payment badge bootstrap | `229041d` |
| B141 | Webhook tier-write on customer.subscription.updated | `6b9007f` |
| B144 | CA Resend Invite (B66.5.1 parity) | `2b6821d` |
| B147 | Quantity sync (defer-to-renewal) — Stripe arc | `f7e9ffd` (squash) + `010dd75` + `6934576` + `8e187f4` + `717b6f0` |
| B149 | Honest-down (cleanup commit fragment) | `cf9cd2d` |
| B150 | Vehicle lifecycle cascade on resident move-out | `2f062a9` + `aa4b0c6` |
| B151 | customer.subscription.created webhook dispatch | `e2431d3` |
| B153 | Webhook race: eager-populate fix | `da9bbda` |
| B154 | Storage_facilities subscriber-ownership | `2b980df` + `cf9cd2d` |
| B155.1 | user_roles privilege-escalation hotfix | `68f9f05` |
| B155.2 | Tighten phase (F9 + F1/F2/F4/F5/F6/F7 + F10) | `a90c009` + `9cf1a1c` |
| B155.3 | Anon over-read closure | `42caf97` |
| B155.4 | user_roles role-write lockdown (CA→admin) | `cde22f2` |
| B158-A | Surface start-billing failures on /signup/redeem/verify | `976f0dc` |
| B162 | Already-used / expired OTP recovery card | `9c09966` |
| B166 | Owner-trim + B167 PM-add + B150 escape bundle | `aa4b0c6` + `a742f72` |
| B167 | PM-add vehicle fields | `aa4b0c6` |
| B175 | Violation void mechanism (A1-launch gate, CA-only) | `0ee884c` |
| B178 | Confirmed-violation evidence-field lockdown | `f0038cd` |
| B180 | Hide resident dispute affordance behind flag | `7735fc2` |
| B182 | PM tow-ticket summary route + reprint collapse | `43baf92` |
| B182 #2 | Media-authz close (drop manager UPDATE policies + UI) | `5d6b28b` |
| B197 | Manager Add-Resident vehicle_color spread bug | `abe7420` |
| B198 | Extend /auth/accept to type=signup (+email_change, magiclink) | `51cf1b2` + `25f5e82` |
| B202 | Restore declined vehicle visibility in resident portal | `79147f9` |
| B203 | Bulk-upload companion vehicles silently dropped | `06fbc5a` |
| B205 | Signup cross-context (redirect validator + getUser swap) | `a6bbf59` |

### A-items / D-items / Phase items / Standing arcs

| Item | Title | Evidence |
|---|---|---|
| A1 Wrecker workflow validation | Phases 1-5 validated, Phase 6 cleanup deferred | Memory note `project_a1_wrecker_workflow_validation_shipped.md` (2026-05-19) |
| A2 (block-A1) | get_company_admin_emails capture + anon close + body guard | `3ded3a6` |
| D1 | CA-created non-resident invites via /api/admin/invite-user | `2c8f019` |
| D2 | user_roles.name + B155.2 RPC closure + B68 capture (atomic) | `36c2dd2` |
| Phase 2a | hasFeature() wire-up + Plan tab + 3 new DB triggers | `df8e5fa` |
| Cascading Deactivation arc | Derived effective-active access model (16/16 probe) | `7da03d2` (this session) |
| Stripe Tax Pattern A | automatic_tax + SaaS tax_code + DB-skip backfill | `2f401fb` + `56b851e` |
| DBA entity update | Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ | `05749dd` |
| B143 | Bulk upload invite expiry 1h→24h | Engineering reset May 30 reports "Closed May 28" (no specific commit found; relies on reset accuracy) |
| Help docs B50 (16 docs) | Committed to repo + /help routes | `efc476b` + `2b987e8` + `e5c174c` |

---

## SECTION 2 — GENUINELY OPEN

No shipped evidence in any source. **Launch-signal tags** (legend: `[SECURITY]` `[BILLING]` `[LEGAL]` `[DATA]` `[A1-DAY1]` `[POLISH]`).

### Tagged (touches a launch-signal axis)

| Item | Title | Last-known status | Tags |
|---|---|---|---|
| **B67** | Abandoned-account cleanup (orphan unverified auth.users) | Engineering reset May 30 listed `[CONFIRM]` — never found in commits or memory | `[SECURITY]` `[BILLING]` |
| **B68** | Capture-pass for production-only SECURITY DEFINER functions | Memory: BACKLOG; gates B82 follow-up retrofit | `[SECURITY]` `[DATA]` |
| **B107** | Signup verification email landing in spam | Memory: BACKLOG P2; blocks `public_signup_open=true` launch | `[BILLING]` (gates public signup) |
| **B108** | Canonical hostname mismatch (bare → www) | Memory: BACKLOG P2; blocks `public_signup_open=true` launch | `[BILLING]` |
| **B110** | Texas SaaS sales tax LAUNCH BLOCKER | Memory says BACKLOG — **see LIKELY MOOT below: Pattern A may have closed this** | `[BILLING]` `[LEGAL]` |
| **B114** | Signup form server-side cap enforcement gap | Memory: BACKLOG P2; blocks `public_signup_open=true` launch | `[SECURITY]` `[BILLING]` |
| **B135** | Dormancy flag default + operator visibility | Memory: BACKLOG; launch-prep | `[BILLING]` |
| **B136** | Webhook subscription audit + doc | Memory: BACKLOG; missing invoice.payment_action_required at B66.5 c2 smoke | `[BILLING]` `[DATA]` |
| **B137** | Backfill stripe_events processed=false stale rows | Memory: BACKLOG; one-shot UPDATE | `[BILLING]` `[DATA]` |
| **B138** | Verify Vercel cron failure email post-run | Memory: BACKLOG P3 | `[BILLING]` |
| **B147** (email lowercasing) | Driver-insert email lowercasing gap (data hygiene) | Memory: BACKLOG; admin:654 + CA:905 store as-typed | `[DATA]` `[SECURITY]` |
| **B169** | B147 Stripe hardening follow-up | Memory mention in B147 closure | `[BILLING]` |
| **B172/B173** | Latent finds from B166 smoke | Memory mention in B166 closure | `[DATA]` |
| **B174** | Policy ILIKE sweep (post-B155.2 probe) | Memory mention in B155.2 closure | `[SECURITY]` |
| **B182 #3** | Driver double-ticket diagnostic | Todo list: pending row-ID confirm from Jose | `[DATA]` `[A1-DAY1]` |
| **B183** | Pre-flip 8-helper anon sweep | Todo list: standing queue | `[SECURITY]` |
| **B187** | Swift-handler URL Safari DOMException | Memory: CA Add-User "string did not match expected pattern"; affects A1's own CA-Add-User flow | `[A1-DAY1]` |
| **B188** | Invite-user orphan cleanup on RPC failure | Memory: low priority but constrained-input means unreachable normally | `[DATA]` `[SECURITY]` |
| **B190** | Auto-logout / session inactivity timeout | Memory: security hardening; not A1-gating | `[SECURITY]` |
| **CAPTCHA** | Public forms (visitor / register / signup) | Engineering reset: `[CONFIRM]` believed unbuilt; gates `public_signup_open=true` | `[SECURITY]` (gates public signup) |
| **Post-signup wizard** | Cluster 7.2 wizard | Engineering reset: appears UNBUILT `[CONFIRM]`; not A1-gating but public-signup gate | `[A1-DAY1]` (only if Jose decides) |
| **Deactivation follow-up #1** | effective-active check on `update_my_vehicle_cosmetic` + `mark_my_vehicle_declined_read` | Filed this session; lower-risk | `[SECURITY]` |
| **Deactivation follow-up #2** | audit_logs entries on 5 is_active write sites | Filed this session | `[DATA]` |
| **PKCE handler cleanup** | /signup/verify + /signup/redeem/verify post-B198 soak | Todo list: standing queue | `[SECURITY]` |

### Untagged (polish / non-launch-signal)

| Item | Title | Last-known status |
|---|---|---|
| B25 | Tighten driver photo/video soft-delete to uploader+time-window | Deferred per locked decision; revisit on incident |
| B26 | Storage cleanup cron for orphaned violation media | Phase 2 backlog |
| B27 | Replace driver_name with driver_id FK | Deferred until A1 driver #7 or next customer |
| B33 | Admin-via-CA portal audit action distinction | Deferred 30+ days |
| B34 | Tier limits split TS+SQL drift | Defer until Phase 2 tier_limits refactor |
| B46 | DELETE error handling on discard paths | Defer until production report |
| B49 | Proposal code amendment/renewal workflow | Design deferred; needed by A1's first renewal |
| B56 | Pricing truth-up: stale $99 references | Memory: Jose propagates through project context separately |
| B60 | Audit log convention harmonization | LOW backlog; pre-launch polish |
| B64 | Admin Bill Calculator input replace bug | LOW; super-admin-only; ~2 LOC |
| B66.6 | Refund button | Workaround: Stripe Dashboard refund; not A1-blocking |
| B66.8 | Welcome email (2 templates, branched on acquisition_channel) | Can send manually for one customer; not A1-blocking |
| B69 | Suspended-account write-disable sweep | Banner-only correct today; full sweep when admin suspension tooling exists |
| B77 | Tier-fallback source-of-truth refactor | Schedule after B66/B67 Stripe stabilizes |
| B81 | manager.name semantics bug | Latent client-side filter; post-B74 RLS contains damage |
| B86 | Role-aware bootstrap caching (B76 extension) | Cosmetic; not A1-blocking |
| B91 | Landing page Premium card sub-copy off-tone | P3; waiting on Jose's marketing copy |
| B94 | Prefix-tolerant /help/<NN-slug> redirect | BACKLOG P3; ~5 LOC |
| B96 | Storage-facility favorites | Engineering reset post-launch pile |
| B124 | Multi-vehicle bulk upload | Post-launch; resident self-service covers v1 |
| B145 | Reserved-space bulk upload | Post-launch |
| B146 | Invitation email prefetching | Overlaps B117 C-token |
| B148 | Resident bulletin (P3 engagement) | Filed May 30 |
| B152 | Stale Supabase auth state at /login | P2 pre-public-launch; not A1-blocking |
| B171 | Webhook metadata.company_id fallback | LOW backlog |
| B191 | Persist mileage on violation row | Not A1-gating |
| Manager-portal PM-name header doc clarification | Add to help-docs / onboarding | Memory: doc cleanup item |

---

## SECTION 3 — UNCLEAR

Partial / ambiguous evidence. **Jose's eyes needed.**

| Item | Why unclear |
|---|---|
| **B90** | The May 20 backlog filed B90 as "Resident portal renders Edit button on declined vehicles." The git log has `fb7d357` "fix: B90 — resident vehicle write guard via DEFINER RPC (v2)" which is a DIFFERENT scope (write-side guard, not Edit-button UI). Either (a) the original B90 was rescoped, (b) B90 number got reused, or (c) the Edit-button bug got swept into B202 declined-visibility work. Needs Jose to confirm intent. |
| **B66.9** | Memory says SHIPPED 2026-05-23 via `2025f61` as "Texas SaaS Sales Tax integration (Pattern B, 6.6% flat)." But recent commits `2f401fb` + `56b851e` are the SAME concept implemented as Pattern A (automatic_tax + tax_code). Likely Pattern B shipped then rebuilt as Pattern A — see LIKELY MOOT. Confirm whether Pattern B code path is fully removed. |
| **B117 C-token (Phase 1)** | `cdd0c6f` is "B117 C-token Phase 1 — dual-handler OTP signup verify (HELD)" — marked HELD. Phase 2 (`44a80ba`) shipped. Engineering reset May 30 lists "B117 — pre-flight owed by Mateo, queued behind B66.7" suggesting more work expected. Is C-token Phase 1 still HELD, abandoned, or superseded by Phase 2? |
| **B115 / B116** | B66.4 memory says "Three real bugs caught in smoke: B115/B116/B117 (filed separately by Jose)." B117 is reconciled above. B115 and B116 don't appear in any memory file or commit. Need their filing source to evaluate. |
| **B125** (Properties bulk upload) | Engineering reset May 30 flagged as `[CONFIRM]` — "P1-conditional." No commit found, no memory file. May overlap the post-signup wizard question. |
| **B66.5.3** | Engineering reset says "B66.5 polish tail closed May 29." Memory has commits 1–4.3 + .1/.2 but no B66.5.3 file. Likely just a sub-tag rolling into the main arc, but flagged for confirmation. |
| **B143** | Engineering reset says "Bulk upload invite expiry 1h→24h | Closed May 28" but no commit found containing "B143" string. Could be subsumed into B113 fast-follow batch `0611b57`. |

---

## SECTION 4 — LIKELY MOOT (DIRECTION CHANGED)

Items that were filed when a different approach was current, since superseded.

| Item | What changed | Recommendation |
|---|---|---|
| **B66.9 (Pattern B Texas SaaS Sales Tax, 6.6% flat manual)** | Replaced by Pattern A (Stripe `automatic_tax` + `tax_code='txcd_10103001'`) shipped `2f401fb` + `56b851e` in last 7 days. Stripe handles rate calculation; we no longer maintain 6.6% flat. | Close. Update memory `project_b110_*` to reflect Pattern A closure. |
| **B110 (Texas SaaS launch blocker)** | Same — listed as live launch blocker in memory but Pattern A shipped recently. | Confirm Pattern A fully covers (incl. invoicing parity per pending "send_invoice migration" todo). |
| **B121 (Dispute response deadline alerting)** | Dispute *product feature* has been disabled (`RESIDENT_DISPUTES_ENABLED=false` via B180 `7735fc2`). Deadline alerting for a disabled feature is moot. | Close, OR re-file when/if dispute feature returns. |
| **Free trial mechanics** | Landing page chose "14-day money-back guarantee" not free trial (visible `app/page.tsx:360`). Any old item proposing trial mechanics is moot. | No items found that explicitly mention free-trial; flagged for vigilance during full audit. |
| **AI chatbot (HeyGen) / White-glove onboarding / Live chat / Driver performance reports** | Descoped via B57 + B58 (`cd635cb`) on 2026-05-19. Memory confirms removal from feature-flags, tier-config, Plan tab summaries. | Already moot; any backlog item referencing these can be closed. |
| **Self-serve Premium tier** | B89 part 1 (`8814936`) locked Premium as contact-sales only. Any item proposing self-serve Premium UI is moot. | No such items found; flagged for vigilance. |
| **Pre-rebrand "A1 Parking" naming** | Rebranded to ShieldMyLot via `3c5a784` (April 2026 era). DBA update via `05749dd` (recent). Any item proposing rename work is moot. | Flagged for vigilance during the Downloads PDFs scan. |

---

## SECTION 5 — NOTES (systemic observations)

1. **MEMORY.md index is over its load limit (40.4 KB vs 24.4 KB).** Items recorded as memory files but whose index entries exceed the 200-char limit may not appear in chat sessions' loaded context. The on-disk memory files are sound (~70 `project_b*.md` verified), but reliance on the index alone may miss items. Recommend MEMORY.md compaction pass — shorten each line to <150 chars and move detail to topic files.

2. **B-numbers reused or rescoped at least once** (B90 above). Recommend Jose's audit pass cross-check B-number → scope mapping for the high-volume runs (B66, B113, B117, B147, B155, B182).

3. **Three of the four `public_signup_open=true` launch blockers** (B107 spam, B108 hostname, B114 server-side cap) carry P2 individually but **compose into one true launch gate**. None has any ship evidence. Tracking them as a single launch-gate cluster may be clearer than per-item triage. (B67 abandoned-account cleanup + CAPTCHA join this cluster.)

4. **B66.9 → Pattern A direction change is the most consequential silent moot.** Memory `project_b110_texas_saas_sales_tax_launch_blocker.md` still reads as live spec; the actual integration has been replaced. Highest-priority correction.

5. **The "A1-blocker" tag has narrowed.** Most launch-critical work has shipped. Remaining A1-DAY1 tagged items are small (B182 #3 diagnostic, B187 Safari swift-handler). Public-self-serve gating is the larger remaining track.

6. **Cascading Deactivation arc** (HEAD `7da03d2`, this session) shipped without a new B-number — it was conceived and shipped within one session. Worth a memory file for the next audit; otherwise it'll be invisible to "what shipped" reconciliations.

7. **PDF coverage gap.** ~7 PDFs in `~/Downloads/` (A1_Wrecker_Feature_Backlog-1.pdf through -6.pdf, May 7 backlog, June 14/15 open backlogs) could not be text-extracted without `poppler` installed. Running `brew install poppler` then re-running this reconciliation against the PDF text would close the gap. The .md mirrors covered most of the same data, but anything that only ever appeared in those PDFs is absent here.

8. **Pending Pattern A follow-up: send_invoice migration.** Mentioned in this session's standing queue. Not formally B-numbered; flag for inclusion in next backlog snapshot.

---

*Reconciliation complete. 148 items processed across 271 commits, 52 migrations, 9 probe scripts, 70+ memory closures, 5 backlog source documents.*
