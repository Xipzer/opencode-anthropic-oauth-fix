# Opencode Anthropic OAuth Fix

Thin multi-account extension for **Kimaki's built-in Anthropic plugin**.

This repo no longer ships a second full Anthropic auth/request-rewrite stack.
Instead, it layers only multi-account orchestration on top of Kimaki's existing
single-account Anthropic implementation.

This version includes:

- labeled saved Anthropic OAuth accounts
- manual switching between saved Anthropic accounts
- reactive failover to another saved account on Anthropic rate limits/auth failures
- persistence of saved-account metadata in `anthropic-accounts.json`
- reuse of Kimaki's built-in Anthropic OAuth flow, refresh locking, and Claude Code request shaping

## Quick install

```bash
git clone https://github.com/Xipzer/opencode-anthropic-oauth-fix.git
cd opencode-anthropic-oauth-fix
chmod +x install.sh
bash ./install.sh
```

Then restart OpenCode/Kimaki or start a fresh session.

## Uninstall

If you only want to remove this repo's local multi-account wrapper and saved-account sidecar files while keeping Kimaki's built-in Anthropic behavior, run:

```bash
git clone https://github.com/Xipzer/opencode-anthropic-oauth-fix.git
cd opencode-anthropic-oauth-fix
chmod +x uninstall.sh
bash ./uninstall.sh
```

This removes:

- `~/.config/opencode/plugins/opencode-anthropic-auth.ts`
- `~/.config/opencode/anthropic-accounts.json`
- `~/.config/opencode/anthropic-pending-oauth.json`
- `~/.config/opencode/anthropic-auth-debug.log`

The last two are legacy cleanup from the older standalone implementation.

It does **not** remove:

- `~/.config/opencode/package.json`
- `~/.local/share/opencode/auth.json`
- the installed `kimaki` dependency used by the thin wrapper

So uninstalling this repo's patch falls back to Kimaki's built-in Anthropic plugin behavior after a restart or fresh session.

If you ever see `/usr/bin/env: 'bash\r': Permission denied`, your checkout converted the script to CRLF line endings. Fix it once with:

```bash
sed -i 's/\r$//' install.sh
bash ./install.sh
```

## What gets installed

- `~/.config/opencode/package.json`
- `~/.config/opencode/plugins/opencode-anthropic-auth.ts`
- `~/.config/opencode/anthropic-accounts.json` (created after you save accounts)

The installer does not need to rewrite `opencode.json` in the thin-wrapper design.

## Architecture

The extension adds a saved-account layer on top of Kimaki's canonical Anthropic auth slot.

- `anthropic-accounts.json` stores labeled saved OAuth accounts plus active-account metadata
- Kimaki's built-in Anthropic plugin remains authoritative for:
  - OAuth login
  - token refresh
  - refresh locking
  - Claude Code-compatible request shaping
- the extension overrides the `anthropic` auth hook only to add:
  - `Add Claude Pro/Max Account`
  - `Use saved Anthropic account`
  - reactive failover between saved accounts
- the canonical OpenCode `auth.json` slot remains the live active credential

That means this repo is an extension layer, not a replacement auth provider.

## Root Cause Fixed

The critical long-running failure mode in the earlier version of this repo came from trying to replace too much of Kimaki's built-in Anthropic implementation.

The unsafe parts were:

- duplicate auth/request-shaping logic outside Kimaki's built-in plugin
- saved-account state drifting from OpenCode's canonical live auth slot
- background refresh / failover logic acting on a second auth control plane

The current architecture fixes that by:

- delegating auth and request shaping back to Kimaki's built-in Anthropic plugin
- keeping this repo focused on saved-account orchestration only
- using the canonical Anthropic auth slot as the single live source of truth

## Anthropic methods added

- `Add Claude Pro/Max Account`
- `Use saved Anthropic account`
- `Create an API Key`
- `Manually enter API Key`

## Multi-account flow

1. Run `opencode providers login --provider anthropic`
2. Choose `Add Claude Pro/Max Account`
3. Enter a label such as `personal`, `work`, or `backup`
4. Repeat for as many Anthropic OAuth accounts as you want
5. Switch manually later with `Use saved Anthropic account`

When Anthropic returns a `rate_limit_error`, the plugin will try another saved account automatically and replay the same request.

## Which method to use

- `Add Claude Pro/Max Account`: Kimaki's built-in plugin automatically chooses localhost auto-complete or remote/manual mode based on the runtime environment

## Verify

```bash
opencode providers login --provider anthropic --method nope
```

That should list the Anthropic auth methods.

Then log in with:

```bash
opencode providers login --provider anthropic
```

## Debugging

If auth fails again, inspect:

```text
~/.config/opencode/anthropic-auth-debug.log
```

## Environment overrides

- `ANTHROPIC_DEFAULT_ACCOUNT_LABEL`
- `ANTHROPIC_RATE_LIMIT_COOLDOWN_MS`

## Notes

- This installer is written for bash-compatible environments.
- On Windows, use Git Bash, WSL, or another POSIX-compatible shell.
- The uninstall script removes only this repo's local extension layer, not Kimaki's built-in Anthropic plugin or existing canonical auth state.
