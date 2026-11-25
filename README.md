# Clutch Arena

Clutch Arena is an esports tournament and scrims management platform.

## Product goals

- Separate Manager, Team, and Spectator workspaces
- Tournament and scrim creation and registration
- Team rosters, slots, groups, and match schedules
- Custom room details with controlled publication
- Match results, scoring, standings, and prize tracking
- Team profiles and completed-event history
- Purple esports visual identity retained from the existing app

## Repository layout

The `legacy-appdeploy/` directory contains the source snapshot exported from the existing Clutch Arena application. It is preserved as a migration baseline and reference for existing features and UI.

## Migration status

The source snapshot has been transferred to GitHub. It is **not yet an independent runnable deployment**: the legacy frontend imports `@appdeploy/client` and the legacy backend imports `@appdeploy/sdk`. Those AppDeploy dependencies still need to be replaced with a standalone API, database, and deployment configuration before this repository can run independently.

The existing hosted application should remain untouched until the independent replacement has been implemented, tested, and verified.

## Planned standalone stack

- Frontend: React + TypeScript + Vite
- API: Node.js + TypeScript
- Database: PostgreSQL
- Hosting: Vercel (frontend) and Railway (API/database)

No secrets or production credentials belong in this repository.
