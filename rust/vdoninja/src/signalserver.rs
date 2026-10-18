// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! A small VDO.Ninja-compatible signaling server (the routed `wss2` protocol)
//! for tests, LAN and offline development. No TURN, no rate limiting; see
//! <https://github.com/steveseguin/websocket_server> for production hosting.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct State {
    clients: HashMap<String, mpsc::UnboundedSender<String>>,
    streams: HashMap<String, String>,
    stream_ids: HashMap<String, String>,
    rooms: HashMap<String, String>,
    room_list: HashMap<String, Vec<String>>,
    directors: HashMap<String, String>,
    waiting: HashMap<String, HashSet<String>>,
}

impl State {
    fn send(&self, uuid: &str, v: &Value) {
        if let Some(tx) = self.clients.get(uuid) {
            let _ = tx.send(v.to_string());
        }
    }

    fn notify_room(&self, room: &str, v: &Value, skip: &str) {
        if let Some(members) = self.room_list.get(room) {
            for m in members {
                if m != skip {
                    self.send(m, v);
                }
            }
        }
    }

    fn cleanup(&mut self, uuid: &str) {
        self.clients.remove(uuid);
        if let Some(sid) = self.stream_ids.remove(uuid) {
            if self.streams.get(&sid).map(|s| s.as_str()) == Some(uuid) {
                self.streams.remove(&sid);
            }
        }
        if let Some(room) = self.rooms.remove(uuid) {
            if self.directors.get(&room).map(|s| s.as_str()) == Some(uuid) {
                self.directors.remove(&room);
            }
            if let Some(list) = self.room_list.get_mut(&room) {
                list.retain(|m| m != uuid);
                if list.is_empty() {
                    self.room_list.remove(&room);
                }
            }
        }
        self.waiting.retain(|_, set| {
            set.remove(uuid);
            !set.is_empty()
        });
    }

