// Feature flag string keys — single source of truth for the flag names used
// in tier-config.ts and proposal_codes.feature_overrides JSONB. Keep in sync
// with the Tier Matrix v1 (May 7, 2026).

export const FEATURE_FLAGS = {
  // ─── Numeric limits (-1 = unlimited) ────────────────────────────────
  MAX_PROPERTIES: 'max_properties',
  MAX_DRIVERS: 'max_drivers',
  MAX_VISITOR_PASSES_PER_PROPERTY_MONTH: 'max_visitor_passes_per_property_month',
  MAX_VISITOR_PASS_DURATION_HOURS: 'max_visitor_pass_duration_hours',
  // Phase 2a (May 17, 2026): replaces the awkward booleans
  // VIDEO_UPLOADS_LIMITED / VIDEO_UPLOADS_FULL. Number speaks for itself.
  // Booleans kept for back-compat through this commit; removal slated
  // for B35 follow-up.
  VIDEO_MAX_DURATION_SECONDS: 'video_max_duration_seconds',
  // B42 (May 18, 2026): max photos per violation submission.
  // -1 = unlimited. Client-side enforcement only (no DB trigger);
  // matches VIDEO_MAX_DURATION_SECONDS precedent. Server-side trigger
  // would be a B44 follow-up if real-world data shows bypass abuse.
  MAX_PHOTOS_PER_VIOLATION: 'max_photos_per_violation',

  // ─── Enforcement-track core (true on all enforcement tiers) ─────────
  AI_PLATE_SCANNING: 'ai_plate_scanning',
  VIOLATION_DOCUMENTATION: 'violation_documentation',
  TOW_TICKET_GENERATION: 'tow_ticket_generation',
  TOWING_AUTHORIZATION_UI: 'towing_authorization_ui',
  DRIVER_PORTAL: 'driver_portal',
  STORAGE_FACILITY_MANAGEMENT: 'storage_facility_management',
  PHOTO_UPLOADS: 'photo_uploads',
  DISPUTE_REQUESTS: 'dispute_requests',
  FINDMYTOWEDCAR_LINKS: 'findmytowedcar_links',
  CSV_EXPORT_BASIC: 'csv_export_basic',

  // ─── Cross-track core (true on both tracks) ─────────────────────────
  RESIDENT_MANAGEMENT: 'resident_management',
  VISITOR_PASS_MANAGEMENT: 'visitor_pass_management',
  MANAGER_PORTAL: 'manager_portal',
  AUDIT_LOGS: 'audit_logs',
  CUSTOM_LOGO_BRANDING: 'custom_logo_branding',
  MOBILE_FRIENDLY_PORTALS: 'mobile_friendly_portals',
  BASIC_DASHBOARDS: 'basic_dashboards',
  EMAIL_SUPPORT: 'email_support',

  // ─── PM-track core (true on all PM tiers) ───────────────────────────
  PROPERTY_MANAGEMENT: 'property_management',
  RESIDENT_SELF_REGISTRATION: 'resident_self_registration',
  VISITOR_PASS_SELF_SERVICE: 'visitor_pass_self_service',
  RESIDENT_PORTAL: 'resident_portal',
  VEHICLE_REGISTRY: 'vehicle_registry',
  MULTIPLE_MANAGERS_PER_PROPERTY: 'multiple_managers_per_property',
  // B70: PM-only manual plate lookup surface (manager + leasing_agent).
  // Distinct from AI_PLATE_SCANNING which is enforcement-only. Read-only;
  // backed by SECURITY DEFINER pm_plate_lookup() RPC for server-enforced
  // property scoping + atomic audit write.
  PM_PLATE_LOOKUP: 'pm_plate_lookup',

  // ─── Tiered (varying by tier; cross-track unless noted) ─────────────
  LEASING_AGENT_ROLE: 'leasing_agent_role',
  ADVANCED_ANALYTICS: 'advanced_analytics',
  CUSTOM_DATE_RANGE_EXPORTS: 'custom_date_range_exports',
  ADVANCED_PDF_REPORTS: 'advanced_pdf_reports',
  PRIORITY_SUPPORT: 'priority_support',
  DEDICATED_ACCOUNT_MANAGER: 'dedicated_account_manager',

  // Tiered, enforcement-only:
  TOWBOOK_CSV_EXPORT: 'towbook_csv_export',
  API_ACCESS_READ_ONLY: 'api_access_read_only',
  VIDEO_UPLOADS_LIMITED: 'video_uploads_limited',
  VIDEO_UPLOADS_FULL: 'video_uploads_full',
} as const

export type FeatureFlag = typeof FEATURE_FLAGS[keyof typeof FEATURE_FLAGS]

export const NUMERIC_FLAGS = new Set<FeatureFlag>([
  FEATURE_FLAGS.MAX_PROPERTIES,
  FEATURE_FLAGS.MAX_DRIVERS,
  FEATURE_FLAGS.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH,
  FEATURE_FLAGS.MAX_VISITOR_PASS_DURATION_HOURS,
  FEATURE_FLAGS.VIDEO_MAX_DURATION_SECONDS,
  FEATURE_FLAGS.MAX_PHOTOS_PER_VIOLATION,
])

export function isNumericFlag(flag: FeatureFlag): boolean {
  return NUMERIC_FLAGS.has(flag)
}
