# Email Intelligence

AI-powered hybrid search system for email archives with multi-user support. Built on Cloudflare's edge platform, inspired by [Tobi Lütke's QMD](https://github.com/tobi/qmd).

## Features

- **Multi-User Isolation** - Each user has isolated data with email/password authentication
- **Hybrid Search** - Combines BM25 full-text search + semantic vector search + LLM re-ranking
- **Contact Tracking** - Automatic contact and company extraction from emails
- **Source Management** - Track and manage multiple email imports (MBOX, PST, Gmail)
- **Thread Reconstruction** - Groups emails into conversations
- **Analytics Dashboard** - Communication volume, top contacts, trends
- **Attachment Storage** - Secure attachment storage with user isolation

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  Login   │  │  Search  │  │ Contacts │  │ Source Manager   │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Layer (Hono on Workers)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │   Auth   │  │  Search  │  │  Ingest  │  │ Sources/Contacts │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
        │               │               │               │
        ▼               ▼               ▼               ▼
┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────────┐
│    KV     │   │ Vectorize │   │    D1     │   │      R2       │
│ (Sessions)│   │ (Vectors) │   │ (SQLite)  │   │ (Attachments) │
└───────────┘   └───────────┘   └───────────┘   └───────────────┘
                      │
                      ▼
              ┌───────────────┐
              │  Cloudflare   │
              │      AI       │
              │ (BGE + Llama) │
              └───────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.8+ (for import scripts)
- Cloudflare account with Workers paid plan

### 1. Clone and Install

```bash
cd email-intelligence
npm install
cd frontend && npm install && cd ..
pip install -r scripts/requirements.txt
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create email-db

# Create Vectorize index
npx wrangler vectorize create email-vectors --dimensions=768 --metric=cosine

# Create R2 bucket
npx wrangler r2 bucket create email-attachments

# Create KV namespaces
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create SESSIONS
```

### 3. Update Configuration

Update `wrangler.toml` with the IDs from the commands above:

```toml
[[d1_databases]]
database_id = "YOUR_DATABASE_ID"

[[kv_namespaces]]
binding = "CACHE"
id = "YOUR_CACHE_KV_ID"

[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_SESSIONS_KV_ID"
```

### 4. Initialize Database

```bash
# Run all migrations
npx wrangler d1 execute email-db --local --file=./migrations/001_initial.sql
npx wrangler d1 execute email-db --local --file=./migrations/002_sources.sql
npx wrangler d1 execute email-db --local --file=./migrations/003_users.sql
npx wrangler d1 execute email-db --local --file=./migrations/004_user_isolation.sql
```

### 5. Run Development Server

```bash
# Terminal 1: API
npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

### 6. Create Account & Import Emails

1. Open http://localhost:3000
2. Register a new account with email and password
3. Import emails via the web UI or CLI:

```bash
# From Outlook PST
python scripts/ingest_pst.py /path/to/archive.pst --api-url http://localhost:8787 --token YOUR_TOKEN

# From Gmail MBOX (via Google Takeout)
python scripts/ingest_mbox.py /path/to/All\ mail.mbox --api-url http://localhost:8787 --token YOUR_TOKEN
```

## Search Pipeline

The hybrid search follows QMD's approach:

1. **Query Expansion**: LLM generates alternative search terms
2. **Parallel Retrieval**: BM25 (D1 FTS5) + Vector (Vectorize) search
3. **RRF Fusion**: Merge results using Reciprocal Rank Fusion
4. **LLM Re-ranking**: Score candidates with language model
5. **Position-Aware Blending**: Final score based on position

```typescript
// Example: finds emails about "pricing" even when they say "cost" or "budget"
const results = await search({
  query: "pricing discussion with John about the Melbourne project"
});
```

## API Documentation

### Authentication

All endpoints except `/api/auth/*` require a Bearer token.

#### Register
```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "Optional Name"
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login with email/password |
| GET | `/api/auth/verify` | Verify current session |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/search` | Hybrid search |
| GET | `/api/search/quick?q=` | Quick autocomplete search |
| GET | `/api/emails/:id` | Get email details |
| GET | `/api/contacts` | List contacts |
| GET | `/api/contacts/:id` | Contact timeline |
| GET | `/api/companies` | List companies |
| GET | `/api/companies/:id` | Company details |
| GET | `/api/analytics` | Analytics summary |
| GET | `/api/sources` | List email sources |
| POST | `/api/sources` | Create new source |
| POST | `/api/ingest` | Bulk email import |

## Data Isolation

Each user's data is completely isolated:

- **Emails** - Scoped to user via `user_id` column
- **Contacts** - Each user has their own contact list
- **Companies** - Companies are per-user
- **Sources** - Each user manages their own import sources
- **Attachments** - Stored in user-specific R2 paths
- **Search** - Results only include the user's emails
- **Vector Search** - Post-filtered by user_id

## Import Formats

### MBOX Files

Standard MBOX format from Gmail Takeout or Thunderbird exports.

### PST Files

Microsoft Outlook PST files. Requires conversion to MBOX or direct API ingestion.

### Gmail Takeout

1. Go to [Google Takeout](https://takeout.google.com/)
2. Select only "Mail"
3. Choose MBOX format
4. Download and extract
5. Use the import feature in the web UI

## Deployment

### Deploy to Cloudflare

```bash
# Deploy API
npm run deploy

# Build and deploy frontend
cd frontend
npm run build
npx wrangler pages deploy .next --project-name=email-intelligence
```

### Production Migrations

```bash
# Run migrations on production D1
npx wrangler d1 execute email-db --file=./migrations/001_initial.sql
npx wrangler d1 execute email-db --file=./migrations/002_sources.sql
npx wrangler d1 execute email-db --file=./migrations/003_users.sql
npx wrangler d1 execute email-db --file=./migrations/004_user_isolation.sql
```

## Cost Estimates

| Component | Free Tier | Paid Estimate |
|-----------|-----------|---------------|
| D1 | 5GB, 5M reads/day | ~$5-20/mo |
| Vectorize | 5M vectors, 30M queries/mo | ~$10-30/mo |
| Workers AI | 10K neurons/day | ~$10-50/mo |
| R2 | 10GB storage | ~$5/mo |
| KV | 100K reads/day | Included |
| **Total** | Good for dev | **~$30-100/mo** |

## Project Structure

```
email-intelligence/
├── src/
│   ├── workers/         # Cloudflare Worker (API)
│   │   └── index.ts     # Main API routes
│   ├── lib/             # Core logic
│   │   ├── auth.ts      # User authentication
│   │   ├── search.ts    # QMD-inspired hybrid search
│   │   ├── ingest.ts    # Email ingestion
│   │   └── sources.ts   # Source management
│   └── types/           # TypeScript types
├── frontend/            # Next.js frontend
│   └── src/
│       ├── app/         # Pages (login, search, etc.)
│       └── lib/         # Auth context & API client
├── scripts/             # Python ingestion scripts
│   ├── ingest_pst.py    # Outlook PST parser
│   └── ingest_mbox.py   # Gmail MBOX parser
├── migrations/          # D1 SQL migrations
│   ├── 001_initial.sql
│   ├── 002_sources.sql
│   ├── 003_users.sql
│   └── 004_user_isolation.sql
└── wrangler.toml        # Cloudflare configuration
```

## Security

- Passwords are hashed using PBKDF2 with 100,000 iterations
- Sessions are stored in KV with 24-hour expiry
- User tokens embed user_id for verification
- All database queries filter by user_id
- Attachments stored in user-scoped R2 paths

## License

MIT
