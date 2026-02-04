'use client';

import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { TrendingUp, Users, Building, Mail } from 'lucide-react';
import { getAnalytics, type Analytics } from '@/lib/api';
import { format, parseISO } from 'date-fns';

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    getAnalytics(days)
      .then(setAnalytics)
      .finally(() => setLoading(false));
  }, [days]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-12 text-gray-500">Loading analytics...</div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center py-12 text-gray-500">Failed to load analytics</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Analytics</h1>
          <p className="text-gray-600">Email communication insights for the last {days} days</p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="px-4 py-2 border border-gray-300 rounded-lg"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <StatCard
          icon={<Mail className="h-6 w-6 text-blue-600" />}
          label="Total Emails"
          value={analytics.total_emails.toLocaleString()}
          color="blue"
        />
        <StatCard
          icon={<Users className="h-6 w-6 text-green-600" />}
          label="Unique Contacts"
          value={analytics.unique_contacts.toLocaleString()}
          color="green"
        />
        <StatCard
          icon={<Building className="h-6 w-6 text-purple-600" />}
          label="Companies"
          value={analytics.unique_companies.toLocaleString()}
          color="purple"
        />
        <StatCard
          icon={<TrendingUp className="h-6 w-6 text-orange-600" />}
          label="Avg per Day"
          value={(analytics.total_emails / days).toFixed(1)}
          color="orange"
        />
      </div>

      {/* Volume Chart */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Email Volume Over Time</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={analytics.volume_by_day}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(date) => format(parseISO(date), 'MMM d')}
              />
              <YAxis />
              <Tooltip
                labelFormatter={(date) => format(parseISO(date as string), 'PPP')}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#0284c7"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top Contacts & Companies */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Top Contacts */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Contacts</h2>
          <div className="space-y-3">
            {analytics.top_contacts.map(({ contact, count }, i) => (
              <div key={contact.id} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400 w-4">{i + 1}</span>
                  <div>
                    <div className="font-medium text-gray-900">
                      {contact.name || contact.email}
                    </div>
                    {contact.name && (
                      <div className="text-sm text-gray-500">{contact.email}</div>
                    )}
                  </div>
                </div>
                <span className="text-sm font-medium text-gray-600">
                  {count} emails
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Top Companies */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Companies</h2>
          <div className="space-y-3">
            {analytics.top_companies.map(({ company, count }, i) => (
              <div key={company.id} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400 w-4">{i + 1}</span>
                  <div>
                    <div className="font-medium text-gray-900">
                      {company.name || company.domain}
                    </div>
                    {company.name && (
                      <div className="text-sm text-gray-500">{company.domain}</div>
                    )}
                  </div>
                </div>
                <span className="text-sm font-medium text-gray-600">
                  {count} emails
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  const bgColors: Record<string, string> = {
    blue: 'bg-blue-50',
    green: 'bg-green-50',
    purple: 'bg-purple-50',
    orange: 'bg-orange-50',
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${bgColors[color]}`}>{icon}</div>
        <div>
          <div className="text-sm text-gray-500">{label}</div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
        </div>
      </div>
    </div>
  );
}
