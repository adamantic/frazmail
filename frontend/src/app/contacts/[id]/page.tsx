'use client';

export const runtime = 'edge';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Mail,
  Building,
  Calendar,
  Search,
  Clock,
  Send,
  Inbox,
  User,
} from 'lucide-react';
import { getContact, search, type ContactTimeline, type SearchResult } from '@/lib/api';
import { format, parseISO } from 'date-fns';

export default function ContactDetailPage() {
  const params = useParams();
  const router = useRouter();
  const contactId = params?.id as string;

  const [timeline, setTimeline] = useState<ContactTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (contactId) {
      setLoading(true);
      getContact(contactId)
        .then(setTimeline)
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [contactId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !timeline) return;

    setSearching(true);
    try {
      const results = await search({
        query: searchQuery,
        filters: { from_contact_id: contactId },
        limit: 50,
      });
      setSearchResults(results.results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  const displayEmails = searchResults || timeline?.emails || [];

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-[var(--surface)] rounded w-1/3 mb-4"></div>
          <div className="h-4 bg-[var(--surface)] rounded w-1/2 mb-8"></div>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-[var(--surface)] rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-center py-12">
          <User className="h-12 w-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">Contact not found</h3>
          <Link href="/contacts" className="text-[var(--accent)] hover:opacity-80">
            Back to contacts
          </Link>
        </div>
      </div>
    );
  }

  const { contact, company, stats } = timeline;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Back button */}
      <Link
        href="/contacts"
        className="inline-flex items-center gap-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to contacts
      </Link>

      {/* Contact Header */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 bg-[var(--accent-dim)] rounded-full flex items-center justify-center flex-shrink-0">
            <User className="h-8 w-8 text-[var(--accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-[var(--text-primary)] truncate">
              {contact.name || contact.email}
            </h1>
            {contact.name && (
              <p className="text-[var(--text-secondary)] truncate">{contact.email}</p>
            )}
            {company && (
              <Link
                href={`/companies/${company.id}`}
                className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:opacity-80 mt-1"
              >
                <Building className="h-4 w-4" />
                {company.name || company.domain}
              </Link>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-[var(--border)]">
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Mail className="h-4 w-4" />
              Total Emails
            </div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{stats.total_emails}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Inbox className="h-4 w-4" />
              Received
            </div>
            <div className="text-2xl font-bold text-[var(--success)]">{stats.received}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Send className="h-4 w-4" />
              Sent
            </div>
            <div className="text-2xl font-bold text-[var(--accent)]">{stats.sent}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Calendar className="h-4 w-4" />
              First Contact
            </div>
            <div className="text-lg font-semibold text-[var(--text-primary)]">
              {stats.first_contact
                ? format(parseISO(stats.first_contact), 'MMM d, yyyy')
                : '-'}
            </div>
          </div>
        </div>
      </div>

      {/* Search within contact */}
      <div className="mb-6">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search emails with ${contact.name || contact.email}...`}
              className="w-full pl-12 pr-4 py-3 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
            />
          </div>
          <button
            type="submit"
            disabled={searching || !searchQuery.trim()}
            className="px-6 py-3 bg-[var(--accent)] text-white rounded-[14px] hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
          {searchResults && (
            <button
              type="button"
              onClick={clearSearch}
              className="px-4 py-3 border border-[var(--border)] text-[var(--text-secondary)] rounded-[14px] hover:bg-[var(--surface-hover)]"
            >
              Clear
            </button>
          )}
        </form>
        {searchResults && (
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            Found {searchResults.length} results for &quot;{searchQuery}&quot;
          </p>
        )}
      </div>

      {/* Email List */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="font-semibold text-[var(--text-primary)]">
            {searchResults ? 'Search Results' : 'Email History'}
          </h2>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {displayEmails.length === 0 ? (
            <div className="p-8 text-center text-[var(--text-secondary)]">
              {searchResults ? 'No emails match your search' : 'No emails found'}
            </div>
          ) : (
            displayEmails.map((email: any) => (
              <Link
                key={email.id || email.email_id}
                href={`/search?email=${email.id || email.email_id}`}
                className="block p-4 hover:bg-[var(--surface-hover)] transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                      email.direction === 'received' ? 'bg-[var(--success)]' : 'bg-[var(--accent)]'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-[var(--text-primary)] truncate">
                        {email.subject || '(No subject)'}
                      </h3>
                    </div>
                    <p className="text-sm text-[var(--text-secondary)] line-clamp-2">
                      {email.snippet}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-[var(--text-muted)]">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(parseISO(email.sent_at), 'MMM d, yyyy h:mm a')}
                      </span>
                      {email.direction && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs ${
                            email.direction === 'received'
                              ? 'bg-[var(--success)]/10 text-[var(--success)]'
                              : 'bg-[var(--accent-dim)] text-[var(--accent)]'
                          }`}
                        >
                          {email.direction === 'received' ? 'From them' : 'To them'}
                        </span>
                      )}
                      {email.score && (
                        <span className="text-[var(--text-muted)]">
                          Score: {email.score.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
