# Herdr Status for Vicinae

See which [Herdr](https://herdr.dev) coding agents need input (`blocked`) or
finished (`done`) — local and remote machines — without leaving
[Vicinae](https://vicinae.com).

Each agent row shows live session cost (OpenCode, Pi) with `oc`-style numbers:
rounded spend and current context tokens, matching the OpenCode footer.

## Commands

- **Herdr Agent Status** (view) — agents grouped by status, auto-refreshing.
  Actions per agent: Focus (jumps to the pane, marks seen), Copy Last Output,
  Copy Pane ID.
- **Herdr Attention** (no-view, every minute) — menu-bar style subtitle such as
  `🔔 2 blocked · ✅ 1 done · 0 working`.

## Requirements

- [Herdr](https://herdr.dev) installed (`curl -fsSL https://herdr.dev/install.sh | sh`)
  with its server running (`herdr`).
- `sqlite3` on `PATH` (or `~/miniconda3/bin`, `/usr/bin`) for OpenCode cost
  lookup. Without it, rows simply show no cost.

## Preferences

- **Herdr binary** — path to `herdr` (default resolves via `PATH`, then
  `~/.local/bin/herdr`).
- **Refresh interval** — status view polling in seconds (default 5).

## Cost sources

- **OpenCode** (`oc`) — exact `cost` + token counters from
  `~/.local/share/opencode/opencode.db`; context = latest step total, same
  math as the `oc` footer; spend rounded to cents like `oc`.
- **Pi** — sums per-message `usage.cost.total` + tokens from
  `~/.pi/agent/sessions/*/*.jsonl`; title = first prompt.

## Develop

```sh
npm install
npm run build   # typechecks and installs to Vicinae (restart Vicinae to reload)
npm run lint
```
