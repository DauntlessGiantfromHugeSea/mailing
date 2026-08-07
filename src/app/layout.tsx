import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Mailing — Drip-Versand",
  description: "Randomisierter E-Mail-Versand im Minutentakt über Hostinger",
  applicationName: "Mailing",
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#007e80",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
