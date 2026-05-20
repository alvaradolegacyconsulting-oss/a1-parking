---
title: "Tow Tickets and Evidence"
category: "Enforcement Track"
audience: ["driver", "manager", "company_admin"]
tier_required: "any"
last_updated: "2026-05-20"
related: ["submitting-violations", "managing-disputes", "understanding-your-tier"]
---

# Tow Tickets and Evidence

After a violation is confirmed, the workflow shifts from evidence capture to documentation, retention, and (when applicable) fleet integration. This guide covers what happens after the Confirm & Submit button gets pressed.

## When this guide applies

This guide assumes a violation has been confirmed. If you haven't reached the confirmation step yet, read [Submitting Violations](06-submitting-violations.md) first — it covers the workflow up through review and confirmation.

After confirmation, several things become available:
- Tow ticket generation
- Evidence retention and review
- Post-confirmation media management (with audit trail)
- Towbook CSV export (Growth+ tiers)

---

## The tow ticket workflow

When a driver confirms a violation, the platform immediately offers a **tow ticket modal**. This is a printable document that:

- Identifies the vehicle being towed
- Identifies the property the vehicle was on
- States the violation type
- Records the timestamp
- Includes contact information for the vehicle owner to retrieve their vehicle

The tow ticket is the physical paperwork that goes with the tow operation. Texas Chapter 2308 has specific requirements for tow ticket content; ShieldMyLot generates tickets that comply with these requirements.

### Generating a tow ticket

In the tow ticket modal:

1. Confirm the vehicle and property details are correct
2. Select the storage facility (if you have multiple)
3. Enter the tow operator's name (often the driver themselves)
4. Click **Generate Ticket**

The platform produces a printable ticket. Print it from the modal or save as PDF if you have a wireless printer in your truck.

### Reprinting a ticket

If you lose the printed ticket or need a duplicate:

1. Navigate to the violation in your driver portal (or have the company admin/manager access it from their portals)
2. Click **View Ticket** or **Reprint Ticket**
3. Print or save again

The reprint matches the original — same content, same timestamp.

### What if no tow happens?

Not every violation results in a tow. Some scenarios:
- The vehicle owner returned and moved the vehicle before tow operation completed
- The driver decided the violation didn't warrant towing (e.g., expired permit on a vehicle that's otherwise authorized)
- The property requested no tow on this specific incident

For these cases, the violation record stays in the system as documentation, but no tow ticket is generated. The violation appears in manager and resident portals normally; the dispute workflow still applies if the owner challenges the violation.

---

## Evidence retention

Photos, videos, and violation records are retained for at least **seven years** from the violation date, in line with Texas record retention norms for parking enforcement.

After seven years:
- Violations with disputes or legal activity are retained indefinitely
- Standard violations may be archived but not deleted (audit trail preservation)

Specific retention policy details are subject to your service agreement and applicable law.

### Where evidence lives

- **Photos and videos** — Encrypted at rest in cloud storage, accessible only through the platform
- **Violation records (DB rows)** — Encrypted at rest with audit logs
- **Tow tickets** — Generated on demand; reproducible from the violation record

### Access to evidence

| Who | Can view | Can manage media (soft-delete) |
|---|---|---|
| Driver (submitter) | Their own violations | Yes, with audit trail |
| Property Manager | Violations at their property | Yes, with audit trail |
| Company Admin | All violations at company | Yes, with audit trail |
| Resident (plate-matched) | Their own violations only | No |
| Super Admin (ShieldMyLot) | All violations | For platform-level moderation only |

---

## Managing media after confirmation

Sometimes a confirmed violation needs media adjustments:
- A photo was attached by mistake (wrong angle, blurry, irrelevant)
- A photo accidentally captured a third party (privacy concern)
- A video has audio that's inappropriate
- A driver wants to add a photo that was missed at submission time

The **Manage Media** feature handles these cases with full audit trails.

### Who can manage media

By default:
- The driver who submitted the violation
- Property managers at the violation's property
- Company admins

Each action (soft-delete, restore) is logged with: who, when, why (reason field), and what specifically changed.

### How to soft-delete a photo or video

1. Open the violation
2. Find the **Manage Media** button or menu
3. Click the photo or video to remove
4. Provide a reason in the dialog (required — examples: "wrong photo attached", "captured bystander in background")
5. Confirm

The photo or video disappears from the visible violation card but is not actually deleted — it remains in the database with an audit record. This is important for:

- Defending against accusations of evidence tampering
- Legal discovery if a dispute escalates
- Restoring evidence if a soft-delete was a mistake

