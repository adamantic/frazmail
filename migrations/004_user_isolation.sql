-- Add user_id to contacts and companies for full user isolation
-- Run with: wrangler d1 execute email-db --local --file=./migrations/004_user_isolation.sql

-- Add user_id to contacts
ALTER TABLE contacts ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

-- Add user_id to companies
ALTER TABLE companies ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_companies_user ON companies(user_id);
