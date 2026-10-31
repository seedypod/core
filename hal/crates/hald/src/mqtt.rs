//! MQTT transport (rumqttc). Connects with a retained LWT on
//! `availability`, publishes `online` on every (re)connect, subscribes to the
//! command topics, and bridges to the engine over channels. Connection loss
//! never crashes the daemon: the loop backs off (1 s → 30 s) and asks the
//! engine for a full `Resync` after each reconnect, so dropping publishes
//! while offline is safe (every retained topic is regenerated).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use hal_core::{topics, ActuatorCommand, AlertKind};
use rumqttc::{AsyncClient, Event, LastWill, MqttOptions, Packet, QoS};
use tokio::sync::mpsc::UnboundedReceiver;
use tracing::{info, warn};

use crate::engine::{Inbound, Outbound};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MqttSettings {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// `mqtt://host[:port]` → (host, port). `mqtts://` is accepted for the
/// address but TLS is not configured (LAN-only trust model; Phase 8).
pub fn parse_url(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("mqtt://")
        .or_else(|| url.strip_prefix("mqtts://"))
        .ok_or_else(|| format!("{url:?}: expected mqtt://host[:port]"))?;
    let rest = rest.trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => {
            let port: u16 = p.parse().map_err(|_| format!("{url:?}: bad port {p:?}"))?;
            (h.trim_matches(['[', ']']).to_owned(), port)
        }
        _ => (rest.trim_matches(['[', ']']).to_owned(), 1883),
    };
    if host.is_empty() {
        return Err(format!("{url:?}: empty host"));
    }
    Ok((host, port))
}

/// Client options: id `hald-<unit>`, 30 s keep-alive, retained LWT `offline`.
pub fn options(settings: &MqttSettings, unit: &str) -> Result<MqttOptions, String> {
    let (host, port) = parse_url(&settings.url)?;
    let mut o = MqttOptions::new(format!("hald-{unit}"), host, port);
    o.set_keep_alive(Duration::from_secs(30));
    o.set_clean_session(true);
    o.set_max_packet_size(256 * 1024, 256 * 1024);
    o.set_last_will(LastWill::new(
        topics::availability(unit),
        "offline",
        QoS::AtLeastOnce,
        true,
    ));
    if let (Some(u), Some(p)) = (&settings.username, &settings.password) {
        o.set_credentials(u.clone(), p.clone());
    }
    Ok(o)
}

/// Topics `hald` listens on.
pub fn subscriptions(unit: &str) -> Vec<String> {
    let mut v = vec![
        format!("{}/actuator/+/set", topics::prefix(unit)),
        format!("{}/alert/+/ack", topics::prefix(unit)),
    ];
    v.extend(crate::ha::command_topics(unit));
    v
}

