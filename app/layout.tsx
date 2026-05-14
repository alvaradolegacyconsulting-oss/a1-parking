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
  // B62.4: Texas-first positioning + Chapter 2308 specificity in title + desc.
  title: "ShieldMyLot™ — Texas Parking Enforcement Platform | Chapter 2308 Compliance",
  description: "Texas-only parking enforcement platform built around Chapter 2308. Resident registration, visitor passes, violation tracking, and tow ticketing for towing companies and property managers.",
  openGraph: {
    title: "ShieldMyLot — Texas Parking Enforcement Platform",
    description: "Texas-only parking enforcement platform built around Chapter 2308. Resident registration, visitor passes, violation tracking, and tow ticketing for towing companies and property managers.",
    url: "https://shieldmylot.com",
    siteName: "ShieldMyLot",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ShieldMyLot — Texas Parking Enforcement Platform",
    description: "Texas-only parking enforcement platform built around Chapter 2308. Resident registration, visitor passes, violation tracking, and tow ticketing for towing companies and property managers.",
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
