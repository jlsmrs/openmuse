# Azure browser worker deployment

The live browser worker runs as an Azure Container App, not from the
Render blueprint in `render.yaml` (that file defines the worker for Render
only). This doc records the Azure shape as deployed. There is no checked-in
infrastructure definition for it — see **Gap** below.

## Live shape

- **App:** `openmuse-browser`, resource group `openmuse-rg`, environment
  `openmuse-env`, subscription "Notary Needs".
- **Ingress:** internal-only. There is no public URL; the API reaches it
  over the container environment network.
- **Port:** 8790. A healthy replica logs `listening on port 8790` at startup.
- **Image:** `openmuseacr.azurecr.io/openmuse-browser:<commit-sha>`, built
  from the `apps/worker` directory with `apps/worker/Dockerfile`.
- **Replicas:** 1.
- **Environment variables** (names; values live on the Container App, not
  in this repo): `WORKER_HOST`, `WORKER_DATA_DIR`, `WORKER_TOKEN`. The
  image defaults are `WORKER_HOST=0.0.0.0` and `WORKER_DATA_DIR=/data`
  (see `apps/worker/Dockerfile`).
- **Runtime user:** the image runs as `pwuser`, not root.
- **Chromium:** launched with `--disable-dev-shm-usage` (Azure offers no
  shared-memory size control, same as the Render path).

## Build and deploy route

Build in Azure Container Registry, then update the app to the new image.
The image tag is always the merged commit SHA — an image-only update to
`:latest` with an unchanged tag string creates **no** new revision, and
the old replica keeps running.

```sh
az acr build --registry openmuseacr \
  --image openmuse-browser:<commit-sha> \
  --file apps/worker/Dockerfile apps/worker

az containerapp update --name openmuse-browser --resource-group openmuse-rg \
  --image openmuseacr.azurecr.io/openmuse-browser:<commit-sha>
```

The update is image-only: it preserves all environment variables.
Afterwards verify the new revision is Healthy, carries 100% traffic
weight, and that the environment variable names are unchanged
(`WORKER_HOST`, `WORKER_DATA_DIR`, `WORKER_TOKEN`).

## Health check

The worker exposes `GET /diagnostics` on port 8790. Because the app is
internal-only, the check runs from inside the cluster — exec into the API
container and call the worker with its `BROWSER_WORKER_URL` and
`WORKER_TOKEN` environment variables:

- No credentials → `401`.
- `Authorization: Bearer <WORKER_TOKEN>` → `200` with
  `{"status": "ok", "sessions": {"count": N}, ...}`.

The token must go in the `Authorization: Bearer` header; `x-worker-token`
and `x-api-key` headers both return `401`.

## Worker-image rule

The ACR build context is `apps/worker`, so the image contains only that
directory. Worker code must never import from `packages/` — a
cross-package import resolves in local tests (which run from the repo
root) but fails with `ERR_MODULE_NOT_FOUND` in the deployed image and
crash-loops the worker. Any helper the worker needs must live inside
`apps/worker`, vendored locally with a comment saying why it must stay
self-contained.

## Gap (open)

There is no checked-in Azure definition for this app — no Bicep, ARM,
Terraform, or `az containerapp create` script in the repo. The app was
created and is updated by manual `az` commands following the route above.
That gap stays open until someone checks in a definition; this doc records
the known shape so the next deploy does not have to rediscover it.
