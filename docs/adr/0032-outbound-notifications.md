---
type: "Decision record"
title: "ADR 0032: Outbound notifications"
description: "Pod events go to an ntfy topic or a webhook the owner picks: ntfy with a random topic and a QR for most owners, a webhook for the rest. Opt-in event groups, one notification per alert transition, https off the LAN, the webhook URL never returned."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-20T22:00:00+00:00"}
sources: [{"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0013-ha-bridge.md", "title": "ADR 0013: Core-level MQTT bridge for Home Assistant"}, {"resource": "/adr/0023-homekit.md", "title": "ADR 0023: HomeKit"}, {"resource": "https://docs.ntfy.sh/publish/", "title": "ntfy: publishing"}, {"resource": "https://docs.ntfy.sh/subscribe/phone/", "title": "ntfy: phone apps and ntfy:// links"}]
---

# ADR 0032: Outbound notifications

**Status:** Accepted
**Date:** 2026-11-20

## Context

The implementation plan made Home Assistant the only notification channel and
ruled out a push service of our own (ADR 0013). That leaves owners without Home
Assistant with nothing: the HomeKit tank-as-battery covers water low on
iPhones (ADR 0023), and every other alert waits in the web UI until someone
opens it. Autopilot's Notify action doesn't reach Home Assistant either.

A webhook field reaches everything, but most owners can't use one: they'd
have to dig a URL out of Discord's or Slack's settings first.

## Decision

`src/notify/` sends pod events to **one target** the owner picks in
**Settings → Notifications**. It's off until they pick one.

- **Phone (ntfy).** This is the default path. The owner installs the free
  [ntfy](https://ntfy.sh) app. The unit makes a random topic
  (`seedypod-` + 12 characters, about 59 bits) and shows it with a QR of the
  `ntfy://` link: the Android app subscribes from that link, and on iPhone,
  which has no such link, the owner types the topic. Core publishes JSON to
  the server root, `https://ntfy.sh` unless the owner runs their own.
- **Webhook.** A URL and a format: plain JSON (`{ event, at, unit, title,
  emoji, message, priority, data }`), Discord or Slack. A JSON body can be signed
  with HMAC-SHA256 in `X-Seedypod-Signature: sha256=<hex>`.

Each event leads with **one emoji** for what happened (`emojiFor` in
`targets.ts`): inline before the title on Discord and Slack, as an ntfy
shortcode tag, which the app shows in front of the title, and in its own
`emoji` field in JSON, so `title` stays the plain string automations match on.

**Event groups**, each a switch: Problems (`alerts`), Reminders, Autopilot
on by default; Watering and Lights off by default, since they send several a
day. An alert
kind's group comes from its name (`reminder_*`/`chore_*`, `autopilot_*`, the
rest are problems).

**When something is sent.** The notifier wraps the store's `alerts.raise`
and `clear` once at start-up, because about fifteen places raise alerts and
the store is where they all meet. A raise sends only when it opens a new
alert, not when it refreshes one. A clear sends a "resolved" message for problems
only, and not when the owner cleared it themselves. The same alert kind
doesn't notify again for 15 minutes, so a flapping camera sends once. Pump runs
come from the HAL's `pumpRun` event. That topic is retained, so a run that
ended more than 5 minutes ago, or one already sent, is the broker's copy and
is skipped.
Light changes come from the HAL's `actuator` events for `light`. The first
state after start-up is the baseline, a change is sent once the light has held
for 3 minutes (the scheduler steps a ramp each minute, so a sunrise is one
message), and a move under 5% while the light stays on isn't sent. The light
arbiter's source at that moment says why: schedule, Autopilot or by hand.

**Delivery.** Delivery happens off the caller's path and sends one request at
a time, with a 10 s timeout. A 5xx or 429 retries after 10 s, 1 min and 5 min,
then the event is dropped. At most 20 events wait. Settings shows the
last delivery, and **Send test** sends one at once.

**Trust.** This is the second kind of outbound connection ADR 0012 allows,
after brokers the operator configures: it goes only to the target the owner
saved, and only once they pick one.

- A target must be `https://`, or plain `http://` to a LAN host
  (`localhost`, `*.local`, `*.lan`, `*.home.arpa`, private IPv4 and IPv6),
  so notifications are encrypted on the way off the network.
- The webhook URL is stored in plaintext in `device_settings` like the MQTT
  password and bucket keys (ADR 0012): anyone with the database already owns
  the unit, and a key on the same card would protect nothing. It is never
  returned by the API, MCP or `settings.get`, which show it masked
  (`https://discord.com/…abc1`). It never appears in logs or delivery errors.
  A backup holds it, like the unit's other secrets.
- The ntfy topic is shown to anyone on the LAN, like the HomeKit setup code,
  because the owner has to type it into the app. Settings says plainly that
  notifications pass through the ntfy server and that anyone with the topic
  can read them. **New topic** replaces it.

## Consequences

- An owner with only a phone gets problems and reminders with no account
  and no URL to paste.
- Notifications pass through a third party (ntfy.sh, Discord, Slack) unless
  the owner self-hosts. Messages carry the unit's name and the alert text,
  never photos or readings history.
- One target at a time. Sending to ntfy and a webhook together, per-group
  targets, and grow milestones (stage changes, harvests) are left for later.
- Home Assistant users can point the webhook at an HA webhook trigger, so
  Autopilot notices finally reach HA.
