# Superseded-migration header sweep — 2026-09-10

Triggered by the `record_vehicle_removal` overload resurrection. Full write-up in the
`🔴 SUPERSEDED — DO NOT RE-APPLY` header of
`migrations/20260909_tow_log_commit_4_rpcs.sql`.

## The rule

**A migration that creates a function signature a later migration drops is not idempotent —
it is a landmine.** Applying migrations in order from scratch works. Re-applying one in
isolation does not.

Verification files (`*_verification.sql`) are re-runnable at will; they only read. Migration
files are one-time unless a header says otherwise.

The failure mode is worse than "an error": a stale verification gate fails, and the natural
response — re-apply the migration behind it — is exactly the action that breaks the schema.
The gradient points at restoring the superseded state.

## Two classes

**Class A — re-apply RESURRECTS a dropped signature.** The file creates the function and
does *not* itself drop it. Re-applying leaves two live signatures; PostgREST returns
`PGRST203 could not choose the best candidate` for every call the two share. This is what
happened on 2026-09-10.

**Class B — re-apply REVERTS the body.** The file drops and recreates the same function.
Re-applying produces no ambiguity and no error — it silently restores an older
implementation. Quieter, and in some ways worse.

## Class A — 22 pairs

| migration | function | dropped by | current definition | annotated |
|---|---|---|---|---|
| `20260513_rls_completeness_pass.sql` | `accept_tos()` | `20260716_drop_accept_tos_overloads.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260520_b65_self_serve_signup_schema.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260522_b70_b71_polish_pass.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260604_b118_consent_version_tracking.sql` | `accept_signup_consents()` | `20260713_tos_acceptances_company_id_derivation.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260604_b118_consent_version_tracking.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260611_b178_evidence_field_lockdown.sql` | `stamp_tow_ticket()` | `20260629_violations_mileage_vin_persistence.sql` | `20260903_track_gating_write_path_gates.sql` | yes |
| `20260614_b182_pm_ticket_summary.sql` | `stamp_tow_ticket()` | `20260629_violations_mileage_vin_persistence.sql` | `20260903_track_gating_write_path_gates.sql` | yes |
| `20260621_spaces_v1_metadata_rpc.sql` | `update_space_metadata()` | `20260829_spaces_add_monthly_fee_and_extend_rpc.sql` | `20260829_spaces_add_monthly_fee_and_extend_rpc.sql` | yes |
| `20260621_spaces_v1_schema.sql` | `free_space()` | `20260622_spaces_v1_1_multi_resident_schema.sql` | `20260819_spaces_designated_vehicle_lifecycle_clears.sql` | yes |
| `20260621_spaces_v1_schema.sql` | `reassign_space()` | `20260622_spaces_v1_1_multi_resident_schema.sql` | `20260621_spaces_v1_schema.sql` | yes |
| `20260626_b220_pm_plate_lookup_guest_auth_stage.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260626_tow_ticket_regenerate_layer_1.sql` | `regenerate_tow_ticket()` | `20260629_violations_mileage_vin_persistence.sql` | `20260903_track_gating_write_path_gates.sql` | NO |
| `20260626_tow_ticket_regenerate_layer_1.sql` | `stamp_tow_ticket()` | `20260629_violations_mileage_vin_persistence.sql` | `20260903_track_gating_write_path_gates.sql` | NO |
| `20260628_pm_plate_lookup_volatile_fix.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260630_b228_console_aggregates.sql` | `get_console_aggregates()` | `20260630_b228_phase2_rpcs.sql` | `20260630_b228_phase2_rpcs.sql` | yes |
| `20260630_b228_console_aggregates_fix.sql` | `get_console_aggregates()` | `20260630_b228_phase2_rpcs.sql` | `20260630_b228_phase2_rpcs.sql` | yes |
| `20260707_b118_layer2_saas_schema.sql` | `accept_saas_agreement()` | `20260713_tos_acceptances_company_id_derivation.sql` | `20260904_accept_saas_agreement_relax_selfserve_preflight.sql` | yes |
| `20260710_record_resident_tos_acceptance_rpc.sql` | `record_resident_tos_acceptance()` | `20260713_tos_acceptances_company_id_derivation.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260723_dnt_b2_function_scope_fix.sql` | `check_dnt_plate()` | `20260723_do_not_tow_cascade_and_guards.sql` | `20260723_do_not_tow_cascade_and_guards.sql` | yes |
| `20260808_get_residents_row_by_precedence.sql` | `get_residents_row_by_precedence()` | `20260828_get_residents_row_by_precedence_add_company.sql` | `20260828_get_residents_row_by_precedence_add_company.sql` | yes |
| `20260831_get_space_payments_report_rpc.sql` | `get_space_payments_report()` | `20260831_get_space_payments_report_rpc_v2.sql` | `20260831_get_space_payments_report_rpc_v2.sql` | yes |
| `20260909_tow_log_commit_4_rpcs.sql` | `record_vehicle_removal()` | `20260909_tow_log_vehicle_removals_notes_column.sql` | `20260910_record_vehicle_removal_plate_normalize_fix.sql` | yes |

