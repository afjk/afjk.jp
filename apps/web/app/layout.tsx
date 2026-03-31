import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "afjk — XR Engineer & Maker",
  description:
    "Next-gen portfolio for Akihiro Fujii (afjk). Built with Next.js + Prisma to showcase experiments, activity streams, and live telemetry.",
  openGraph: {
    title: "afjk — XR Engineer & Maker",
    url: "https://afjk.jp",
    description: "Dynamic portfolio platform for prototypes, XR work, and maker projects.",
    siteName: "afjk.jp",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    site: "@afjk01",
    title: "afjk — XR Engineer & Maker",
    description: "Live activity, experiments, and XR builds from Akihiro Fujii."
  }
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