/// Decode an incoming publish. Unknown topics and malformed payloads → `None`
/// (logged by the caller).
pub fn parse_inbound(unit: &str, topic: &str, payload: &[u8]) -> Result<Inbound, String> {
    let text = std::str::from_utf8(payload).map_err(|e| format!("non-UTF-8 payload: {e}"))?;
    let prefix = format!("{}/", topics::prefix(unit));
    let rest = topic
        .strip_prefix(&prefix)
        .ok_or_else(|| format!("topic {topic:?} is not ours"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    match parts.as_slice() {
        ["actuator", id, "set"] => {
            let id =
                crate::config::parse_actuator_id(id).ok_or_else(|| format!("unknown actuator {id:?}"))?;
            let cmd: ActuatorCommand = if text.trim().is_empty() {
                ActuatorCommand::default()
            } else {
                serde_json::from_str(text).map_err(|e| format!("bad ActuatorCommand {text:?}: {e}"))?
            };
            Ok(Inbound::ActuatorSet(id, cmd))
        }
        ["alert", kind, "ack"] => {
            let kind: AlertKind = serde_json::from_value(serde_json::Value::String((*kind).to_owned()))
                .map_err(|_| format!("unknown alert kind {kind:?}"))?;
            Ok(Inbound::AlertAck(kind))
        }
        ["ha", ..] => crate::ha::translate_command(unit, topic, text)
            .map(|(id, cmd)| Inbound::ActuatorSet(id, cmd))
            .ok_or_else(|| format!("unrecognised HA command {topic:?} = {text:?}")),
        _ => Err(format!("unhandled topic {topic:?}")),
    }
}

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Runs until `out_rx` closes (the engine has shut down), then flushes and
/// disconnects.
pub async fn run(
    settings: MqttSettings,
    unit: String,
    inbound: Sender<Inbound>,
    mut out_rx: UnboundedReceiver<Outbound>,
    connected: Arc<AtomicBool>,
) {
    let opts = match options(&settings, &unit) {
        Ok(o) => o,
        Err(e) => {
            warn!(%e, "MQTT disabled: invalid settings");
            // Drain so the engine never blocks on a full channel.
            while out_rx.recv().await.is_some() {}
            return;
        }
    };
    info!(url = %settings.url, client = %format!("hald-{unit}"), "MQTT connecting");
    let (client, mut eventloop) = AsyncClient::new(opts, 128);
    let mut backoff = BACKOFF_MIN;
    let mut retry_at: Option<tokio::time::Instant> = None;

    loop {
        let waiting = retry_at.is_some();
        tokio::select! {
            _ = async { tokio::time::sleep_until(retry_at.unwrap_or_else(tokio::time::Instant::now)).await }, if waiting => {
                retry_at = None;
            }
            ev = eventloop.poll(), if !waiting => match ev {
                Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                    if ack.code == rumqttc::ConnectReturnCode::Success {
                        info!("MQTT connected");
                        connected.store(true, Ordering::Relaxed);
                        backoff = BACKOFF_MIN;
                        let _ = client.try_publish(topics::availability(&unit), QoS::AtLeastOnce, true, "online");
                        for t in subscriptions(&unit) {
                            if let Err(e) = client.try_subscribe(&t, QoS::AtLeastOnce) {
                                warn!(topic = %t, %e, "subscribe failed");
                            }
                        }
                        let _ = inbound.send(Inbound::Resync);
                    } else {
                        warn!(code = ?ack.code, "MQTT connection refused by broker");
                    }
                }
                Ok(Event::Incoming(Packet::Publish(p))) => match parse_inbound(&unit, &p.topic, &p.payload) {
                    Ok(msg) => {
                        if inbound.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(e) => warn!(topic = %p.topic, %e, "ignoring MQTT message"),
                },
                Ok(_) => {}
                Err(e) => {
                    if connected.swap(false, Ordering::Relaxed) {
                        warn!(%e, "MQTT connection lost");
                    } else {
                        info!(%e, retry_in_s = backoff.as_secs(), "MQTT unavailable; retrying");
                    }
                    retry_at = Some(tokio::time::Instant::now() + backoff);
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            },
            msg = out_rx.recv() => match msg {
                Some(o) => {
                    if connected.load(Ordering::Relaxed) {
                        if let Err(e) = client.try_publish(&o.topic, QoS::AtLeastOnce, o.retain, o.payload.clone()) {
                            warn!(topic = %o.topic, %e, "publish dropped");
                        }
                    }
                }
                None => break,
            },
        }
    }

    // Engine is gone: let the final publishes (pump state, `offline`) drain.
    if connected.load(Ordering::Relaxed) {
        let _ = client.try_disconnect();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, eventloop.poll()).await {
                Ok(Ok(Event::Outgoing(rumqttc::Outgoing::Disconnect))) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(_)) => {}
            }
        }
    }
    connected.store(false, Ordering::Relaxed);
    info!("MQTT stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use hal_core::ActuatorId;

    #[test]
    fn urls_parse_with_default_port_and_ipv6() {
        assert_eq!(
            parse_url("mqtt://127.0.0.1:1883").unwrap(),
            ("127.0.0.1".into(), 1883)
        );
        assert_eq!(
            parse_url("mqtt://broker.local").unwrap(),
            ("broker.local".into(), 1883)
        );
        assert_eq!(parse_url("mqtts://b:8883/").unwrap(), ("b".into(), 8883));
        assert_eq!(parse_url("mqtt://[::1]:1884").unwrap(), ("::1".into(), 1884));
        assert!(parse_url("http://x").is_err());
        assert!(parse_url("mqtt://x:notaport").is_err());
        assert!(parse_url("mqtt://").is_err());
    }

    #[test]
    fn options_carry_lwt_credentials_and_client_id() {
        let s = MqttSettings {
            url: "mqtt://h:1883".into(),
            username: Some("u".into()),
            password: Some("p".into()),
        };
        let o = options(&s, "u1").unwrap();
        assert_eq!(o.client_id(), "hald-u1");
        assert_eq!(o.broker_address(), ("h".to_owned(), 1883));
        let will = o.last_will().unwrap();
        assert_eq!(will.topic, "leafypod/u1/availability");
        assert_eq!(&will.message[..], b"offline");
        assert!(will.retain);
        let login = o.credentials().expect("credentials set");
        assert_eq!((login.username.as_str(), login.password.as_str()), ("u", "p"));
        let anon = options(
            &MqttSettings {
                url: "mqtt://h".into(),
                username: None,
                password: None,
            },
            "u1",
        )
        .unwrap();
        assert!(anon.credentials().is_none());
        assert!(options(
            &MqttSettings {
                url: "nope".into(),
                username: None,
                password: None
            },
            "u1"
        )
        .is_err());
    }

    #[test]
    fn subscriptions_cover_commands_acks_and_ha_mirrors() {
        let s = subscriptions("u1");
        assert!(s.contains(&"leafypod/u1/actuator/+/set".to_owned()));
        assert!(s.contains(&"leafypod/u1/alert/+/ack".to_owned()));
        assert!(s.contains(&"leafypod/u1/ha/light/brightness/set".to_owned()));
        assert_eq!(s.len(), 6);
    }

    #[test]
    fn inbound_parsing_covers_every_command_shape() {
        let cmd = parse_inbound(
            "u1",
            "leafypod/u1/actuator/pump/set",
            br#"{"on":true,"level":100,"durationS":300}"#,
        )
        .unwrap();
        assert_eq!(
            cmd,
            Inbound::ActuatorSet(
                ActuatorId::Pump,
                ActuatorCommand {
                    on: Some(true),
                    level: Some(100.0),
                    duration_s: Some(300)
                }
            )
        );
        assert_eq!(
            parse_inbound("u1", "leafypod/u1/actuator/light/set", b"").unwrap(),
            Inbound::ActuatorSet(ActuatorId::Light, ActuatorCommand::default())
        );
        assert_eq!(
            parse_inbound("u1", "leafypod/u1/alert/pump_fault/ack", b"{}").unwrap(),
            Inbound::AlertAck(AlertKind::PumpFault)
        );
        assert_eq!(
            parse_inbound("u1", "leafypod/u1/ha/light/set", b"ON").unwrap(),
            Inbound::ActuatorSet(
                ActuatorId::Light,
                ActuatorCommand {
                    on: Some(true),
                    ..Default::default()
                }
            )
        );
        for (topic, payload) in [
            ("leafypod/u1/actuator/fan/set", b"{}".as_slice()),
            ("leafypod/u1/actuator/pump/set", b"{\"on\":\"yes\"}"),
            ("leafypod/u1/alert/nope/ack", b"{}"),
            ("leafypod/u1/ha/light/set", b"maybe"),
            ("leafypod/u1/something/else", b"{}"),
            ("leafypod/u2/actuator/pump/set", b"{}"),
            ("leafypod/u1/actuator/pump/set", &[0xFF, 0xFE]),
        ] {
            assert!(parse_inbound("u1", topic, payload).is_err(), "{topic}");
        }
    }

    #[tokio::test]
    async fn run_with_invalid_settings_drains_and_returns() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (itx, _irx) = std::sync::mpsc::channel();
        tx.send(Outbound::retained("t", "p")).unwrap();
        drop(tx);
        run(
            MqttSettings {
                url: "bogus".into(),
                username: None,
                password: None,
            },
            "u1".into(),
            itx,
            rx,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
    }

    #[tokio::test]
    async fn run_survives_an_unreachable_broker_and_stops_when_the_engine_closes() {
        // Port 1 on localhost refuses immediately; the loop must back off, not panic,
        // and exit once the outbound channel closes.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (itx, _irx) = std::sync::mpsc::channel();
        let connected = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(run(
            MqttSettings {
                url: "mqtt://127.0.0.1:1".into(),
                username: None,
                password: None,
            },
            "u1".into(),
            itx,
            rx,
            connected.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(300)).await;
        tx.send(Outbound::retained("leafypod/u1/x", "dropped while offline"))
            .unwrap();
        drop(tx);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!connected.load(Ordering::Relaxed));
    }
}
