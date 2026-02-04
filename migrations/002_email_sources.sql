-- Email Sources - Track imported email accounts/files
-- Run with: wrangler d1 execute email-db --remote --file=./migrations/002_email_sources.sql

-- Email sources (imported accounts/files)
CREATE TABLE IF NOT EXISTS email_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                    -- Display name (e.g., "Work Gmail", "Personal Outlook")
    email_address TEXT,                    -- Primary email address for this source
    source_type TEXT NOT NULL CHECK (source_type IN ('gmail', 'outlook', 'mbox', 'pst', 'api')),
    file_name TEXT,                        -- Original filename if uploaded
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    emails_total INTEGER DEFAULT 0,
    emails_processed INTEGER DEFAULT 0,
    emails_failed INTEGER DEFAULT 0,
    is_included_in_search BOOLEAN DEFAULT TRUE,  -- Whether to include in search results
    error_message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sources_status ON email_sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_included ON email_sources(is_included_in_search);

-- Add source_id to emails table
ALTER TABLE emails ADD COLUMN source_id TEXT REFERENCES email_sources(id);

CREATE INDEX IF NOT EXISTS idx_emails_source ON emails(source_id);
