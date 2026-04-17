import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { anthropicAuthPlugin as builtInAnthropicAuthPlugin } from "kimaki/src/anthropic-auth-plugin.ts"

const HOME = process.env.HOME ?? ""
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config"), "opencode")
const DATA_DIR = path.join(process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share"), "opencode")
const AUTH_FILE = path.join(DATA_DIR, "auth.json")
const ACCOUNTS_FILE = path.join(CONFIG_DIR, "anthropic-accounts.json")
const DEFAULT_IMPORTED_LABEL = process.env.ANTHROPIC_DEFAULT_ACCOUNT_LABEL || "default"
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.ANTHROPIC_RATE_LIMIT_COOLDOWN_MS) || 15 * 60 * 1000

type OAuthStored = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
}

type OAuthSuccess = {
  type: "success"
  provider?: string
  refresh: string
  access: string
  expires: number
}

type StoredAccount = {
  label: string
  refresh: string
  access: string
  expires: number
  addedAt: string
  updatedAt: string
  lastRateLimitAt?: string
}

type AccountHistoryEntry = {
  at: string
  action: string
  label?: string
  from?: string
  to?: string
  reason?: string
}

type AccountStore = {
  version: 1
  active?: string
  accounts: Record<string, StoredAccount>
  history: AccountHistoryEntry[]
}

function nowIso() {
  return new Date().toISOString()
}

function sanitizeLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 64)
}

function validateLabel(value: string) {
  const label = sanitizeLabel(value)
  if (!label) return "Required"
  if (label.length < 2) return "Use at least 2 characters"
  if (/\r|\n/.test(value)) return "Newlines are not allowed"
  return undefined
}

function emptyStore(): AccountStore {
  return {
    version: 1,
    accounts: {},
    history: [],
  }
}

function toOAuthBody(account: StoredAccount) {
  return {
    type: "oauth" as const,
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
  }
}

function toOAuthSuccess(account: StoredAccount): OAuthSuccess {
  return {
    type: "success",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
  }
}

function buildStoredAccount(label: string, auth: { refresh: string; access: string; expires: number }, previous?: StoredAccount): StoredAccount {
  const now = nowIso()
  return {
    label,
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
    addedAt: previous?.addedAt ?? now,
    updatedAt: now,
    lastRateLimitAt: previous?.lastRateLimitAt,
  }
}

