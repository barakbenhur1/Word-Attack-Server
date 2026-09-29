# Word-Attack-Server / WordZap backend

The legacy production backend is the Node/Express + MongoDB + Socket.IO service
in the repository root. Its Render free instance is currently a rollback source,
not the target architecture.

The replacement backend lives in `cloudflare/` and is designed to keep the
production service off Render:

- Cloudflare Worker for HTTP APIs.
- Cloudflare D1 for profiles, game state, leaderboards, premium scores, device
  tokens, and PVP shared words.
- SQLite Durable Object + WebSocket Hibernation for PVP matchmaking and live
  turns/typing.
- Workers AI for `/ai/aiGuess`, with strict Wordle validation and a
  Wikipedia-backed constrained fallback.
- APNs push delivery directly from the Worker.

## Verification

Fast source checks:

```bash
npm --prefix cloudflare run check
npm --prefix cloudflare run verify:static
```

The GitHub `Cloudflare backend checks` workflow also starts a real local
Wrangler/workerd runtime, creates a local D1 database, and exercises health,
readiness, matchmaking, shared PVP words, coin flip, typing, turn switching, and
match cleanup.

## Production deployment

Production provisioning is intentionally parallel to Render. The iOS app keeps
the legacy URL until Cloudflare has passed live acceptance and existing data has
been migrated.

See:

```
cloudflare/CLOUDFLARE_MIGRATION.md
```

A one-command provisioner is available:

```bash
npm --prefix cloudflare run provision:deploy
```

It requires a Cloudflare API token in the environment and does not print the
token. A manual GitHub Actions workflow named `Deploy WordZap Cloudflare` is
also included for repositories configured with `CLOUDFLARE_API_TOKEN` and,
when needed, `CLOUDFLARE_ACCOUNT_ID`.

Do not commit `wrangler.toml`, `.dev.vars`, generated migration SQL, APNs
private keys, or Cloudflare credentials.
