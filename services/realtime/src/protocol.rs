use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROTOCOL_VERSION: u8 = 1;

const EPHEMERAL_CHANNELS: &[&str] = &[
    "typing",
    "presence.heartbeat",
    "latency.ping",
    "latency.pong",
    "bot.status",
    "simulation.telemetry",
    "moderation.risk.preview",
];

#[derive(Debug, Clone)]
pub enum Outbound {
    Reliable(String),
    Ephemeral(String),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralEnvelope {
    pub version: u8,
    pub delivery: String,
    pub channel: String,
    pub room_id: String,
    pub actor_id: Option<String>,
    pub sent_at: String,
    pub payload: Value,
}

pub fn reliable_room_event(room_id: &str, event: Value, source: &str) -> Result<String> {
    let sequence = event
        .get("sequence")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("room event is missing a string sequence"))?;

    Ok(serde_json::to_string(&json!({
        "version": PROTOCOL_VERSION,
        "delivery": "reliable",
        "channel": "room.event",
        "roomId": room_id,
        "sequence": sequence,
        "source": source,
        "event": event,
    }))?)
}

pub fn validate_ephemeral(raw: &str, expected_room_id: &str) -> Result<String> {
    let message: EphemeralEnvelope = serde_json::from_str(raw)?;

    if message.version != PROTOCOL_VERSION {
        bail!("unsupported protocol version");
    }

    if message.delivery != "ephemeral" {
        bail!("datagram delivery must be ephemeral");
    }

    if message.room_id != expected_room_id {
        bail!("datagram room does not match the session room");
    }

    if !EPHEMERAL_CHANNELS.contains(&message.channel.as_str()) {
        bail!("unsupported ephemeral channel");
    }

    Ok(serde_json::to_string(&message)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_ephemeral_channels() {
        let raw = r#"{
            "version": 1,
            "delivery": "ephemeral",
            "channel": "typing",
            "roomId": "global-lobby",
            "actorId": "human-1",
            "sentAt": "2026-07-01T00:00:00.000Z",
            "payload": {"active": true}
        }"#;

        assert!(validate_ephemeral(raw, "global-lobby").is_ok());
    }

    #[test]
    fn rejects_cross_room_datagrams() {
        let raw = r#"{
            "version": 1,
            "delivery": "ephemeral",
            "channel": "typing",
            "roomId": "other-room",
            "actorId": "human-1",
            "sentAt": "2026-07-01T00:00:00.000Z",
            "payload": {}
        }"#;

        assert!(validate_ephemeral(raw, "global-lobby").is_err());
    }
}
