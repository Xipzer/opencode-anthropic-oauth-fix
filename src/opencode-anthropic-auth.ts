import { spawn } from "node:child_process"
import { once } from "node:events"
import { appendFile } from "node:fs/promises"
import { createServer } from "node:http"
import { generatePKCE } from "@openauthjs/openauth/pkce"
import { AnthropicAuthPlugin as BaseAnthropicAuthPlugin } from "opencode-anthropic-auth"

const CLIENT_ID = process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_AI_AUTHORIZE_URL = process.env.ANTHROPIC_AUTHORIZE_URL || "https://claude.ai/oauth/authorize"
const CONSOLE_AUTHORIZE_URL = process.env.ANTHROPIC_CONSOLE_AUTHORIZE_URL || "https://platform.claude.com/oauth/authorize"
const TOKEN_URL = process.env.ANTHROPIC_TOKEN_URL || "https://platform.claude.com/v1/oauth/token"
const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const MANUAL_REDIRECT_URL = process.env.ANTHROPIC_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback"
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code"
const LOCALHOST = "localhost"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEBUG_LOG = `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ""}/.config`}/opencode/anthropic-auth-debug.log`
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CODE_BETA_HEADERS = process.env.ANTHROPIC_BETA_FLAGS || "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
const CLAUDE_CLI_VERSION = process.env.ANTHROPIC_CLI_VERSION || "2.1.80"
const CLAUDE_CODE_USER_AGENT = process.env.ANTHROPIC_USER_AGENT || `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`
const MCP_TOOL_PREFIX = "mcp_"
const CLAUDE_AI_SCOPES = (process.env.ANTHROPIC_SCOPES || "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload")
  .split(/\s+/)
  .filter(Boolean)
const CONSOLE_SCOPES = (process.env.ANTHROPIC_CONSOLE_SCOPES || "org:create_api_key user:profile")
  .split(/\s+/)
  .filter(Boolean)

type Candidate = {
  code: string
  state: string
}

function cleanInput(value: string) {
  return value.trim().replace(/\s+/g, "")
}

function extractSystemText(system: unknown) {
  if (Array.isArray(system)) {
    return system
      .filter((item): item is { type?: string; text?: string } => Boolean(item && typeof item === "object"))
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n\n")
  }

  if (typeof system === "string") return system
  return ""
}

function stripClaudeCodePrompt(value: string) {
  return value.split(CLAUDE_CODE_SYSTEM_PROMPT).join("").trim()
}

async function debugLog(event: string, data: Record<string, unknown>) {
  const payload = {
    time: new Date().toISOString(),
    event,
    ...data,
  }

  console.error(`[anthropic-auth] ${event}`, payload)
  try {
    await appendFile(DEBUG_LOG, `${JSON.stringify(payload)}\n`)
  } catch {}
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 3) {
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const response = await fetch(url, init)
    if (response.status !== 429 || attempt === retries - 1) return response

    lastResponse = response
    await debugLog("token_retry_scheduled", {
      url,
      status: response.status,
      attempt: attempt + 1,
      retries,
    })
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000))
  }

  return lastResponse ?? fetch(url, init)
}

function addCandidate(candidates: Candidate[], seen: Set<string>, code?: string | null, state?: string | null) {
  if (!code || code === "true" || !state) return
  const key = `${code}#${state}`
  if (seen.has(key)) return
  seen.add(key)
  candidates.push({ code, state })
}

function addUrlCandidates(candidates: Candidate[], seen: Set<string>, url: URL, verifier: string) {
  const queryCode = url.searchParams.get("code")
  const queryState = url.searchParams.get("state")
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
  const hashParams = new URLSearchParams(hash)
  const hashCode = hashParams.get("code")
  const hashState = hashParams.get("state")

  addCandidate(candidates, seen, queryCode, queryState ?? hashState ?? hash ?? verifier)
  addCandidate(candidates, seen, hashCode, hashState ?? queryState ?? verifier)
}

