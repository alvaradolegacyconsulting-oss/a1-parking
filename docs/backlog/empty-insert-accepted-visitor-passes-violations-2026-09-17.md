# `visitor_passes` and `violations` accept a completely empty INSERT

**Found:** 2026-09-17, by accident — probing for a NOT NULL error message
with `.insert({})` and getting a row back instead of an error.

## What

```
supabase.from('visitor_passes').insert({})   →  succeeds, id 1397
supabase.from('violations').insert({})       →  succeeds, id 379
```

Neither table has a single NOT NULL column without a default. A row with
**null plate and null property** is valid in both. Both probe rows were
deleted the same minute, verified with `RETURNING`.

## Why it matters, and why it isn't urgent

**Not urgent:** no write path produces one. Every real insert goes
through a form or an RPC that supplies plate and property, and the two
rows created here were the only ones (confirmed by querying
`WHERE plate IS NULL` — zero others).

**Worth closing anyway**, and the two tables differ in how much:

- **`violations` is a defence record.** A row with no plate and no
  property is not a weaker record, it is an unfalsifiable one — it can
  never be matched to a vehicle, a property, or an incident, and it
  cannot be distinguished from a record whose plate was lost. On a table
  whose purpose is evidentiary, constructible-but-meaningless is the
  wrong default.
- **`visitor_passes` is enforcement input.** `enforce_visitor_pass_limit`
  counts rows `WHERE property = NEW.property AND normalized(plate) = …`.
  A null-plate row never matches, so it cannot corrupt a count — but it
  also sits in the table indefinitely with nothing able to reach it.

## The shape of the fix

`ALTER TABLE … ALTER COLUMN plate SET NOT NULL` and the same for
`property`, on both tables — **after** confirming zero violating rows,
because `SET NOT NULL` validates the existing table and fails loudly on
one bad row.

⚠ Check `violations.property` first. Some historical rows may predate
property stamping, and if any carry NULL this becomes a backfill
decision rather than a constraint.

Paired verification wants an execution gate, not a structural one: the
claim is *"an INSERT omitting plate is rejected"*, and only attempting
it proves that. `attnotnull` being set does not prove the constraint
enforces — that is the false-green class this project has hit before.

## Not filed as

A validation change at the write paths. They already supply both
columns; the gap is that nothing stops a path that doesn't, and the
constraint is where that belongs.