### Restoring removed media

If a photo or video was removed by mistake:

1. Open the violation
2. Find the **Manage Media** section
3. Look for removed media (shown with an "Hidden" indicator)
4. Click **Restore**
5. Provide a reason
6. Confirm

The photo or video returns to the visible violation card.

### What you can't do

- **Permanently delete** a confirmed violation's media — only soft-delete with audit trail
- **Modify** an existing photo or video (rotate, crop, edit) — only add new ones or soft-delete existing ones
- **Hide** the audit trail — every action is permanent in the audit log

These limits exist because evidence integrity is essential. Confirmed violations may be reviewed in disputes, legal proceedings, or compliance audits — the chain of custody must be defensible.

---

## Towbook CSV export (Growth+ tiers)

If your company uses Towbook fleet management software, ShieldMyLot can export your violation data in a Towbook-compatible CSV format.

This feature is available on:
- Enforcement: Growth tier and above
- Property Management: not applicable

### How to export

1. Company Admin portal → Violations tab
2. Filter by date range or other criteria
3. Click **Export to Towbook CSV**
4. Save the CSV file
5. Import into Towbook through their standard import workflow

### What's included

The CSV export includes the standard Towbook fields:
- Violation timestamp
- Vehicle plate, state, color, make, model
- Property name and address
- Violation type
- Driver name (submitter)
- Tow ticket reference (if applicable)

The CSV is plain text and can be reviewed before import. You can edit it in Excel or any spreadsheet tool if needed.

### Limitations

- Photos and videos are not exported in the CSV — only references. Photos must be downloaded separately if Towbook needs them.
- Exports include only confirmed violations, not drafts
- Soft-deleted media is not included in the reference list (only visible media)

If you're not using Towbook, ignore this section — the platform works fully without external integration.

---

## Compliance and record-keeping

Texas Chapter 2308 (the Texas Towing and Booting Act) has specific requirements for how parking enforcement records must be maintained. ShieldMyLot helps you comply by:

- Recording all required information at violation submission
- Generating compliant tow tickets
- Maintaining unalterable audit trails
- Retaining records for the required retention period
- Providing dispute workflow timeline tracking

For the full compliance picture, see [Texas Chapter 2308](../compliance/16-texas-chapter-2308.md).

**Your responsibilities (not handled by the platform):**
- Maintaining proper signage at properties (Chapter 2308 has specific signage requirements)
- Securing authorization documents from property owners
- Communicating tow notifications to vehicle owners within statutory timelines
- Operating storage facilities in compliance with Chapter 2308
- Responding to disputes within required timelines

ShieldMyLot is a documentation and workflow tool. It supports compliance but does not replace your operational responsibility for compliance.

---

## Common questions

**A driver removed a photo that should have stayed. Can I un-do it?**
Yes. Photos are soft-deleted, not permanently deleted. Use Manage Media to find the removed item and click Restore.

**A resident is asking for copies of all photos in their violation. Are we required to provide them?**
Texas Chapter 2308 includes specific transparency requirements. Residents (the vehicle owner) are entitled to see evidence supporting a tow. The resident portal automatically shows them their violation photos and videos. If they request additional documentation, consult your legal counsel for the appropriate response.

**Can a driver edit a violation after confirming it?**
No. Confirmed violations are locked from the driver. If a violation has wrong details, contact your manager or company admin immediately — they have tools to manage the situation. Do not submit a duplicate violation.

**How long does Towbook CSV export take to generate?**
For most companies, a CSV export with up to 1,000 violations generates in under 10 seconds. Larger exports may take longer. If an export times out, narrow the date range and try again.

**Where are the photos and videos actually stored?**
Encrypted cloud storage with strict access controls. The platform is the only way to access them — you can't get a "raw" file URL or share access externally. This is intentional for chain-of-custody protection.

**Can I delete a violation entirely?**
Not as a customer-side action. Confirmed violations are part of the permanent record. If a violation was created in error and you need it removed (e.g., a test that accidentally got marked real), contact support@shieldmylot.com with the details and the platform team can advise on the appropriate path.

---

## Next steps

- Understand the dispute workflow that follows some violations: [Managing Disputes](../shared/12-managing-disputes.md)
- Review Texas compliance specifics: [Texas Chapter 2308](../compliance/16-texas-chapter-2308.md)
- Train your team on the submission workflow: [Submitting Violations](06-submitting-violations.md)

Questions about tow tickets, evidence handling, or exports? Email support@shieldmylot.com.
