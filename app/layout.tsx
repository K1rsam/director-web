import type { Metadata } from "next";
import "./globals.css";
import "./vision-studio.css";
import { PageTransition } from "./ui/page-transition";

export const metadata: Metadata = {
  title: "Seedance 分镜导演工作台",
  description: "从规范化剧本到Seedance分镜单元的结构化导演生产线"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body><PageTransition>{children}</PageTransition></body>
    </html>
  );
}
