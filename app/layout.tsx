import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./components/NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ShieldMyLot™ — Parking Enforcement & Management Platform",
  description: "ShieldMyLot is a parking enforcement and property management platform for Texas towing companies and property managers. A product of Alvarado Legacy Consulting LLC.",
  openGraph: {
    title: "ShieldMyLot — Parking Enforcement & Management Platform",
    description: "Resident registration, visitor passes, violation tracking, and tow ticketing — one platform for Texas property teams.",
    url: "https://shieldmylot.com",
    siteName: "ShieldMyLot",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ShieldMyLot — Parking Enforcement & Management Platform",
    description: "Resident registration, visitor passes, violation tracking, and tow ticketing — one platform for Texas property teams.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
