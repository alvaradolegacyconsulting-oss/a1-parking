---
title: "Submitting Violations"
category: "Enforcement Track"
audience: ["driver", "company_admin", "manager"]
tier_required: "any"
last_updated: "2026-05-19"
related: ["adding-properties", "tow-tickets-and-evidence", "managing-disputes"]
---

# Submitting Violations

This is the core driver workflow — observing a parking violation, capturing evidence, and submitting it through ShieldMyLot™. Every detail in this process matters because the violation record may eventually be reviewed by a resident, a manager, or in rare cases a court.

This guide walks through the complete submission process: what to do before submitting, the two-step submission flow, photo and video requirements, the review screen, and what happens after confirmation.

## Before you submit

A good violation submission starts before you open the app.

### Verify the violation

Three things to confirm in person:

1. **Signage is posted and visible.** Texas Chapter 2308 requires specific signage. If the property's signage is missing, damaged, or not where it should be, do not submit a violation. Report the signage issue to your manager instead.
2. **The vehicle is actually violating.** Common violations: parking in fire lane, blocking access, parked in reserved space without permit, expired permit, unauthorized vehicle in resident-only area. Confirm the violation matches one of the property's enforcement rules.
3. **The vehicle is not on the exempt list.** Some plates are exempt — property owner vehicles, permanent permits, delivery services. Use the plate lookup feature before submitting to check exemption status.

### Take preliminary observations

Note the time, location within the property, and vehicle position. You'll need these for the submission form. Walking around the vehicle and noting damage (or lack of damage) protects you from later disputes claiming you damaged the vehicle during enforcement.

---

## The two-step submission process

ShieldMyLot uses a two-step submission: **Form → Review → Confirm**. The reason: a violation record affects a real person and a real vehicle. The review step gives you one last chance to verify everything before the record becomes official.

### Step 1: Open the violation form

In the Driver portal, tap **Add Violation** (or **Submit New Violation** depending on the view).

[Screenshot: Driver portal home with Add Violation button highlighted]

### Step 2: Select the property

Choose the property where the violation is occurring from the dropdown. You'll only see properties your company has access to.

### Step 3: Fill in violation details

**Required fields:**

- **Plate number** — Either type it manually or use the plate scanner (camera). Plate is automatically normalized (uppercase, no spaces or hyphens).
- **Violation type** — Common options: "Parking in fire lane", "Unauthorized vehicle", "Expired permit", "Blocking access", "No visible permit". Select from dropdown.
- **Location on property** — Free text describing where on the property the vehicle is parked. Examples: "Building B, rear lot, space 14", "Fire lane near main entrance", "Reserved spot 23 — has no permit displayed".

**Optional but recommended:**

- **Notes** — Anything relevant a manager or resident might want to know later. Examples: "Vehicle has flat tire — appears abandoned", "Observed parking 11:30pm; signage clearly visible at entrance".
- **Vehicle color, make, model** — Helps cross-reference if plate lookup later reveals a registered vehicle. Especially valuable if there's a dispute later about which vehicle was towed.

### Step 4: Attach photos

Photos are evidence. They are also your strongest protection against disputes.

**What to photograph:**
1. **The license plate clearly** — Both rear and front plates if visible. Plate must be readable in the photo.
2. **The vehicle in context** — A wide shot showing the vehicle in its violation position. The signage should be visible in at least one photo if possible.
3. **The signage itself** — A close-up of the no-parking or restricted-parking sign that the vehicle is violating.
4. **Specific violation details** — If the violation is "expired permit", photograph the windshield showing the expired permit. If "blocking fire lane", show the fire lane markings.

**Photo tier limits:**

| Enforcement Tier | Photos per violation |
|---|---|
| Starter | 3 |
| Growth | 10 |
| Legacy | Unlimited |

**File size limit:** 10MB per photo (any tier).

If you try to attach more photos than your tier allows, you'll see an error message. You can remove individual photos with the X button before submitting.

[Screenshot: Photo attachment area showing thumbnails with X buttons, tier limit indicator]

### Step 5: Attach video (optional)

A short video can settle disputes that photos alone can't. Walk around the vehicle while narrating ("Vehicle parked in fire lane, signage visible to my left, plate ABC1234, time stamp 11:35pm December 12").

**Video tier limits:**

| Enforcement Tier | Maximum video duration |
|---|---|
| Starter | 30 seconds |
| Growth | 60 seconds |
| Legacy | 120 seconds |

**File size limit:** 150MB (any tier).

Video uploads use a resumable protocol — if you lose your connection mid-upload, ShieldMyLot will resume from the last completed chunk when your connection returns. You don't need to start over.

### Step 6: Submit

Tap **Submit Violation**. You'll see an "Uploading…" indicator with a progress percentage if you have a video.

When the upload completes, you'll see the review screen.

---

## The review screen

This is the most important screen in the workflow. Once you confirm, the violation becomes official and is visible to managers, residents, and potentially used in legal proceedings.

[Screenshot: Review screen with violation details, photo grid, and three buttons at bottom: Edit, Discard, Confirm & Submit]

### What to verify

- **Plate is correct** — Compare against the vehicle. Even one wrong character will hand the violation to the wrong owner.
- **Property and location are correct** — Wrong property = wrong manager notified, wrong jurisdiction.
- **Violation type matches the actual violation** — "Expired permit" is different from "Unauthorized vehicle"; pick the accurate one.
- **All photos are clear and relevant** — Click each photo thumbnail to see the full version.
- **The video plays and shows what you intended** — Click the Play Video button to verify.
- **Vehicle details (color, make, model) match the vehicle** — A discrepancy here is the strongest evidence in a "you towed the wrong vehicle" dispute.

