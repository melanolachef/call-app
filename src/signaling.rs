//! WebSocket endpoint: puts each connection in a room and relays its messages.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::presence::Presence;
use crate::rooms::{valid_room_id, Join, Rooms};

/// Large enough for any SDP offer/answer, small enough to bound memory.
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
/// Proxies (Fly.io's included) drop WebSockets that stay silent; a quiet room
/// sends nothing for minutes. A ping keeps it alive (browsers answer on their own).
const PING_EVERY: Duration = Duration::from_secs(25);

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

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room_id): Path<String>,
    State(rooms): State<Rooms>,
    State(presence): State<Presence>,
) -> Response {
    if !valid_room_id(&room_id) {
        return (StatusCode::BAD_REQUEST, "ID de sala inválido").into_response();
    }
    ws.max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, room_id, rooms, presence))
}

async fn handle_socket(mut socket: WebSocket, room_id: String, rooms: Rooms, presence: Presence) {
    let (tx, rx) = mpsc::unbounded_channel();
    match rooms.join(&room_id, tx) {
        Join::Full => {
            // Best effort: the browser may already be gone.
            let full = json!({ "type": "full", "max": rooms.max_peers() });
            let _ = socket.send(text(&full)).await;
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
    mut rx: mpsc::UnboundedReceiver<String>,
) -> Result<(), axum::Error> {
    let welcome = json!({ "type": "welcome", "id": id, "peers": others, "max": rooms.max_peers() });
    socket.send(text(&welcome)).await?;

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first tick is immediate
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(msg))) => {
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
            Some(msg) = rx.recv() => socket.send(Message::Text(msg.into())).await?,
            _ = ping.tick() => socket.send(Message::Ping(Default::default())).await?,
        }
    }
}

fn text(value: &Value) -> Message {
    Message::Text(value.to_string().into())
}
