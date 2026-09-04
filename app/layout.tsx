import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Temporal Point Cloud',
  description: 'SICK microScan3 XY + time point cloud viewer',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
