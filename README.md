# Opencode Anthropic OAuth Fix

Patch repo for restoring Anthropic Claude Pro/Max OAuth in OpenCode/Kimaki.

This version is confirmed working and includes:

- Anthropic OAuth login restoration
- labeled multi-account Anthropic OAuth support
- local `localhost` auto callback flow
- manual/remote fallback flow for SSH, WSL, and JetBrains Remote
- recovery from overwritten/stale pending manual OAuth attempts
- manual switching between saved Anthropic accounts
- automatic failover to another saved account on Anthropic rate limits
- periodic background refresh for saved Anthropic accounts to keep them warm
- quarantine of accounts whose refresh tokens are invalid
- token auto-refresh
- Claude Code-style runtime request shaping
- debug logging for auth failures
- environment variable overrides for endpoints, scopes, beta flags, and user agent

## Quick install

```bash
git clone https://github.com/Xipzer/opencode-anthropic-oauth-fix.git
cd opencode-anthropic-oauth-fix
chmod +x install.sh
bash ./install.sh
```

Then restart OpenCode/Kimaki or start a fresh session.

If you ever see `/usr/bin/env: 'bash\r': Permission denied`, your checkout converted the script to CRLF line endings. Fix it once with:

```bash
sed -i 's/\r$//' install.sh
bash ./install.sh
```

## What gets installed

- `~/.config/opencode/package.json`
- `~/.config/opencode/opencode.json`
- `~/.config/opencode/plugins/opencode-anthropic-auth.ts`
- `~/.config/opencode/anthropic-accounts.json` (created after you save accounts)
- `~/.config/opencode/anthropic-pending-oauth.json` (created during manual auth flows)

## Architecture

The patch adds a local Anthropic account manager on top of OpenCode's normal single-provider auth slot.

- `anthropic-accounts.json` stores labeled saved OAuth accounts plus active-account state
- the active account is mirrored back into OpenCode's canonical `auth.json`
- manual auth attempts are tracked in `anthropic-pending-oauth.json` so stale/overwritten dialogs can still be redeemed safely
- runtime requests use the active account and reactively fail over to another saved account on Anthropic `429` responses
- saved accounts are refreshed periodically in the background so inactive accounts do not silently rot
- accounts with invalid refresh tokens are quarantined instead of being retried forever

## Anthropic methods added

- `Add Claude Pro/Max Account`
- `Add Claude Pro/Max Account (Manual / Remote)`
- `Use saved account: <label>`
- `Create an API Key`
- `Create an API Key (Manual / Remote)`
- `Manually enter API Key`

## Multi-account flow

1. Run `opencode providers login --provider anthropic`
2. Choose `Add Claude Pro/Max Account` or `Add Claude Pro/Max Account (Manual / Remote)`
3. Enter a label such as `personal`, `work`, or `backup`
4. Repeat for as many Anthropic OAuth accounts as you want
5. Switch manually later with `Use saved account: <label>`

When Anthropic returns a `rate_limit_error`, the plugin will try another saved account automatically and replay the same request.

By default, the patch does **not** poll Anthropic's `/api/oauth/usage` endpoint. It relies on reactive failover from real runtime `429`s because the usage endpoint is noisy and can be rate-limited independently. Usage polling can be re-enabled explicitly if you want it.

## Which method to use

- `Add Claude Pro/Max Account`: use when browser and OpenCode run on the same machine and `localhost` callback works
- `Add Claude Pro/Max Account (Manual / Remote)`: use for JetBrains Remote, SSH, WSL, and split browser/terminal setups

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

- `ANTHROPIC_CLIENT_ID`
- `ANTHROPIC_AUTHORIZE_URL`
- `ANTHROPIC_CONSOLE_AUTHORIZE_URL`
- `ANTHROPIC_TOKEN_URL`
- `ANTHROPIC_REDIRECT_URI`
- `ANTHROPIC_SCOPES`
- `ANTHROPIC_CONSOLE_SCOPES`
- `ANTHROPIC_BETA_FLAGS`
- `ANTHROPIC_CLI_VERSION`
- `ANTHROPIC_USER_AGENT`
- `ANTHROPIC_BACKGROUND_REFRESH_INTERVAL_MS`
- `ANTHROPIC_BACKGROUND_REFRESH_EXPIRY_MARGIN_MS`
- `ANTHROPIC_ENABLE_USAGE_POLLING`
- `ANTHROPIC_USAGE_CACHE_TTL_MS`
- `ANTHROPIC_USAGE_RATE_LIMIT_BACKOFF_MS`
- `ANTHROPIC_RATE_LIMIT_COOLDOWN_MS`

## Notes

- This installer is written for bash-compatible environments.
- On Windows, use Git Bash, WSL, or another POSIX-compatible shell.
