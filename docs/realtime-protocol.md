# Realtime Protocol

The realtime protocol is independent of its transport. WebTransport is the
primary transport and WebSocket is the compatibility fallback.

## Endpoints

- WebTransport: `https://localhost:4433/v1/rooms/{roomId}?after={sequence}`
- WebSocket: `ws://localhost:3002/v1/rooms/{roomId}?after={sequence}`
- Transport configuration: `http://localhost:3002/v1/realtime/config`
- Gateway health: `http://localhost:3002/health`

The configuration endpoint returns the development certificate SHA-256 hash
required by the browser `WebTransport` constructor.

## Reliable Delivery

Authoritative room events use reliable delivery. WebTransport sends these
events on a server-created unidirectional stream. Each frame contains a
four-byte unsigned big-endian length followed by UTF-8 JSON.

WebSocket sends the same JSON envelope as a text message.

Clients must persist the highest processed `sequence`, reconnect with `after`,
and ignore sequences they have already processed. Delivery is at least once,
so duplicate handling is required.

## Ephemeral Delivery

Signals that can be discarded use WebTransport datagrams. The WebSocket
fallback sends the same envelope as a text message.

Supported channels are:

- `typing`
- `presence.heartbeat`
- `latency.ping`
- `latency.pong`
- `bot.status`
- `simulation.telemetry`
- `moderation.risk.preview`

Ephemeral signals are not written to PostgreSQL and are not replayed.

## Contract

See [realtime-v1.schema.json](../contracts/realtime-v1.schema.json) for the
version 1 JSON envelope contract.
