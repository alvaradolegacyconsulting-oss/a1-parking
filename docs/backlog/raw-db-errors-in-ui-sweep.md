# Raw database errors shown in the UI — sweep

Filed 2026-10-12 (Jose: "File, a sweep, not now"). Nothing built.
**Survey every user-facing occurrence first, then replace in one pass.**

## Why

Standing rule: raw JS/server errors never reach user-facing UI. A Postgres
error string is not a message to a property manager — it names internals,
leaks schema, and tells the reader nothing they can act on.

Found while auditing the protected-columns guard. During the window when the
guard raised `malformed array literal`, a CA deactivating a property would
have been shown, verbatim:

```
Error: malformed array literal: "is_active"
```

from `app/company_admin/page.tsx:2238`:

```js
const { error: updErr } = await supabase.from('properties').update(...)
if (updErr) { setPropMsg('Error: ' + updErr.message); return }
```

The error handling itself is correct — it checks, it stops, it tells the user
something went wrong. Only the *text* is wrong.

## Scope of the sweep

Survey, don't guess. Grep for the shapes that concatenate a driver/DB error
into user-visible state:

- `setPropMsg('Error: ' + ...)` / `setMsg(... .message)` and every
  `set*Msg` variant
- `alert(... .message)`
- any `.message` reaching JSX
- `catch (e) { ...e.message... }` where the result is rendered

Report the count and the distinct call-site shapes before proposing a fix.

## Shape of the fix, when ruled

- A single helper that maps a Supabase/Postgres error to plain copy, with a
  deliberate default ("Something went wrong saving that. Try again, and tell
  us if it keeps happening.") and the raw text sent to `console.error` only.
- Known tokens get specific copy — `protected_column_not_permitted` already
  carries an actionable HINT naming the columns and the person to ask, and
  that is the pattern to follow.
- Severity passed explicitly, not inferred from the text.
- 🔴 Keep the distinction the absence rule requires: "nothing here" and
  "could not load" must not render the same way. This sweep is about wording,
  and must not collapse the two states while rewording them.
