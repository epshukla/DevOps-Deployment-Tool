import type { Metadata } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Body: IBM Plex Sans — technical, highly legible at dense 12–14px sizes
const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Headings and data: JetBrains Mono (see design-system/deployx/MASTER.md)
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "DeployX — Cloud-Native CI/CD Platform",
  description:
    "Production-grade CI/CD platform. Build, test, containerize, deploy, observe, self-heal.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plex.variable} ${jetbrainsMono.variable} dark`}
    >
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
