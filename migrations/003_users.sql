-- Multi-user support
-- Run with: wrangler d1 execute email-db --local --file=./migrations/003_users.sql

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Add user_id to email_sources
ALTER TABLE email_sources ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sources_user ON email_sources(user_id);

-- Add user_id to emails for faster filtering
ALTER TABLE emails ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id);
