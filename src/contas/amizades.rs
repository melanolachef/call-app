//! Friendships between accounts (#157): ask by exact @username, the other
//! person accepts. Nobody is ever listed or searched by part of a name. Also
//! where account friends are right now (in memory, while they are in a room
//! and not invisible; see signaling.rs).

use std::{collections::HashMap, time::Instant};

use axum::{
    extract::{FromRef, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{clean_username, current, now, off, signed_out, Contas, ContasState, Problem, User};
use crate::rooms::Rooms;

/// Requests one account may have waiting for an answer.
const MAX_PENDING: i64 = 50;

/// Where an account's connections are: (room, participant) -> (account, since).
pub type Online = HashMap<(String, u32), (i64, Instant)>;

/// How two accounts relate, from the point of view of the one asking.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Relation {
    Friend,
    /// They asked me.
    Received,
    /// I asked them.
    Sent,
    None,
    Me,
}

impl Relation {
    fn name(self) -> &'static str {
        match self {
            Relation::Friend => "amigo",
            Relation::Received => "recebido",
            Relation::Sent => "enviado",
            Relation::None => "nenhuma",
            Relation::Me => "voce",
        }
    }
}

fn pair(a: i64, b: i64) -> (i64, i64) {
    (a.min(b), a.max(b))
}

