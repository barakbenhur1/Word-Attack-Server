# WordZap Cloudflare production migration

This is the parallel production target that replaces the suspended Render web
service without changing the iOS production URL until acceptance passes.

## Architecture

- HTTP API: Cloudflare Worker
- Durable application data: Cloudflare D1
- PVP matchmaking / turns / typing: Durable Object + WebSocket Hibernation
- AI guesses: Workers AI, with Wordle validation and a Wikipedia fallback
- Random game words: Wikipedia API from the Worker
- Legacy Render service: rollback-only until final cutover, then left off

The existing Render application remains untouched by the Cloudflare files under
`cloudflare/`.

## Implemented compatibility surface

The Worker currently implements:

- `GET /healthz`, `GET /health`, `GET /ready`
- `POST /login`
- `POST /login/isLoggedin`
- `POST /login/changeLanguage`
- `POST /login/gender`
- `POST /words/word`
- `POST /words/getWord`
- `POST /words/addGuess`
- `POST /score/score`
- `POST /score/getScore`
- `POST /score/scoreboard`
- `POST /score/place`
- `POST /score/premiumScore`
- `POST /score/getPremiumScore`
- `POST /score/getAllPremiumScores`
- `POST /devices/register`
- `GET /pvp/word`
- `GET /ai/health`
- `POST /ai/aiGuess`
- `POST /ai/guess`
- `GET /pvp/socket` WebSocket upgrade

The PVP Worker preserves the app-level events used by the current server:
`pvp:queue:join`, `pvp:queue:waiting`, `pvp:matchFound`, `pvp:join`,
`pvp:coinflip`, `pvp:coinflipResult`, `pvp:typing`, `pvp:rowDone`,
`pvp:turn`, `pvp:queue:leave`, and `pvp:opponentLeft`.

The transport is native WebSocket JSON rather than Socket.IO. The iOS cutover
must therefore switch its PVP transport only after the Worker is deployed.

## Local/static verification

```bash
npm --prefix cloudflare run check
npm --prefix cloudflare run verify:static
```

GitHub Actions runs the same checks for every Cloudflare change.

## Provisioning

Do not commit the generated `wrangler.toml`.

```bash
cd cloudflare
cp wrangler.toml.example wrangler.toml

npx wrangler@latest d1 create wordzap
# Put the returned database_id into wrangler.toml.

npx wrangler@latest d1 execute wordzap --remote --file schema.sql
npx wrangler@latest deploy
```

After deployment:

```bash
curl -sS https://YOUR-WORKER.workers.dev/healthz | python3 -m json.tool
curl -sS https://YOUR-WORKER.workers.dev/ready | python3 -m json.tool
```

Acceptance requires `ok: true`, `storage: d1`, and
`pvp: durable-object-websocket`.

## Data migration gate

Production cutover must not happen with an empty D1 database. Existing MongoDB
profiles, leaderboard history, premium scores, game state and device
registrations need to be migrated or deliberately retired field-by-field.

The MongoDB Atlas ChatGPT connector currently cannot read this Atlas
organization because AI-client access is disabled at organization level. This
does not block implementation, but it blocks an automatic data copy from this
chat until an Organization Owner enables that access or the data is exported
through another approved route.

## Remaining production gates

1. Provision the D1 database and deploy the Worker.
2. Run live HTTP/AI/PVP smoke tests.
3. Migrate the existing MongoDB production data to D1 and compare counts.
4. Port the iOS PVP transport from Socket.IO to the Worker native WebSocket
   event envelope.
5. Change the iOS base URL only after all acceptance checks pass.
6. Verify two real devices through matchmaking, shared word, coin flip, typing,
   turn switching, opponent leave and rematch.
7. Keep Render off after the rollback window.

No paid Render upgrade is required for this target.