function normalizeStore(store: Partial<AccountStore> | undefined): AccountStore {
  return {
    version: 1,
    active: typeof store?.active === "string" ? store.active : undefined,
    accounts: store?.accounts && typeof store.accounts === "object" ? store.accounts : {},
    history: Array.isArray(store?.history) ? store.history.filter(Boolean).slice(-50) as AccountHistoryEntry[] : [],
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8")
    return JSON.parse(content) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function loadCanonicalAnthropicAuth() {
  const data = await readJson<Record<string, unknown>>(AUTH_FILE, {})
  const auth = data?.anthropic as Partial<OAuthStored> | undefined
  if (!auth || auth.type !== "oauth") return
  if (typeof auth.refresh !== "string" || typeof auth.access !== "string" || typeof auth.expires !== "number") return
  return auth as OAuthStored
}

async function loadAccountStore() {
  return normalizeStore(await readJson<Partial<AccountStore>>(ACCOUNTS_FILE, emptyStore()))
}

async function saveAccountStore(store: AccountStore) {
  await writeJson(ACCOUNTS_FILE, store)
}

function addHistory(store: AccountStore, entry: AccountHistoryEntry) {
  store.history = [...store.history, entry].slice(-50)
}

function sortedLabels(store: AccountStore) {
  return Object.keys(store.accounts).sort((left, right) => {
    if (store.active === left) return -1
    if (store.active === right) return 1
    return left.localeCompare(right)
  })
}

function labelForAuth(store: AccountStore, auth: { refresh: string; access: string }) {
  return sortedLabels(store).find((label) => {
    const account = store.accounts[label]
    if (!account) return false
    return account.refresh === auth.refresh || account.access === auth.access
  })
}

async function ensureAccountStore() {
  const store = await loadAccountStore()
  let changed = false
  const canonical = await loadCanonicalAnthropicAuth()

  if (canonical) {
    const matched = labelForAuth(store, canonical)
    if (matched) {
      const current = store.accounts[matched]
      if (
        current &&
        (current.refresh !== canonical.refresh || current.access !== canonical.access || current.expires !== canonical.expires)
      ) {
        store.accounts[matched] = buildStoredAccount(matched, canonical, current)
        changed = true
      }
      if (store.active !== matched) {
        store.active = matched
        changed = true
      }
    } else if (Object.keys(store.accounts).length === 0) {
      const label = sanitizeLabel(DEFAULT_IMPORTED_LABEL) || "default"
      store.accounts[label] = buildStoredAccount(label, canonical)
      store.active = label
      addHistory(store, {
        at: nowIso(),
        action: "import",
        label,
        reason: "Imported existing canonical Anthropic auth",
      })
      changed = true
    }
  }

  if ((!store.active || !store.accounts[store.active]) && sortedLabels(store).length > 0) {
    store.active = sortedLabels(store)[0]
    changed = true
  }

  if (changed) {
    await saveAccountStore(store)
  }

  return store
}

async function setActiveLabel(store: AccountStore, label: string, reason: string) {
  const previous = store.active
  store.active = label
  addHistory(store, {
    at: nowIso(),
    action: previous && previous !== label ? "switch" : "activate",
    from: previous,
    to: label,
    reason,
  })
  await saveAccountStore(store)
}

async function upsertAccount(store: AccountStore, label: string, auth: { refresh: string; access: string; expires: number }, reason: string) {
  const key = sanitizeLabel(label)
  if (!key) throw new Error("Missing account label")
  const existed = Boolean(store.accounts[key])
  store.accounts[key] = buildStoredAccount(key, auth, store.accounts[key])
  addHistory(store, {
    at: nowIso(),
    action: existed ? "upsert" : "add",
    label: key,
    reason,
  })
  await saveAccountStore(store)
  return { label: key, account: store.accounts[key] }
}

async function setCanonicalAuth(client: Parameters<Plugin>[0]["client"], account: StoredAccount) {
  await client.auth.set({ path: { id: "anthropic" }, body: toOAuthBody(account) })
}

function cooldownUntil(account: StoredAccount) {
  if (!account.lastRateLimitAt) return 0
  const timestamp = Date.parse(account.lastRateLimitAt)
  if (!Number.isFinite(timestamp)) return 0
  return timestamp + RATE_LIMIT_COOLDOWN_MS
}

function pickNextAccount(store: AccountStore, currentLabel?: string, attempted?: Set<string>) {
  return sortedLabels(store)
    .filter((label) => label !== currentLabel)
    .filter((label) => !attempted?.has(label))
    .filter((label) => {
      const account = store.accounts[label]
      return account ? cooldownUntil(account) <= Date.now() : false
    })[0]
}

function isAnthropicRateLimit(status: number, text: string) {
  return status === 429 && /rate_limit_error|Rate limited/i.test(text)
}

function isAnthropicAuthFailure(status: number, text: string) {
  if (![401, 403].includes(status)) return false
  return /invalid authentication credentials|oauth authentication is currently not allowed|authentication_error|token_expired/i.test(text)
}

function rebuildResponse(response: Response, text: string) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function accountLabelPrompt() {
  return {
    type: "text" as const,
    key: "label",
    message: "Account label",
    placeholder: "personal",
    validate: validateLabel,
  }
}

function activatePrompt() {
  return {
    type: "select" as const,
    key: "makeActive",
    message: "Make this the active account?",
    options: [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
  }
}

function createAddAccountMethod(
  baseMethod: NonNullable<Awaited<ReturnType<typeof builtInAnthropicAuthPlugin>>["auth"]>["methods"][number],
) {
  return {
    label: "Add Claude Pro/Max Account",
    type: "oauth" as const,
    prompts: [accountLabelPrompt(), activatePrompt()],
    authorize: async (inputs?: Record<string, string>) => {
      const beforeCanonical = await loadCanonicalAnthropicAuth()
      const store = await ensureAccountStore()
      const beforeLabel = beforeCanonical ? labelForAuth(store, beforeCanonical) ?? store.active : store.active
      const accountLabel = sanitizeLabel(inputs?.label ?? "")
      const makeActive = inputs?.makeActive !== "no"
      const result = await baseMethod.authorize(inputs)

      return {
        ...result,
        callback: async (...args: [string?]) => {
          const authResult = result.method === "code" ? await result.callback(args[0]!) : await result.callback()
          if (!authResult || authResult.type !== "success" || !("refresh" in authResult)) {
            return authResult
          }

          const latestStore = await ensureAccountStore()
          const saved = await upsertAccount(latestStore, accountLabel, authResult, "Added saved Anthropic account")

          if (makeActive || !beforeCanonical) {
            await setActiveLabel(latestStore, saved.label, "Added and activated account")
            return authResult
          }

          if (beforeLabel && latestStore.accounts[beforeLabel]) {
            await setActiveLabel(latestStore, beforeLabel, "Added account without activation")
          }

          return {
            type: "success" as const,
            refresh: beforeCanonical.refresh,
            access: beforeCanonical.access,
            expires: beforeCanonical.expires,
          }
        },
      }
    },
  }
}

function createUseSavedAccountMethod(client: Parameters<Plugin>[0]["client"], store: AccountStore) {
  const options = sortedLabels(store).map((label) => ({ label, value: label }))
  if (options.length === 0) return

  return {
    label: "Use saved Anthropic account",
    type: "oauth" as const,
    prompts: [
      {
        type: "select" as const,
        key: "label",
        message: "Saved account",
        options,
      },
    ],
    authorize: async (inputs?: Record<string, string>) => ({
      url: "",
      instructions: `Switching to saved Anthropic account \"${inputs?.label ?? ""}\"...`,
      method: "auto" as const,
      callback: async () => {
        const label = sanitizeLabel(inputs?.label ?? "")
        const latestStore = await ensureAccountStore()
        const account = latestStore.accounts[label]
        if (!account) return { type: "failed" as const }
        await setActiveLabel(latestStore, label, "Manual account switch")
        await setCanonicalAuth(client, account)
        return toOAuthSuccess(account)
      },
    }),
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  const builtIn = await builtInAnthropicAuthPlugin({ client })
  if (!builtIn.auth || builtIn.auth.provider !== "anthropic") return builtIn

  const baseAuth = builtIn.auth
  const store = await ensureAccountStore()
  const claudeProMethod = baseAuth.methods.find((method) => method.label === "Claude Pro/Max")
  if (!claudeProMethod) return builtIn
  const addAccountMethod = createAddAccountMethod(claudeProMethod)
  const useSavedAccountMethod = createUseSavedAccountMethod(client, store)

  return {
    ...builtIn,
    auth: {
      ...baseAuth,
      methods: [
        addAccountMethod,
        ...(useSavedAccountMethod ? [useSavedAccountMethod] : []),
        ...baseAuth.methods.slice(1),
      ],
      loader: baseAuth.loader
        ? async (getAuth, provider) => {
            const loaded = await baseAuth.loader!(getAuth, provider)
            if (!loaded.fetch) return loaded

            return {
              ...loaded,
              async fetch(input, init) {
                const latestStore = await ensureAccountStore()
                if (Object.keys(latestStore.accounts).length < 2) {
                  return loaded.fetch!(input, init)
                }

                const response = await loaded.fetch!(input, init)

                const text = await response.text().catch(() => "")
                if (!isAnthropicRateLimit(response.status, text) && !isAnthropicAuthFailure(response.status, text)) {
                  return rebuildResponse(response, text)
                }

                const canonical = await loadCanonicalAnthropicAuth()
                const currentLabel = canonical ? labelForAuth(latestStore, canonical) ?? latestStore.active : latestStore.active
                if (currentLabel && latestStore.accounts[currentLabel] && isAnthropicRateLimit(response.status, text)) {
                  latestStore.accounts[currentLabel].lastRateLimitAt = nowIso()
                  await saveAccountStore(latestStore)
                }

                const nextLabel = pickNextAccount(latestStore, currentLabel)
                if (!nextLabel) {
                  return rebuildResponse(response, text)
                }

                const next = latestStore.accounts[nextLabel]
                await setActiveLabel(latestStore, nextLabel, isAnthropicRateLimit(response.status, text) ? "Anthropic rate limit failover" : "Anthropic auth failover")
                await setCanonicalAuth(client, next)
                return loaded.fetch!(input, init)
              },
            }
          }
        : undefined,
    },
  }
}