    fn handle(&mut self, uuid: &str, mut msg: Value) {
        let request = msg
            .get("request")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let Some(request) = request else {
            let target = msg
                .get("UUID")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(target) = target {
                if self.clients.contains_key(&target) {
                    msg["UUID"] = json!(uuid);
                    if let Some(m) = msg.as_object_mut() {
                        m.remove("from");
                    }
                    self.send(&target, &msg);
                }
            }
            return;
        };
        let str_field = |m: &Value, k: &str| {
            m.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        match request.as_str() {
            "play" => self.play(uuid, &str_field(&msg, "streamID")),
            "seed" => self.seed(uuid, &str_field(&msg, "streamID")),
            "joinroom" => {
                let claim = msg.get("claim").and_then(|v| v.as_bool()).unwrap_or(false);
                self.join_room(
                    uuid,
                    &str_field(&msg, "roomid").to_lowercase(),
                    claim,
                    &str_field(&msg, "streamID"),
                );
            }
            _ => {}
        }
    }

    fn play(&mut self, uuid: &str, stream_id: &str) {
        if stream_id.is_empty() {
            return;
        }
        match self.streams.get(stream_id).cloned() {
            None => {
                self.waiting
                    .entry(stream_id.into())
                    .or_default()
                    .insert(uuid.into());
            }
            Some(seeder) => {
                if seeder == uuid {
                    return;
                }
                if !self.clients.contains_key(&seeder) {
                    self.waiting
                        .entry(stream_id.into())
                        .or_default()
                        .insert(uuid.into());
                    return;
                }
                if let Some(room) = self.rooms.get(&seeder) {
                    if self.rooms.get(uuid) != Some(room) {
                        self.waiting
                            .entry(stream_id.into())
                            .or_default()
                            .insert(uuid.into());
                        return;
                    }
                }
                self.send(&seeder, &json!({"request": "offerSDP", "UUID": uuid}));
            }
        }
    }

    fn seed(&mut self, uuid: &str, stream_id: &str) {
        if stream_id.is_empty() {
            return;
        }
        if let Some(existing) = self.stream_ids.get(uuid) {
            if existing != stream_id {
                self.send(uuid, &json!({"request": "alert", "message": "Stream ID cannot change on an existing connection."}));
                return;
            }
        }
        if let Some(owner) = self.streams.get(stream_id) {
            if owner != uuid && self.clients.contains_key(owner) {
                self.send(
                    uuid,
                    &json!({"request": "alert", "message": "Stream ID is already in use."}),
                );
                return;
            }
        }
        self.streams.insert(stream_id.into(), uuid.into());
        self.stream_ids.insert(uuid.into(), stream_id.into());
        if let Some(room) = self.rooms.get(uuid).cloned() {
            self.notify_room(
                &room,
                &json!({"request": "videoaddedtoroom", "UUID": uuid, "streamID": stream_id}),
                uuid,
            );
        } else if let Some(watchers) = self.waiting.remove(stream_id) {
            for viewer in watchers {
                if self.clients.contains_key(&viewer) {
                    self.send(uuid, &json!({"request": "offerSDP", "UUID": viewer}));
                }
            }
        }
    }

    fn join_room(&mut self, uuid: &str, room: &str, claim: bool, stream_id: &str) {
        if room.is_empty() || self.rooms.contains_key(uuid) {
            return;
        }
        self.rooms.insert(uuid.into(), room.into());
        if !stream_id.is_empty() && !self.stream_ids.contains_key(uuid) {
            self.streams.insert(stream_id.into(), uuid.into());
            self.stream_ids.insert(uuid.into(), stream_id.into());
        }
        let mut resp = json!({"request": "listing"});
        let mut is_director = false;
        if claim {
            let current = self.directors.get(room).cloned();
            match current {
                Some(cur) if self.clients.contains_key(&cur) => {
                    resp["claim"] = json!(cur == uuid);
                    if cur != uuid {
                        resp["director"] = json!(cur);
                    }
                }
                _ => {
                    self.directors.insert(room.into(), uuid.into());
                    resp["claim"] = json!(true);
                    is_director = true;
                }
            }
        } else if let Some(d) = self.directors.get(room) {
            resp["director"] = json!(d);
        }
        let members = self.room_list.entry(room.into()).or_default().clone();
        let list: Vec<Value> = members
            .iter()
            .map(|m| {
                let mut e = json!({"UUID": m});
                if let Some(sid) = self.stream_ids.get(m) {
                    e["streamID"] = json!(sid);
                }
                if self.directors.get(room) == Some(m) {
                    e["director"] = json!(true);
                }
                e
            })
            .collect();
        resp["list"] = json!(list);
        self.send(uuid, &resp);
        let mut notice = json!({"request": "someonejoined", "UUID": uuid});
        if is_director {
            notice["director"] = json!(true);
        }
        if let Some(sid) = self.stream_ids.get(uuid) {
            notice["streamID"] = json!(sid);
        }
        self.notify_room(room, &notice, uuid);
        self.room_list
            .entry(room.into())
            .or_default()
            .push(uuid.into());
        if let Some(sid) = self.stream_ids.get(uuid).cloned() {
            let room_owned = room.to_string();
            let rooms = self.rooms.clone();
            if let Some(watchers) = self.waiting.get_mut(&sid) {
                let in_room: Vec<String> = watchers
                    .iter()
                    .filter(|w| rooms.get(*w) == Some(&room_owned))
                    .cloned()
                    .collect();
                for viewer in in_room {
                    watchers.remove(&viewer);
                    if let Some(tx) = self.clients.get(uuid) {
                        let _ = tx.send(json!({"request": "offerSDP", "UUID": viewer}).to_string());
                    }
                }
            }
        }
    }
}

/// A running signaling server.
pub struct SignalServer {
    /// Bound address, e.g. for building `ws://127.0.0.1:PORT`.
    pub addr: SocketAddr,
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

impl SignalServer {
    /// Binds and serves until dropped.
    pub async fn bind(addr: &str) -> std::io::Result<SignalServer> {
        let listener = TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let state = Arc::new(Mutex::new(State::default()));
        let st = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let st = st.clone();
                tokio::spawn(handle_client(st, stream));
            }
        });
        Ok(SignalServer { addr, state, task })
    }

    /// `ws://host:port` URL for this server.
    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    /// Number of connected clients.
    pub fn client_count(&self) -> usize {
        self.state.lock().unwrap().clients.len()
    }
}

impl Drop for SignalServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle_client(state: Arc<Mutex<State>>, stream: TcpStream) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let uuid = vdoninja_core::generate_uuid();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.lock().unwrap().clients.insert(uuid.clone(), tx);
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = source.next().await {
        if let Message::Text(text) = msg {
            if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                if value.is_object() {
                    state.lock().unwrap().handle(&uuid, value);
                }
            }
        }
    }
    state.lock().unwrap().cleanup(&uuid);
    writer.abort();
}
