# Cloudflared tunnel disconnected

The cloudflared quick-tunnel that exposes the Console dev surface to the public internet has stopped serving traffic. External requests return 502 from cloudflared's edge OR the local metrics endpoint refuses connections.

## Symptoms

- Console System Health row `tunnel-reachability` is yellow or red.
- External GETs to `https://<random>.trycloudflare.com/` return 502 Bad Gateway.
- `curl http://127.0.0.1:20241/quicktunnel` returns connection refused.
- Loop tick reports include `tunnel-watchdog` exit-code lines in stderr.
- Any session that depends on the public URL (webhook callback, Telegram link preview, mobile-browser dev access) fails silently.

## Atom kinds that fire

The tunnel itself does not emit atoms; its absence is what surfaces on the Console probe. Look for the supervising script's behavior:

- `scripts/tunnel-watchdog.mjs` lifecycle log lines on stderr.
- Process table: `cloudflared` should be alive (`ps -ef | grep cloudflared` on POSIX, `tasklist | findstr cloudflared` on Windows).
- The `.lag/tunnel-allowed-origins.json` file is rewritten on every hostname rotation; staleness here mirrors a stuck supervisor.

## Recovery steps

1. Confirm the cloudflared binary is installed: `cloudflared --version`. On Windows installs the MSI puts the binary at `%ProgramFiles(x86)%\cloudflared\cloudflared.exe`; set `LAG_CLOUDFLARED_PATH` if the binary is elsewhere.
2. Probe the metrics endpoint directly: `curl http://127.0.0.1:20241/quicktunnel`. A 200 with `{ "hostname": "<random>.trycloudflare.com" }` confirms the tunnel is live; the System Health row was stale.
3. Restart the supervised stack: `node scripts/tunnel-watchdog.mjs`. The watchdog spawns the API + Vite + cloudflared trio and applies the breaker policy on repeated failure.
4. One-shot fallback (no supervision): `cloudflared tunnel --url http://localhost:9080 --no-autoupdate`. Watch stderr for the assigned `<random>.trycloudflare.com` URL.
5. Update the allowlist: when cloudflared rotates the hostname the watchdog updates `LAG_CONSOLE_ALLOWED_ORIGINS` automatically; a manual restart requires editing `.env` to include the new host or restarting the backend with the new env var set.

## Prevention follow-up

- Substrate gap: the tunnel-watchdog supervises restarts but does not emit a heartbeat atom; the System Health probe relies on cloudflared's own metrics endpoint. Wiring a `tunnel-watchdog-heartbeat` atom on every successful health-check tick would make the absence detectable from the atom store alone, not just from the live HTTP probe.
- Cloudflared `--metrics localhost:20241` is the canonical port the probe checks; if an operator runs a custom port they must set `LAG_TUNNEL_METRICS_PORT` so the probe reaches the right endpoint.
- Long-term: replace the quick-tunnel with a named tunnel (cloudflared persistent tunnel via Cloudflare dashboard) so the hostname is stable across restarts and the allowlist rotation goes away.

## Related

- Code: `scripts/tunnel-watchdog.mjs`, `scripts/lib/tunnel-watchdog.mjs`
- Console probe: `apps/console/server/system-health.ts` (probeTunnelReachability)
- Memory: `feedback_loop_must_keep_tunnel_and_servers_alive`, `feedback_tunnel_restart_needs_allowlist_update`
- Audit: `docs/audit/2026-05-22-perpetual-self-audit-v1.md` PR-7
