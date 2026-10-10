# D1 Schema

Apply the initial schema migration with Wrangler:

```bash
npx wrangler d1 execute family-ai-metadata --file db/migrations/0001_initial.sql
```

For local development DB:

```bash
npx wrangler d1 execute family-ai-metadata --local --file db/migrations/0001_initial.sql
```
