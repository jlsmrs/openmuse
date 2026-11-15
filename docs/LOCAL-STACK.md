# Local stack

How to run the whole OpenMuse stack on a development machine. The
browser worker is the only part with a Compose definition
(`infra/compose.yaml`); the API and the web app run from the repo
directly. See also the [quick start](../README.md#quick-start) and the
[worker guide](../apps/worker/README.md).

## Prerequisites

Node 24 LTS, pnpm 11.19.0, Docker (for the worker via Compose only), and
a CopilotKit Intelligence project key.

```sh
git clone https://github.com/CopilotKit/OpenMuse.git openmuse
cd openmuse
pnpm install --frozen-lockfile
cp .env.example .env
npx copilotkit@latest login
npx copilotkit@latest project select
# Set CPK_INTELLIGENCE_API_KEY in .env to the generated server-only project key.
# Keep the CLI-generated CPK_TELEMETRY_ID too.
```

## 1. Browser worker

The worker is a private Chromium service on port 8790. Set the same
random `WORKER_TOKEN` (at least 32 characters) in `.env` and in the shell
that starts Compose, then start it from the repository root:

```sh
WORKER_TOKEN=<the-same-token> docker compose -f infra/compose.yaml up --build -d
```

Compose publishes only the loopback host port (`127.0.0.1:8790`) and
stores profiles in the `browser-profiles` Docker volume. To run the
worker without Docker instead:

```sh
pnpm dev:browser
```

That runs `apps/worker/src/index.ts` directly and stores profiles in
`.openmuse/browser-profiles` by default (`WORKER_DATA_DIR` overrides it).

## 2. API

```sh
pnpm dev
```

The API runs at `http://localhost:8787`; check
`http://localhost:8787/api/health`. It reads its settings from `.env`,
including the worker connection:

```sh
BROWSER_WORKER_URL=http://127.0.0.1:8790
WORKER_TOKEN=<the-same-token>
```

Local data lives in `.openmuse` under the repo root (`DATA_DIR`
overrides it). `pnpm dev` watches the server source; `pnpm build:server`
followed by `pnpm start` runs the compiled build instead.

## 3. Web app

In another terminal:

```sh
pnpm dev:web
```

Open `http://localhost:8081`. The web app talks to the API at
`http://localhost:8787` by default in local development. For iOS or
Android, use `pnpm --dir apps/mobile ios` or `pnpm --dir apps/mobile android`
(Xcode or Android tooling required; see
[Native iOS / Android / web setup](../apps/mobile/README.md)).

## Order of operations

1. Start the worker first — the API tolerates a missing worker, but
   browsing features (page reads, screenshots, Take control) need it.
2. Start the API.
3. Start the web app.

Stop everything with `docker compose -f infra/compose.yaml down`
(worker) and Ctrl-C in the API and web terminals. Deleting the
`browser-profiles` Docker volume deletes saved worker logins and
downloads.
