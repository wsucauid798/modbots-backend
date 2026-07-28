mod hub;
mod protocol;
mod replay;

use std::env;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use async_nats::Client as NatsClient;
use axum::extract::Request;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use hub::Hub;
use protocol::{Outbound, reliable_room_event, validate_ephemeral};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use url::Url;
use wtransport::{Endpoint, Identity, ServerConfig};

#[derive(Clone)]
struct AppState {
    backend_url: String,
    certificate_hash: Vec<u8>,
    http: HttpClient,
    hub: Hub,
    public_websocket_url: String,
    public_webtransport_url: String,
}

#[derive(Debug, Deserialize)]
struct SessionQuery {
    after: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let websocket_port = env_port("WEBSOCKET_PORT", 3002)?;
    let webtransport_port = env_port("WEBTRANSPORT_PORT", 4433)?;
    let nats_url = env::var("NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".into());
    let backend_url = env::var("BACKEND_URL").unwrap_or_else(|_| "http://localhost:3001".into());
    let public_websocket_url = env::var("PUBLIC_WEBSOCKET_URL")
        .unwrap_or_else(|_| "ws://localhost:3002/v1/rooms/{roomId}".into());
    let public_webtransport_url = env::var("PUBLIC_WEBTRANSPORT_URL")
        .unwrap_or_else(|_| format!("https://localhost:{webtransport_port}/v1/rooms/{{roomId}}"));
    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
    let certificate_hash = identity
        .certificate_chain()
        .as_slice()
        .first()
        .context("generated identity has no certificate")?
        .hash();
    let state = AppState {
        backend_url,
        certificate_hash: certificate_hash.as_ref().to_vec(),
        http: HttpClient::new(),
        hub: Hub::default(),
        public_websocket_url,
        public_webtransport_url,
    };
    let nats = connect_nats(&nats_url).await;

    // Bind IPv4 explicitly: a dual-stack wildcard socket answers IPv4
    // clients from an IPv6-mapped source, which Docker's userland UDP proxy
    // fails to match back to the client's flow, so handshake replies vanish.
    let webtransport_address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, webtransport_port));

    tokio::spawn(run_nats_subscription(nats, state.hub.clone()));
    tokio::spawn(run_webtransport(
        webtransport_address,
        identity,
        state.clone(),
    ));

    let app = Router::new()
        .route("/", get(service_root))
        .route("/robots.txt", get(robots))
        .route("/health", get(health))
        .route("/v1/realtime/config", get(realtime_config))
        .route("/v1/rooms/{room_id}", get(websocket_upgrade))
        .layer(middleware::from_fn(add_noindex_header))
        .layer(CorsLayer::permissive())
        .with_state(state);
    let address = format!("0.0.0.0:{websocket_port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;

    info!(%address, "WebSocket fallback listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn service_root() -> Json<Value> {
    Json(json!({ "service": "modbots-realtime" }))
}

async fn robots() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "User-agent: *\nAllow: /\n",
    )
}

async fn add_noindex_header(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex, nofollow"),
    );
    response
}

fn env_port(name: &str, fallback: u16) -> Result<u16> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be a valid port")),
        Err(_) => Ok(fallback),
    }
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "modbots-realtime",
        "transports": {
            "webtransport": "available",
            "websocket": "available"
        }
    }))
}

async fn realtime_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "version": 1,
        "primary": {
            "transport": "webtransport",
            "url": state.public_webtransport_url,
            "serverCertificateHashes": [{
                "algorithm": "sha-256",
                "value": state.certificate_hash
            }]
        },
        "fallback": {
            "transport": "websocket",
            "url": state.public_websocket_url
        }
    }))
}

async fn websocket_upgrade(
    Path(room_id): Path<String>,
    Query(query): Query<SessionQuery>,
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| websocket_session(socket, room_id, query, state))
}

async fn websocket_session(
    socket: WebSocket,
    room_id: String,
    query: SessionQuery,
    state: AppState,
) {
    let after = query.after.unwrap_or_else(|| "0".into());
    let (peer_id, sender, mut receiver) = state.hub.register_buffering(&room_id).await;
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            let raw = match message {
                Outbound::Reliable(raw) | Outbound::Ephemeral(raw) => raw,
            };

            if socket_sender.send(Message::Text(raw.into())).await.is_err() {
                break;
            }
        }
    });

    if let Err(error) =
        replay::send_replay(&state.http, &state.backend_url, &room_id, &after, &sender).await
    {
        warn!(%error, %room_id, "WebSocket replay failed");
    }
    state.hub.activate(&room_id, peer_id).await;

    while let Some(Ok(message)) = socket_receiver.next().await {
        if let Message::Text(raw) = message {
            match validate_ephemeral(&raw, &room_id) {
                Ok(validated) => {
                    state
                        .hub
                        .broadcast(&room_id, Outbound::Ephemeral(validated))
                        .await;
                }
                Err(error) => warn!(%error, %room_id, "Rejected WebSocket ephemeral message"),
            }
        }
    }

    state.hub.remove(&room_id, peer_id).await;
    writer.abort();
}

