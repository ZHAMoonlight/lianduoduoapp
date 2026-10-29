import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "练多多 · 体育培训经营工作台",
  description: "连接排课履约、课堂反馈与学员跟进，让每一节好课带来下一次期待。",
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
