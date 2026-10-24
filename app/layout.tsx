import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "练多多 · 连锁经营工作台",
  description: "连接品牌、门店、教练与学员，让每一家门店都更进一步。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
