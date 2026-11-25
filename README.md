# Clutch Arena

Clutch Arena is an esports tournament and scrims management platform with separate Manager, Team and Spectator experiences.

## Repository layout

- `src/`: independent React + TypeScript + Vite frontend, preserving the purple esports interface
- `server/`: standalone Express + TypeScript API and PostgreSQL schema
- `legacy-appdeploy/`: untouched source snapshot of the previous AppDeploy version, retained as a reference

## Migrated features

The standalone API now supports:
- Public event discovery and event detail
- Manager event creation and configuration
- Team registration with four-player rosters and private team access tokens
- Manager authentication for room details and event updates
- Team slot assignment and payment-status verification
- Match scheduling, delays, cancellations and rescheduling
- Match result confirmation and standings data
- Prize configuration and payout tracking
- Private match room release to eligible registered teams
- Team history archiving and automatic removal of completed events after 24 hours

The frontend has been copied into the root Vite app and now uses a small native Fetch API client instead of `@appdeploy/client`. The legacy purple theme is preserved.

## Local development

Requirements: Node.js 22 or newer and PostgreSQL.

### 1. Start PostgreSQL

Create a database, then apply the schema:

```bash
psql "$DATABASE_URL" -f server/schema.sql
```

### 2. Start the API

```bash
cd server
cp .env.example .env
# Set DATABASE_URL, CORS_ORIGINS, and APP_SECRET in .env
npm install
npm run build
npm start
```

API health: `GET http://localhost:4000/api/_healthcheck`

Database readiness: `GET http://localhost:4000/api/_ready`

### 3. Start the frontend

In another terminal from the repository root:

```bash
cp .env.example .env
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:4000` by default. Set `API_PROXY_TARGET` to change the local API target.

## Hosting configuration

- Vercel frontend configuration is in `vercel.json`.
- Railway API configuration and Dockerfile are in `server/railway.json` and `server/Dockerfile`.
- Configure Railway service root directory as `/server`.
- Add a PostgreSQL service to the same Railway project and set the API's `DATABASE_URL`.
- Set `CORS_ORIGINS` on Railway to the exact Vercel production URL(s).
- Set `VITE_API_BASE_URL` on Vercel to the Railway API public URL, without a trailing slash.

A GitHub Actions workflow in `.github/workflows/build.yml` builds the frontend and API on pushes and pull requests.

## Important migration status

The independent source code and deployment configuration are in GitHub. A successful CI build, production database setup, hosting deployment and end-to-end verification are still required before this can replace the old live app. The old AppDeploy app has not been modified or deleted.

Never commit real credentials, organizer tokens, database passwords or API secrets.