function getCandidates(value: string, verifier: string) {
  const input = cleanInput(value)
  const seen = new Set<string>()
  const candidates: Candidate[] = []

  if (!input) return candidates

  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      addUrlCandidates(candidates, seen, new URL(input), verifier)
    } catch {}
  }

  if (input.includes("?") || input.includes("&")) {
    try {
      const params = new URLSearchParams(input.replace(/^[^?#]*[?#]/, ""))
      addCandidate(candidates, seen, params.get("code"), params.get("state") ?? verifier)
    } catch {}
  }

  const hashIndex = input.indexOf("#")
  if (hashIndex !== -1) {
    const left = input.slice(0, hashIndex)
    const right = input.slice(hashIndex + 1)
    addCandidate(candidates, seen, left, right)
    addCandidate(candidates, seen, right, left)
  }

  addCandidate(candidates, seen, input, verifier)
  return candidates
}

function buildAuthUrl(authorizeUrl: string, scopes: string[], verifier: string, challenge: string, redirectUri: string) {
  const url = new URL(authorizeUrl)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", scopes.join(" "))
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", verifier)
  return url.toString()
}

async function exchangeCode(code: string, state: string, verifier: string, redirectUri: string) {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_CODE_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  })

  if (!response.ok) {
    const error = await response.text().catch(() => "")
    await debugLog("token_exchange_failed", {
      status: response.status,
      redirectUri,
      codeLength: code.length,
      stateLength: state.length,
      error,
    })
    throw new Error(error || `Token exchange failed: ${response.status}`)
  }

  const json = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

async function refreshTokens(refreshToken: string) {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_CODE_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const error = await response.text().catch(() => "")
    throw new Error(error || `Token refresh failed: ${response.status}`)
  }

  return (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
}

async function authorizeWithManualCode(value: string, verifier: string, redirectUri: string) {
  const candidates = getCandidates(value, verifier)
  let lastError = ""

  for (const [index, candidate] of candidates.entries()) {
    try {
      return await exchangeCode(candidate.code, candidate.state, verifier, redirectUri)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await debugLog("manual_candidate_failed", {
        redirectUri,
        index,
        candidateCodeLength: candidate.code.length,
        candidateStateLength: candidate.state.length,
        lastError,
      })
    }
  }

  await debugLog("manual_exchange_failed", {
    redirectUri,
    inputLength: cleanInput(value).length,
    candidatesTried: candidates.length,
    lastError,
  })

  return { type: "failed" as const }
}

function openBrowser(url: string) {
  const commands = (() => {
    if (process.platform === "darwin") return [["open", [url]]]
    if (process.platform === "win32") return [["cmd", ["/c", "start", "", url]]]
    return [
      ["xdg-open", [url]],
      ["wslview", [url]],
    ]
  })()

  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return true
    } catch {}
  }

  return false
}

async function startLocalAuth(authorizeUrl: string, scopes: string[]) {
  const pkce = await generatePKCE()
  const server = createServer()
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined

    server.on("request", (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", `http://${LOCALHOST}`)
        if (requestUrl.pathname !== "/callback") {
          response.statusCode = 404
          response.end("Not found")
          return
        }

        const code = requestUrl.searchParams.get("code")
        const state = requestUrl.searchParams.get("state")
        if (!code || !state) {
          response.statusCode = 400
          response.setHeader("content-type", "text/plain; charset=utf-8")
          response.end("Missing code or state in callback URL.")
          return
        }

        response.statusCode = 302
        response.setHeader("location", SUCCESS_URL)
        response.end()
        if (timeout) clearTimeout(timeout)
        server.close()
        resolve({ code, state })
      } catch (error) {
        if (timeout) clearTimeout(timeout)
        server.close()
        reject(error)
      }
    })

    server.once("error", reject)
    server.listen(0, LOCALHOST)

    void once(server, "listening").then(() => {
      timeout = setTimeout(() => {
        server.close()
        reject(new Error("Timed out waiting for the Anthropic browser callback."))
      }, CALLBACK_TIMEOUT_MS)
    })
  })

  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Failed to allocate local callback port.")
  }

  const redirectUri = `http://${LOCALHOST}:${address.port}/callback`
  const url = buildAuthUrl(authorizeUrl, scopes, pkce.verifier, pkce.challenge, redirectUri)

  return {
    url,
    redirectUri,
    verifier: pkce.verifier,
    open: () => openBrowser(url),
    async finish() {
      const result = await callback
      return exchangeCode(result.code, result.state, pkce.verifier, redirectUri)
    },
  }
}

function createAutoAuthMethod(label: string, authorizeUrl: string, scopes: string[]) {
  return {
    label,
    type: "oauth" as const,
    authorize: async () => {
      const flow = await startLocalAuth(authorizeUrl, scopes)
      const opened = flow.open()

      return {
        url: flow.url,
        instructions: opened
          ? "Browser opened. Waiting for the Anthropic callback. Press c to copy the URL if you need to reopen it."
          : "Open the link in your browser. This auto flow only works when your browser can reach this machine's localhost callback.",
        method: "auto" as const,
        callback: async () => {
          try {
            return await flow.finish()
          } catch {
            return { type: "failed" as const }
          }
        },
      }
    },
  }
}

