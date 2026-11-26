//! Groups (#189), like Discord servers: a name, an owner, members, an invite
//! link, and rooms inside (they start with "geral"). They replace the fixed
//! "Block" room.
//!
//! No account needed: a member is either an account (`u:<id>`) or a browser,
//! by the hash of a random key it keeps (`d:<sha256>`, sent in the
//! `X-Cpx-Aparelho` header or the WebSocket's `?aparelho=`). Signing in moves
//! that browser's groups to the account, so they follow you elsewhere.
//!
//! A group room only lets members in (checked when the WebSocket opens), and
//! the group's owner is the room owner there (#151: lock and kick).

use axum::{
    extract::{FromRef, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{cookie, hash_token, now, off, random_hex, Contas, ContasState, Problem};

pub const DEVICE_HEADER: &str = "x-cpx-aparelho";
const NAME_MAX: usize = 32;
/// Groups one member may own, belong to, members per group, rooms per group.
const OWN_MAX: i64 = 10;
const BELONG_MAX: i64 = 50;
const MEMBERS_MAX: i64 = 200;
const ROOMS_MAX: i64 = 20;
const FIRST_ROOM: &str = "geral";

/// Who is asking: an account, or else a browser key.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    /// `u:<account id>` or `d:<hash of the browser key>`.
    pub key: String,
    /// The browser's own `d:` key, also when signed in (to claim its groups).
    pub device: Option<String>,
}

/// Whether a connection may enter a room.
#[derive(Debug, PartialEq)]
pub enum Access {
    /// Not a group room: open to whoever has the link, as before.
    Open,
    Denied,
    /// A member. Keys (hashes) for the room: this member's and the owner's.
    Member {
        key: String,
        owner: String,
    },
}

/// A browser key (32 to 64 hex) as the `d:` member key.
pub fn device_key(raw: &str) -> Option<String> {
    let ok = (32..=64).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then(|| format!("d:{}", hash_token(&raw.to_ascii_lowercase())))
}

/// A group or room name: spaces collapsed, no control characters, 1 to 32.
fn clean_name(text: &str) -> Option<String> {
    let name: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX)
        .collect();
    (!name.is_empty()).then_some(name)
}

/// The key a member has inside a room (kept by the room for kicks).
fn room_key(member: &str) -> String {
    hash_token(&format!("membro:{member}"))
}

fn db_err(_: rusqlite::Error) -> Problem {
    Problem::Database
}

impl Contas {
    /// The member behind a request: the account when signed in, else the
    /// browser key (header or `device` from a WebSocket's query).
    pub fn member(&self, headers: &HeaderMap, device: Option<&str>) -> Option<Member> {
        let device = device
            .or_else(|| headers.get(DEVICE_HEADER)?.to_str().ok())
            .and_then(device_key);
        let account = cookie(headers, super::SESSION_COOKIE)
            .and_then(|token| self.user_by_token(token))
            .map(|user| format!("u:{}", user.id));
        match (account, device) {
            (Some(key), device) => Some(Member { key, device }),
            (None, Some(key)) => Some(Member {
                device: Some(key.clone()),
                key,
            }),
            (None, None) => None,
        }
    }

    /// Signed in: this browser's groups move to the account.
    pub fn claim_device(&self, member: &Member) -> Result<(), Problem> {
        let Some(device) = member.device.as_deref().filter(|d| *d != member.key) else {
            return Ok(());
        };
        let db = self.db();
        db.execute(
            "UPDATE OR IGNORE group_members SET member = ?1 WHERE member = ?2",
            params![member.key, device],
        )
        .map_err(db_err)?;
        db.execute(
            "DELETE FROM group_members WHERE member = ?1",
            params![device],
        )
        .map_err(db_err)?;
        db.execute(
            "UPDATE groups SET owner = ?1 WHERE owner = ?2",
            params![member.key, device],
        )
        .map_err(db_err)?;
        Ok(())
    }

    fn count(&self, sql: &str, value: impl rusqlite::ToSql) -> Result<i64, Problem> {
        self.db()
            .query_row(sql, params![value], |r| r.get(0))
            .map_err(db_err)
    }