## Class B — 17 pairs

| migration | function | dropped by | current definition | annotated |
|---|---|---|---|---|
| `20260521_b65_4_redeem_signature_address.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260604_b118_consent_version_tracking.sql` | `accept_tos()` | `20260716_drop_accept_tos_overloads.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260612_b155_3_anon_overread_rpcs.sql` | `get_company_branding()` | `20260714_anon_rpc_ilike_wildcard_close.sql` | `20260714_anon_rpc_ilike_wildcard_close.sql` | yes |
| `20260612_b155_3_anon_overread_rpcs.sql` | `get_properties_for_visitor_select()` | `20260714_anon_rpc_ilike_wildcard_close.sql` | `20260714_anon_rpc_ilike_wildcard_close.sql` | yes |
| `20260612_b155_3_anon_overread_rpcs.sql` | `get_property_for_visitor()` | `20260728_property_name_aliases_schema.sql` | `20260728_property_name_aliases_schema.sql` | yes |
| `20260630_redeem_texas_attestation.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260707_b118_layer2_redeem_two_click_and_stamp.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260707_b118_layer2_saas_redeem_extension.sql` | `redeem_proposal_code()` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | `20260710_acceptance_reviewed_at_redeem_extension.sql` | yes |
| `20260708_b230_pm_plate_lookup_pending_states.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260710_acceptance_reviewed_at_accept_tos_extension.sql` | `accept_tos()` | `20260716_drop_accept_tos_overloads.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260710_acceptance_reviewed_at_signup_extension.sql` | `accept_signup_consents()` | `20260713_tos_acceptances_company_id_derivation.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260713_tos_acceptances_company_id_derivation.sql` | `accept_tos()` | `20260716_drop_accept_tos_overloads.sql` | `20260713_tos_acceptances_company_id_derivation.sql` | yes |
| `20260714_anon_rpc_ilike_wildcard_close.sql` | `get_property_for_visitor()` | `20260728_property_name_aliases_schema.sql` | `20260728_property_name_aliases_schema.sql` | yes |
| `20260720_pm_plate_lookup_hardening.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260723_ap_cascade_check_authorized_plate.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260723_dnt_b2_function_scope_fix.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |
| `20260723_do_not_tow_cascade_and_guards.sql` | `pm_plate_lookup()` | `20260724_pm_plate_lookup_viewing_property.sql` | `20260805_pm_plate_lookup_current_date_central_sweep.sql` | yes |

## Method and its limits

Detection is **by function NAME**, not by signature. The script reads every non-verification
`migrations/*.sql`, strips comment-only lines, and records `CREATE [OR REPLACE] FUNCTION`
and `DROP FUNCTION` occurrences; a file is flagged when a later file drops a function it
creates.

**Consequence: there are false positives.** A file that drops overload X and creates
signature Y, where a later file drops only overload Z, is flagged even though re-applying it
would be harmless. `20260713_tos_acceptances_company_id_derivation.sql` (`accept_tos`) is
one such case.

The headers are written to survive that imprecision — they state the observed facts and
instruct the reader to check `pg_proc` before re-applying, rather than asserting an absolute
prohibition the analysis cannot support. **The catalog is the audit surface, not this tree.**

## Not annotated

`migrations/20260626_tow_ticket_regenerate_layer_1.sql` — flagged (creates
`stamp_tow_ticket` and `regenerate_tow_ticket`, both dropped by
`20260629_violations_mileage_vin_persistence.sql`) but **untracked in git**. Annotating it
would pull an uncommitted migration into the repo, which is a separate decision. It is also
one of several applied-but-untracked migrations — worth its own reconciliation pass.

## Follow-ups

1. **Verification files carrying stale signature assertions.** The sweep covers migrations.
   `20260909_tow_log_commit_4_rpcs_verification.sql` was the one that fired; there is no
   reason to think it is the only verification file asserting a signature that has since
   moved. A parallel sweep over `*_verification.sql` for `to_regprocedure` strings, checked
   against `pg_proc`, would close that class.
2. **Applied-but-untracked migrations.** `git status` shows ~15 in `migrations/`. Each is
   production state absent from the repo — the drift the migrations-dir rule exists to
   prevent.
