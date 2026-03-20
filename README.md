# Opencode Anthropic OAuth Fix

Patch repo for restoring Anthropic Claude Pro/Max OAuth in OpenCode/Kimaki.

This version is confirmed working and includes:

- Anthropic OAuth login restoration
- local `localhost` auto callback flow
- manual/remote fallback flow for SSH, WSL, and JetBrains Remote
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

## Anthropic methods added

- `Claude Pro/Max`
- `Claude Pro/Max (Manual / Remote)`
- `Create an API Key`
- `Create an API Key (Manual / Remote)`
- `Manually enter API Key`

## Which method to use

- `Claude Pro/Max`: use when browser and OpenCode run on the same machine and `localhost` callback works
- `Claude Pro/Max (Manual / Remote)`: use for JetBrains Remote, SSH, WSL, and split browser/terminal setups

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
