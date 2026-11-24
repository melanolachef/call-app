//! In-memory rooms: who is in each one and how to reach them.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Room size when `MAX_PEERS` is not set. In a mesh, whoever shares encodes
/// once per viewer, so much bigger rooms would need a media server (SFU).
pub const DEFAULT_MAX_PEERS: usize = 12;

/// Rooms open at once on the whole server.
pub const DEFAULT_MAX_ROOMS: usize = 1000;
/// Messages waiting for one participant. A browser reads them right away; a
/// connection that lets this many pile up isn't reading and gets dropped,
/// so a stuck client can't grow the server's memory without limit.
pub const QUEUE: usize = 256;

/// Sends text messages to one participant's WebSocket task.
pub type Tx = mpsc::Sender<String>;
pub type Rx = mpsc::Receiver<String>;

/// A participant's queue: the sending half goes in the room, the other to its task.
pub fn queue() -> (Tx, Rx) {
    mpsc::channel(QUEUE)
}

#[derive(Default)]
struct Room {
    next_id: u32,
    peers: HashMap<u32, Tx>,
}

/// All rooms, shared between connections. Cloning only clones the `Arc`.
#[derive(Clone)]
pub struct Rooms {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    max_peers: usize,
    max_rooms: usize,
}

impl Default for Rooms {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PEERS)
    }
}

/// Outcome of trying to enter a room.
#[derive(Debug, PartialEq)]
pub enum Join {
    /// Entered as participant `id`; `others` were already in the room.
    Joined {
        id: u32,
        others: Vec<u32>,
    },
    Full,
    /// Too many rooms on the server: no new one can open now.
    ServerFull,
}

impl Rooms {
    pub fn new(max_peers: usize) -> Self {
        Self::with_max_rooms(max_peers, DEFAULT_MAX_ROOMS)
    }

    pub fn with_max_rooms(max_peers: usize, max_rooms: usize) -> Self {
        Self {
            rooms: Arc::default(),
            max_peers,
            max_rooms,
        }
    }

    pub fn max_peers(&self) -> usize {
        self.max_peers
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Room>> {
        // Every change under the lock is a single insert/remove, so a panic
        // elsewhere can't leave the map half-updated: just keep using it.
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a participant to the room (creating the room if needed) and tells
    /// the others about it.
    pub fn join(&self, room_id: &str, tx: Tx) -> Join {
        let (id, others, count) = {
            let mut rooms = self.lock();
            if !rooms.contains_key(room_id) && rooms.len() >= self.max_rooms {
                drop(rooms);
                println!("[limite] sala nova recusada: salas demais no servidor");
                return Join::ServerFull;
            }
            let room = rooms.entry(room_id.to_owned()).or_default();
            if room.peers.len() >= self.max_peers {
                drop(rooms);
                println!("[sala {}] entrada recusada: sala cheia", short(room_id));
                return Join::Full;
            }
            room.next_id += 1;
            let id = room.next_id;
            let others: Vec<(u32, Tx)> = room
                .peers
                .iter()
                .map(|(&peer_id, peer_tx)| (peer_id, peer_tx.clone()))
                .collect();
            room.peers.insert(id, tx);
            (id, others, room.peers.len())
        };

        // Sent before join() returns, hence before the newcomer's welcome and
        // before any offer it could send: the others always learn of it first.
        self.broadcast(room_id, &others, &json!({ "type": "peer-joined", "id": id }));
        println!(
            "[sala {}] participante {id} entrou ({count}/{})",
            short(room_id),
            self.max_peers
        );
        Join::Joined {
            id,
            others: others.into_iter().map(|(peer_id, _)| peer_id).collect(),
        }
    }

    /// How many people are in each room; rooms that don't exist count 0.
    pub fn counts<'a>(&self, ids: &[&'a str]) -> Vec<(&'a str, usize)> {
        let rooms = self.lock();
        ids.iter()
            .map(|&id| (id, rooms.get(id).map_or(0, |room| room.peers.len())))
            .collect()
    }

