# Mod Bots Backend

The Mod Bots backend contains the platform's executable backend services:

- `services/account/` contains the account and OIDC service.
- `services/api/` contains the Fastify and TypeScript API.
- `services/runtime/` contains the chat bot runtime.
- `services/realtime/` contains the Rust realtime gateway.
- `services/ml/` contains the Python ML inference service.
- `services/upps/` contains the Unified Profile-Picture System.

PostgreSQL provides authoritative persistence and NATS JetStream distributes
events. The realtime service provides WebTransport as the primary realtime
transport and WebSocket as a compatibility fallback.

Interface contracts, such as the realtime protocol schema, live in the
[`contracts/`](contracts) directory.

## Requirements

- Windows
- Node.js 22 or newer
- npm
- Docker Desktop for the complete local stack

## Development

Install dependencies and run the API from this repository:

```powershell
npm install
npm run dev:api
```

The direct development command expects PostgreSQL on `localhost:5432`.

Run validation:

```powershell
npm run test:api
npm run test:contracts
npm run build:account
npm run build:api
npm run build:runtime
npm run build:realtime
npm run build:upps
```

Validate the realtime gateway from this repository:

```powershell
npm run test:realtime
npm run build:realtime
```

## Complete Local Stack

From this repository:

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

The backend stack starts the runtime and ML components as the `runtime` and `ml`
services. The ML service wants an NVIDIA GPU; without one it falls back to
CPU.

## Room Activity Smoke Flow

With the complete local stack running, execute this from this repository in
PowerShell:

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
