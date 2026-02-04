'use client';

import { useState, useEffect } from 'react';
import { Search, User, Building, Mail, Clock } from 'lucide-react';
import { getContacts, type Contact } from '@/lib/api';
import { format, parseISO } from 'date-fns';

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    getContacts({ q: search || undefined, limit, offset: page * limit })
      .then(({ contacts, total }) => {
        setContacts(contacts);
        setTotal(total);
      })
      .finally(() => setLoading(false));
  }, [search, page]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Contacts</h1>
        <p className="text-gray-600">
          All contacts extracted from your email archive ({total.toLocaleString()} total)
        </p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts by name or email..."
            className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      </form>

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-gray-500">Loading contacts...</div>
      )}

      {/* Contacts Grid */}
      {!loading && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {contacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} />
            ))}
          </div>

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Showing {page * limit + 1} - {Math.min((page + 1) * limit, total)} of {total}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={(page + 1) * limit >= total}
                  className="px-4 py-2 border border-gray-300 rounded-lg disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {!loading && contacts.length === 0 && (
        <div className="text-center py-12">
          <User className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No contacts found</h3>
          <p className="text-gray-600">
            {search ? 'Try a different search term' : 'Import emails to see contacts'}
          </p>
        </div>
      )}
    </div>
  );
}

function ContactCard({ contact }: { contact: Contact }) {
  return (
    <a
      href={`/contacts/${contact.id}`}
      className="block p-4 bg-white border border-gray-200 rounded-lg hover:border-primary-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0">
          <User className="h-5 w-5 text-gray-400" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-gray-900 truncate">
            {contact.name || contact.email}
          </h3>
          {contact.name && (
            <p className="text-sm text-gray-500 truncate">{contact.email}</p>
          )}
          {contact.company_name && (
            <p className="text-sm text-gray-400 truncate flex items-center gap-1 mt-1">
              <Building className="h-3 w-3" />
              {contact.company_name}
            </p>
          )}
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <Mail className="h-3 w-3" />
              {contact.email_count} emails
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {format(parseISO(contact.last_seen), 'MMM yyyy')}
            </span>
          </div>
        </div>
      </div>
    </a>
  );
}
