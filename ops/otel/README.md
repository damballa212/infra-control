# OTel host metrics

This is a prepared, outbound-only Linux hostmetrics collector for Infra Control. It is **not installed or enabled on a live host**. The receiver accepts OTLP/HTTP JSON over the panel's existing HTTPS origin; it does not open an OTLP listener or add a public port.

## Payload and cadence

- CPU, memory, and network counters: collect every 30 seconds.
- Filesystem utilization: collect every 60 seconds and exclude virtual/container mounts.
- Detail samples are kept for 24 hours, with a hard limit of 5,000 rows per host. The combined 30-second and 60-second pipelines produce up to 4,320 observations/day, leaving room for scheduling jitter without unbounded growth.
- Only metrics supported by the backend parser are useful: `system.cpu.utilization`, `system.memory.utilization`, `system.memory.usage`, `system.memory.limit`, `system.filesystem.utilization`, and `system.network.io`.
- Gzip, a 10-second request timeout, bounded retry queue, durable local queue storage, and a 128 MiB collector memory limit are configured.
- Collector image is pinned to `otel/opentelemetry-collector-contrib:0.163.2`, the current patch of the v0.163 line. Its release updates the Go runtime and CA bundle; update the pin only after revalidating the config against that release.

## Enrollment contract

Each host requires a distinct random bearer token and stable `host.id`. Add only the token's SHA-256 hash to `otelCollectors`, bound to the exact resource alias/catalog ID:

```json
{
  "otelCollectors": [
    {
      "hostId": "host-home-vps",
      "resourceId": "aws:prod:i-0123456789abcdef0",
      "tokenHash": "<64-character-lowercase-sha256>"
    }
  ]
}
```

The collector sends its configured `host.id`; the backend compares it to the credential's registered identity and never trusts an identity supplied by an unauthenticated caller. Duplicate host IDs, resource IDs, or token hashes are rejected by config validation. Revoke the host by removing its entry and restarting the panel. Do not copy a token between instances or bake one into an image.

Copy `.env.example` to `.env` on the host and set the endpoint, host ID, and unique token. `.env` is ignored by Git. Keep it readable only by the operator/root and never include it in backups shared outside the host. Then validate the rendered Compose config and collector config before starting it:

```sh
docker compose -f docker-compose.yaml config --quiet
docker compose -f docker-compose.yaml run --rm --no-deps host-metrics validate --config=/etc/otelcol-contrib/collector.yaml
```

The service mounts the host root read-only, uses the host network to observe host interfaces, drops Linux capabilities, enables `no-new-privileges`, and publishes no ports. It runs as root inside the container to read mounted host metrics; this increases local privilege, so do not deploy until the isolation pilot and host-specific review pass. Never mount the Docker socket or add process scraping.

## Pilot gate

Before enrollment, validate the collector config with the pinned binary, run it against a disposable Linux VM/container and a local receiver, and measure CPU, memory, outbound bytes, scrape/export delay, and queue recovery for at least 15 minutes including a simulated disconnect. Confirm no other host identity is accepted, and verify resource visibility through REST, SSE, and read-only MCP. Do not use the Rakazo/Hermes production host as the first pilot. The checkout contains no live token, host assignment, or authorization to install this collector.
