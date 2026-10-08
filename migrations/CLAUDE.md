# CLAUDE.md — Alvarado Legacy Consulting small-site standard

This file sits at the root of every small client site repo. Read it at the start of every session.
Project-specific instructions live in `docs/preflight/` — the most recent preflight is the source of truth.

## Operating model

| Role | Who | Does |
|---|---|---|
| Architect / reviewer | Claude, in chat | Writes preflight and greenlight `.md` files. Never touches the repo. |
| Builder | You (Mateo, Claude Code) | Reads those files, writes the code, commits. |
| Operator | Jose | Relays between the two, reviews previews, talks to the client, makes the calls. |

- **Report first.** For anything non-trivial, the first deliverable is a short report (plan, file list,
  questions), not code. Wait for a greenlight.
- **Never build on an unanswered question.** If a preflight lists an open item, stub it with a visible
  `[PLACEHOLDER]` and move on; never invent a fact about the client (hours, prices, addresses, offers).
- **One concern per commit.** Conventional commit messages (`feat:`, `fix:`, `content:`, `chore:`).
  Something breaking at 9pm should mean reverting one commit.

## Stack (default for every small site)

- Next.js (App Router), TypeScript strict, Tailwind CSS. No database, no auth, no CMS.
- Hosted on Vercel under the Alvarado Legacy Consulting **Pro** team (Hobby is non-commercial only;
  paid client work counts as commercial). Preview deployments are the staging environment;
  `main` is production.
- Fonts via `next/font`. Images via `next/image`, stored in `public/images/`.
- Email from forms via a transactional email API (Resend unless the preflight says otherwise).

## Structure rule: content and theme are the only client-specific parts

```
content/        # ALL client facts: site.ts, schedule.ts, menu.ts, events.ts (typed)
theme/          # tokens.ts (colors, fonts, radii) — the only place hex values live
components/     # generic, content-driven; no client names or facts hard-coded
app/            # routes; read from content/, never contain literal client facts
lib/            # helpers (time zone, schedule, email)
docs/preflight/ # architect's instruction files, numbered
```

If you find yourself typing a phone number, price, address or hex value inside `components/` or `app/`,
stop and move it to `content/` or `theme/`. This is what lets the next client be a content swap.

Every piece of user-facing text in `content/` is shaped `{ en: string; es?: string }` from day one, even
when the site launches English-only.

## Class rules (learned the hard way on ShieldMyLot)

1. **Absence is not failure.** Where a value can legitimately be empty, the failure state must look
   different. An empty schedule renders "Check Instagram for this week's stops," never a blank box.
   A failed fetch or send renders an error with the phone number, never a success message.
2. **A report that says something other than what happened is the bug.** A form shows "Sent" only after
   the email API returns success. Log what actually happened, not what was attempted.
3. **Time zone.** Vercel runs in UTC. Any "today", "open now", or "this week" logic uses
   `lib/time.ts` with `America/Chicago`, never `new Date()` date parts directly. On a statically
   built page, "today" must be computed in the browser, not at build time.
4. **A click with no feedback looks like a click that didn't register.** Every button shows a
   pending state; every submit ends in a visible success or error.
5. **Mechanism before data.** Fix the component, then the content.

## Quality floor (every site, not negotiable)

- Mobile first: design and test at 390px wide before desktop.
- Accessible: real `<button>`/`<a>`, labels on inputs, visible keyboard focus, 4.5:1 text contrast,
  `prefers-reduced-motion` respected, alt text on every image.
- Tap-to-call (`tel:`) and directions links work on a phone.
- SEO basics: per-page metadata, Open Graph image, `sitemap.ts`, `robots.ts`, schema.org JSON-LD
  for the business.
- No secrets in the repo. Every env var is listed with a comment in `.env.example`.

## Built for handover

- `README.md` must let a stranger clone, install, run and deploy with no help: prerequisites,
  `npm install`, `npm run dev`, env vars, how to deploy, how to update each file in `content/`.
- No manual steps that live only in someone's head. If Jose does it by hand, it goes in the README.
- `docs/UPDATING.md`: plain-English steps for the recurring edits (post this week's stops,
  change a price, swap a photo), written for whoever holds the Care Plan.

## Definition of done for any preflight

Every acceptance gate in the preflight is checked on a Vercel preview URL, on a real phone, and reported
back as a list of gate names with PASS/FAIL. "It's done" is not a report.
