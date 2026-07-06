use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Endpoint};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayConfig {
    primary: PrimaryConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimaryConfig {
    server_certificate_hashes: Vec<CertificateHash>,
    url: String,
}

#[derive(Debug, Deserialize)]
struct CertificateHash {
    value: Vec<u8>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = reqwest::get("http://localhost:3002/v1/realtime/config")
        .await?
        .error_for_status()?
        .json::<GatewayConfig>()
        .await?;
    let hash: [u8; 32] = config
        .primary
        .server_certificate_hashes
        .first()
        .context("gateway did not provide a certificate hash")?
        .value
        .clone()
        .try_into()
        .map_err(|_| anyhow::anyhow!("gateway certificate hash is not 32 bytes"))?;
    let client_config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([Sha256Digest::new(hash)])
        .build();
    let endpoint = Endpoint::client(client_config)?;
    let url = config.primary.url.replace("{roomId}", "global-lobby");
    let connection = endpoint.connect(format!("{url}?after=0")).await?;
    let mut stream = connection.accept_uni().await?;
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).await?;
    let mut payload = vec![0_u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut payload).await?;
    let envelope: Value = serde_json::from_slice(&payload)?;

    if envelope.get("delivery").and_then(Value::as_str) != Some("reliable") {
        anyhow::bail!("WebTransport did not return a reliable envelope");
    }

    println!("{}", serde_json::to_string(&envelope)?);
    let ephemeral = serde_json::json!({
        "version": 1,
        "delivery": "ephemeral",
        "channel": "latency.ping",
        "roomId": "global-lobby",
        "actorId": "realtime-human",
        "sentAt": "2026-07-01T00:00:00.000Z",
        "payload": {"nonce": "smoke-test"}
    });
    connection.send_datagram(serde_json::to_vec(&ephemeral)?)?;
    let received: Value = serde_json::from_slice(&connection.receive_datagram().await?)?;

    if received.get("channel").and_then(Value::as_str) != Some("latency.ping") {
        anyhow::bail!("WebTransport did not return the ephemeral datagram");
    }

    println!("{}", serde_json::to_string(&received)?);
    connection.close(0_u32.into(), b"smoke test complete");
    endpoint.wait_idle().await;
    Ok(())
}
