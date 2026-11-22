# AlignEx CBT Center Server App

This is the initial Electron desktop app for running an AlignEx CBT center server on a local machine. It starts a local Node/Express server when Electron launches, opens a React admin UI, prepares a SQLite database, exposes server health, and reports LAN access details for candidate machines.

Candidate login, answer saving, scoring, and sync logic are intentionally not implemented yet.

## Stack

- Electron
- React + TypeScript
- Vite
- Tailwind CSS
- shadcn/ui-style components
- lucide-react
- Node.js
- Express.js
- SQLite with better-sqlite3
- Socket.IO

## Features In This Initial App

- Electron main process starts the local Express server.
- `GET /api/health` returns server status.
- `GET /api/server-info` returns database connectivity and MVP record counts.
- SQLite database is created automatically.
- SQLite WAL mode is enabled.
- Local LAN IP address is detected.
- Candidate URL is generated from the LAN IP and server port.
- Socket.IO server is attached for future live monitoring.
- Admin UI has a sidebar, top status bar, dashboard cards, loading state, and API error state.
- Import Exam screen fetches approved online exams by code.
- Import Exam can retrieve, validate, and save an MVP exam package into SQLite.

## Setup

Install dependencies from this directory:

```bash
cd offline-server
npm install
```

The KernelBridge TypeScript SDK is a sibling workspace dependency at `../kernelbridge-license/packages/typescript`. Install its dependencies once with `npm install` in that package; `npm run build:main` builds the SDK before compiling the Server.

Start the Electron app in development mode:

```bash
npm run dev
```

Build the main process and renderer:

```bash
npm run build
```

For Windows packaging, `scripts/package-win-unpacked.ps1` checks that the staged `better-sqlite3` module can actually open a database under the bundled Electron runtime. The native module installed for Node may not work in Electron. Build a matching Electron binary for the installed `better-sqlite3` version and pass its path with `-ElectronSqliteBinary` when needed. Use `-ReleaseDirectory` with a new directory name to preserve existing release artifacts; the script refuses to reuse that directory. Development signatures are not production code signatures.

Run the built Electron app:

```bash
npm start
```

## Local Server

Default server port:

```text
4080
```

Health endpoint:

```text
http://127.0.0.1:4080/api/health
```

Server information endpoint:

```text
http://127.0.0.1:4080/api/server-info
```

Candidate URL shown in the app:

```text
http://<local-lan-ip>:4080/exam
```

The candidate route is only reserved for the future candidate exam interface. It is not implemented yet.

## Environment

Copy `.env.example` if you want to customize local settings later:

```bash
cp .env.example .env
```

Current useful values:

```text
OFFLINE_SERVER_PORT=4080
OFFLINE_CENTER_ID=
OFFLINE_STORAGE_PATH=./data/offline.sqlite
ALIGNEX_SYNC_BASE_URL=
ALIGNEX_SYNC_TOKEN=
KERNELBRIDGE_API_URL=https://kernelbridge.com/api/v1
KERNELBRIDGE_ENTITLEMENT_PUBLIC_KEYS='{"<key-id>":"<base64-ed25519-public-key>"}'
ALIGNEX_REQUIRE_KERNELBRIDGE_LICENSE=false
```

AlignEx Center Server uses the KernelBridge TypeScript SDK in Electron's main process. Configure the KernelBridge API base URL and trusted Ed25519 public keys before activating a server. The public-key JSON maps each KernelBridge signing `key_id` to its PEM or base64-encoded public key. Provision these keys from a trusted KernelBridge administrator; do not download and trust them from an unauthenticated endpoint. The SDK's local cache signing key is generated automatically and encrypted with Electron `safeStorage`.

After activation, **Settings > License and Device** shows the subscription plan and the verified installation entitlements, including their limits. The server refreshes the signed snapshot according to the SDK verification interval and offline grace policy; use Refresh in Settings to reload the displayed snapshot. The sidebar and feature navigation use the same verified feature projection. Legacy licenses do not provide a verified KernelBridge entitlement list.

For the unpacked Windows application, place deployment configuration in `resources/.env` beside `app.asar`, or supply it through the process environment. Keep the public-key trust map aligned with the actual KernelBridge signing key and point the API URL at the KernelBridge instance reachable by the server.

The AlignEx Platform must be configured with its KernelBridge integration credential and an active AlignEx account link. Server activation then exchanges the Platform's short-lived, installation-bound code directly with KernelBridge. Do not put a KernelBridge API credential in the Server's `.env`, renderer, or installer. AlignEx must be switched to Platform Account (or Hybrid) licensing mode by a KernelBridge administrator before this flow can complete. Existing installations are not automatically migrated or rebound.

For rollout, first configure the API URL and trusted public keys while `ALIGNEX_REQUIRE_KERNELBRIDGE_LICENSE=false`. After confirming the Platform account link and product licensing mode, set it to `true` and restart the Server. Strict mode blocks legacy offline-file activation and prevents local plan data from substituting for KernelBridge entitlements. Keep it `false` only for an explicitly approved legacy transition.

Code-based import calls:

```text
GET <ALIGNEX_SYNC_BASE_URL>/api/offline/exam-packages/{IMPORT_CODE}?center_id=<OFFLINE_CENTER_ID>&exam_code=<EXAM_CODE>
```

The endpoint may return the exam package directly, or wrap it under `package`, `exam_package`, or `data`.

## Directory Map

```text
offline-server/
  docs/                  Architecture notes.
  src/
    contracts/           Offline package and sync bundle contracts.
    electron/            Electron main process.
    renderer/            React admin UI.
    server/              Express, SQLite schema, LAN IP, Socket.IO, and status service.
    services/            Shared services for future package/runtime work.
    storage/             SQLite schema reference.
```

## Exam Package Format

The MVP package format is documented in:

```text
docs/exam-package-format.md
```

The current package is JSON with these top-level keys:

```text
manifest, subjects, questions, options, candidates
```

Manual MVP test steps:

```text
docs/mvp-test-checklist.md
```

## Next Step

The next implementation phase should keep portal-fetched exam import as the only start path, while planning offline question authoring behind center plan activation.
