//! A group's text channel (#223), like Discord's #geral: any member reads
//! and writes it from anywhere, also without being in one of the group's
//! rooms. Kept in SQLite for 30 days like the direct messages (#180), text
//! only. Pages ask for what is new every few seconds while the channel is on
//! screen; nothing is pushed.

use axum::{
    extract::{FromRef, Path, RawQuery, State},
    http::HeaderMap,
    response::Response,
    routing::{delete, get},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::grupos::{db_err, with_member, Member};
use super::mensagens::{clean_text, KEEP_SECS};
use super::{now, Contas, ContasState, Problem};

/// Messages per page (older ones on scroll), and at most this many new ones
/// per poll.
const PAGE: i64 = 50;
const NEWER_MAX: i64 = 100;

#[derive(Debug, PartialEq)]
pub struct GroupMessage {
    pub id: i64,
    /// The author's member id in the group (`membros[].id`).
    pub member: i64,
    /// The author's name when they wrote it.
    pub nick: String,
    pub text: String,
    pub at: i64,
}

impl GroupMessage {
    fn json(&self, me: i64) -> Value {
        json!({
            "id": self.id,
            "membro": self.member,
            "nick": self.nick,
            "texto": self.text,
            "em": self.at,
            "voce": self.member == me,
        })
    }
}

/// Which page of the channel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Page {
    /// The newest messages.
    Latest,
    /// Older than this id (scrolling up).
    Before(i64),
    /// Newer than this id (the poll).
    After(i64),
}