function createManualAuthMethod(label: string, authorizeUrl: string, scopes: string[]) {
  return {
    label,
    type: "oauth" as const,
    authorize: async () => {
      const pkce = await generatePKCE()
      const url = buildAuthUrl(authorizeUrl, scopes, pkce.verifier, pkce.challenge, MANUAL_REDIRECT_URL)
      const opened = openBrowser(url)

      return {
        url,
        instructions: opened
          ? "Browser opened. Finish Anthropic login, then paste the final callback URL, the returned code#state value, or the raw Authentication Code here."
          : "Open the link, finish Anthropic login, then paste the final callback URL, the returned code#state value, or the raw Authentication Code here.",
        method: "code" as const,
        callback: async (value: string) => authorizeWithManualCode(value, pkce.verifier, MANUAL_REDIRECT_URL),
      }
    },
  }
}

export async function AnthropicAuthPlugin(input: Parameters<typeof BaseAnthropicAuthPlugin>[0]) {
  const hooks = await BaseAnthropicAuthPlugin(input)
  if (!hooks.auth || hooks.auth.provider !== "anthropic") return hooks

  const baseLoader = hooks.auth.loader?.bind(hooks.auth)

  return {
    ...hooks,
    auth: {
      ...hooks.auth,
      loader: baseLoader
        ? async (getAuth, provider) => {
            const loaded = await baseLoader(getAuth, provider)
            if (!loaded.fetch) return loaded

            return {
              ...loaded,
              async fetch(request, init) {
                let auth = await getAuth()
                if (auth.type === "oauth" && (!auth.access || auth.expires < Date.now())) {
                  const refreshed = await refreshTokens(auth.refresh)
                  await input.client.auth.set({
                    path: {
                      id: "anthropic",
                    },
                    body: {
                      type: "oauth",
                      refresh: refreshed.refresh_token ?? auth.refresh,
                      access: refreshed.access_token,
                      expires: Date.now() + refreshed.expires_in * 1000,
                    },
                  })
                  auth = {
                    ...auth,
                    access: refreshed.access_token,
                    refresh: refreshed.refresh_token ?? auth.refresh,
                    expires: Date.now() + refreshed.expires_in * 1000,
                  }
                }

                if (auth.type !== "oauth") return loaded.fetch(request, init)

                const requestHeaders = new Headers()
                if (request instanceof Request) {
                  request.headers.forEach((value, key) => {
                    requestHeaders.set(key, value)
                  })
                }
                if (init?.headers) {
                  new Headers(init.headers).forEach((value, key) => {
                    requestHeaders.set(key, value)
                  })
                }

                const requestInit: RequestInit = request instanceof Request
                  ? {
                      method: request.method,
                      body: request.body,
                      cache: request.cache,
                      credentials: request.credentials,
                      integrity: request.integrity,
                      keepalive: request.keepalive,
                      mode: request.mode,
                      redirect: request.redirect,
                      referrer: request.referrer,
                      referrerPolicy: request.referrerPolicy,
                      signal: request.signal,
                    }
                  : {}

                if (init) Object.assign(requestInit, init)

                let finalUrl: string | null = null
                try {
                  if (typeof request === "string" || request instanceof URL) {
                    finalUrl = request.toString()
                  } else if (request instanceof Request) {
                    finalUrl = request.url
                  }
                } catch {}

                let body = requestInit.body
                if (finalUrl && finalUrl.includes("/v1/messages")) {
                  const url = new URL(finalUrl)
                  if (!url.searchParams.has("beta")) {
                    url.searchParams.set("beta", "true")
                  }
                  finalUrl = url.toString()

                  requestHeaders.set("anthropic-beta", CLAUDE_CODE_BETA_HEADERS)
                  requestHeaders.set("user-agent", CLAUDE_CODE_USER_AGENT)
                  requestHeaders.set("x-app", "cli")
                  requestHeaders.set("authorization", `Bearer ${auth.access}`)
                  requestHeaders.delete("x-api-key")

                  if (typeof body === "string") {
                    try {
                      const parsed = JSON.parse(body)
                      const customSystemText = stripClaudeCodePrompt(extractSystemText(parsed.system))

                      parsed.system = CLAUDE_CODE_SYSTEM_PROMPT

                      if (customSystemText) {
                        const messages = Array.isArray(parsed.messages) ? parsed.messages : []
                        messages.unshift({
                          role: "user",
                          content: `[System Instructions]\n${customSystemText}`,
                        })
                        messages.splice(1, 0, {
                          role: "assistant",
                          content: "Understood. I'll follow these instructions.",
                        })
                        parsed.messages = messages
                      }

                      if (Array.isArray(parsed.tools)) {
                        parsed.tools = parsed.tools.map((tool: Record<string, unknown>) => ({
                          ...tool,
                          name: typeof tool.name === "string" && !tool.name.startsWith(MCP_TOOL_PREFIX)
                            ? `${MCP_TOOL_PREFIX}${tool.name}`
                            : tool.name,
                        }))
                      }

                      if (Array.isArray(parsed.messages)) {
                        parsed.messages = parsed.messages.map((message: Record<string, unknown>) => {
                          if (!Array.isArray(message.content)) return message

                          return {
                            ...message,
                            content: message.content.map((block: Record<string, unknown>) => {
                              if (block.type !== "tool_use" || typeof block.name !== "string") return block
                              if (block.name.startsWith(MCP_TOOL_PREFIX)) return block
                              return {
                                ...block,
                                name: `${MCP_TOOL_PREFIX}${block.name}`,
                              }
                            }),
                          }
                        })
                      }

                      body = JSON.stringify(parsed)
                    } catch {}
                  }
                } else {
                  requestHeaders.set("x-app", "cli")
                  requestHeaders.set("authorization", `Bearer ${auth.access}`)
                  requestHeaders.delete("x-api-key")
                }

                const response = await fetch(finalUrl ?? request, {
                  ...requestInit,
                  body,
                  headers: requestHeaders,
                })

                if (!response.body) return response

                const reader = response.body.getReader()
                const decoder = new TextDecoder()
                const encoder = new TextEncoder()

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read()
                    if (done) {
                      controller.close()
                      return
                    }

                    let text = decoder.decode(value, { stream: true })
                    text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                    controller.enqueue(encoder.encode(text))
                  },
                })

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                })
              },
            }
          }
        : undefined,
      methods: [
        createAutoAuthMethod("Claude Pro/Max", CLAUDE_AI_AUTHORIZE_URL, CLAUDE_AI_SCOPES),
        createManualAuthMethod("Claude Pro/Max (Manual / Remote)", CLAUDE_AI_AUTHORIZE_URL, CLAUDE_AI_SCOPES),
        {
          ...createAutoAuthMethod("Create an API Key", CONSOLE_AUTHORIZE_URL, CONSOLE_SCOPES),
          authorize: async () => {
            const flow = await startLocalAuth(CONSOLE_AUTHORIZE_URL, CONSOLE_SCOPES)
            const opened = flow.open()

            return {
              url: flow.url,
              instructions: opened
                ? "Browser opened. Waiting for the Anthropic callback. Press c to copy the URL if you need to reopen it."
                : "Open the link in your browser. This auto flow only works when your browser can reach this machine's localhost callback.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const credentials = await flow.finish()
                  if (credentials.type === "failed") return credentials

                  const response = await fetch(API_KEY_URL, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  })
                  if (!response.ok) return { type: "failed" as const }

                  const result = (await response.json()) as { raw_key?: string }
                  if (!result.raw_key) return { type: "failed" as const }
                  return { type: "success" as const, key: result.raw_key }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          ...createManualAuthMethod("Create an API Key (Manual / Remote)", CONSOLE_AUTHORIZE_URL, CONSOLE_SCOPES),
          authorize: async () => {
            const pkce = await generatePKCE()
            const url = buildAuthUrl(CONSOLE_AUTHORIZE_URL, CONSOLE_SCOPES, pkce.verifier, pkce.challenge, MANUAL_REDIRECT_URL)
            const opened = openBrowser(url)

            return {
              url,
              instructions: opened
                ? "Browser opened. Finish Anthropic login, then paste the final callback URL, the returned code#state value, or the raw Authentication Code here."
                : "Open the link, finish Anthropic login, then paste the final callback URL, the returned code#state value, or the raw Authentication Code here.",
              method: "code" as const,
              callback: async (value: string) => {
                const credentials = await authorizeWithManualCode(value, pkce.verifier, MANUAL_REDIRECT_URL)
                if (credentials.type === "failed") return credentials

                const response = await fetch(API_KEY_URL, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                })
                if (!response.ok) return { type: "failed" as const }

                const result = (await response.json()) as { raw_key?: string }
                if (!result.raw_key) return { type: "failed" as const }
                return { type: "success" as const, key: result.raw_key }
              },
            }
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api" as const,
        },
      ],
    },
  }
}
