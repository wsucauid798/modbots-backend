# Mod Bots Account

The account surface for Mod Bots at modbots.ai: sign in, create an account,
and the OIDC hand-off that signs clients in through the browser. Built with
Fastify, TypeScript, server-rendered Nunjucks pages, Tailwind, and
oidc-provider, backed by the platform backend's identity store.

## Requirements

- Windows
- Node.js 22 or newer
- npm
- The Mod Bots backend stack running from the backend repository (PostgreSQL
  holds the identities; Redis holds OIDC state)

## Development

Install dependencies and run from the backend repository:

```powershell
npm install
npm run dev:account
```

The service listens on `http://localhost:3003` and expects the backend API
on `http://localhost:3001` and Redis on `localhost:6379`. Override with the
`PORT`, `BACKEND_URL`, `REDIS_URL`, `ACCOUNT_ISSUER`, `COOKIE_SECRET`, and
`DESKTOP_REDIRECT_URI` environment variables.

## Build

```powershell
npm run build:account
npm run start:account
```

## Complete Local Stack

From the backend repository:

```powershell
docker compose up --build
```

The account service is part of the stack and listens on
`http://localhost:3003`.

## License

&copy; 2026 William Sawyerr. See [License](LICENSE.md) for more details.
