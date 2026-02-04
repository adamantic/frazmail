import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Navigation } from '@/components/Navigation';
import { QMDemon } from '@/components/QMDemon';

export const metadata: Metadata = {
  title: 'QMDemon',
  description: 'Search and analyze your email archive with AI-powered hybrid search',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-gray-50 dark:bg-gray-900 min-h-screen transition-colors">
        <Providers>
          <Navigation />
          <main>{children}</main>
          <QMDemon />
        </Providers>
      </body>
    </html>
  );
}
