import type { MetadataRoute } from 'next'

// Next.js App Router auto-emits /manifest.webmanifest from this file.
// theme_color #103b5d is the ShieldMyLot navy — matches the shield mark.
// The maskable purpose entry lets Android crop the icon into its safe zone
// (circle, squircle, teardrop) without cutting off the shield silhouette.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ShieldMyLot',
    short_name: 'ShieldMyLot',
    description: 'Parking & Enforcement Management',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#103b5d',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