impl Contas {
    pub fn user_by_username(&self, username: &str) -> Option<User> {
        let username = clean_username(username)?;
        self.db()
            .query_row(
                "SELECT id, username, nick FROM users WHERE username = ?1",
                params![username],
                |r| {
                    Ok(User {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        nick: r.get(2)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn relation(&self, me: i64, other: i64) -> Relation {
        if me == other {
            return Relation::Me;
        }
        let (a, b) = pair(me, other);
        let row: Option<(i64, Option<i64>)> = self
            .db()
            .query_row(
                "SELECT requested_by, accepted_at FROM friendships WHERE user_a = ?1 AND user_b = ?2",
                params![a, b],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten();
        match row {
            None => Relation::None,
            Some((_, Some(_))) => Relation::Friend,
            Some((by, None)) if by == me => Relation::Sent,
            Some(_) => Relation::Received,
        }
    }

    /// Asks `username` to be friends. If they had already asked, it's mutual:
    /// you become friends right away.
    pub fn request(&self, me: &User, username: &str) -> Result<Relation, Problem> {
        if me.username.is_none() {
            return Err(Problem::NeedUsername);
        }
        let other = self.user_by_username(username).ok_or(Problem::NotFound)?;
        match self.relation(me.id, other.id) {
            Relation::Me => Err(Problem::SelfFriend),
            Relation::Friend | Relation::Sent => Ok(self.relation(me.id, other.id)),
            Relation::Received => {
                self.accept(me.id, other.id)?;
                Ok(Relation::Friend)
            }
            Relation::None => {
                let db = self.db();
                let pending: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM friendships WHERE requested_by = ?1 AND accepted_at IS NULL",
                        params![me.id],
                        |r| r.get(0),
                    )
                    .map_err(|_| Problem::Database)?;
                if pending >= MAX_PENDING {
                    return Err(Problem::TooManyRequests);
                }
                let (a, b) = pair(me.id, other.id);
                db.execute(
                    "INSERT INTO friendships (user_a, user_b, requested_by, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![a, b, me.id, now()],
                )
                .map_err(|_| Problem::Database)?;
                Ok(Relation::Sent)
            }
        }
    }

    /// Accepts a request that `other` sent to `me`.
    pub fn accept(&self, me: i64, other: i64) -> Result<(), Problem> {
        let (a, b) = pair(me, other);
        let changed = self
            .db()
            .execute(
                "UPDATE friendships SET accepted_at = ?1 WHERE user_a = ?2 AND user_b = ?3 AND requested_by = ?4 AND accepted_at IS NULL",
                params![now(), a, b, other],
            )
            .map_err(|_| Problem::Database)?;
        if changed == 0 {
            return Err(Problem::NotFound);
        }
        Ok(())
    }

    /// Unfriends, cancels a sent request or declines a received one.
    pub fn unfriend(&self, me: i64, other: i64) -> Result<(), Problem> {
        let (a, b) = pair(me, other);
        self.db()
            .execute(
                "DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2",
                params![a, b],
            )
            .map_err(|_| Problem::Database)?;
        Ok(())
    }

    /// Everyone tied to `me`, with how.
    pub fn friendships(&self, me: i64) -> Result<Vec<(User, Relation)>, Problem> {
        let db = self.db();
        let mut stmt = db
            .prepare(
                "SELECT u.id, u.username, u.nick, f.requested_by, f.accepted_at
                 FROM friendships f
                 JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
                 WHERE f.user_a = ?1 OR f.user_b = ?1
                 ORDER BY lower(coalesce(nullif(u.nick, ''), u.username))",
            )
            .map_err(|_| Problem::Database)?;
        let rows = stmt
            .query_map(params![me], |r| {
                let user = User {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    nick: r.get(2)?,
                };
                let by: i64 = r.get(3)?;
                let accepted: Option<i64> = r.get(4)?;
                let relation = match accepted {
                    Some(_) => Relation::Friend,
                    None if by == me => Relation::Sent,
                    None => Relation::Received,
                };
                Ok((user, relation))
            })
            .map_err(|_| Problem::Database)?;
        rows.collect::<Result<_, _>>()
            .map_err(|_| Problem::Database)
    }

    // ---------- presença (em memória) ----------

    fn online(&self) -> std::sync::MutexGuard<'_, Online> {
        self.online
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// This room connection belongs to account `user` (and isn't invisible).
    pub fn present(&self, room: &str, conn: u32, user: i64) {
        self.online()
            .entry((room.to_owned(), conn))
            .and_modify(|seen| seen.0 = user)
            .or_insert((user, Instant::now()));
    }

    /// Left the room, or went invisible.
    pub fn absent(&self, room: &str, conn: u32) {
        self.online().remove(&(room.to_owned(), conn));
    }

    /// The page is open somewhere (lobby, app) for account `user`. Counted,
    /// so two tabs don't cancel each other; `went_away` undoes it.
    pub fn came_online(&self, user: i64) {
        *self
            .lobby
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(user)
            .or_default() += 1;
    }

    pub fn went_away(&self, user: i64) {
        let mut lobby = self
            .lobby
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = lobby.get_mut(&user) {
            *count -= 1;
            if *count == 0 {
                lobby.remove(&user);
            }
        }
    }

    /// Online: the page open somewhere, or in a room (not invisible).
    pub fn is_online(&self, user: i64) -> bool {
        let in_lobby = self
            .lobby
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&user);
        in_lobby || self.where_is(user).is_some()
    }

    /// A deleted account: drop everything kept in memory about it, so its
    /// still-open pages stop showing it to anyone (ids can be reused).
    pub fn forget_account(&self, user: i64) {
        self.online().retain(|_, (who, _)| *who != user);
        self.lobby
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&user);
        self.inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&user);
    }

    /// The room `user` joined most recently, and for how long.
    pub fn where_is(&self, user: i64) -> Option<(String, u64)> {
        self.online()
            .iter()
            .filter(|(_, (who, _))| *who == user)
            .max_by_key(|(_, (_, since))| *since)
            .map(|((room, _), (_, since))| (room.clone(), since.elapsed().as_secs()))
    }
}

// ---------- rotas ----------

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
    Rooms: FromRef<S>,
{
    Router::new()
        .route("/api/usuarios/{username}", get(find))
        .route("/api/amigos", get(list).post(ask))
        .route("/api/amigos/{id}/aceitar", post(accept))
        .route("/api/amigos/{id}", axum::routing::delete(remove))
}

fn person(user: &User) -> Value {
    json!({ "id": user.id, "username": user.username, "nick": user.nick })
}

/// `GET /api/usuarios/rafa` -> `{id, username, nick, relacao}`; exact @username only.
async fn find(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    let Some(user) = contas.user_by_username(&username) else {
        return Problem::NotFound.into_response();
    };
    let mut body = person(&user);
    body["relacao"] = contas.relation(me.id, user.id).name().into();
    Json(body).into_response()
}

/// `GET /api/amigos` -> `{amigos: [{..., sala?, pessoas?, desde?}], recebidos: [...], enviados: [...]}`.
async fn list(
    State(contas): State<ContasState>,
    State(rooms): State<Rooms>,
    headers: HeaderMap,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    let Ok(all) = contas.friendships(me.id) else {
        return Problem::Database.into_response();
    };
    let (mut friends, mut received, mut sent) = (Vec::new(), Vec::new(), Vec::new());
    let unread = contas.unread(me.id);
    for (user, relation) in &all {
        let mut entry = person(user);
        match relation {
            Relation::Friend => {
                entry["online"] = contas.is_online(user.id).into();
                entry["nao_lidas"] = unread.get(&user.id).copied().unwrap_or(0).into();
                if let Some((room, secs)) = contas.where_is(user.id) {
                    let count = rooms.counts(&[room.as_str()]).first().map_or(0, |c| c.1);
                    entry["sala"] = room.into();
                    entry["pessoas"] = count.into();
                    entry["desde"] = secs.into();
                }
                friends.push(entry);
            }
            Relation::Received => received.push(entry),
            Relation::Sent => sent.push(entry),
            Relation::None | Relation::Me => {}
        }
    }
    Json(json!({ "amigos": friends, "recebidos": received, "enviados": sent })).into_response()
}

#[derive(Deserialize)]
struct Ask {
    username: String,
}

/// `POST /api/amigos {"username": "rafa"}` -> `{"relacao": "enviado" | "amigo"}`.
async fn ask(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Json(body): Json<Ask>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.request(&me, &body.username) {
        Ok(relation) => Json(json!({ "relacao": relation.name() })).into_response(),
        Err(problem) => problem.into_response(),
    }
}

/// `POST /api/amigos/{id}/aceitar`: only works for a request sent to you.
async fn accept(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.accept(me.id, id) {
        Ok(()) => Json(json!({ "relacao": "amigo" })).into_response(),
        Err(problem) => problem.into_response(),
    }
}

/// `DELETE /api/amigos/{id}`: unfriend, cancel or decline; only your own ties.
async fn remove(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.unfriend(me.id, id) {
        Ok(()) => (StatusCode::OK, Json(json!({}))).into_response(),
        Err(problem) => problem.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contas::tests::memory;

    fn account(contas: &Contas, sub: &str, username: &str) -> User {
        let id = contas.user_for_google(sub).unwrap();
        contas
            .update_user(id, Some(username), Some(username))
            .unwrap();
        contas
            .user_by_token(&contas.new_session(id).unwrap())
            .unwrap()
    }

    #[test]
    fn ask_accept_and_unfriend() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let rafa = account(&contas, "g-2", "rafa");

        assert_eq!(contas.request(&lucas, "@Rafa"), Ok(Relation::Sent));
        assert_eq!(contas.relation(rafa.id, lucas.id), Relation::Received);
        assert_eq!(
            contas.request(&lucas, "rafa"),
            Ok(Relation::Sent),
            "asking twice changes nothing"
        );

        // Lucas can't accept his own request; Rafa can.
        assert_eq!(contas.accept(lucas.id, rafa.id), Err(Problem::NotFound));
        contas.accept(rafa.id, lucas.id).unwrap();
        assert_eq!(contas.relation(lucas.id, rafa.id), Relation::Friend);
        assert_eq!(
            contas.friendships(lucas.id).unwrap()[0]
                .0
                .username
                .as_deref(),
            Some("rafa")
        );

        contas.unfriend(rafa.id, lucas.id).unwrap();
        assert_eq!(contas.relation(lucas.id, rafa.id), Relation::None);
    }

    #[test]
    fn mutual_requests_become_friends() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let bia = account(&contas, "g-2", "bia");
        contas.request(&bia, "lucas").unwrap();
        assert_eq!(contas.request(&lucas, "bia"), Ok(Relation::Friend));
    }

    #[test]
    fn refusals() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        assert_eq!(contas.request(&lucas, "lucas"), Err(Problem::SelfFriend));
        assert_eq!(contas.request(&lucas, "ninguem"), Err(Problem::NotFound));
        let id = contas.user_for_google("g-9").unwrap();
        let no_name = User {
            id,
            username: None,
            nick: String::new(),
        };
        assert_eq!(
            contas.request(&no_name, "lucas"),
            Err(Problem::NeedUsername)
        );
    }

    #[test]
    fn deleting_an_account_drops_its_friendships() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let rafa = account(&contas, "g-2", "rafa");
        contas.request(&lucas, "rafa").unwrap();
        contas.delete_user(rafa.id).unwrap();
        assert!(contas.friendships(lucas.id).unwrap().is_empty());
    }

    #[test]
    fn presence_follows_room_connections() {
        let contas = memory("http://nada");
        assert_eq!(contas.where_is(7), None);
        contas.present("churrasco-k3f9x2", 1, 7);
        assert_eq!(contas.where_is(7).unwrap().0, "churrasco-k3f9x2");
        contas.absent("churrasco-k3f9x2", 1);
        assert_eq!(contas.where_is(7), None);
    }

    #[test]
    fn online_counts_open_pages() {
        let contas = memory("http://nada");
        assert!(!contas.is_online(7));
        contas.came_online(7);
        contas.came_online(7); // a second tab
        contas.went_away(7);
        assert!(contas.is_online(7), "one tab still open");
        contas.went_away(7);
        assert!(!contas.is_online(7));
        contas.present("sala", 3, 7);
        assert!(contas.is_online(7), "in a room counts as online");
    }
}
