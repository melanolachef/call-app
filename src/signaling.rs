//! WebSocket endpoint: puts each connection in a room and relays its messages.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, RawQuery, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};

use std::sync::Arc;

use crate::contas::Contas;
use crate::ice::Ice;
use crate::limits::{too_many, Bucket, ClientIp, Connection, Kind, Limits};
use crate::presence::Presence;
use crate::rooms::{queue, valid_room_id, Admin, Join, Rooms, Rx};
use sha2::{Digest, Sha256};

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

/// For the server: the room owner's commands (#151), `{"admin": {"kick": 3}}`
/// or `{"admin": {"lock": true}}`. Only the owner's are obeyed.
#[derive(Deserialize)]
struct AdminMsg {
    admin: AdminCmd,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AdminCmd {
    Kick(u32),
    Lock(bool),
}

/// The owner key a browser keeps for this room (`?dono=`, 32 to 64 hex), as
/// a hash: the raw key never stays on the server.
fn owner_key(query: Option<&str>) -> Option<String> {
    let key = query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("dono="))?;
    let ok = (32..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then(|| {
        Sha256::digest(key.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    })
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
    RawQuery(query): RawQuery,
    State(rooms): State<Rooms>,
    State(presence): State<Presence>,
    State(ice): State<Arc<Ice>>,
    State(limits): State<Limits>,
    State(contas): State<Option<Arc<Contas>>>,
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
    // Signed in: friends with an account see this room too (same rules as
    // friend codes: only while here, and not when invisible).
    let account = contas.and_then(|c| c.account_id(&headers).map(|id| (c, id)));
    let key = owner_key(query.as_deref());
    ws.max_message_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| {
            handle_socket(socket, room_id, rooms, presence, ice, slot, account, key)
        })
}

#[allow(clippy::too_many_arguments)]
async fn handle_socket(
    mut socket: WebSocket,
    room_id: String,
    rooms: Rooms,
    presence: Presence,
    ice: Arc<Ice>,
    _slot: Connection, // held until the socket ends
    account: Option<(Arc<Contas>, i64)>,
    key: Option<String>,
) {
    let (tx, rx) = queue();
    match rooms.join_as(&room_id, tx, key) {
        Join::Locked => {
            let _ = socket.send(text(&json!({ "type": "locked" }))).await;
            let _ = socket.send(Message::Close(None)).await;
        }
        Join::Kicked => {
            let _ = socket.send(text(&json!({ "type": "kicked" }))).await;
            let _ = socket.send(Message::Close(None)).await;
        }
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
            // TURN credentials only reach people inside a room (#150): the
            // HTTP endpoint gives STUN only, so a script can't just ask for them.
            let servers = ice.servers().await;
            let _ = run(
                &mut socket,
                &rooms,
                &presence,
                &room_id,
                id,
                &others,
                &servers,
                account.as_ref(),
                rx,
            )
            .await;
            presence.forget(&room_id, id);
            if let Some((contas, _)) = &account {
                contas.absent(&room_id, id);
            }
            rooms.leave(&room_id, id);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    socket: &mut WebSocket,
    rooms: &Rooms,
    presence: &Presence,
    room_id: &str,
    id: u32,
    others: &[u32],
    ice: &Value,
    account: Option<&(Arc<Contas>, i64)>,
    mut rx: Rx,
) -> Result<(), axum::Error> {
    let state = rooms.state(room_id);
    let welcome = json!({ "type": "welcome", "id": id, "peers": others, "max": rooms.max_peers(), "ice": ice,
        "owner": state["owner"], "locked": state["locked"] });
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
                    } else if let Ok(msg) = serde_json::from_str::<AdminMsg>(msg.as_str()) {
                        let action = match msg.admin {
                            AdminCmd::Kick(target) => Admin::Kick(target),
                            AdminCmd::Lock(locked) => Admin::Lock(locked),
                        };
                        rooms.admin(room_id, id, action);
                    } else if let Ok(msg) = serde_json::from_str::<PresenceMsg>(msg.as_str()) {
                        match msg.presence {
                            Some(a) => {
                                presence.announce(room_id, id, &a.secret, &a.nick);
                                if let Some((contas, user)) = account {
                                    contas.present(room_id, id, *user);
                                }
                            }
                            None => {
                                presence.forget(room_id, id);
                                if let Some((contas, _)) = account {
                                    contas.absent(room_id, id);
                                }
                            }
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

/// `GET /ws/presenca`: the page is open (lobby, the Windows app) for the
/// signed-in account, so friends see "online" (#158). Nothing is sent; the
/// page closes it to go invisible. Same checks as joining a room.
pub async fn presence_handler(
    ws: WebSocketUpgrade,
    State(limits): State<Limits>,
    State(contas): State<Option<Arc<Contas>>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
) -> Response {
    let Some(contas) = contas else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Cheap checks first: only then ask the database who this is.
    if !limits.origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Origem não permitida").into_response();
    }
    if !limits.allow(Kind::Join, ip) {
        return too_many();
    }
    let Some(user) = contas.account_id(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(slot) = limits.connect(ip) else {
        return too_many();
    };
    ws.max_message_size(1024).on_upgrade(move |mut socket| async move {
        let _slot = slot;
        contas.came_online(user);
        // Direct messages arrive here while the page is open (#180).
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
        let listener = contas.listen(user, tx);
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {} // nothing to say; pongs land here too
                },
                Some(msg) = rx.recv() => if socket.send(Message::Text(msg.into())).await.is_err() { break },
                _ = ping.tick() => if socket.send(Message::Ping(Default::default())).await.is_err() { break },
            }
        }
        contas.stop_listening(user, listener);
        contas.went_away(user);
    })
}

fn text(value: &Value) -> Message {
    Message::Text(value.to_string().into())
}
