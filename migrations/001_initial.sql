-- Email Intelligence System - Initial Schema
-- Run with: wrangler d1 execute email-db --file=./migrations/001_initial.sql

-- ═══════════════════════════════════════════════════════════════════
-- COMPANIES
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    name TEXT,
    total_emails INTEGER DEFAULT 0,
    first_contact DATETIME,
    last_contact DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_companies_total_emails ON companies(total_emails DESC);

-- ═══════════════════════════════════════════════════════════════════
-- CONTACTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    company_id TEXT REFERENCES companies(id),
    first_seen DATETIME,
    last_seen DATETIME,
    email_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email_count ON contacts(email_count DESC);

-- ═══════════════════════════════════════════════════════════════════
-- EMAILS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    message_id TEXT UNIQUE,
    thread_id TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    sent_at DATETIME,
    from_contact_id TEXT NOT NULL REFERENCES contacts(id),
    has_attachments BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_from_contact ON emails(from_contact_id);

-- ═══════════════════════════════════════════════════════════════════
-- FTS5 FULL-TEXT SEARCH
-- ═══════════════════════════════════════════════════════════════════
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    subject,
    body_text,
    content='emails',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(rowid, subject, body_text)
    VALUES (new.rowid, new.subject, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, body_text)
    VALUES ('delete', old.rowid, old.subject, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, body_text)
    VALUES ('delete', old.rowid, old.subject, old.body_text);
    INSERT INTO emails_fts(rowid, subject, body_text)
    VALUES (new.rowid, new.subject, new.body_text);
END;

-- ═══════════════════════════════════════════════════════════════════
-- EMAIL RECIPIENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS email_recipients (
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc')),
    PRIMARY KEY (email_id, contact_id, recipient_type)
);

CREATE INDEX IF NOT EXISTS idx_recipients_email ON email_recipients(email_id);
CREATE INDEX IF NOT EXISTS idx_recipients_contact ON email_recipients(contact_id);

-- ═══════════════════════════════════════════════════════════════════
-- ATTACHMENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    r2_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);

-- ═══════════════════════════════════════════════════════════════════
-- THREADS (for thread reconstruction)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    subject TEXT,
    email_count INTEGER DEFAULT 0,
    first_email_at DATETIME,
    last_email_at DATETIME,
    participant_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════
-- AUDIT LOG (for tracking imports)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS import_logs (
    id TEXT PRIMARY KEY,
    source_file TEXT,
    source_type TEXT CHECK (source_type IN ('pst', 'mbox', 'api')),
    emails_processed INTEGER DEFAULT 0,
    emails_failed INTEGER DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    error_log TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