    /// Group `group` if `member` belongs to it: (name, owner key).
    fn group_of(&self, member: &Member, group: i64) -> Result<(String, String), Problem> {
        self.db()
            .query_row(
                "SELECT g.name, g.owner FROM groups g JOIN group_members m ON m.group_id = g.id
                 WHERE g.id = ?1 AND m.member = ?2",
                params![group, member.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or(Problem::NoGroup)
    }

    fn owned(&self, member: &Member, group: i64) -> Result<(), Problem> {
        let (_, owner) = self.group_of(member, group)?;
        if owner == member.key {
            Ok(())
        } else {
            Err(Problem::NotOwner)
        }
    }

    /// A new group with its first room; returns its id.
    pub fn create_group(&self, member: &Member, name: &str, nick: &str) -> Result<i64, Problem> {
        let name = clean_name(name).ok_or(Problem::BadName)?;
        if self.count("SELECT COUNT(*) FROM groups WHERE owner = ?1", &member.key)? >= OWN_MAX {
            return Err(Problem::Limit("Você já criou o máximo de 10 grupos."));
        }
        if self.count(
            "SELECT COUNT(*) FROM group_members WHERE member = ?1",
            &member.key,
        )? >= BELONG_MAX
        {
            return Err(Problem::Limit("Você já está no máximo de 50 grupos."));
        }
        let t = now();
        let mut db = self.db();
        let tx = db.transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO groups (name, owner, invite, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![name, member.key, random_hex(6), t],
        )
        .map_err(db_err)?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO group_members (group_id, member, nick, joined_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, member.key, clean_name(nick).unwrap_or_default(), t],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO group_rooms (room_id, group_id, name, position, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
            params![format!("g-{}", random_hex(8)), id, FIRST_ROOM, t],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(id)
    }

    fn rooms_json(&self, group: i64) -> Result<Vec<Value>, Problem> {
        let db = self.db();
        let mut stmt = db
            .prepare("SELECT room_id, name FROM group_rooms WHERE group_id = ?1 ORDER BY position, created_at")
            .map_err(db_err)?;
        let rooms = stmt
            .query_map(params![group], |r| {
                Ok(json!({ "id": r.get::<_, String>(0)?, "nome": r.get::<_, String>(1)? }))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rooms)
    }

    /// Every group of `member`, with its rooms.
    pub fn groups(&self, member: &Member) -> Result<Vec<Value>, Problem> {
        let list: Vec<(i64, String, String, String, i64)> = {
            let db = self.db();
            let mut stmt = db
                .prepare(
                    "SELECT g.id, g.name, g.owner, g.invite,
                            (SELECT COUNT(*) FROM group_members WHERE group_id = g.id)
                     FROM groups g JOIN group_members m ON m.group_id = g.id
                     WHERE m.member = ?1 ORDER BY m.joined_at, g.id",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![member.key], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(db_err)?
                .collect::<Result<_, _>>()
                .map_err(db_err)?;
            rows
        };
        list.into_iter()
            .map(|(id, name, owner, invite, members)| {
                Ok(json!({
                    "id": id,
                    "nome": name,
                    "dono": owner == member.key,
                    "convite": invite,
                    "membros": members,
                    "salas": self.rooms_json(id)?,
                }))
            })
            .collect()
    }

    /// One group with its members (only for members).
    pub fn group(&self, member: &Member, group: i64) -> Result<Value, Problem> {
        let (name, owner) = self.group_of(member, group)?;
        let members: Vec<Value> = {
            let db = self.db();
            let mut stmt = db
                .prepare(
                    "SELECT m.rowid, m.member, m.nick, u.username, u.nick
                     FROM group_members m LEFT JOIN users u ON m.member = 'u:' || u.id
                     WHERE m.group_id = ?1 ORDER BY m.joined_at",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![group], |r| {
                    let key: String = r.get(1)?;
                    let nick: String = r.get(2)?;
                    let username: Option<String> = r.get(3)?;
                    let account_nick: Option<String> = r.get(4)?;
                    let shown = account_nick.filter(|n| !n.is_empty()).unwrap_or(nick);
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?,
                        "nick": shown,
                        "usuario": username,
                        "dono": key == owner,
                        "voce": key == member.key,
                    }))
                })
                .map_err(db_err)?
                .collect::<Result<_, _>>()
                .map_err(db_err)?;
            rows
        };
        let invite: String = self
            .db()
            .query_row(
                "SELECT invite FROM groups WHERE id = ?1",
                params![group],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        Ok(json!({
            "id": group,
            "nome": name,
            "dono": owner == member.key,
            "convite": invite,
            "salas": self.rooms_json(group)?,
            "membros": members,
        }))
    }

    /// What an invite leads to: (group id, name, members).
    pub fn invite(&self, code: &str) -> Result<(i64, String, i64), Problem> {
        self.db()
            .query_row(
                "SELECT g.id, g.name, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id)
                 FROM groups g WHERE g.invite = ?1",
                params![code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or(Problem::NoInvite)
    }

    /// Joins the group behind an invite; returns its id.
    pub fn accept_invite(&self, member: &Member, code: &str, nick: &str) -> Result<i64, Problem> {
        let (group, _, members) = self.invite(code)?;
        let already = self.group_of(member, group).is_ok();
        if already {
            return Ok(group);
        }
        if members >= MEMBERS_MAX {
            return Err(Problem::Limit("Esse grupo já tem o máximo de 200 pessoas."));
        }
        if self.count(
            "SELECT COUNT(*) FROM group_members WHERE member = ?1",
            &member.key,
        )? >= BELONG_MAX
        {
            return Err(Problem::Limit("Você já está no máximo de 50 grupos."));
        }
        self.db()
            .execute(
                "INSERT OR IGNORE INTO group_members (group_id, member, nick, joined_at) VALUES (?1, ?2, ?3, ?4)",
                params![group, member.key, clean_name(nick).unwrap_or_default(), now()],
            )
            .map_err(db_err)?;
        Ok(group)
    }

    /// Leaves a group. The owner can't (they delete it instead).
    pub fn leave_group(&self, member: &Member, group: i64) -> Result<(), Problem> {
        let (_, owner) = self.group_of(member, group)?;
        if owner == member.key {
            return Err(Problem::Limit("Você é o dono: para sair, apague o grupo."));
        }
        self.db()
            .execute(
                "DELETE FROM group_members WHERE group_id = ?1 AND member = ?2",
                params![group, member.key],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// The owner deletes the group; returns its rooms (to close them).
    pub fn delete_group(&self, member: &Member, group: i64) -> Result<Vec<String>, Problem> {
        self.owned(member, group)?;
        let rooms = self.room_ids(group)?;
        self.db()
            .execute("DELETE FROM groups WHERE id = ?1", params![group])
            .map_err(db_err)?;
        Ok(rooms)
    }

    fn room_ids(&self, group: i64) -> Result<Vec<String>, Problem> {
        let db = self.db();
        let mut stmt = db
            .prepare("SELECT room_id FROM group_rooms WHERE group_id = ?1")
            .map_err(db_err)?;
        let ids = stmt
            .query_map(params![group], |r| r.get(0))
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        Ok(ids)
    }

    pub fn rename_group(&self, member: &Member, group: i64, name: &str) -> Result<(), Problem> {
        self.owned(member, group)?;
        let name = clean_name(name).ok_or(Problem::BadName)?;
        self.db()
            .execute(
                "UPDATE groups SET name = ?1 WHERE id = ?2",
                params![name, group],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// A new invite code: the old link stops working.
    pub fn new_invite(&self, member: &Member, group: i64) -> Result<String, Problem> {
        self.owned(member, group)?;
        let code = random_hex(6);
        self.db()
            .execute(
                "UPDATE groups SET invite = ?1 WHERE id = ?2",
                params![code, group],
            )
            .map_err(db_err)?;
        Ok(code)
    }

    /// The owner takes someone out (by the member's `id` in `group`). Returns
    /// their room key and the group's rooms, to send them out of a call.
    pub fn remove_member(
        &self,
        member: &Member,
        group: i64,
        target: i64,
    ) -> Result<(String, Vec<String>), Problem> {
        self.owned(member, group)?;
        let key: String = self
            .db()
            .query_row(
                "SELECT member FROM group_members WHERE group_id = ?1 AND rowid = ?2",
                params![group, target],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .ok_or(Problem::NoGroup)?;
        if key == member.key {
            return Err(Problem::Limit("Você é o dono do grupo."));
        }
        self.db()
            .execute(
                "DELETE FROM group_members WHERE group_id = ?1 AND rowid = ?2",
                params![group, target],
            )
            .map_err(db_err)?;
        Ok((room_key(&key), self.room_ids(group)?))
    }

    /// Your name in every group (for browsers without an account).
    pub fn set_group_nick(&self, member: &Member, nick: &str) -> Result<(), Problem> {
        let nick = clean_name(nick).ok_or(Problem::BadName)?;
        self.db()
            .execute(
                "UPDATE group_members SET nick = ?1 WHERE member = ?2",
                params![nick, member.key],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn add_room(&self, member: &Member, group: i64, name: &str) -> Result<String, Problem> {
        self.owned(member, group)?;
        let name = clean_name(name).ok_or(Problem::BadName)?;
        let (count, last): (i64, i64) = self
            .db()
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(position), 0) FROM group_rooms WHERE group_id = ?1",
                params![group],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        if count >= ROOMS_MAX {
            return Err(Problem::Limit("Um grupo pode ter até 20 salas."));
        }
        let id = format!("g-{}", random_hex(8));
        self.db()
            .execute(
                "INSERT INTO group_rooms (room_id, group_id, name, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, group, name, last + 1, now()],
            )
            .map_err(db_err)?;
        Ok(id)
    }

    fn room_group(&self, room: &str) -> Option<i64> {
        self.db()
            .query_row(
                "SELECT group_id FROM group_rooms WHERE room_id = ?1",
                params![room],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    fn owned_room(&self, member: &Member, group: i64, room: &str) -> Result<(), Problem> {
        self.owned(member, group)?;
        if self.room_group(room) == Some(group) {
            Ok(())
        } else {
            Err(Problem::NoGroup)
        }
    }

    pub fn rename_room(
        &self,
        member: &Member,
        group: i64,
        room: &str,
        name: &str,
    ) -> Result<(), Problem> {
        self.owned_room(member, group, room)?;
        let name = clean_name(name).ok_or(Problem::BadName)?;
        self.db()
            .execute(
                "UPDATE group_rooms SET name = ?1 WHERE room_id = ?2",
                params![name, room],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// Deletes a room (not the last one).
    pub fn delete_room(&self, member: &Member, group: i64, room: &str) -> Result<(), Problem> {
        self.owned_room(member, group, room)?;
        if self.count(
            "SELECT COUNT(*) FROM group_rooms WHERE group_id = ?1",
            group,
        )? <= 1
        {
            return Err(Problem::Limit("O grupo precisa de pelo menos uma sala."));
        }
        self.db()
            .execute("DELETE FROM group_rooms WHERE room_id = ?1", params![room])
            .map_err(db_err)?;
        Ok(())
    }

    /// May this connection enter `room`?
    pub fn access(&self, room: &str, member: Option<&Member>) -> Access {
        let Some(group) = self.room_group(room) else {
            return Access::Open;
        };
        let Some(member) = member else {
            return Access::Denied;
        };
        match self.group_of(member, group) {
            Ok((_, owner)) => Access::Member {
                key: room_key(&member.key),
                owner: room_key(&owner),
            },
            Err(_) => Access::Denied,
        }
    }
}

// ---------- rotas ----------

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
    crate::rooms::Rooms: FromRef<S>,
{
    Router::new()
        .route("/api/grupos", get(list).post(create))
        .route("/api/grupos/nick", put(nick))
        .route("/api/grupos/{id}", get(show).put(rename).delete(remove))
        .route("/api/grupos/{id}/sair", post(leave))
        .route("/api/grupos/{id}/convite", post(reinvite))
        .route("/api/grupos/{id}/membros/{membro}", delete(kick))
        .route("/api/grupos/{id}/salas", post(add_room))
        .route(
            "/api/grupos/{id}/salas/{sala}",
            put(rename_room).delete(remove_room),
        )
        .route("/api/convites/{codigo}", get(preview).post(accept))
}

fn no_member() -> Response {
    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Recarregue a página e tente de novo." })),
    )
        .into_response()
}

/// Runs `then` with the asking member, or answers why it can't.
fn with_member(
    contas: ContasState,
    headers: &HeaderMap,
    then: impl FnOnce(&Contas, &Member) -> Result<Value, Problem>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(member) = contas.member(headers, None) else {
        return no_member();
    };
    match then(&contas, &member) {
        Ok(body) => Json(body).into_response(),
        Err(problem) => problem.into_response(),
    }
}

#[derive(Deserialize)]
struct Named {
    nome: String,
    #[serde(default)]
    nick: String,
}

/// `GET /api/grupos` -> `{"grupos": [...]}` (and claims this browser's groups
/// for the account, when signed in).
async fn list(State(contas): State<ContasState>, headers: HeaderMap) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.claim_device(member)?;
        Ok(json!({ "grupos": contas.groups(member)? }))
    })
}

/// `POST /api/grupos {"nome", "nick"}` -> the new group.
async fn create(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Json(body): Json<Named>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        let id = contas.create_group(member, &body.nome, &body.nick)?;
        contas.group(member, id)
    })
}

#[derive(Deserialize)]
struct Nick {
    nick: String,
}

/// `PUT /api/grupos/nick {"nick"}`: your name in every group.
async fn nick(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Json(body): Json<Nick>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.set_group_nick(member, &body.nick)?;
        Ok(json!({}))
    })
}

async fn show(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    with_member(contas, &headers, |contas, member| contas.group(member, id))
}

async fn rename(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Named>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.rename_group(member, id, &body.nome)?;
        contas.group(member, id)
    })
}

async fn remove(
    State(contas): State<ContasState>,
    State(rooms): State<crate::rooms::Rooms>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        for room in contas.delete_group(member, id)? {
            rooms.close(&room);
        }
        Ok(json!({}))
    })
}

async fn leave(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.leave_group(member, id)?;
        Ok(json!({}))
    })
}

