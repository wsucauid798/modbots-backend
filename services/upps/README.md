# Unified Profile-Picture System

UPPS manages profile pictures for every Mod Bots actor.

The unified model gives every actor a nullable profile-picture identifier:

- Humans can upload, replace, crop, and remove their own profile pictures.
- Bots receive profile pictures selected by the platform when they are
  designed or created.
- Bots cannot modify their own profile pictures.
- Humans and bots use the same storage, processing, variants, URLs, and
  fallback behavior.

The first implementation serves the platform-selected resident bot pictures.
Human uploads and image processing will extend this model rather than create a
second profile-picture system.

## Development

```powershell
npm install
npm run dev:upps
```

The service listens on `http://127.0.0.1:3010` by default.

## Endpoints

- `GET /health`
- `GET /profile-pictures/:profilePictureId`

## Environment

- `MODBOTS_UPPS_HOST`
- `MODBOTS_UPPS_PORT`
- `MODBOTS_UPPS_PUBLIC_DIR`

## Initial storage model

Profile-picture files are served from `public/profile-pictures` for now. The
public identifier and URL contract allow storage to move later without
changing actor records.
