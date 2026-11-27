//! Direct messages between friends (#180). Kept in SQLite for 30 days (then
//! deleted), text only, and only between accepted friends. They arrive right
//! away through the page's presence connection (/ws/presenca) when the other
//! person has the app open; otherwise the next time they look.

use std::collections::HashMap;

use axum::{
    extract::{FromRef, Path, RawQuery, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::amizades::Relation;
use super::{current, now, off, signed_out, Contas, ContasState, Problem};

/// Messages older than this are deleted.
pub const KEEP_SECS: i64 = 30 * 24 * 3600;
pub const TEXT_MAX: usize = 2000;
const PAGE: i64 = 50;

/// Open presence connections per account, to deliver messages right away.
pub type Inbox = HashMap<i64, Vec<(u64, mpsc::Sender<String>)>>;

#[derive(Debug, PartialEq)]
pub struct Dm {
    pub id: i64,
    pub from: i64,
    pub text: String,
    pub at: i64,
}

pub(super) fn clean_text(text: &str) -> Option<String> {
    let text: String = text
        .trim()
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(TEXT_MAX)
        .collect();
    (!text.is_empty()).then_some(text)
}

impl Contas {
    fn inbox(&self) -> std::sync::MutexGuard<'_, Inbox> {
        self.inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A presence connection of `user` that wants messages; returns its id
    /// for `stop_listening`.
    pub fn listen(&self, user: i64, tx: mpsc::Sender<String>) -> u64 {
        let id = self
            .next_listener
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.inbox().entry(user).or_default().push((id, tx));
        id
    }

    pub fn stop_listening(&self, user: i64, id: u64) {
        let mut inbox = self.inbox();
        if let Some(list) = inbox.get_mut(&user) {
            list.retain(|(i, _)| *i != id);
            if list.is_empty() {
                inbox.remove(&user);
            }
        }
    }

    fn push(&self, user: i64, msg: &Value) {
        let text = msg.to_string();
        if let Some(list) = self.inbox().get(&user) {
            for (_, tx) in list {
                let _ = tx.try_send(text.clone()); // a full queue just misses the live copy
            }
        }
    }

    /// Sends a message from `me` to friend `to`.
    pub fn send_dm(&self, me: i64, to: i64, text: &str) -> Result<Dm, Problem> {
        if self.relation(me, to) != Relation::Friend {
            return Err(Problem::NotFriends);
        }
        let text = clean_text(text).ok_or(Problem::EmptyMessage)?;
        let at = now();
        let id = {
            let db = self.db();
            db.execute(
                "DELETE FROM messages WHERE created_at < ?1",
                params![at - KEEP_SECS],
            )
            .map_err(|_| Problem::Database)?;
            db.execute(
                "INSERT INTO messages (sender, recipient, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![me, to, text, at],
            )
            .map_err(|_| Problem::Database)?;
            db.last_insert_rowid()
        };
        let dm = Dm {
            id,
            from: me,
            text,
            at,
        };
        let live =
            json!({ "type": "dm", "id": id, "de": me, "para": to, "texto": dm.text, "em": at });
        self.push(to, &live);
        self.push(me, &live); // your other tabs
        Ok(dm)
    }

    /// The conversation with `other`, newest last (up to 50, before `before`),
    /// marking what they sent you as read.
    pub fn conversation(
        &self,
        me: i64,
        other: i64,
        before: Option<i64>,
    ) -> Result<Vec<Dm>, Problem> {
        let db = self.db();
        let mut stmt = db
            .prepare(
                "SELECT id, sender, body, created_at FROM messages
                 WHERE ((sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1))
                   AND id < ?3 AND created_at >= ?4
                 ORDER BY id DESC LIMIT ?5",
            )
            .map_err(|_| Problem::Database)?;
        let mut list: Vec<Dm> = stmt
            .query_map(
                params![
                    me,
                    other,
                    before.unwrap_or(i64::MAX),
                    now() - KEEP_SECS,
                    PAGE
                ],
                |r| {
                    Ok(Dm {
                        id: r.get(0)?,
                        from: r.get(1)?,
                        text: r.get(2)?,
                        at: r.get(3)?,
                    })
                },
            )
            .map_err(|_| Problem::Database)?
            .collect::<Result<_, _>>()
            .map_err(|_| Problem::Database)?;
        list.reverse();
        db.execute(
            "UPDATE messages SET read_at = ?1 WHERE sender = ?2 AND recipient = ?3 AND read_at IS NULL",
            params![now(), other, me],
        )
        .map_err(|_| Problem::Database)?;
        Ok(list)
    }

    /// Unread messages per friend: friend id -> count.
    pub fn unread(&self, me: i64) -> HashMap<i64, i64> {
        let db = self.db();
        let Ok(mut stmt) = db.prepare(
            "SELECT sender, COUNT(*) FROM messages WHERE recipient = ?1 AND read_at IS NULL AND created_at >= ?2 GROUP BY sender",
        ) else {
            return HashMap::new();
        };
        stmt.query_map(params![me, now() - KEEP_SECS], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Deletes the whole conversation, for both people.
    pub fn delete_conversation(&self, me: i64, other: i64) -> Result<(), Problem> {
        self.db()
            .execute(
                "DELETE FROM messages WHERE (sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1)",
                params![me, other],
            )
            .map_err(|_| Problem::Database)?;
        Ok(())
    }
}

// ---------- rotas ----------

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
{
    Router::new().route("/api/mensagens/{id}", get(read).post(write).delete(remove))
}

fn dm_json(dm: &Dm) -> Value {
    json!({ "id": dm.id, "de": dm.from, "texto": dm.text, "em": dm.at })
}

/// `GET /api/mensagens/{amigo}?antes=<id>` -> `{"mensagens": [...]}`.
async fn read(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(other): Path<i64>,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    let before = query
        .unwrap_or_default()
        .split('&')
        .find_map(|p| p.strip_prefix("antes="))
        .and_then(|v| v.parse().ok());
    match contas.conversation(me.id, other, before) {
        Ok(list) => Json(json!({ "mensagens": list.iter().map(dm_json).collect::<Vec<_>>() }))
            .into_response(),
        Err(problem) => problem.into_response(),
    }
}

#[derive(Deserialize)]
struct Write {
    texto: String,
}

/// `POST /api/mensagens/{amigo} {"texto": "..."}`: only to a friend.
async fn write(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(other): Path<i64>,
    Json(body): Json<Write>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.send_dm(me.id, other, &body.texto) {
        Ok(dm) => Json(dm_json(&dm)).into_response(),
        Err(problem) => problem.into_response(),
    }
}

/// `DELETE /api/mensagens/{amigo}`: the whole conversation, for both.
async fn remove(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(other): Path<i64>,
) -> Response {
    let Some(contas) = contas else { return off() };
    let Some(me) = current(&contas, &headers) else {
        return signed_out();
    };
    match contas.delete_conversation(me.id, other) {
        Ok(()) => Json(json!({})).into_response(),
        Err(problem) => problem.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contas::tests::memory;
    use crate::contas::User;

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
    fn only_friends_talk_and_messages_get_read() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let rafa = account(&contas, "g-2", "rafa");
        assert_eq!(
            contas.send_dm(lucas.id, rafa.id, "oi"),
            Err(Problem::NotFriends)
        );
        contas.request(&lucas, "rafa").unwrap();
        assert_eq!(
            contas.send_dm(lucas.id, rafa.id, "oi"),
            Err(Problem::NotFriends),
            "a request isn't friendship"
        );
        contas.accept(rafa.id, lucas.id).unwrap();

        assert_eq!(
            contas.send_dm(lucas.id, rafa.id, "   "),
            Err(Problem::EmptyMessage)
        );
        contas.send_dm(lucas.id, rafa.id, "bora jogar?").unwrap();
        contas.send_dm(lucas.id, rafa.id, "tô na sala").unwrap();
        contas.send_dm(rafa.id, lucas.id, "já vou").unwrap();
        assert_eq!(contas.unread(rafa.id).get(&lucas.id), Some(&2));

        let seen = contas.conversation(rafa.id, lucas.id, None).unwrap();
        assert_eq!(
            seen.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["bora jogar?", "tô na sala", "já vou"]
        );
        assert_eq!(contas.unread(rafa.id).get(&lucas.id), None, "read now");
        assert_eq!(contas.unread(lucas.id).get(&rafa.id), Some(&1));

        contas.delete_conversation(rafa.id, lucas.id).unwrap();
        assert!(
            contas
                .conversation(lucas.id, rafa.id, None)
                .unwrap()
                .is_empty(),
            "gone for both"
        );
    }

    #[test]
    fn old_messages_are_deleted() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let rafa = account(&contas, "g-2", "rafa");
        contas.request(&lucas, "rafa").unwrap();
        contas.accept(rafa.id, lucas.id).unwrap();
        contas.db().execute(
            "INSERT INTO messages (sender, recipient, body, created_at) VALUES (?1, ?2, 'velha', ?3)",
            params![lucas.id, rafa.id, now() - KEEP_SECS - 10],
        ).unwrap();
        assert!(
            contas
                .conversation(rafa.id, lucas.id, None)
                .unwrap()
                .is_empty(),
            "past 30 days: not shown"
        );
        contas.send_dm(lucas.id, rafa.id, "nova").unwrap();
        let left: i64 = contas
            .db()
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "and deleted on the next send");
    }

    #[test]
    fn live_copy_reaches_open_pages() {
        let contas = memory("http://nada");
        let lucas = account(&contas, "g-1", "lucas");
        let rafa = account(&contas, "g-2", "rafa");
        contas.request(&lucas, "rafa").unwrap();
        contas.accept(rafa.id, lucas.id).unwrap();
        let (tx, mut rx) = mpsc::channel(8);
        let listener = contas.listen(rafa.id, tx);
        contas.send_dm(lucas.id, rafa.id, "oi").unwrap();
        let live: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(
            (live["type"].as_str(), live["texto"].as_str()),
            (Some("dm"), Some("oi"))
        );
        contas.stop_listening(rafa.id, listener);
        contas.send_dm(lucas.id, rafa.id, "de novo").unwrap();
        assert!(rx.try_recv().is_err());
    }
}
