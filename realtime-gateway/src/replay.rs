use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::{Outbound, reliable_room_event};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPage {
    data: Vec<Value>,
    next_cursor: String,
}

pub async fn send_replay(
    client: &Client,
    backend_url: &str,
    room_id: &str,
    after: &str,
    sender: &tokio::sync::mpsc::Sender<Outbound>,
) -> Result<()> {
    let mut cursor = after.to_owned();

    loop {
        let url = format!("{backend_url}/api/rooms/{room_id}/events?after={cursor}&limit=500");
        let page = client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json::<EventPage>()
            .await
            .context("invalid event replay response")?;
        let event_count = page.data.len();

        for event in page.data {
            sender
                .send(Outbound::Reliable(reliable_room_event(
                    room_id, event, "replay",
                )?))
                .await
                .context("realtime peer disconnected during replay")?;
        }

        if event_count < 500 || page.next_cursor == cursor {
            return Ok(());
        }

        cursor = page.next_cursor;
    }
}
