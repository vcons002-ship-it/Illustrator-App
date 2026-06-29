# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — don't open a public issue for a vulnerability.

- **Preferred:** use GitHub's **private vulnerability reporting** on this repository
  (the **Security** tab → **Report a vulnerability**). If it isn't enabled yet, a maintainer can turn
  it on under *Settings → Code security → Private vulnerability reporting*.

You'll get an acknowledgement and updates as a fix is worked. Thanks for helping keep users safe.

## Security model

Visual Reader is a **local, single-user application** — a desktop app (Tauri), a browser app, and a
browser extension. It is built **bring-your-own-key**:

- **Your API keys and OAuth credentials stay on your device.** They're entered in Settings and stored
  locally (IndexedDB in the browser / the OS app-data dir on desktop). They are **never** committed to
  this repository, and they're sent only directly to the provider you configured
  (OpenAI, Anthropic, Google, a local engine, …).
- **No secrets live in the repo.** There are no API keys, tokens, or OAuth client secrets in the
  source or in git history. OAuth (Google, Schwab) reads its client id/secret from *your* Settings.
- **The desktop build runs local tools** — it can run shell commands, read/write files, fetch URLs,
  and launch local MCP servers **on your own machine, with your consent**, the way a coding assistant
  does. The plain web build does **not** have these capabilities.

### If you self-host or expose access

The desktop's local-execution tools (`run_command`, file writes, arbitrary `http_fetch`, MCP process
spawning) are designed for a **single trusted user on their own machine**. Do **not** expose a desktop
instance — or the phone-link relay — to untrusted input or the open internet without your own access
controls; in a multi-user / hosted setting those tools could be abused (command execution / SSRF). The
phone link is gated by a per-session pairing token — keep it that way, and front any public tunnel
with authentication (e.g. an access proxy).

## Supported versions

This is an actively developed project; security fixes land on the default branch.