impl Contas {
    /// The asking member's id in `group` and the name shown for them; only
    /// for members.
    fn me_in_group(&self, member: &Member, group: i64) -> Result<(i64, String), Problem> {
        self.group_of(member, group)?;
        self.db()
            .query_row(
                "SELECT m.rowid, COALESCE(NULLIF(u.nick, ''), m.nick)
                 FROM group_members m LEFT JOIN users u ON m.member = 'u:' || u.id
                 WHERE m.group_id = ?1 AND m.member = ?2",
                params![group, member.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or(Problem::NoGroup)
    }

    /// Writes `text` in the group's channel.
    pub fn send_to_group(
        &self,
        member: &Member,
        group: i64,
        text: &str,
    ) -> Result<(GroupMessage, i64), Problem> {
        let (me, nick) = self.me_in_group(member, group)?;
        let text = clean_text(text).ok_or(Problem::EmptyMessage)?;
        let at = now();
        let db = self.db();
        db.execute(
            "DELETE FROM group_messages WHERE created_at < ?1",
            params![at - KEEP_SECS],
        )
        .map_err(db_err)?;
        db.execute(
            "INSERT INTO group_messages (group_id, member, nick, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![group, me, nick, text, at],
        )
        .map_err(db_err)?;
        let message = GroupMessage {
            id: db.last_insert_rowid(),
            member: me,
            nick,
            text,
            at,
        };
        Ok((message, me))
    }

    /// A page of the group's channel, oldest first, and the asker's member id.
    pub fn group_messages(
        &self,
        member: &Member,
        group: i64,
        page: Page,
    ) -> Result<(Vec<GroupMessage>, i64), Problem> {
        let (me, _) = self.me_in_group(member, group)?;
        let since = now() - KEEP_SECS;
        let (sql, mark, limit) = match page {
            Page::Latest => ("id < ?2 ORDER BY id DESC", i64::MAX, PAGE),
            Page::Before(id) => ("id < ?2 ORDER BY id DESC", id, PAGE),
            Page::After(id) => ("id > ?2 ORDER BY id ASC", id, NEWER_MAX),
        };
        let db = self.db();
        let mut stmt = db
            .prepare(&format!(
                "SELECT id, member, nick, body, created_at FROM group_messages
                 WHERE group_id = ?1 AND created_at >= ?3 AND {sql} LIMIT ?4"
            ))
            .map_err(db_err)?;
        let mut list: Vec<GroupMessage> = stmt
            .query_map(params![group, mark, since, limit], |r| {
                Ok(GroupMessage {
                    id: r.get(0)?,
                    member: r.get(1)?,
                    nick: r.get(2)?,
                    text: r.get(3)?,
                    at: r.get(4)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?;
        if !matches!(page, Page::After(_)) {
            list.reverse();
        }
        Ok((list, me))
    }

    /// Deletes one message: its author or the group's owner.
    pub fn delete_group_message(
        &self,
        member: &Member,
        group: i64,
        message: i64,
    ) -> Result<(), Problem> {
        let (_, owner) = self.group_of(member, group)?;
        let (me, _) = self.me_in_group(member, group)?;
        let author: Option<i64> = self
            .db()
            .query_row(
                "SELECT member FROM group_messages WHERE id = ?1 AND group_id = ?2",
                params![message, group],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match author {
            None => Ok(()), // already gone
            Some(author) if author == me || owner == member.key => {
                self.db()
                    .execute("DELETE FROM group_messages WHERE id = ?1", params![message])
                    .map_err(db_err)?;
                Ok(())
            }
            Some(_) => Err(Problem::NotOwner),
        }
    }
}

// ---------- rotas ----------

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    ContasState: FromRef<S>,
{
    Router::new()
        .route("/api/grupos/{id}/mensagens", get(read).post(write))
        .route("/api/grupos/{id}/mensagens/{msg}", delete(remove))
}

fn page(query: Option<String>) -> Page {
    let query = query.unwrap_or_default();
    let value = |name: &str| {
        query
            .split('&')
            .find_map(|p| p.strip_prefix(name)?.strip_prefix('='))
            .and_then(|v| v.parse::<i64>().ok())
    };
    match (value("depois"), value("antes")) {
        (Some(id), _) => Page::After(id),
        (None, Some(id)) => Page::Before(id),
        (None, None) => Page::Latest,
    }
}

/// `GET /api/grupos/{id}/mensagens[?antes=<id>|?depois=<id>]` ->
/// `{"mensagens": [{id, membro, nick, texto, em, voce}]}`, oldest first.
async fn read(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    RawQuery(query): RawQuery,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        let (list, me) = contas.group_messages(member, id, page(query))?;
        Ok(json!({ "mensagens": list.iter().map(|m| m.json(me)).collect::<Vec<_>>() }))
    })
}

#[derive(Deserialize)]
struct Write {
    texto: String,
}

/// `POST /api/grupos/{id}/mensagens {"texto"}` -> the message.
async fn write(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Write>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        let (message, me) = contas.send_to_group(member, id, &body.texto)?;
        Ok(message.json(me))
    })
}

/// `DELETE /api/grupos/{id}/mensagens/{msg}`: the author or the owner.
async fn remove(
    State(contas): State<ContasState>,
    headers: HeaderMap,
    Path((id, msg)): Path<(i64, i64)>,
) -> Response {
    with_member(contas, &headers, |contas, member| {
        contas.delete_group_message(member, id, msg)?;
        Ok(json!({}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contas::grupos::device_key;
    use crate::contas::tests::memory;

    fn device(n: u8) -> Member {
        let key = device_key(&format!("{n:02x}").repeat(16)).unwrap();
        Member {
            device: Some(key.clone()),
            key,
        }
    }

    #[test]
    fn members_write_read_and_delete() {
        let contas = memory("http://nada");
        let (ana, beto, caio) = (device(1), device(2), device(3));
        let group = contas.create_group(&ana, "Turma", "Ana").unwrap();
        let invite = contas.group(&ana, group).unwrap()["convite"]
            .as_str()
            .unwrap()
            .to_owned();
        contas.accept_invite(&beto, &invite, "Beto").unwrap();

        // Not a member: neither reads nor writes.
        assert_eq!(
            contas.send_to_group(&caio, group, "oi"),
            Err(Problem::NoGroup)
        );
        assert!(contas.group_messages(&caio, group, Page::Latest).is_err());
        assert_eq!(
            contas.send_to_group(&ana, group, "   "),
            Err(Problem::EmptyMessage)
        );

        let (first, ana_id) = contas.send_to_group(&ana, group, " bora jogar? ").unwrap();
        assert_eq!(first.text, "bora jogar?");
        assert_eq!(first.nick, "Ana");
        let (second, beto_id) = contas.send_to_group(&beto, group, "bora").unwrap();
        assert_ne!(ana_id, beto_id);

        let (list, me) = contas.group_messages(&beto, group, Page::Latest).unwrap();
        assert_eq!(me, beto_id);
        assert_eq!(
            list.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["bora jogar?", "bora"]
        );
        let (newer, _) = contas
            .group_messages(&ana, group, Page::After(first.id))
            .unwrap();
        assert_eq!(newer, [second]);
        let (older, _) = contas
            .group_messages(&ana, group, Page::Before(first.id))
            .unwrap();
        assert!(older.is_empty());

        // Beto can't delete Ana's; the owner deletes anyone's.
        assert_eq!(
            contas.delete_group_message(&beto, group, first.id),
            Err(Problem::NotOwner)
        );
        let (list, _) = contas.group_messages(&ana, group, Page::Latest).unwrap();
        contas
            .delete_group_message(&ana, group, list[1].id)
            .unwrap();
        contas
            .delete_group_message(&beto, group, list[0].id)
            .unwrap_err();
        contas
            .delete_group_message(&ana, group, list[0].id)
            .unwrap();
        assert!(contas
            .group_messages(&ana, group, Page::Latest)
            .unwrap()
            .0
            .is_empty());

        // Deleting the group takes its channel with it.
        contas.send_to_group(&beto, group, "tchau").unwrap();
        contas.delete_group(&ana, group).unwrap();
        let left: i64 = contas
            .db()
            .query_row("SELECT COUNT(*) FROM group_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn leaving_takes_your_messages_and_signing_in_keeps_them() {
        let contas = memory("http://nada");
        let (ana, beto, caio, dani) = (device(1), device(2), device(3), device(4));
        let group = contas.create_group(&ana, "Turma", "Ana").unwrap();
        let invite = contas.group(&ana, group).unwrap()["convite"]
            .as_str()
            .unwrap()
            .to_owned();
        let texts = |who: &Member| -> Vec<String> {
            let (list, _) = contas.group_messages(who, group, Page::Latest).unwrap();
            list.into_iter().map(|m| m.text).collect()
        };
        for (who, nick) in [(&beto, "Beto"), (&caio, "Caio"), (&dani, "Dani")] {
            contas.accept_invite(who, &invite, nick).unwrap();
            contas
                .send_to_group(who, group, &format!("oi do {nick}"))
                .unwrap();
        }

        contas.leave_group(&beto, group).unwrap();
        let caio_id = contas.group_messages(&caio, group, Page::Latest).unwrap().1;
        contas.remove_member(&ana, group, caio_id).unwrap();
        assert_eq!(texts(&ana), ["oi do Dani"]);

        // Dani signs in, and her account already was in the group: her
        // browser's messages become the account's.
        let account = Member {
            key: "u:77".into(),
            device: None,
        };
        contas.accept_invite(&account, &invite, "Dani").unwrap();
        let signed_in = Member {
            key: "u:77".into(),
            device: dani.device.clone(),
        };
        contas.claim_device(&signed_in).unwrap();
        let (list, me) = contas
            .group_messages(&signed_in, group, Page::Latest)
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].member, me);
        contas
            .delete_group_message(&signed_in, group, list[0].id)
            .unwrap();
    }

    #[test]
    fn pages_of_fifty() {
        let contas = memory("http://nada");
        let ana = device(1);
        let group = contas.create_group(&ana, "Turma", "Ana").unwrap();
        for i in 0..60 {
            contas.send_to_group(&ana, group, &format!("m{i}")).unwrap();
        }
        let (latest, _) = contas.group_messages(&ana, group, Page::Latest).unwrap();
        assert_eq!(latest.len(), 50);
        assert_eq!(latest[0].text, "m10");
        assert_eq!(latest[49].text, "m59");
        let (older, _) = contas
            .group_messages(&ana, group, Page::Before(latest[0].id))
            .unwrap();
        assert_eq!(older.len(), 10);
        assert_eq!(older[0].text, "m0");
    }

    #[test]
    fn page_from_the_query() {
        assert_eq!(page(None), Page::Latest);
        assert_eq!(page(Some("antes=12".into())), Page::Before(12));
        assert_eq!(page(Some("depois=7".into())), Page::After(7));
        assert_eq!(page(Some("antesx=3".into())), Page::Latest);
    }
}
