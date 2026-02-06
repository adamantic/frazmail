'use client';

import { useState, useCallback, useEffect } from 'react';
import { Search, Mail, Clock, ChevronRight, Filter, X } from 'lucide-react';
import { search, type SearchRequest, type SearchResult, type SearchResponse } from '@/lib/api';
import { format, parseISO } from 'date-fns';
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = ['mark', 'p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'img'];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'class', 'style', 'target', 'rel'];

function sanitizeHTML(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<NonNullable<SearchRequest['filters']>>({});
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await search({ query, filters });
      setResponse(res);
      setResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, filters]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Search Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Search Emails</h1>
        <p className="text-gray-600">
          AI-powered hybrid search across your entire email archive
        </p>
      </div>

      {/* Search Box */}
      <div className="mb-6">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search emails... (e.g., 'pricing discussion with John about the Melbourne project')"
              className="w-full pl-12 pr-4 py-3 text-lg border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-4 py-3 border rounded-lg ${
              showFilters ? 'bg-primary-50 border-primary-500' : 'border-gray-300'
            }`}
          >
            <Filter className="h-5 w-5" />
          </button>
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            className="px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From Date
                </label>
                <input
                  type="date"
                  value={filters.date_from || ''}
                  onChange={(e) => setFilters({ ...filters, date_from: e.target.value || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  To Date
                </label>
                <input
                  type="date"
                  value={filters.date_to || ''}
                  onChange={(e) => setFilters({ ...filters, date_to: e.target.value || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Has Attachments
                </label>
                <select
                  value={filters.has_attachments === undefined ? '' : filters.has_attachments.toString()}
                  onChange={(e) => setFilters({
                    ...filters,
                    has_attachments: e.target.value === '' ? undefined : e.target.value === 'true'
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="">Any</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Results Info */}
      {response && (
        <div className="mb-4 flex items-center justify-between text-sm text-gray-600">
          <div>
            Found {response.total} results in {response.search_time_ms}ms
            {response.query_expanded.length > 1 && (
              <span className="ml-2 text-gray-400">
                (also searched: {response.query_expanded.slice(1).join(', ')})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Results - Inbox Style */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="divide-y divide-gray-100">
          {results.map((result) => (
            <div
              key={result.email_id}
              onClick={() => setSelectedEmail(result.email_id)}
              className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <div className="w-44 flex-shrink-0">
                <span className="text-sm font-medium text-gray-900 truncate block">
                  {result.from_name || result.from_email.split('@')[0]}
                </span>
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="font-medium text-gray-900 truncate">
                  {result.subject || '(No subject)'}
                </span>
                <span className="text-gray-400">-</span>
                <span
                  className="text-gray-500 truncate text-sm"
                  dangerouslySetInnerHTML={{ __html: sanitizeHTML(result.snippet) }}
                />
              </div>
              <div className="w-24 flex-shrink-0 text-right">
                <span className="text-sm text-gray-500">
                  {format(parseISO(result.sent_at), 'MMM d')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Empty State */}
      {!loading && query && results.length === 0 && !error && (
        <div className="text-center py-12">
          <Mail className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No results found</h3>
          <p className="text-gray-600">Try different keywords or broaden your search</p>
        </div>
      )}

      {/* Initial State */}
      {!loading && !query && results.length === 0 && (
        <div className="text-center py-12">
          <Search className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Search your emails</h3>
          <p className="text-gray-600 max-w-md mx-auto">
            Use natural language to find emails. The hybrid search combines keyword matching
            with semantic understanding to find what you're looking for.
          </p>
          <div className="mt-6 space-y-2 text-sm text-gray-500">
            <p>Try searching for:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                'pricing discussion with John',
                'project proposal from last year',
                'invoice attached',
                'meeting follow up',
              ].map((example) => (
                <button
                  key={example}
                  onClick={() => setQuery(example)}
                  className="px-3 py-1 bg-gray-100 rounded-full hover:bg-gray-200"
                >
                  "{example}"
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Email Detail Modal */}
      {selectedEmail && (
        <EmailModal
          emailId={selectedEmail}
          onClose={() => setSelectedEmail(null)}
        />
      )}
    </div>
  );
}

// Email detail modal component
function EmailModal({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    import('@/lib/api').then(({ getEmail }) => {
      getEmail(emailId)
        .then(setEmail)
        .finally(() => setLoading(false));
    });
  }, [emailId]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Email Details</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : email ? (
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-4">{email.subject}</h1>

              <div className="mb-6 space-y-2 text-sm">
                <div className="flex">
                  <span className="w-20 text-gray-500">From:</span>
                  <span>{email.from_name} &lt;{email.from_email}&gt;</span>
                </div>
                <div className="flex">
                  <span className="w-20 text-gray-500">To:</span>
                  <span>
                    {email.recipients
                      .filter((r: any) => r.recipient_type === 'to')
                      .map((r: any) => r.name || r.email)
                      .join(', ')}
                  </span>
                </div>
                <div className="flex">
                  <span className="w-20 text-gray-500">Date:</span>
                  <span>{format(parseISO(email.sent_at), 'PPpp')}</span>
                </div>
              </div>

              {email.attachments?.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Attachments</h3>
                  <div className="flex flex-wrap gap-2">
                    {email.attachments.map((att: any) => (
                      <a
                        key={att.id}
                        href={`/api/emails/${emailId}/attachments/${att.id}`}
                        className="px-3 py-1 bg-gray-100 rounded text-sm hover:bg-gray-200"
                      >
                        {att.filename} ({(att.size / 1024).toFixed(1)} KB)
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="border-t pt-4">
                <div
                  className="email-body prose max-w-none"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHTML(email.body_html || email.body_text.replace(/\n/g, '<br>'))
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">Email not found</div>
          )}
        </div>
      </div>
    </div>
  );
}
