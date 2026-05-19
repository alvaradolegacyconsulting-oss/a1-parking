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
};

export default nextConfig;
