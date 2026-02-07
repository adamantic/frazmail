'use client';

export const runtime = 'edge';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Building,
  Users,
  Mail,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { getCompany, type Company, type Contact } from '@/lib/api';
import { format, parseISO } from 'date-fns';

interface CompanyEmail {
  id: string;
  subject: string;
  sent_at: string;
  from_email: string;
  from_name?: string | null;
}

interface CompanyDetail {
  company: Company;
  contacts: Contact[];
  recent_emails: CompanyEmail[];
}

export default function CompanyDetailPage() {
  const params = useParams();
  const companyId = params?.id as string;

  const [data, setData] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  useEffect(() => {
    if (companyId) {
      setLoading(true);
      getCompany(companyId)
        .then(setData)
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [companyId]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-[var(--surface)] rounded w-1/3 mb-4"></div>
          <div className="h-4 bg-[var(--surface)] rounded w-1/2 mb-8"></div>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-[var(--surface)] rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="text-center py-12">
          <Building className="h-12 w-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">Company not found</h3>
          <Link href="/companies" className="text-[var(--accent)] hover:opacity-80">
            Back to companies
          </Link>
        </div>
      </div>
    );
  }

  const { company, contacts, recent_emails } = data;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Back button */}
      <Link
        href="/companies"
        className="inline-flex items-center gap-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to companies
      </Link>

      {/* Company Header */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 bg-[var(--accent-dim)] rounded-lg flex items-center justify-center flex-shrink-0">
            <Building className="h-8 w-8 text-[var(--accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              {company.name || company.domain}
            </h1>
            <a
              href={`https://${company.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[var(--accent)] hover:opacity-80 mt-1"
            >
              {company.domain}
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-6 pt-6 border-t border-[var(--border)]">
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Mail className="h-4 w-4" />
              Total Emails
            </div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{company.total_emails}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Users className="h-4 w-4" />
              Contacts
            </div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{contacts.length}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1">
              <Clock className="h-4 w-4" />
              Domain
            </div>
            <div className="text-lg font-semibold text-[var(--text-primary)]">{company.domain}</div>
          </div>
        </div>
      </div>

      {/* Contacts from this company */}
      {contacts.length > 0 && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h2 className="font-semibold text-[var(--text-primary)]">Contacts at {company.name || company.domain}</h2>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {contacts.map((contact) => (
              <Link
                key={contact.id}
                href={`/contacts/${contact.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--surface-hover)] transition-colors"
              >
                <div className="w-8 h-8 bg-[var(--accent-dim)] rounded-full flex items-center justify-center flex-shrink-0">
                  <Users className="h-4 w-4 text-[var(--accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-[var(--text-primary)]">
                    {contact.name || contact.email}
                  </span>
                  {contact.name && (
                    <span className="text-[var(--text-secondary)] ml-2 text-sm">{contact.email}</span>
                  )}
                </div>
                <div className="text-sm text-[var(--text-secondary)]">
                  {contact.email_count} emails
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Emails from this company */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="font-semibold text-[var(--text-primary)]">
            Emails from {company.name || company.domain}
            <span className="text-[var(--text-secondary)] font-normal ml-2">({recent_emails.length})</span>
          </h2>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {recent_emails.length === 0 ? (
            <div className="p-8 text-center text-[var(--text-secondary)]">
              No emails found from this company
            </div>
          ) : (
            recent_emails.map((email) => (
              <div
                key={email.id}
                onClick={() => setSelectedEmail(email.id)}
                className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--surface-hover)] cursor-pointer transition-colors"
              >
                <div className="w-44 flex-shrink-0">
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate block">
                    {email.from_name || email.from_email?.split('@')[0] || 'Unknown'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-[var(--text-primary)] truncate block">
                    {email.subject || '(No subject)'}
                  </span>
                </div>
                <div className="w-24 flex-shrink-0 text-right">
                  <span className="text-sm text-[var(--text-secondary)]">
                    {format(parseISO(email.sent_at), 'MMM d')}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

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
    import('@/lib/api').then(({ getEmail }) => {
      getEmail(emailId)
        .then(setEmail)
        .finally(() => setLoading(false));
    });
  }, [emailId]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--surface)] rounded-[14px] shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden border border-[var(--border)]">
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Email Details</h2>
          <button onClick={onClose} className="p-1 hover:bg-[var(--surface-hover)] rounded">
            <span className="text-xl text-[var(--text-secondary)]">&times;</span>
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {loading ? (
            <div className="text-center py-8 text-[var(--text-secondary)]">Loading...</div>
          ) : email ? (
            <div>
              <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-4">{email.subject}</h1>

              <div className="mb-6 space-y-2 text-sm">
                <div className="flex">
                  <span className="w-20 text-[var(--text-secondary)]">From:</span>
                  <span className="text-[var(--text-primary)]">{email.from_name} &lt;{email.from_email}&gt;</span>
                </div>
                <div className="flex">
                  <span className="w-20 text-[var(--text-secondary)]">To:</span>
                  <span className="text-[var(--text-primary)]">
                    {email.recipients
                      .filter((r: any) => r.recipient_type === 'to')
                      .map((r: any) => r.name || r.email)
                      .join(', ')}
                  </span>
                </div>
                <div className="flex">
                  <span className="w-20 text-[var(--text-secondary)]">Date:</span>
                  <span className="text-[var(--text-primary)]">{format(parseISO(email.sent_at), 'PPpp')}</span>
                </div>
              </div>

              {email.attachments?.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Attachments</h3>
                  <div className="flex flex-wrap gap-2">
                    {email.attachments.map((att: any) => (
                      <a
                        key={att.id}
                        href={`/api/emails/${emailId}/attachments/${att.id}`}
                        className="px-3 py-1 bg-[var(--accent-dim)] text-[var(--accent)] rounded text-sm hover:bg-[var(--accent-glow)] transition-colors"
                      >
                        {att.filename} ({(att.size / 1024).toFixed(1)} KB)
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="border-t border-[var(--border)] pt-4">
                <div
                  className="email-body prose max-w-none"
                  dangerouslySetInnerHTML={{
                    __html: email.body_html || email.body_text.replace(/\n/g, '<br>')
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-[var(--text-secondary)]">Email not found</div>
          )}
        </div>
      </div>
    </div>
  );
}
