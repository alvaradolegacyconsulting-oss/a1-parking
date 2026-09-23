# BACKLOG — `attorney_review_required` does not withhold the page

**Filed:** 2026-09-23
**Author:** Mateo
**Priority:** P2 — dormant while `/help` is gated. **Prerequisite, not a follow-up, if `/help` is ever made public again.**
**Status:** Filed, not built. Ruled out of the 2026-09-23 routing commit because `/help` stays behind auth.

---

## The flag promises a gate it does not provide

`attorney_review_required: true` in a help doc's frontmatter does exactly two things:

1. sets `shouldNoIndex` — [app/lib/help-docs.ts:122](../../app/lib/help-docs.ts#L122)
2. which becomes `robots: { index: false, follow: false }` metadata — [app/help/\[slug\]/page.tsx:62](../../app/help/[slug]/page.tsx#L62)

and renders a NOTICE banner at the top of the article — [:243](../../app/help/[slug]/page.tsx#L243).

**The document itself renders in full.** Nothing calls `notFound()`. `noindex` is a request
to a crawler, not access control: anyone with the URL reads the page, and any crawler that
ignores the hint indexes it.

The B85 commit describes the banner as "no click-gate per locked decision", so the rendering
behaviour is intentional. What is not safe is the flag's **name**, which reads like a
withholding gate to anyone adding a document.

## It has already cost us once

`docs/help/16-texas-chapter-2308.md` set `attorney_review_required: true`. The `noindex`
wiring was already live — it landed in B85 Phase 1 (`2b987e8`, 2026-05-19), a month before.
The doc shipped anyway. From `d9a57a9` (2026-06-17), verbatim:

> Doc 16 was authored as a structural framework awaiting attorney fill-in (every legal
> section is a [STATUTORY TEXT — ATTORNEY REVIEW] placeholder), **but it shipped publicly +
> indexed at /help/texas-chapter-2308.** Hiding it pre-attorney-review removes two
> concrete-but-uncited representations ("at least seven years" retention + storage-facility
> licensing characterization) that we don't want public until a Texas attorney signs off on
> specific language.

**The remedy was deleting the file** — 305 lines removed, five inbound references cleaned —
because the flag could not withhold the page. That is the clearest possible evidence of
what the flag does and does not do: when someone actually needed a document withheld, the
flag was set and they deleted the file instead.

## Why it is dormant today

`136bb46` (2026-07-12) removed `/help` from the middleware allowlist, so every help route
answers `307 → /login` for anonymous traffic. With the whole tree gated, an unreviewed
draft in `docs/help/` is not publicly readable and the flag's weakness costs nothing.

## 🔴 The trigger condition

`publicPaths` is **prefix-matched** ([middleware.ts:38](../../middleware.ts#L38)), so making
the help center public again is a one-string change — `'/help'` back in the list. That one
string would also make **every present and future** `/help/*` document public the moment its
markdown file lands, with no second step and no review gate.

**If that change is ever made, making `attorney_review_required` call `notFound()` ships in
the same commit.** Not after. The prefix rule and the missing gate are safe separately and
dangerous together.

Open question for whoever builds it: `notFound()` for both flags, or only for
`attorney_review_required`? `noindex: true` reads like a deliberate "public but not
promoted" state and probably should keep rendering. If they diverge, `shouldNoIndex` can no
longer be one derived boolean.

## Also fix: the stale comment

[app/lib/help-docs.ts:26](../../app/lib/help-docs.ts#L26) still reads:

> `16-texas-chapter-2308 sets attorney_review_required: true which implies noindex: true`

That file was deleted in `d9a57a9` — which names this comment as knowingly left behind
("Non-active refs left alone per scope"). Index 16 is now
`16-approval-authority-grants.md`, an unrelated document, so the comment points a reader at
a real file with the wrong contents. **No doc in the tree sets either flag today**, which
means the mechanism has no live example at all and the comment is the only description of
it a reader will find.
