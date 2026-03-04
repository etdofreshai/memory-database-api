# memory-database-api

REST API for the OpenClaw memory database (messages, sources, people) with Bearer token auth, pgvector search, and a React admin dashboard.

## Quick Start

```bash
npm install --include=dev
cd admin && npm install --include=dev && npm run build && cd ..
npm run build
DATABASE_URL=postgresql://... npm start
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `PORT` — Server port (default 3000)
- `ADMIN_TOKEN` — Bootstrap admin token on first run

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/messages?source=&sender=&after=&before=&limit=&offset=` — List messages
- `GET /api/messages/search?q=&limit=&offset=` — Full-text search
- `GET /api/messages/vector-search` — pgvector similarity search
- `POST /api/messages` — Create message (write token)
- `GET /api/sources` — List sources
- `GET /api/people` — List people
- `GET/POST/PATCH/DELETE /api/admin/tokens` — Token management (admin)
- `/admin` — Admin dashboard

## Migrations

```bash
npm run migrate  # Run manually when ready
```
