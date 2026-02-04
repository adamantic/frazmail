'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useEffect, useState } from 'react';

const navItems = [
  { href: '/', label: 'Search' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/companies', label: 'Companies' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/import', label: 'Import' },
];

export function Navigation() {
  const pathname = usePathname();
  const { isAuthenticated, logout, isLoading } = useAuth();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = stored === 'dark' || (!stored && prefersDark);
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle('dark', shouldBeDark);
  }, []);

  const toggleDark = () => {
    const newValue = !isDark;
    setIsDark(newValue);
    localStorage.setItem('theme', newValue ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', newValue);
  };

  // Don't show nav on login page or when loading
  if (pathname === '/login' || isLoading) {
    return null;
  }

  // Don't show nav if not authenticated
  if (!isAuthenticated) {
    return null;
  }

  return (
    <nav className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <Link href="/" className="flex items-center">
              <span className="text-xl font-bold text-red-500">QMDemon</span>
            </Link>
            <div className="hidden sm:ml-8 sm:flex sm:space-x-4">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    pathname === item.href
                      ? 'text-primary-600 bg-primary-50 dark:text-primary-400 dark:bg-primary-900/20'
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleDark}
              className="p-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
