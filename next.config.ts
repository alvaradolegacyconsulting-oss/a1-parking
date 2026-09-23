import type { NextConfig } from "next";

// B85 Phase 2: route-scoped CSP for HeyGen iframe embeds. Applies ONLY
// to /help/videos/<slug> pages so the rest of the app (landing page +
// portal pages + future Stripe surfaces) is untouched. Global CSP
// deliberately avoided — enumerating every external resource the app
// touches (Google Fonts via next/font/google, Supabase Storage logo
// URLs, etc.) is out of B85 scope and high-risk.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/help/videos/:slug*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-src 'self' https://app.heygen.com",
          },
        ],
      },
    ]
  },
  async redirects() {
    return [
      // 2026-07-31 — /help/videos/resident retired when the pre-Spaces /
      // pre-CRM-redesign / pre-disputes-removal walkthrough was removed.
      // Redirects to the new Resident walkthrough rather than the video
      // library index: old bookmarks are residents wanting the resident
      // video (per Mateo). Permanent (308) — bookmarks + any indexed URL
      // land on the current file.
      {
        source: '/help/videos/resident',
        destination: '/help/videos/getting-started-resident',
        permanent: true,
      },
      // ── Ad short paths → /operators (2026-09-23, Commit 4 of 4) ────
      // /operators is CANONICAL so the page survives a change of ad hook
      // or of association membership; these short paths exist for print
      // legibility and can be added to or retired without touching it.
      //
      // 🔴 DO NOT PUT A QUERY STRING ON `destination`. Next forwards the
      // incoming query to a destination that has none; give the
      // destination its own and the incoming one is REPLACED. The
      // printed QR encodes /morethantruck?src=swto-print, so dropping
      // the query would land the reader on a working page, save the
      // lead with source null, and report success everywhere — print and
      // email attribution would both collapse into "direct" with nothing
      // anywhere raising an error. Zero print-attributed leads looks
      // exactly like an ad nobody answered.
      //
      // scripts/verify-operators-redirects.ts starts a real server and
      // asserts the forwarded query, so an edit here trips a gate.
      {
        source: '/morethantruck',
        destination: '/operators',
        permanent: true,
      },
      {
        source: '/swtowop',
        destination: '/operators',
        permanent: true,
      },
    ]
  },
};

export default nextConfig;
