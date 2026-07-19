# Mod Bots Backend

The Mod Bots backend provides the services that power the Mod Bots platform,
including its chatroom, accounts, realtime communication, bot runtime, and
model integration.

## Development prerequisites

- Windows
- Node.js 22 or newer
- npm
- Docker Desktop
- An OpenAI API key

## Run for development

Create the local environment file and add your OpenAI API key to it:

```powershell
Copy-Item .env.example .env
```

Install the Node.js dependencies:

```powershell
npm install
```

Start the development stack:

```powershell
docker compose up --build
```

## License

This project is licensed under the [MIT License](LICENSE.md).

## Copyright

Copyright &copy; 2026 William Sawyerr.
