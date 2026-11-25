# Clutch Arena

Clutch Arena is an esports tournament and scrims management platform.

## Product goals

- Separate Manager, Team, and Spectator workspaces
- Tournament and scrim creation and registration
- Team rosters, slots, groups, and match schedules
- Controlled custom room details
- Match results, scoring, standings, and prize tracking
- Team profiles and completed-event history
- Purple esports visual identity retained from the existing app

## Repository layout

- `legacy-appdeploy/`: original application snapshot, preserved as a migration baseline
- `server/`: standalone Node.js + TypeScript API foundation and PostgreSQL schema

## Standalone API foundation

The new API uses Express and PostgreSQL. It includes security headers, origin-restricted CORS, API rate limiting, health/readiness checks, connection pooling, and a PostgreSQL schema for events, teams, and archived team history.

### Run locally

1. Install Node.js 20 or newer and PostgreSQL.
2. In `server/`, copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Install and build:

```bash
cd server
npm install
npm run build
npm start
```

The health endpoint is `GET /api/_healthcheck`; database readiness is `GET /api/_ready`.

## Migration status

The original 15-file application snapshot has been committed under `legacy-appdeploy/`. The independent API foundation is now in `server/`.

**The full app is not yet migrated or production-ready.** Existing business routes and the frontend API client still need to be ported from AppDeploy to this API, then tested against PostgreSQL. The old hosted app remains separate and should not be removed until the new deployment is verified.

## Planned hosting

- Frontend: Vercel
- API and PostgreSQL: Railway

No credentials or production secrets belong in this repository.
