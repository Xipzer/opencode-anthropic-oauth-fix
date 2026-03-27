# Opencode Anthropic OAuth Fix

Patch repo for restoring Anthropic Claude Pro/Max OAuth in OpenCode/Kimaki.

This version is confirmed working and includes:

- Anthropic OAuth login restoration
- labeled multi-account Anthropic OAuth support
- local `localhost` auto callback flow
- manual/remote fallback flow for SSH, WSL, and JetBrains Remote
- manual switching between saved Anthropic accounts
- automatic failover to another saved account on Anthropic rate limits
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

## Notes

- This installer is written for bash-compatible environments.
- On Windows, use Git Bash, WSL, or another POSIX-compatible shell.
