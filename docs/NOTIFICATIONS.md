---
type: "Guide"
title: "Notifications"
description: "Get the pod's problems and reminders on your phone with the free ntfy app, or send them to Discord, Slack, Home Assistant or your own server with a webhook."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-20T22:00:00+00:00"}
sources: [{"resource": "/adr/0032-outbound-notifications.md", "title": "ADR 0032: Outbound notifications"}]
---

# Notifications

The unit can tell you when it needs you: the water is low, the pump faulted,
it's time to thin or harvest, an Autopilot rule fired. Notifications are off
until you turn them on in **Settings → Notifications**.

## On your phone

1. Install **ntfy**. It's free on the App Store and Google Play, with no
   account.
2. In **Settings → Notifications**, pick **Phone**. The unit makes a topic
   (like `seedypod-k7m2xq9rtp4a`) and shows it with a QR code.
3. Subscribe to the topic:
   - **Android:** scan the QR code with the camera, or open the link on the
     phone. ntfy opens and subscribes.
   - **iPhone:** in ntfy tap **+** and type the topic.
4. Tap **Send test**. A notification arrives within a few seconds.

Notifications pass through the ntfy.sh server, and anyone who knows the topic
can read them. That's why the topic is long and random: keep it to yourself.
**New topic** replaces it; phones subscribed to the old one stop getting
notifications. If you run your own ntfy server, the unit can use that instead
(ask the API: `PATCH /api/notifications` with `ntfyServer`).

## With a webhook

Pick **Webhook**, paste the URL and pick a format:

| Format | Sends | Use it for |
|---|---|---|
| Discord | `{ "username", "content" }` | A Discord channel's webhook (Channel settings → Integrations → Webhooks) |
| Slack | `{ "text" }` | A Slack incoming webhook |
| JSON | `{ "event", "at", "unit", "title", "emoji", "message", "priority", "data" }` | Home Assistant's webhook trigger, n8n, your own server |

A Discord or Slack URL sets its format for you, and the format picker only
appears for other servers: Discord and Slack refuse any other shape.

Each message leads with one emoji for what happened, like
`**Gardyn** · 💧 Watering: Watered for 10 min, tank 83% full.` on Discord.
JSON keeps `title` plain and puts the emoji in its own `emoji` field, so an
automation matching on the title keeps working.

`event` is `alerts.raised`, `alerts.cleared`, `reminders.raised`,
`autopilot.raised`, `watering.ran`, `lights.changed` or `test`. With a **signing secret** set,
each JSON body carries `X-Seedypod-Signature: sha256=<hex>`, the HMAC-SHA256
of the body with your secret, so your server can tell the request came from
the unit.

The URL must start with `https://`, except for a server on your own network
(`http://homeassistant.local:8123/…` is fine). Once saved, the URL is shown
only masked; paste a new one to replace it.

## What gets sent

Each notification starts with an emoji: 🚱 water low, ⚠️ a pump fault,
🧪 a dosing lockout, 🌡️ the board too hot, 📷 a camera, 🔌 the hardware
daemon, ☁️ the off-device copy, ⏰ a missed watering, 🛠️ setup left to do,
🌱 ✂️ 🥄 🚰 🔍 🧺 reminders, 🤖 Autopilot, 💧 a pump run, 💡 the light on or
brighter, 🔅 dimmer, 🌙 off, ✅ anything resolved and 🔔 a test. On a phone,
ntfy shows it in front of the title.

| Switch | Default | Sends |
|---|---|---|
| Problems | on | Water low, pump faults, a camera or the hardware daemon down, a missed watering, a failed backup; and a "resolved" message when one clears by itself |
| Reminders | on | Thin, feed, top off, check roots, harvest |
| Autopilot | on | A rule's **Notify** action |
| Watering | off | Every pump run, with how long it ran and how full the tank is. Several a day |
| Lights | off | The light turning on, off, dimming or brightening, and whether the schedule, Autopilot or a person did it |

Each alert notifies once when it opens, not while it stays open. An alert
that keeps coming and going notifies at most once every 15 minutes.

A light change is sent once the light has held for three minutes, so a
sunrise ramp or a fade is one message with where it ended up, not one a
minute. Moves under 5% while the light stays on aren't sent.

If a server doesn't answer, the unit tries again after 10 seconds, a minute
and five minutes, then gives up on that message. The last delivery, and why it
failed, shows under **Send test**.