async fn reinvite(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        Ok(json!({ "convite": contas.new_invite(member, id)? }))
    })
}

async fn kick(
    State(contas): State<ContasState>,
    State(rooms): State<crate::rooms::Rooms>,
    headers: HeaderMap,
    Path((id, target)): Path<(i64, i64)>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        let (key, room_ids) = contas.remove_member(member, id, target)?;
        for room in room_ids {
            rooms.remove_key(&room, &key);
        }
        contas.group(member, id)
    })
}

async fn add_room(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Named>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.add_room(member, id, &body.nome)?;
        contas.group(member, id)
    })
}

async fn rename_room(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path((id, room)): Path<(i64, String)>,
    Json(body): Json<Named>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.rename_room(member, id, &room, &body.nome)?;
        contas.group(member, id)
    })
}

async fn remove_room(
    State(contas): State<ContasState>,
    State(rooms): State<crate::rooms::Rooms>,
    headers: HeaderMap,
    Path((id, room)): Path<(i64, String)>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.delete_room(member, id, &room)?;
        rooms.close(&room);
        contas.group(member, id)
    })
}

/// `GET /api/convites/{codigo}` -> `{"nome", "membros"}`: what you'd join.
async fn preview(State(contas): State<ContasState>, Path(code): Path<String>) -> Response {
    let Some(contas) = contas else { return off() };
    match contas.invite(&code) {
        Ok((_, name, members)) => Json(json!({ "nome": name, "membros": members })).into_response(),
        Err(problem) => problem.into_response(),
    }
}

