// ════════════════════════════════════════════════════════════════════
// Company existence validation — pre-write gate for free-TEXT company
// columns (C3, 2026-09-18)
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
// ---------------
// `user_roles.company` and `drivers.company` are free TEXT with NO
// foreign key to `companies`. Nothing in the database rejects a company
// name that does not exist. The only write-time guard is the metachar
// CHECK from 20260911_user_roles_metachar_check.sql, and that fires
// ONLY on `%`, `_` and `\` — an ordinary wrong-but-well-formed string
// inserts silently.
//
// A user_roles row carrying a company nobody owns is not inert. It is
// the input `get_my_company()` returns, which is what the company-scoped
// RLS policies compare against. A driver minted against a company that
// does not exist is scoped to nothing, and the portal's own fallback
// (app/driver/page.tsx:462) turns "I could not read your row" into
// `assigned_properties: ['All']` — see the commit message for that link.
//
// WHAT THIS IS NOT
// ----------------
// 🔴 This is a CLIENT-SIDE gate, not a constraint. It closes the write
// paths it is called from and nothing else. Anything reaching the table
// by another route — service-role scripts, SQL, a future call site that
// forgets to call this — is unaffected. The durable fix is a foreign key
// on `companies.name` (or a company_id column), filed separately; this
// helper is deliberately narrow so that filing does not get closed by it.
//
// WHY A FETCH-AND-COMPARE INSTEAD OF `.ilike('name', value)`
// ----------------------------------------------------------
// `.ilike()` interprets `%` and `_` in the VALUE as wildcards, so a
// lookup for a company literally named "A_1" would match "A11", "AB1",
// and friends — a validator that says yes to the wrong row is worse than
// no validator. The whole `email ~~*` arc is the same mistake at scale.
// We read the candidate names and compare in JS with `lower(trim(...))`,
// which is exactly the comparison `get_my_company()`-consuming policies
// perform, and has no pattern semantics at all.
//
// CANONICAL SPELLING
// ------------------
// On success this returns `canonical`: the spelling as STORED, not as
// supplied. Callers write that. The point is that "a1 wrecker, llc " and
// "A1 Wrecker, LLC" must not become two different scopes downstream.

type MinimalClient = {
  from: (table: string) => {
    select: (cols: string) => PromiseLike<{ data: { name: string | null }[] | null; error: { message: string } | null }>
  }
}

export type CompanyValidation =
  | { ok: true; canonical: string | null }
  | { ok: false; message: string }

// Callers pass the operator's raw field value. An empty/absent company is
// LEGITIMATE on these surfaces (the admin form's "None" option writes
// null), so blank is `ok` with a null canonical — it is not an error, and
// conflating "left blank" with "typed something wrong" would produce a
// misleading message for the commonest case.
export async function validateCompanyExists(
  supabase: MinimalClient,
  raw: string | null | undefined,
): Promise<CompanyValidation> {
  const value = (raw ?? '').trim()
  if (value === '') return { ok: true, canonical: null }

  const { data, error } = await supabase.from('companies').select('name')

  // 🔴 A failed lookup must NOT read as "company is fine". Absence of a
  // match and inability to check are different answers and the operator
  // gets told which one happened — a validator that fails open is a
  // validator that reports success on the exact day it mattered.
  if (error) {
    return { ok: false, message: `Could not verify the company "${value}": ${error.message}. Nothing was created.` }
  }
  if (data === null) {
    return { ok: false, message: `Could not verify the company "${value}": the company list came back empty. Nothing was created.` }
  }

  const key = value.toLowerCase()
  const hit = data.find(c => (c.name ?? '').trim().toLowerCase() === key)
  if (!hit) {
    return {
      ok: false,
      message: `No company named "${value}" exists. Create the company first, then add the user. Nothing was created.`,
    }
  }
  return { ok: true, canonical: (hit.name ?? '').trim() }
}