async fn connect_nats(url: &str) -> NatsClient {
    loop {
        match async_nats::connect(url).await {
            Ok(client) => return client,
            Err(error) => {
                warn!(%error, %url, "Waiting for NATS");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn run_nats_subscription(nats: NatsClient, hub: Hub) {
    let mut subscription = match nats.subscribe("rooms.*.events.*").await {
        Ok(subscription) => subscription,
        Err(error) => {
            error!(%error, "Failed to subscribe to room events");
            return;
        }
    };

    while let Some(message) = subscription.next().await {
        let payload: Value = match serde_json::from_slice(&message.payload) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "Discarding invalid NATS room event");
                continue;
            }
        };
        let Some(room_id) = payload.get("roomId").and_then(Value::as_str) else {
            warn!("Discarding NATS event without roomId");
            continue;
        };
        let Some(event) = payload.get("event").cloned() else {
            warn!(%room_id, "Discarding NATS message without event");
            continue;
        };

        match reliable_room_event(room_id, event, "live") {
            Ok(envelope) => {
                hub.broadcast(room_id, Outbound::Reliable(envelope)).await;
            }
            Err(error) => warn!(%error, %room_id, "Discarding invalid room event"),
        }
    }
}

async fn run_webtransport(address: SocketAddr, identity: Identity, state: AppState) {
    let config = ServerConfig::builder()
        .with_bind_address(address)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(10)))
        .build();
    let endpoint = match Endpoint::server(config) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            error!(%error, "Failed to start WebTransport endpoint");
            return;
        }
    };

    info!(%address, "WebTransport listening");

    loop {
        let incoming = endpoint.accept().await;
        let state = state.clone();

        tokio::spawn(async move {
            if let Err(error) = handle_webtransport(incoming, state).await {
                warn!(%error, "WebTransport session ended");
            }
        });
    }
}

async fn handle_webtransport(
    incoming: wtransport::endpoint::IncomingSession,
    state: AppState,
) -> Result<()> {
    let request = incoming.await?;
    let parsed = Url::parse(&format!("https://localhost{}", request.path()))?;
    let Some(room_id) = parsed
        .path()
        .strip_prefix("/v1/rooms/")
        .filter(|room_id| !room_id.is_empty())
        .map(str::to_owned)
    else {
        request.not_found().await;
        bail!("unknown WebTransport path");
    };
    let after = parsed
        .query_pairs()
        .find(|(key, _)| key == "after")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| "0".into());
    let connection = request.accept().await?;
    let (peer_id, sender, mut receiver) = state.hub.register_buffering(&room_id).await;
    let writer_connection = connection.clone();
    let writer = tokio::spawn(async move {
        let mut reliable_stream = match writer_connection.open_uni().await {
            Ok(stream) => match stream.await {
                Ok(stream) => stream,
                Err(error) => {
                    warn!(%error, "Failed to initialize WebTransport reliable stream");
                    return;
                }
            },
            Err(error) => {
                warn!(%error, "Failed to open WebTransport reliable stream");
                return;
            }
        };

        while let Some(message) = receiver.recv().await {
            match message {
                Outbound::Reliable(raw) => {
                    let bytes = raw.as_bytes();
                    let Ok(length) = u32::try_from(bytes.len()) else {
                        continue;
                    };

                    if reliable_stream
                        .write_all(&length.to_be_bytes())
                        .await
                        .is_err()
                        || reliable_stream.write_all(bytes).await.is_err()
                    {
                        break;
                    }
                }
                Outbound::Ephemeral(raw) => {
                    if writer_connection.send_datagram(raw.as_bytes()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    if let Err(error) =
        replay::send_replay(&state.http, &state.backend_url, &room_id, &after, &sender).await
    {
        warn!(%error, %room_id, "WebTransport replay failed");
    }
    state.hub.activate(&room_id, peer_id).await;

    loop {
        tokio::select! {
            datagram = connection.receive_datagram() => {
                let datagram = datagram?;
                let raw = std::str::from_utf8(&datagram)?;

                match validate_ephemeral(raw, &room_id) {
                    Ok(validated) => {
                        state.hub.broadcast(
                            &room_id,
                            Outbound::Ephemeral(validated),
                        ).await;
                    }
                    Err(error) => {
                        warn!(%error, %room_id, "Rejected WebTransport datagram");
                    }
                }
            }
            _ = connection.closed() => break,
        }
    }

    state.hub.remove(&room_id, peer_id).await;
    writer.abort();
    Ok(())
}
