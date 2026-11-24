# Hermes Windows relay

Hermex/Conduit → HTTPS `workers.dev` → Worker + SQLite Durable Object → outbound connector → `127.0.0.1:9119` on Windows. No EC2, inbound router ports, purchased domain, or iPhone VPN in this path. Hermes itself executes on Windows.

## Authentication and boundaries

All dashboard requests and WebSocket upgrades require `X-Hermes-Relay-Key` (Worker secret `CLIENT_KEY`), in addition to Hermes' native login. Set the header in each mobile app, including media requests. The dedicated connector endpoint `/_relay/connect` requires a different bearer (`CONNECTOR_KEY`). Fail closed if either secret is missing. Never reuse model OAuth, dashboard passwords, MCP tokens or peer API keys for this transport.

The connector accepts only relative paths to fixed loopback port9119; it never follows HTTP redirects or shares backend cookies between clients. Preserve the dashboard's basic-auth hash and stable secret, and set `dashboard.public_url` to the exact Worker origin so native authentication/Host/Origin/WS-ticket validation engages. Do not expose gateway peer API18742. Native Desktop loopback listeners remain separate.

Request bodies flow in64KiB chunks with acknowledgments; response bodies use explicit pull credits. Limits:32MiB upload,128MiB download,1MiB WebSocket frame,12 concurrent HTTP/handshake requests and8 active client sockets. Idle sockets use Durable Object hibernation attachments, not permanent JavaScript timers. No SQLite chat storage or request-payload logging. Access metadata may still be processed by Cloudflare. Do not put credentials in URLs.

Disconnects fail in-flight HTTP and close client sockets. The connector reconnects with bounded jittered backoff; it does not queue or replay user operations. If a mutation was interrupted, check Hermes' state before retrying. A Worker deployment/DO reset can interrupt existing streams; mobile clients reconnect normally.

## Local verification

Node24+ and Python3.12+:

```
npm ci
python -m venv .venv
# Windows uses .venv/Scripts/python.exe; macOS uses .venv/bin/python.
.venv/bin/python -m pip install -r requirements.txt
npm test
npx wrangler deploy --dry-run
npm audit
```

Tests run real workerd/Miniflare with the Python connector and a disposable HTTP/WebSocket backend. They check authentication, fixed target/SSRF restrictions, cookie isolation, multi-cookie forwarding,5MiB transfer integrity, compressed responses, HEAD/204, redirects, ranges, streaming, Unicode/binary WS, connector loss and absence of mutation replay. They do not prove physical iOS compatibility.

## Deployment

`wrangler.jsonc` declares a SQLite-backed Durable Object supported on Workers Free. Do not enable a paid subscription. The Free plan has daily quotas; exhausting them interrupts access. It is not an unlimited/SLA service. See [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Deploy this isolated package only. Set `CLIENT_KEY` and `CONNECTOR_KEY` using Wrangler secrets with private input files outside Git. Initial deployment without secrets rejects every request. Disable preview URLs and invocation logs as configured.

On Windows, install `connector.py` and its dedicated venv under `%LOCALAPPDATA%/hermes-relay`, with a user/SYSTEM-only ACL. The private JSON config contains `url` (HTTPS workers.dev origin), `backend` (`http://127.0.0.1:9119`) and `connector_key`. Run:

```
<dedicated-python.exe> connector.py --config <private-config.json>
```

Register only this connector as a user logon scheduled task, with restart-on-failure. Use the existing interactive Hermes_Local_Backend task for dashboard9119. Never start/restart the native Hermes gateway from SSH Session0. Do not touch T3's tunnel or other running applications. Connector start does not imply a live Hermes backend: verify both.

## Rollback

Stop/disable only `Hermes_Cloudflare_Relay`; do not delete Hermes data. Restore the backed-up `dashboard.public_url` if retiring the public route. Remove the dedicated Worker only after confirming it is no longer needed. Secrets and logs remain local/private. Gateway/peer routing is independent and is not changed by this package.

Tracking: [infra-control-private#195](https://github.com/damballa212/infra-control-private/issues/195).