/// `POST /api/convites/{codigo} {"nick"}` -> the group you joined.
async fn accept(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(body): Json<Nick>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        let id = contas.accept_invite(member, &code, &body.nick)?;
        contas.group(member, id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contas::tests::memory;

    fn device(n: u8) -> Member {
        let key = device_key(&format!("{n:02x}").repeat(16)).unwrap();
        Member {
            device: Some(key.clone()),
            key,
        }
    }

    #[test]
    fn create_invite_join_and_rooms() {
        let contas = memory("http://nada");
        let lucas = device(1);
        let rafa = device(2);
        let bia = device(3);
        assert_eq!(
            contas.create_group(&lucas, "   ", "Lucas"),
            Err(Problem::BadName)
        );
        let id = contas.create_group(&lucas, "Os  Cria", "Lucas").unwrap();
        let group = contas.group(&lucas, id).unwrap();
        assert_eq!(group["nome"], "Os Cria");
        assert_eq!(group["salas"][0]["nome"], "geral");
        let room = group["salas"][0]["id"].as_str().unwrap().to_owned();
        assert!(crate::rooms::valid_room_id(&room));

        // Outsiders see nothing and can't enter the room.
        assert_eq!(contas.group(&rafa, id), Err(Problem::NoGroup));
        assert_eq!(contas.access(&room, Some(&rafa)), Access::Denied);
        assert_eq!(contas.access(&room, None), Access::Denied);
        assert_eq!(contas.access("churrasco-k3f9x2", None), Access::Open);

        let code = group["convite"].as_str().unwrap();
        assert_eq!(contas.accept_invite(&rafa, code, "Rafa"), Ok(id));
        assert_eq!(
            contas.accept_invite(&rafa, code, "Rafa"),
            Ok(id),
            "twice is fine"
        );
        let Access::Member { key, owner } = contas.access(&room, Some(&rafa)) else {
            panic!("rafa is a member now");
        };
        assert_ne!(key, owner);
        assert_eq!(contas.groups(&rafa).unwrap()[0]["dono"], false);
        assert_eq!(
            contas.group(&lucas, id).unwrap()["membros"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // Only the owner manages rooms; the last one stays.
        assert_eq!(contas.add_room(&rafa, id, "jogo"), Err(Problem::NotOwner));
        let jogo = contas.add_room(&lucas, id, "jogo").unwrap();
        contas.rename_room(&lucas, id, &jogo, "valorant").unwrap();
        assert_eq!(
            contas.group(&rafa, id).unwrap()["salas"][1]["nome"],
            "valorant"
        );
        contas.delete_room(&lucas, id, &jogo).unwrap();
        assert!(matches!(
            contas.delete_room(&lucas, id, &room),
            Err(Problem::Limit(_))
        ));

        // A new invite: the old one stops working.
        let new = contas.new_invite(&lucas, id).unwrap();
        assert_eq!(
            contas.accept_invite(&bia, code, "Bia"),
            Err(Problem::NoInvite)
        );
        contas.accept_invite(&bia, &new, "Bia").unwrap();

        // The owner takes Bia out; Rafa leaves; the owner can't leave.
        let members = contas.group(&lucas, id).unwrap()["membros"].clone();
        let bia_id = members
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["nick"] == "Bia")
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        assert_eq!(
            contas.remove_member(&rafa, id, bia_id).map(|_| ()),
            Err(Problem::NotOwner)
        );
        contas.remove_member(&lucas, id, bia_id).unwrap();
        assert_eq!(contas.access(&room, Some(&bia)), Access::Denied);
        contas.leave_group(&rafa, id).unwrap();
        assert!(contas.groups(&rafa).unwrap().is_empty());
        assert!(matches!(
            contas.leave_group(&lucas, id),
            Err(Problem::Limit(_))
        ));

        assert_eq!(
            contas.delete_group(&rafa, id).map(|_| ()),
            Err(Problem::NoGroup)
        );
        assert_eq!(contas.delete_group(&lucas, id).unwrap(), vec![room.clone()]);
        assert_eq!(contas.access(&room, Some(&lucas)), Access::Open, "gone");
    }

    #[test]
    fn signing_in_takes_the_browsers_groups() {
        let contas = memory("http://nada");
        let browser = device(7);
        let id = contas.create_group(&browser, "Grupo", "Lu").unwrap();
        let user = contas.user_for_google("g-1").unwrap();
        let account = Member {
            key: format!("u:{user}"),
            device: browser.device.clone(),
        };
        contas.claim_device(&account).unwrap();
        let groups = contas.groups(&account).unwrap();
        assert_eq!((groups.len(), groups[0]["dono"].clone()), (1, json!(true)));
        assert!(contas.groups(&browser).unwrap().is_empty());

        // Deleting the account deletes the groups it owns.
        contas.delete_user(user).unwrap();
        assert_eq!(
            contas
                .invite(groups[0]["convite"].as_str().unwrap())
                .map(|g| g.0),
            Err(Problem::NoInvite)
        );
        let _ = id;
    }

    #[test]
    fn device_keys_are_checked() {
        assert!(device_key("curta").is_none());
        assert!(device_key(&"z".repeat(32)).is_none());
        let a = device_key(&"AB".repeat(16)).unwrap();
        assert_eq!(a, device_key(&"ab".repeat(16)).unwrap());
        assert!(a.starts_with("d:"));
    }
}
