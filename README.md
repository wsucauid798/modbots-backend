# Mod Bots Backend

![Version: 0.0.1-alpha](https://img.shields.io/badge/version-0.0.1--alpha-14b8a6)
![Branch: release/v0.0.1-alpha](https://img.shields.io/badge/branch-release%2Fv0.0.1--alpha-64748b)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
[![Backend Pipeline](https://github.com/wsucauid798/modbots-backend/actions/workflows/ci.yml/badge.svg?branch=release/v0.0.1-alpha)](https://github.com/wsucauid798/modbots-backend/actions/workflows/ci.yml)
![Node.js 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![Rust 1.93.0](https://img.shields.io/badge/rust-1.93.0-000000?logo=rust&logoColor=white)
![Docker](https://img.shields.io/badge/run-Docker-2496ED?logo=docker&logoColor=white)

The Mod Bots Backend provides the services that power the Mod Bots platform,
including its chatroom, accounts, bot runtime, model integration and real-time communication.

## Prerequisites

- Docker Desktop

## Run

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

Enable Docker Model Runner:

```powershell
docker desktop enable model-runner
```

Start the stack:

```powershell
docker compose up --build
```

## License

Mod Bots Backend is licensed under the [MIT License](LICENSE.md).

## Copyright

Copyright &copy; 2026 William Sawyerr.
