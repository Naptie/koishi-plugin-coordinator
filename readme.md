# koishi-plugin-coordinator

[![npm](https://img.use-npm.com/badge/npm/v/koishi-plugin-coordinator?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-coordinator)

Dual-adapter group coordination for Koishi. When the same physical QQ group is served by two
bots — an official QQ bot (adapter-qq) and a OneBot implementation such as NapCat
(adapter-napcat / adapter-onebot) — this plugin makes the pair behave like a single bot:

- **Deduplication**: messages received through both adapters trigger exactly one reply.
- **Mention-aware answering**: `@`-mentioning either bot lets that bot pick up and answer the
  request directly; plain (unmentioned) messages are answered with the official bot's voice.
- **Adaptive delivery**: the final sender adapter is exposed to all plugins
  (`ctx.coordinator.getSendPlatform(session)`), so message rendering can adapt to the adapter
  that actually carries the reply (e.g. official markdown versus plain text).
- **Official-first sending with fallback**: replies for linked groups are delivered through the
  official bot (with passive-reply context and retry), automatically degrading to OneBot when
  the official send fails.
- **Quote support**: official-side `message_reference` quoting via msg_idx when the same
  message was observed on the official side.

## How it works

Groups on both sides are linked automatically (group name + member count + official-bot
presence, with manual overrides available in the config) and stored in the `groupLinks` table.
For every incoming session in a linked group the coordinator resolves a route: which session
executes, whether it is suppressed, and which adapter finally sends the reply. Send routing is
enforced at the `bot.sendMessage` level, making it immune to the session-object cloning that
koishi/cordis performs across its dispatch layers.

## For plugin authors

Consume the service with `inject = ['coordinator']` (or check `ctx.coordinator` for optional
use) and branch rendering on `ctx.coordinator.getSendPlatform(session)`. If your plugin has
messages without text content (e.g. JSON cards), register a match-key extractor so the
coordinator can still correlate the two sides:

```ts
ctx.coordinator.registerMatchKey((session) => {
  // return a stable string key for this message, or undefined
});
```

## Config

- `enabled`: enable/disable coordination (defaults to enabled).
- `suppressCommands`: block all command execution on official-side sessions of linked groups
  (defaults to enabled; the onebot session is the designated executor).
- `onebotSelfId` / `qqSelfId`: prefer a specific bot when several are connected.
- `officialRobotUin`: the official bot's QQ number; auto-resolved from the official API when
  omitted.
- `links`: manual group mappings for groups that cannot be auto-matched.
