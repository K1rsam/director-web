import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '导演工作台',
  description: 'Sites + D1 + 本地 Runner 的导演工作控制面',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