### Three actions

The review screen has three buttons:

**Edit** — Returns you to the form with all your data preserved. The current violation record is deleted from the database, and you can fix mistakes and re-submit. Use this if you noticed wrong details (typo in plate, wrong violation type, etc.).

**Discard** — Deletes the violation entirely and returns you to the portal home. Use this if you realized you shouldn't be submitting this violation at all (vehicle isn't actually violating, exempt plate you didn't catch, wrong property selected, etc.). You'll see a confirmation dialog before discarding.

**Confirm & Submit** — Locks the violation as official. After confirming, the violation becomes visible to the property manager and residents whose plate matches. You can no longer edit the violation details or remove photos as the submitting driver. (See [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md) for what happens after confirmation.)

### What if you can't decide right now?

The review screen has a 24-hour expiration. If you close the app or lose your connection without confirming or discarding, the violation stays in a "draft" state for 24 hours.

When you log back in, you'll see a banner at the top of your portal:

[Screenshot: Yellow banner with "1 unfinished violation — Review oldest | Discard all"]

If you have multiple drafts:

[Screenshot: Expanded resume banner with per-draft Review and Discard buttons, plus "Discard all" footer]

Use the per-draft Review button to return to that draft's review screen. Use Discard to remove specific drafts. Use "Discard all" to clean everything out if your drafts are stale.

**Drafts that are 24+ hours old are automatically purged** to prevent stale evidence from being submitted.

---

## After confirmation

Once you tap **Confirm & Submit**, several things happen:

1. The violation becomes visible in the property manager's portal.
2. If the plate matches a registered resident's vehicle, the resident sees the violation in their portal.
3. A **tow ticket modal** opens, letting you generate a physical tow ticket if a tow is happening.
4. The violation appears in your driver violations history.

See [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md) for what happens with the tow ticket workflow.

---

## Editing or removing media after confirmation

Once you've confirmed a violation, your access to modify it is limited.

**Drivers cannot:**
- Edit the violation details (plate, type, location, notes, vehicle info)
- Remove photos or videos

**Property managers and Company Admins can:**
- Use the **Manage Media** feature to soft-delete photos or videos with a documented reason. This is for cases like "wrong photo accidentally attached" or "offensive content" — not for hiding evidence.

Soft-deleted photos and videos remain in the database with an audit trail (who removed them, when, why). They are no longer visible in the violation card, but the record exists for legal review.

If you confirmed a violation and now realize the wrong details were submitted, contact your property manager or company admin immediately. They have the tools to manage the situation. **Do not submit a duplicate violation** — that creates a confusing record.

---

## Mobile usage tips

Most drivers submit violations on a phone. A few practical tips:

**Use landscape orientation for video** — Captures more context, looks more professional in evidence review.

**Tap the area outside the keyboard to dismiss it** — Especially useful when the keyboard covers the Submit button.

**Take photos one at a time, not multi-select** — Camera-roll multi-select is supported, but quality control is harder. Taking and reviewing each photo as you go produces better evidence.

**Save your work mid-form** — If you switch apps or get a phone call, the form keeps your input. You won't lose your work to interruptions.

**Connection lost mid-upload?** — Tus protocol (the upload system) will resume automatically when connection returns. Wait 10-30 seconds before manually retrying.

---

## What NOT to do

**Do not submit a violation just to "be safe."** A violation record is a serious thing. If you're unsure whether a vehicle is violating, talk to your manager before submitting.

**Do not edit a confirmed violation by submitting a new one and discarding the original.** This creates two records that look like duplicates — confusing for managers, residents, and dispute resolution.

**Do not delete or soft-delete photos after a dispute has been filed.** Removing evidence after a dispute is filed could be considered tampering. Even though the platform's audit trail captures every removal, this is the kind of thing that creates legal exposure.

**Do not share photos or videos of violations outside the platform.** ShieldMyLot is the evidence system of record. Sharing through text or social media creates privacy and chain-of-custody problems.

---

## Common questions

**The plate scanner isn't reading the plate correctly. What should I do?**
Use manual entry. The scanner is helpful but not always accurate, especially in low light or with weathered plates. Manual entry is always available.

**I attached the wrong photo by accident. Can I remove it before confirming?**
Yes. Each photo has an X button. Tap to remove. You can also use Edit on the review screen to return to the form and reattach.

**The video upload keeps failing. What's wrong?**
First, check the file size (under 150MB) and duration (within your tier's limit). If both are within limits, your connection may be the issue. Try uploading on Wi-Fi instead of cellular. If it still fails, you can submit the violation without video — the violation will be saved with photos only.

**Can I submit a violation for a property I'm not at?**
You can technically select any property in the dropdown, but you shouldn't. The location field should match the property, and the photos should clearly show you were physically present. Submitting violations for properties you weren't at is grounds for disciplinary action and creates legal exposure for your company.

**How long do I have to confirm a draft?**
24 hours from initial submission. After that, the draft is automatically purged.

---

## Next steps

- After confirming a violation, you may need to generate a tow ticket: [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md)
- If a resident disputes the violation: [Managing Disputes](../shared/12-managing-disputes.md)
- For property-specific configuration: [Adding Properties](04-adding-properties.md)

Questions not covered? Email support@shieldmylot.com.
