/**
 * API client for Email Intelligence backend
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export interface SearchRequest {
  query: string;
  filters?: {
    from_contact_id?: string;
    company_id?: string;
    date_from?: string;
    date_to?: string;
    has_attachments?: boolean;
  };
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  email_id: string;
  subject: string;
  snippet: string;
  from_email: string;
  from_name: string | null;
  sent_at: string;
  score: number;
  score_breakdown: {
    fts: number;
    vector: number;
    rerank: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query_expanded: string[];
  search_time_ms: number;
}

export interface Email {
  id: string;
  message_id: string;
  thread_id: string | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  sent_at: string;
  from_email: string;
  from_name: string | null;
  from_company: string | null;
  recipients: { email: string; name: string | null; recipient_type: string }[];
  attachments: { id: string; filename: string; content_type: string; size: number }[];
  thread: { id: string; subject: string; sent_at: string; from_email: string }[] | null;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  company_id: string | null;
  company_name?: string | null;
  first_seen: string;
  last_seen: string;
  email_count: number;
}

export interface ContactTimeline {
  contact: Contact;
  company: {
    id: string;
    domain: string;
    name: string | null;
  } | null;
  emails: {
    id: string;
    subject: string;
    sent_at: string;
    direction: 'sent' | 'received';
    snippet: string;
  }[];
  stats: {
    total_emails: number;
    sent: number;
    received: number;
    first_contact: string;
    last_contact: string;
    avg_response_time_hours: number | null;
  };
}

export interface Company {
  id: string;
  domain: string;
  name: string | null;
  total_emails: number;
  contact_count?: number;
}

export interface Analytics {
  period: string;
  total_emails: number;
  unique_contacts: number;
  unique_companies: number;
  top_contacts: { contact: Contact; count: number }[];
  top_companies: { company: Company; count: number }[];
  volume_by_day: { date: string; count: number }[];
}

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    // Unauthorized - redirect to login
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

// Search
export async function search(request: SearchRequest): Promise<SearchResponse> {
  return fetchAPI<SearchResponse>('/api/search', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function quickSearch(query: string): Promise<{ results: SearchResult[] }> {
  return fetchAPI<{ results: SearchResult[] }>(`/api/search/quick?q=${encodeURIComponent(query)}`);
}

// Emails
export async function getEmail(id: string): Promise<Email> {
  return fetchAPI<Email>(`/api/emails/${id}`);
}

// Contacts
export async function getContacts(params?: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ contacts: Contact[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.q) searchParams.set('q', params.q);
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return fetchAPI<{ contacts: Contact[]; total: number }>(
    `/api/contacts${query ? `?${query}` : ''}`
  );
}

export async function getContact(id: string): Promise<ContactTimeline> {
  return fetchAPI<ContactTimeline>(`/api/contacts/${id}`);
}

// Companies
export async function getCompanies(params?: {
  limit?: number;
  offset?: number;
}): Promise<{ companies: Company[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return fetchAPI<{ companies: Company[]; total: number }>(
    `/api/companies${query ? `?${query}` : ''}`
  );
}

export async function getCompany(id: string): Promise<{
  company: Company;
  contacts: Contact[];
  recent_emails: { id: string; subject: string; sent_at: string; from_email: string }[];
}> {
  return fetchAPI(`/api/companies/${id}`);
}

// Analytics
export async function getAnalytics(days?: number): Promise<Analytics> {
  return fetchAPI<Analytics>(`/api/analytics${days ? `?days=${days}` : ''}`);
}
