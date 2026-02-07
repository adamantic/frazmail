'use client';

import { useState, useEffect } from 'react';
import { Building, Users, Mail, ExternalLink } from 'lucide-react';
import { getCompanies, type Company } from '@/lib/api';

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    getCompanies({ limit, offset: page * limit })
      .then(({ companies, total }) => {
        setCompanies(companies);
        setTotal(total);
      })
      .finally(() => setLoading(false));
  }, [page]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">Companies</h1>
        <p className="text-[var(--text-secondary)]">
          Organizations extracted from email domains ({total.toLocaleString()} total)
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-[var(--text-secondary)]">Loading companies...</div>
      )}

      {/* Companies Table */}
      {!loading && (
        <>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] overflow-hidden mb-6">
            <table className="min-w-full divide-y divide-[var(--border)]">
              <thead>
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Company
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Domain
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Contacts
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Emails
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {companies.map((company) => (
                  <tr key={company.id} className="hover:bg-[var(--surface-hover)] transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-[var(--accent-dim)] rounded flex items-center justify-center">
                          <Building className="h-4 w-4 text-[var(--accent)]" />
                        </div>
                        <span className="font-medium text-[var(--text-primary)]">
                          {company.name || company.domain}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <a
                        href={`https://${company.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[var(--accent)] hover:opacity-80"
                      >
                        {company.domain}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)]">
                      <span className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        {company.contact_count || 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)]">
                      <span className="flex items-center gap-1">
                        <Mail className="h-4 w-4" />
                        {company.total_emails}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <a
                        href={`/companies/${company.id}`}
                        className="text-[var(--accent)] hover:opacity-80 font-medium"
                      >
                        View details
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-[var(--text-secondary)]">
                Showing {page * limit + 1} - {Math.min((page + 1) * limit, total)} of {total}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="px-4 py-2 border border-[var(--border)] rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)] disabled:opacity-50 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={(page + 1) * limit >= total}
                  className="px-4 py-2 border border-[var(--border)] rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)] disabled:opacity-50 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {!loading && companies.length === 0 && (
        <div className="text-center py-12">
          <Building className="h-12 w-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">No companies found</h3>
          <p className="text-[var(--text-secondary)]">Import emails to see companies</p>
        </div>
      )}
    </div>
  );
}
