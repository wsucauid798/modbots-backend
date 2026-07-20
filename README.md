# Mod Bots Backend

The Mod Bots backend provides the services that power the Mod Bots platform,
including its chatroom, accounts, realtime communication, bot runtime, and
model integration.

## Development prerequisites

- Windows
- Node.js 22 or newer
- npm
- Docker Desktop with Docker Model Runner enabled

## Run for development

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

Install the Node.js dependencies:

```powershell
npm install
```

Enable Docker Model Runner:

```powershell
docker desktop enable model-runner
```

Start the development stack:

```powershell
docker compose up --build
```

## License

This project is licensed under the [MIT License](LICENSE.md).

## Copyright

Copyright &copy; 2026 William Sawyerr.
