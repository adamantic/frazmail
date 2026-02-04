-- Add user_id to email_sources for user isolation
-- Run with: wrangler d1 execute email-db --remote --file=./migrations/005_sources_user_id.sql

ALTER TABLE email_sources ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sources_user ON email_sources(user_id);
