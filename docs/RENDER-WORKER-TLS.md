# Render worker TLS (G3): literal HTTPS between the API and the worker

The API-to-worker hop on Render is literal HTTPS, via a private CA. Render
provides no managed TLS for private-service traffic, so the TLS is the
worker's own: the worker serves HTTPS with a certificate from a private CA,
and the API verifies that certificate against the CA. The browser service
stays a private service (`pserv`) — nothing about this makes it public.

## The three secrets

| Secret | Service | Contents |
| --- | --- | --- |
| `WORKER_TLS_CERT` | `openmuse-browser` | `worker.crt` — the worker's certificate (PEM) |
| `WORKER_TLS_KEY` | `openmuse-browser` | `worker.key` — the worker's private key (PEM) |
| `WORKER_TLS_CA` | `openmuse-api` | `ca.crt` — the private CA certificate (PEM) |

All three are declared `sync: false` in `render.yaml`, so the Blueprint
never writes or overwrites them. Set them in the Render dashboard
(service → Environment) by pasting the full PEM text, including the
`-----BEGIN ...-----` / `-----END ...-----` lines and their newlines.

**Never commit any of these files, their contents, or the CA key to the
repo or the template.** Generate them on a trusted machine, keep `ca.key`
offline, and delete the working copies once the secrets are set.

## Generate the CA and the worker certificate

Run on a machine with OpenSSL 3.x (verified against OpenSSL 3.0.13).
Note: `openssl x509 -addext` is rejected by that build, so the SAN goes
through an extensions file instead.

```sh
# 1. Private CA (10 years — it only ever signs this worker's certificate).
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt \
  -days 3650 -nodes -subj "/CN=OpenMuse Worker CA"

# 2. Worker key + certificate signing request.
openssl req -newkey rsa:2048 -keyout worker.key -out worker.csr \
  -nodes -subj "/CN=openmuse-browser"

# 3. Sign the worker certificate (825 days). The SAN must be
#    openmuse-browser — exactly the hostname the API connects to in
#    BROWSER_WORKER_URL (https://openmuse-browser:8790).
printf '[v3_req]\nsubjectAltName=DNS:openmuse-browser\n' > worker-ext.cnf
openssl x509 -req -in worker.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out worker.crt -days 825 -extensions v3_req -extfile worker-ext.cnf

# 4. Verify the SAN and the chain before uploading anything.
openssl x509 -in worker.crt -noout -text | grep -A1 "Subject Alternative Name"
openssl verify -CAfile ca.crt worker.crt
```

### SAN rule

TLS verification checks the hostname in the URL the API connects to. The
template connects to the bare service name (`openmuse-browser`), which
resolves on Render's private network, so the certificate must carry
`DNS:openmuse-browser`. Render's dashboard also shows internal hostnames
in `<service-name>-<hash>` form; if `BROWSER_WORKER_URL` ever uses that
hashed form instead, regenerate the certificate with that hostname in the
SAN. Do not add `localhost` to the production certificate — it is only
used by the automated tests, which generate their own certificates.

## What happens when something is misconfigured

- Worker with only one of `WORKER_TLS_CERT` / `WORKER_TLS_KEY` set: the
  worker fails fast at startup with a clear error instead of silently
  serving plain HTTP.
- Worker with a cert/key pair that does not match: startup fails with
  "must be a matching certificate/key pair in PEM format."
- API with an `https://` worker URL and no `WORKER_TLS_CA`: the API
  boots and uses default system-CA trust — that is the live Azure shape,
  where the platform terminates TLS in front of the worker. On Render,
  where the worker's certificate comes from the private CA, a forgotten
  `WORKER_TLS_CA` means every worker call fails loudly at the TLS
  handshake (the private CA is not in the system roots): the worker
  reports `down` in `/api/health`, and browser calls fail with the usual
  "Browser worker is unavailable" 503. Verification is never disabled —
  there is no insecure fallback anywhere in this path, and the API can
  never connect to the private-CA worker unverified.
- API with the wrong CA: the TLS handshake fails, the worker reports
  `down` in `/api/health`, and browser calls fail with the usual
  "Browser worker is unavailable" 503. Verification is never disabled —
  there is no insecure fallback anywhere in this path.

## Rotation

Re-run the generation commands, update the three secrets in the Render
dashboard, and redeploy both services. The server certificate lasts 825
days and the CA 10 years; rotate the server certificate before it
expires. A CA rotation means regenerating everything (the worker
certificate is signed by the CA) and updating all three secrets together.

## Azure (live) deployment

The live Azure deployment does **not** use TLS: `WORKER_TLS_CERT`,
`WORKER_TLS_KEY`, and `WORKER_TLS_CA` are unset there, so the worker
serves plain HTTP on its internal network and the API connects over
plain HTTP exactly as before. Do not set these variables on Azure.
