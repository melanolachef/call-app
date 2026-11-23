//! Friends: who is in which room, only for people who have your friend code.
//!
//! Each browser keeps a random secret; its friend code is derived from it
//! (`friend_code`), so the code can be shared but only the secret's owner can
//! announce presence under it. When someone is in a room and not invisible,
//! their browser sends `{"presence": {"secret", "nick"}}` over the room's
//! WebSocket; the entry lives in memory while that connection is open and is
//! gone when it closes. Nothing is written anywhere, nothing is kept about
//! where someone has been.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

use sha2::{Digest, Sha256};

/// Crockford's base32: no I, L, O, U (easy to read aloud and to type).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LEN: usize = 8;
const NICK_MAX: usize = 24;

/// The friend code of a secret: the first 40 bits of SHA-256, in base32.
/// The page computes the same thing to show the code (static/amigos.js).
pub fn friend_code(secret: &str) -> String {
    let hash = Sha256::digest(secret.as_bytes());
    let bits = hash[..5]
        .iter()
        .fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte));
    (0..CODE_LEN)
        .rev()
        .map(|i| ALPHABET[((bits >> (i * 5)) & 31) as usize] as char)
        .collect()
}

/// A secret is 64 hex characters (32 random bytes from the browser).
pub fn valid_secret(secret: &str) -> bool {
    secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit())
}

/// "7k3f-9x2a" or "7K3F9X2A" -> "7K3F9X2A"; None if it can't be a code.
pub fn normalize_code(code: &str) -> Option<String> {
    let code: String = code
        .chars()
        .filter(|c| *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (code.len() == CODE_LEN && code.bytes().all(|b| ALPHABET.contains(&b))).then_some(code)
}

fn clean_nick(nick: &str) -> String {
    nick.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(NICK_MAX)
        .collect()
}

struct Seen {
    room: String,
    conn: u32,
    nick: String,
    since: Instant,
}

/// Where a friend is right now.
pub struct Where {
    pub nick: String,
    pub room: String,
    pub secs: u64,
}

#[derive(Clone, Default)]
pub struct Presence {
    inner: Arc<Mutex<HashMap<String, Vec<Seen>>>>,
}

impl Presence {
    /// The connection `(room, conn)` belongs to the owner of `secret`. Called
    /// again (new nick, coming back from invisible) it just updates.
    pub fn announce(&self, room: &str, conn: u32, secret: &str, nick: &str) {
        if !valid_secret(secret) {
            return;
        }
        let code = friend_code(secret);
        let mut map = self.inner.lock().unwrap();
        for list in map.values_mut() {
            list.retain(|s| !(s.room == room && s.conn == conn));
        }
        map.retain(|_, list| !list.is_empty());
        map.entry(code).or_default().push(Seen {
            room: room.to_owned(),
            conn,
            nick: clean_nick(nick),
            since: Instant::now(),
        });
    }

    /// The connection left, or went invisible.
    pub fn forget(&self, room: &str, conn: u32) {
        let mut map = self.inner.lock().unwrap();
        for list in map.values_mut() {
            list.retain(|s| !(s.room == room && s.conn == conn));
        }
        map.retain(|_, list| !list.is_empty());
    }

    /// For each code: the room its owner joined most recently, if any.
    pub fn lookup(&self, codes: &[String]) -> Vec<(String, Option<Where>)> {
        let map = self.inner.lock().unwrap();
        codes
            .iter()
            .map(|code| {
                let found = map
                    .get(code)
                    .and_then(|list| list.iter().max_by_key(|s| s.since))
                    .map(|s| Where {
                        nick: s.nick.clone(),
                        room: s.room.clone(),
                        secs: s.since.elapsed().as_secs(),
                    });
                (code.clone(), found)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn friend_code_is_stable_and_readable() {
        let code = friend_code(SECRET);
        assert_eq!(code.len(), CODE_LEN);
        assert_eq!(code, friend_code(SECRET));
        assert!(code.bytes().all(|b| ALPHABET.contains(&b)));
        assert_ne!(code, friend_code(&SECRET.replace('0', "1")));
    }

    #[test]
    fn codes_are_normalized() {
        assert_eq!(normalize_code("7k3f-9x2a").as_deref(), Some("7K3F9X2A"));
        assert_eq!(normalize_code("7K3F9X2"), None);
        assert_eq!(normalize_code("7K3F9X2I"), None, "no I in the alphabet");
    }

    #[test]
    fn presence_follows_the_connection() {
        let presence = Presence::default();
        let code = friend_code(SECRET);
        presence.announce("churrasco-k3f9x2", 1, SECRET, "  Rafa \n ");
        let found = presence.lookup(std::slice::from_ref(&code));
        let seen = found[0].1.as_ref().unwrap();
        assert_eq!(
            (seen.nick.as_str(), seen.room.as_str()),
            ("Rafa", "churrasco-k3f9x2")
        );

        presence.announce("outra-sala", 4, SECRET, "Rafa");
        assert_eq!(
            presence.lookup(std::slice::from_ref(&code))[0]
                .1
                .as_ref()
                .unwrap()
                .room,
            "outra-sala"
        );

        presence.forget("outra-sala", 4);
        assert_eq!(
            presence.lookup(std::slice::from_ref(&code))[0]
                .1
                .as_ref()
                .unwrap()
                .room,
            "churrasco-k3f9x2"
        );
        presence.forget("churrasco-k3f9x2", 1);
        assert!(presence.lookup(&[code])[0].1.is_none());

        presence.announce("sala", 2, "not-a-secret", "X");
        assert!(presence.inner.lock().unwrap().is_empty());
    }
}
