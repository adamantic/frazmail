// Environment bindings
export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ATTACHMENTS: R2Bucket;
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;
  ENVIRONMENT: string;
}

// User types
export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
}

// Context with authenticated user
export interface UserContext {
  userId: string;
  user?: User;
}

// Database models
export interface Email {
  id: string;
  message_id: string;
  thread_id: string | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  sent_at: string;
  from_contact_id: string;
  has_attachments: boolean;
  created_at: string;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  company_id: string | null;
  first_seen: string;
  last_seen: string;
  email_count: number;
}

export interface Company {
  id: string;
  domain: string;
  name: string | null;
  total_emails: number;
  first_contact: string;
  last_contact: string;
}

export interface EmailRecipient {
  email_id: string;
  contact_id: string;
  recipient_type: 'to' | 'cc' | 'bcc';
}

export interface Attachment {
  id: string;
  email_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

// Search types
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
  highlights?: string[];
}

export interface SearchRequest {
  query: string;
  filters?: {
    from_contact_id?: string;
    company_id?: string;
    date_from?: string;
    date_to?: string;
    has_attachments?: boolean;
    source_ids?: string[];  // Filter by specific email sources
  };
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query_expanded: string[];
  search_time_ms: number;
}

// Contact timeline
export interface ContactTimeline {
  contact: Contact;
  company: Company | null;
  emails: EmailSummary[];
  stats: {
    total_emails: number;
    sent: number;
    received: number;
    first_contact: string;
    last_contact: string;
    avg_response_time_hours: number | null;
  };
}

export interface EmailSummary {
  id: string;
  subject: string;
  sent_at: string;
  direction: 'sent' | 'received';
  snippet: string;
}

// Analytics types
export interface AnalyticsSummary {
  period: string;
  total_emails: number;
  unique_contacts: number;
  unique_companies: number;
  top_contacts: { contact: Contact; count: number }[];
  top_companies: { company: Company; count: number }[];
  volume_by_day: { date: string; count: number }[];
  volume_by_hour: { hour: number; count: number }[];
}

// Ingestion types
export interface IngestEmailRequest {
  message_id: string;
  subject: string;
  body_text: string;
  body_html?: string;
  sent_at: string;
  from_email: string;
  from_name?: string;
  to: { email: string; name?: string }[];
  cc?: { email: string; name?: string }[];
  bcc?: { email: string; name?: string }[];
  in_reply_to?: string;
  references?: string[];
  attachments?: {
    filename: string;
    content_type: string;
    size: number;
    content_base64: string;
  }[];
}

export interface IngestBatchResponse {
  processed: number;
  failed: number;
  errors: { message_id: string; error: string }[];
}

// Vector metadata
export interface VectorMetadata {
  email_id: string;
  subject: string;
  sent_at: string;
  from_email: string;
}
