//! WebSocket endpoint: puts each connection in a room and relays its messages.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::limits::{too_many, Bucket, ClientIp, Connection, Kind, Limits};
use crate::presence::Presence;
use crate::rooms::{queue, valid_room_id, Join, Rooms, Rx};

/// Large enough for any SDP offer/answer, small enough to bound memory.
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
/// Proxies (Fly.io's included) drop WebSockets that stay silent; a quiet room
/// sends nothing for minutes. A ping keeps it alive (browsers answer on their own).
const PING_EVERY: Duration = Duration::from_secs(25);
/// Messages per second one connection may send, and the burst allowed (a
/// newcomer negotiates with everyone in the room at once).
const MSG_RATE: f64 = 50.0;
const MSG_BURST: f64 = 600.0;
/// Bytes per second one connection may send, and the burst.
const BYTE_RATE: f64 = 256.0 * 1024.0;
const BYTE_BURST: f64 = 2.0 * 1024.0 * 1024.0;
/// Messages over the limit before the connection is closed.
const MAX_DROPPED: u32 = 200;

/// "Deliver `data` to participant `to`": offer, answer, ICE candidate,
/// chat… relayed untouched.
#[derive(Deserialize)]
struct ClientMsg {
    to: u32,
    data: Value,
}

/// For the server itself: "friends may see me here" (`secret` + `nick`), or
/// `null` to stop (invisible). See presence.rs.
#[derive(Deserialize)]
struct PresenceMsg {
    presence: Option<Announce>,
}

#[derive(Deserialize)]
struct Announce {
    secret: String,
    nick: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room_id): Path<String>,
    State(rooms): State<Rooms>,
    State(presence): State<Presence>,
    State(limits): State<Limits>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
) -> Response {
    if !valid_room_id(&room_id) {
        return (StatusCode::BAD_REQUEST, "ID de sala inválido").into_response();
    }
    if !limits.origin_allowed(&headers) {
        println!("[limite] conexão recusada: página de outro endereço");
        return (StatusCode::FORBIDDEN, "Origem não permitida").into_response();
    }
    if !limits.allow(Kind::Join, ip) {
        return too_many();
    }
    let slot = match limits.connect(ip) {
        Ok(slot) => slot,
        Err(why) => {
            println!("[limite] conexão recusada: {why}");
            return too_many();
        }
    };
    ws.max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, room_id, rooms, presence, slot))
}

async fn handle_socket(
    mut socket: WebSocket,
    room_id: String,
    rooms: Rooms,
    presence: Presence,
    _slot: Connection, // held until the socket ends
) {
    let (tx, rx) = queue();
    match rooms.join(&room_id, tx) {
        Join::Full => {
            // Best effort: the browser may already be gone.
            let full = json!({ "type": "full", "max": rooms.max_peers() });
            let _ = socket.send(text(&full)).await;
            let _ = socket.send(Message::Close(None)).await;
        }
        Join::ServerFull => {
            let _ = socket.send(text(&json!({ "type": "busy" }))).await;
            let _ = socket.send(Message::Close(None)).await;
        }
        Join::Joined { id, others } => {
            // An error only means the connection dropped; either way we leave.
            let _ = run(&mut socket, &rooms, &presence, &room_id, id, &others, rx).await;
            presence.forget(&room_id, id);
            rooms.leave(&room_id, id);
        }
    }
}

async fn run(
    socket: &mut WebSocket,
    rooms: &Rooms,
    presence: &Presence,
    room_id: &str,
    id: u32,
    others: &[u32],
    mut rx: Rx,
) -> Result<(), axum::Error> {
    let welcome = json!({ "type": "welcome", "id": id, "peers": others, "max": rooms.max_peers() });
    socket.send(text(&welcome)).await?;

    let mut messages = Bucket::new(MSG_RATE, MSG_BURST);
    let mut bytes = Bucket::new(BYTE_RATE, BYTE_BURST);
    let mut dropped = 0u32;
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first tick is immediate
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(msg))) => {
                    // Over the limit: dropped; far over it: disconnected.
                    if !messages.take(1.0) || !bytes.take(msg.len() as f64) {
                        dropped += 1;
                        if dropped > MAX_DROPPED {
                            println!("[limite] participante {id} mandava mensagens demais: desconectado");
                            return Ok(());
                        }
                        continue;
                    }
                    // Malformed messages are ignored rather than closing the socket.
                    if let Ok(msg) = serde_json::from_str::<ClientMsg>(msg.as_str()) {
                        rooms.relay(room_id, id, msg.to, msg.data);
                    } else if let Ok(msg) = serde_json::from_str::<PresenceMsg>(msg.as_str()) {
                        match msg.presence {
                            Some(a) => presence.announce(room_id, id, &a.secret, &a.nick),
                            None => presence.forget(room_id, id),
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(err)) => return Err(err),
                Some(Ok(_)) => {} // binary/ping/pong
            },
            queued = rx.recv() => match queued {
                Some(msg) => socket.send(Message::Text(msg.into())).await?,
                // Dropped by the room (it stopped reading its queue).
                None => return Ok(()),
            },
            _ = ping.tick() => socket.send(Message::Ping(Default::default())).await?,
        }
    }
}

fn text(value: &Value) -> Message {
    Message::Text(value.to_string().into())
}