    /// Delivers `data` from `from` to participant `to` of the same room.
    /// Unknown recipients are ignored.
    pub fn relay(&self, room_id: &str, from: u32, to: u32, data: Value) {
        let target = self
            .lock()
            .get(room_id)
            .and_then(|room| room.peers.get(&to))
            .cloned();
        if let Some(tx) = target {
            let msg = json!({ "type": "signal", "from": from, "data": data });
            self.deliver(room_id, to, &tx, msg.to_string());
        }
    }

    /// Queues `msg` for one participant. A full queue means it stopped
    /// reading: it leaves the room, which closes its connection (its task
    /// sees the queue end) and tells the others.
    fn deliver(&self, room_id: &str, id: u32, tx: &Tx, msg: String) {
        if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(msg) {
            let removed = self
                .lock()
                .get_mut(room_id)
                .and_then(|room| room.peers.remove(&id))
                .is_some();
            if removed {
                println!("[sala {}] participante {id} não lia as mensagens: desconectado", short(room_id));
            }
        }
    }

    fn broadcast(&self, room_id: &str, peers: &[(u32, Tx)], msg: &Value) {
        let msg = msg.to_string();
        for (id, tx) in peers {
            // A closed channel just means that participant is leaving right now.
            self.deliver(room_id, *id, tx, msg.clone());
        }
    }

    /// Removes a participant, tells the others and deletes the room once empty.
    pub fn leave(&self, room_id: &str, id: u32) {
        let remaining: Vec<(u32, Tx)> = {
            let mut rooms = self.lock();
            let Some(room) = rooms.get_mut(room_id) else {
                return;
            };
            room.peers.remove(&id);
            let remaining = room
                .peers
                .iter()
                .map(|(&peer_id, peer_tx)| (peer_id, peer_tx.clone()))
                .collect();
            if room.peers.is_empty() {
                rooms.remove(room_id);
            }
            remaining
        };

        self.broadcast(room_id, &remaining, &json!({ "type": "peer-left", "id": id }));
        println!(
            "[sala {}] participante {id} saiu ({}/{})",
            short(room_id),
            remaining.len(),
            self.max_peers
        );
        if remaining.is_empty() {
            println!("[sala {}] vazia, apagada", short(room_id));
        }
    }
}

