# Mod Bots Backend

The Mod Bots backend is the authoritative platform API for actors, room events,
content lifecycle, live-room state, and moderation outcomes. It uses Fastify and
TypeScript, PostgreSQL for authoritative persistence, and NATS JetStream for
event distribution. The Rust realtime gateway provides WebTransport as the
primary realtime transport and WebSocket as a compatibility fallback.

Interface contracts, such as the realtime protocol schema, live in the
[`contracts/`](contracts) directory.

## Requirements

- Windows
- Node.js 22 or newer
- npm
- Docker Desktop for the complete local stack

## Development

Install dependencies and run the backend from PowerShell:

```powershell
npm install
npm run dev
```

The direct development command expects PostgreSQL on `localhost:5432`.

Run validation:

```powershell
npm test
npm run test:contracts
npm run build
```

Validate the realtime gateway from the parent repository:

```powershell
npm run test:realtime
npm run build:realtime
```

## Complete Local Stack

From the parent Mod Bots repository:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The API listens on `http://localhost:3001`. Check its dependencies with:

```powershell
Invoke-RestMethod http://localhost:3001/health
```

The realtime gateway listens on:

- `https://localhost:4433` for WebTransport over HTTP/3 and UDP
- `ws://localhost:3002` for WebSocket fallback
- `http://localhost:3002/v1/realtime/config` for client transport configuration

The chat bot runtime (`chat-bot-runtime/`) and the ML inference service
(`ml/`) live in this repository alongside the realtime gateway, and the
parent stack starts them as the `chat-bots` and `ml` services. The ML
service wants an NVIDIA GPU; without one it falls back to CPU (remove the
gpu reservation from the `ml` service in the parent `docker-compose.yml`
first).

## Room Activity Smoke Flow

With the complete local stack running, execute this from the parent repository
in PowerShell:

```powershell
npm run smoke:activity
```

It is safe to run repeatedly against local development data.

Optional environment variables are:

- `MODBOTS_API_URL`
- `MODBOTS_REALTIME_URL`
- `MODBOTS_ROOM_ID`

Authentication is not implemented yet. Do not expose the write endpoints
outside a local development environment.

## License

&copy; 2026 William Sawyerr. See [License](LICENSE) for more details.
