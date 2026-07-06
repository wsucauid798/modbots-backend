use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::protocol::Outbound;

#[derive(Clone, Default)]
pub struct Hub {
    rooms: Arc<Mutex<HashMap<String, HashMap<Uuid, Peer>>>>,
}

struct Peer {
    sender: mpsc::Sender<Outbound>,
    active: bool,
    buffer: Vec<Outbound>,
}

impl Hub {
    pub async fn register_buffering(
        &self,
        room_id: &str,
    ) -> (Uuid, mpsc::Sender<Outbound>, mpsc::Receiver<Outbound>) {
        let id = Uuid::new_v4();
        let (sender, receiver) = mpsc::channel(1_024);
        let peer = Peer {
            sender: sender.clone(),
            active: false,
            buffer: Vec::new(),
        };

        self.rooms
            .lock()
            .await
            .entry(room_id.to_owned())
            .or_default()
            .insert(id, peer);

        (id, sender, receiver)
    }

    pub async fn activate(&self, room_id: &str, peer_id: Uuid) {
        let mut rooms = self.rooms.lock().await;
        let Some(peer) = rooms
            .get_mut(room_id)
            .and_then(|peers| peers.get_mut(&peer_id))
        else {
            return;
        };

        for message in peer.buffer.drain(..) {
            let _ = peer.sender.try_send(message);
        }

        peer.active = true;
    }

    pub async fn remove(&self, room_id: &str, peer_id: Uuid) {
        let mut rooms = self.rooms.lock().await;

        if let Some(peers) = rooms.get_mut(room_id) {
            peers.remove(&peer_id);

            if peers.is_empty() {
                rooms.remove(room_id);
            }
        }
    }

    pub async fn broadcast(&self, room_id: &str, message: Outbound) {
        let mut rooms = self.rooms.lock().await;
        let Some(peers) = rooms.get_mut(room_id) else {
            return;
        };

        peers.retain(|_, peer| {
            if peer.active {
                peer.sender.try_send(message.clone()).is_ok()
            } else {
                if peer.buffer.len() < 1_024 {
                    peer.buffer.push(message.clone());
                }
                true
            }
        });
    }
}