/// Room IDs come from the URL: 1 to 64 characters of `[A-Za-z0-9_-]`.
pub fn valid_room_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Short prefix of the room ID for logs, so the full link never lands in them.
fn short(id: &str) -> &str {
    id.get(..6).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> (Tx, Rx) {
        queue()
    }

    fn next(rx: &mut Rx) -> Value {
        serde_json::from_str(&rx.try_recv().expect("expected a message")).unwrap()
    }

    #[test]
    fn join_numbers_participants_and_notifies_others() {
        let rooms = Rooms::default();
        let (tx1, mut rx1) = peer();
        let (tx2, mut rx2) = peer();

        assert_eq!(
            rooms.join("r", tx1),
            Join::Joined {
                id: 1,
                others: vec![]
            }
        );
        assert_eq!(
            rooms.join("r", tx2),
            Join::Joined {
                id: 2,
                others: vec![1]
            }
        );
        assert_eq!(next(&mut rx1), json!({ "type": "peer-joined", "id": 2 }));
        assert!(rx2.try_recv().is_err());
    }

    #[test]
    fn rooms_are_independent() {
        let rooms = Rooms::default();
        let (tx1, mut rx1) = peer();
        rooms.join("a", tx1);
        assert_eq!(
            rooms.join("b", peer().0),
            Join::Joined {
                id: 1,
                others: vec![]
            }
        );
        assert!(rx1.try_recv().is_err());
    }

    #[test]
    fn room_is_full_after_max_peers() {
        for max in [3, DEFAULT_MAX_PEERS] {
            let rooms = Rooms::new(max);
            assert_eq!(rooms.max_peers(), max);
            let receivers: Vec<_> = (0..max)
                .map(|_| {
                    let (tx, rx) = peer();
                    assert!(matches!(rooms.join("r", tx), Join::Joined { .. }));
                    rx
                })
                .collect();
            assert_eq!(rooms.join("r", peer().0), Join::Full);
            drop(receivers);
        }
    }

    #[test]
    fn default_allows_more_than_six() {
        assert_eq!(Rooms::default().max_peers(), DEFAULT_MAX_PEERS);
        const _: () = assert!(DEFAULT_MAX_PEERS > 6);
    }

    #[test]
    fn relay_reaches_only_the_target() {
        let rooms = Rooms::default();
        let (tx1, mut rx1) = peer();
        let (tx2, mut rx2) = peer();
        let (tx3, mut rx3) = peer();
        rooms.join("r", tx1);
        rooms.join("r", tx2);
        rooms.join("r", tx3);
        while rx1.try_recv().is_ok() {}
        while rx2.try_recv().is_ok() {}

        rooms.relay("r", 3, 1, json!({ "sharing": true }));
        rooms.relay("r", 3, 99, json!("ignored"));
        rooms.relay("other-room", 3, 2, json!("ignored"));

        assert_eq!(
            next(&mut rx1),
            json!({ "type": "signal", "from": 3, "data": { "sharing": true } })
        );
        assert!(rx2.try_recv().is_err());
        assert!(rx3.try_recv().is_err());
    }

    #[test]
    fn leave_notifies_others_and_deletes_empty_room() {
        let rooms = Rooms::default();
        let (tx1, mut rx1) = peer();
        rooms.join("r", tx1);
        rooms.join("r", peer().0);
        let _ = rx1.try_recv(); // peer-joined

        rooms.leave("r", 2);
        assert_eq!(next(&mut rx1), json!({ "type": "peer-left", "id": 2 }));

        rooms.leave("r", 1);
        // The room is gone, so numbering starts over.
        assert_eq!(
            rooms.join("r", peer().0),
            Join::Joined {
                id: 1,
                others: vec![]
            }
        );
    }

    #[test]
    fn no_new_rooms_past_the_limit() {
        let rooms = Rooms::with_max_rooms(4, 2);
        let (a, _ra) = peer();
        let (b, _rb) = peer();
        let (c, _rc) = peer();
        rooms.join("a", a);
        rooms.join("b", b);
        assert_eq!(rooms.join("c", peer().0), Join::ServerFull);
        // Existing rooms still take people.
        assert!(matches!(rooms.join("a", c), Join::Joined { .. }));
    }

    #[test]
    fn a_participant_that_stops_reading_is_dropped() {
        let rooms = Rooms::default();
        let (tx1, _stuck) = peer(); // never read
        let (tx2, mut rx2) = peer();
        rooms.join("r", tx1);
        rooms.join("r", tx2);
        for _ in 0..=QUEUE {
            rooms.relay("r", 2, 1, json!("spam"));
        }
        assert_eq!(rooms.counts(&["r"]), vec![("r", 1)]);
        assert!(rx2.try_recv().is_err(), "the other participant is untouched");
    }

    #[test]
    fn counts_people_per_room() {
        let rooms = Rooms::default();
        rooms.join("a", peer().0);
        rooms.join("a", peer().0);
        rooms.join("b", peer().0);
        assert_eq!(
            rooms.counts(&["a", "b", "nobody"]),
            vec![("a", 2), ("b", 1), ("nobody", 0)]
        );
    }

    #[test]
    fn room_id_validation() {
        assert!(valid_room_id("e45aa6c6740577e0"));
        assert!(valid_room_id("abc-DEF_123"));
        assert!(!valid_room_id(""));
        assert!(!valid_room_id("bad!id"));
        assert!(!valid_room_id("ção"));
        assert!(!valid_room_id(&"a".repeat(65)));
    }

    #[test]
    fn short_never_panics() {
        assert_eq!(short("e45aa6c6740577e0"), "e45aa6");
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("ççç"), "ççç");
    }
}
