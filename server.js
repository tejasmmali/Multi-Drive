const express = require("express")
const axios = require("axios")
const cors = require("cors")
const path = require("path")
const multer = require("multer")
const busboy = require("busboy")
const mega = require("megajs")
const crypto = require("crypto")
require("dotenv").config()

const app = express()
//multer buffers in memory, so this cap is about this process's RAM. Only MEGA uploads
//come through here now, and only ones under the client's 50 MB streaming threshold.
const MULTER_MAX_BYTES = 100 * 1024 * 1024
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_MAX_BYTES }
})

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

//static assets never need a session, so skip the session store round trip for them.
//this keeps one browser tab from creating a dozen throwaway sessions (and a dozen
//Set-Cookie headers racing each other) while the first page load fetches css/js/images.
const SESSIONLESS_ASSET_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|txt|xml|webmanifest)$/i

function isSessionlessPath(req) {
  const p = String(req.path || "")
  if (p.startsWith("/images/")) return true
  if (p.startsWith("/css/")) return true
  if (p.startsWith("/js/")) return true
  return SESSIONLESS_ASSET_RE.test(p)
}

app.use(async (req, res, next) => {
  if (isSessionlessPath(req)) return next()
  try {
    //every response below depends on the md_sid cookie, so it must never be cached
    //by the Vercel CDN or a proxy. a cached empty response is what makes the home
    //screen look like "no accounts connected" even though the session has accounts.
    res.setHeader("Cache-Control", "private, no-store, max-age=0")
    res.setHeader("Vary", "Cookie")
    await getOrCreateSession(req, res)
    res.on("finish", () => {
      if (typeof req.saveUserSession === "function") {
        req.saveUserSession().catch(() => { })
      }
    })
    next()
  } catch (err) {
    next(err)
  }
})

//routes that talk to the Google Drive API with account.token. renewing an expiring
//access token in one place keeps every one of them working after the first hour.
const GOOGLE_API_PATHS = new Set([
  "/storage",
  "/files",
  "/open-file",
  "/search",
  "/delete-item",
  "/copy-item",
  "/move-item",
  "/create-folder",
  "/upload-session",
  "/upload-item",
  "/upload-item-stream"
])

app.use(async (req, res, next) => {
  if (!req.userSession || !GOOGLE_API_PATHS.has(req.path)) return next()
  try {
    await ensureFreshGoogleTokens(req)
  } catch (e) {
    //a failed refresh is reported per account by the route itself.
  }
  next()
})

app.use((req, res, next) => {
  if (req.path === "/upload-item-stream" || req.path === "/upload-item") {
    //an upload that goes through this process is not bound by the API timeouts.
    req.setTimeout(2 * 60 * 60 * 1000)
    res.setTimeout(2 * 60 * 60 * 1000)
  }
  next()
})

function setStaticCacheHeaders(res, filePath) {
  //html carries the Set-Cookie for a brand new session, so it must stay uncached.
  if (/\.html?$/i.test(String(filePath || ""))) {
    res.setHeader("Cache-Control", "private, no-store, max-age=0")
  }
}

app.use(express.static(path.join(__dirname, "public"), { setHeaders: setStaticCacheHeaders }))
app.use("/images", express.static(path.join(__dirname, "images")))
//this is credenstial value you can set via .env file or enviroment varialable
const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
//this is redirect uri change this if you are self deploying
//only an explicitly configured value is used. the old hardcoded fallback pointed every
//deployment at multi-drives.vercel.app, so a fork, a preview URL or a renamed project
//sent Google's redirect to a different host - a different host means a different
//session cookie, so the callback landed with no oauth state and the account was lost.
//with no env var set the callback URL is derived from the incoming request instead.
const REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || "").trim()
const MEGA_SESSION_TOKEN = process.env.MEGA_SESSION_TOKEN || ""
const MEGA_ACCOUNT_EMAIL = process.env.MEGA_ACCOUNT_EMAIL || ""
const GOOGLE_OAUTH_SCOPE = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive"].join(" ")

//all the Google Drive API endpoints we will be using
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_PROFILE_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
const DRIVE_DRIVES_URL = "https://www.googleapis.com/drive/v3/drives"
const DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink),storageQuota"
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
const FOLDER_MIME = "application/vnd.google-apps.folder"
const DRIVE_FILES_FIELDS = "nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, thumbnailLink, parents, driveId)"


let megaStorage = null
const uploadProgress = new Map()
const sessions = new Map()
const SESSION_COOKIE_NAME = "md_sid"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_CLEANUP_MS = 60 * 60 * 1000
const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "")
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim()
const HAS_UPSTASH = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN)
const SESSION_KEY_PREFIX = "multidrive:sess:"

//Vercel (and any other serverless host) throws the whole node process away between
//requests, so anything kept only in module memory is gone by the next request.
//that is why HAS_UPSTASH is mandatory there: without it accounts vanish the moment
//the OAuth redirect lands on a different lambda instance.
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION)
const STORAGE_ACCOUNT_TIMEOUT_MS = Number(process.env.STORAGE_ACCOUNT_TIMEOUT_MS || 7000)
//Vercel buffers the entire request body before the function starts and rejects anything
//over ~4.5 MB with its own error page, so an upload proxied through this process can never
//be larger than that on the hosted site. Google uploads dodge the limit entirely by going
//browser -> Google; MEGA cannot, so the browser is told the cap up front and can say so.
const PROXY_UPLOAD_MAX_BYTES = Number(
  process.env.PROXY_UPLOAD_MAX_BYTES || (IS_SERVERLESS ? 4 * 1024 * 1024 : 10 * 1024 * 1024 * 1024)
)
//kept just under the 10s function limit of the Vercel hobby plan so the browser gets a
//readable JSON error instead of the platform's HTML timeout page.
const MEGA_LOGIN_TIMEOUT_MS = Number(process.env.MEGA_LOGIN_TIMEOUT_MS || (IS_SERVERLESS ? 9000 : 60000))
const GOOGLE_TOKEN_SKEW_MS = 60 * 1000

if (IS_SERVERLESS && !HAS_UPSTASH) {
  console.error(
    "[multi-drive] FATAL CONFIG: running on a serverless host without UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. " +
    "Sessions will be stored in per-instance memory and connected accounts will disappear between requests. " +
    "Set both env vars in the Vercel project settings and redeploy."
  )
}

function parseCookies(header) {
  const out = {}
  const raw = String(header || "")
  if (!raw) return out
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=")
    if (i <= 0) return
    const key = part.slice(0, i).trim()
    const val = part.slice(i + 1).trim()
    if (!key) return
    out[key] = decodeURIComponent(val)
  })
  return out
}

function makeSessionId() {
  return crypto.randomBytes(24).toString("base64url")
}

function createEmptySession(sid) {
  return {
    id: sid,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    accounts: [],
    oauthStates: {}
  }
}

function sanitizeAccountForStore(account) {
  if (!account || typeof account !== "object") return null
  const base = {
    provider: normalizeProvider(account.provider),
    email: normalizeEmail(account.email)
  }
  if (!base.provider || !base.email) return null
  if (base.provider === "mega") {
    return {
      ...base,
      megaSessionToken: typeof account.megaSessionToken === "string" ? account.megaSessionToken : ""
    }
  }
  //keep the refresh token plus the user's own oauth client credentials: a Google
  //access token dies after ~1 hour and without these three fields the account can
  //never be refreshed, which is what made cards silently disappear.
  return {
    ...base,
    token: typeof account.token === "string" ? account.token : "",
    refreshToken: typeof account.refreshToken === "string" ? account.refreshToken : "",
    clientId: typeof account.clientId === "string" ? account.clientId : "",
    clientSecret: typeof account.clientSecret === "string" ? account.clientSecret : "",
    expiresAt: Number(account.expiresAt || 0) || 0
  }
}

function sanitizeSessionForStore(session) {
  const source = session || {}
  const oauthStates = source.oauthStates && typeof source.oauthStates === "object" ? source.oauthStates : {}
  const nextOauthStates = {}
  for (const key of Object.keys(oauthStates)) {
    const item = oauthStates[key]
    if (!item || typeof item !== "object") continue
    const clientId = String(item.clientId || "").trim()
    const clientSecret = String(item.clientSecret || "").trim()
    const redirectUri = String(item.redirectUri || "").trim()
    const createdAt = Number(item.createdAt || 0)
    if (!clientId || !clientSecret || !redirectUri || !createdAt) continue
    nextOauthStates[key] = { clientId, clientSecret, redirectUri, createdAt }
  }

  const safeAccounts = (Array.isArray(source.accounts) ? source.accounts : [])
    .map(sanitizeAccountForStore)
    .filter(Boolean)

  return {
    id: String(source.id || ""),
    createdAt: Number(source.createdAt || Date.now()),
    lastSeenAt: Number(source.lastSeenAt || Date.now()),
    accounts: safeAccounts,
    oauthStates: nextOauthStates
  }
}

const REDIS_TIMEOUT_MS = 5000

async function redisSetJson(key, value, ttlSec) {
  const url = `${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`
  await axios.post(url, value, {
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    params: { EX: String(ttlSec) },
    timeout: REDIS_TIMEOUT_MS
  })
}

async function redisGetJson(key) {
  const url = `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    timeout: REDIS_TIMEOUT_MS
  })
  const value = response?.data?.result
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch (e) {
    return null
  }
}

async function redisDel(key) {
  const url = `${UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`
  await axios.post(url, null, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    timeout: REDIS_TIMEOUT_MS
  })
}

async function loadSessionById(sid) {
  if (!sid) return null
  if (!HAS_UPSTASH) return sessions.get(sid) || null

  try {
    const payload = await redisGetJson(SESSION_KEY_PREFIX + sid)
    if (!payload || typeof payload !== "object") {
      //not in Redis (expired or never written). the in-memory mirror can still have
      //it when the same warm instance handled the write.
      return sessions.get(sid) || null
    }
    const safe = sanitizeSessionForStore(payload)
    sessions.set(sid, safe)
    return safe
  } catch (err) {
    //never turn a Redis hiccup into a 500 for the whole site.
    console.error("[multi-drive] session load failed:", err.response?.data || err.message)
    return sessions.get(sid) || null
  }
}

async function saveSession(session) {
  if (!session || !session.id) return
  const safe = sanitizeSessionForStore(session)
  //always keep the memory mirror so a warm instance survives a Redis outage.
  sessions.set(safe.id, safe)
  if (!HAS_UPSTASH) return

  try {
    await redisSetJson(SESSION_KEY_PREFIX + safe.id, safe, Math.floor(SESSION_TTL_MS / 1000))
  } catch (err) {
    console.error("[multi-drive] session save failed:", err.response?.data || err.message)
    throw err
  }
}

function buildSessionCookie(req, sid) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    //Lax is required (not Strict): the Google OAuth callback is a cross-site
    //top-level redirect and a Strict cookie would not be sent with it, which loses
    //the oauth state and the freshly connected account.
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ]
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "").split(",")[0].trim()
  if (proto === "https") parts.push("Secure")
  return parts.join("; ")
}

//content fingerprint, ignoring lastSeenAt. used to skip pointless writes: the Upstash
//free tier has a daily command budget, and once it is exhausted every session write
//fails - which looks exactly like "the site forgot my accounts".
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000

function sessionFingerprint(session) {
  const safe = sanitizeSessionForStore(session)
  safe.lastSeenAt = 0
  return JSON.stringify(safe)
}

async function getOrCreateSession(req, res) {
  const cookies = parseCookies(req.headers?.cookie)
  let sid = String(cookies[SESSION_COOKIE_NAME] || "").trim()
  let session = sid ? await loadSessionById(sid) : null
  const isNewSession = !session

  if (!session) {
    sid = makeSessionId()
    session = createEmptySession(sid)
  }
  const loadedFingerprint = sessionFingerprint(session)
  const loadedLastSeenAt = Number(session.lastSeenAt || 0)
  session.lastSeenAt = Date.now()

  //re-send the cookie on every request, not only on creation, so the 30 day window
  //keeps sliding and a browser that dropped the cookie gets it back.
  res.append("Set-Cookie", buildSessionCookie(req, sid))

  req.sessionId = sid
  req.userSession = session
  req.saveUserSession = async (options = {}) => {
    const changed = sessionFingerprint(req.userSession) !== loadedFingerprint
    const stale = Date.now() - loadedLastSeenAt > SESSION_TOUCH_INTERVAL_MS
    if (!options.force && !changed && !stale) return
    req.userSession.lastSeenAt = Date.now()
    await saveSession(req.userSession)
  }

  if (isNewSession) {
    //persist immediately. on Vercel the lambda can be frozen the instant the response
    //is flushed, so a save queued on res "finish" is not guaranteed to run - and an
    //unsaved session id means the very next request starts over with an empty account list.
    try {
      await saveSession(session)
    } catch (e) {
      //already logged in saveSession; the memory mirror still holds it.
    }
  }
}

function cleanupSessions() {
  if (HAS_UPSTASH) return
  const now = Date.now()
  for (const [sid, session] of sessions.entries()) {
    if (!session || now - Number(session.lastSeenAt || 0) > SESSION_TTL_MS) {
      sessions.delete(sid)
    }
  }
}

setInterval(cleanupSessions, SESSION_CLEANUP_MS).unref()

function setUploadProgress(id, patch) {
  if (!id) return
  const now = Date.now()
  const prev = uploadProgress.get(id) || {}
  const next = {
    ...prev,
    ...patch,
    updatedAt: now
  }

  if (!next.startedAt) {
    next.startedAt = now
  }

  const uploaded = Number(next.bytesUploaded || 0)
  const total = Number(next.bytesTotal || 0)
  const elapsedSec = Math.max(0.001, (now - Number(next.startedAt || now)) / 1000)
  const avgBps = uploaded > 0 ? (uploaded / elapsedSec) : 0
  next.avgBps = Number.isFinite(avgBps) ? avgBps : 0
  next.etaSec = avgBps > 0 && total > uploaded ? Math.ceil((total - uploaded) / avgBps) : 0

  const finalState = { ...next }
  if (HAS_UPSTASH) {
    //megajs emits a progress event per chunk, and mirroring every one of them would burn
    //thousands of Upstash commands on a single upload. Only status changes and one write
    //per second reach Redis; the browser polls every 300ms, so it loses nothing that
    //matters and the daily command quota survives.
    const changedPhase = prev.status !== finalState.status || prev.phase !== finalState.phase
    if (changedPhase || now - Number(prev.redisWrittenAt || 0) >= 1000) {
      finalState.redisWrittenAt = now
      redisSetJson(`multidrive:progress:${id}`, finalState, 5 * 60).catch(() => { })
    }
  }
  uploadProgress.set(id, finalState)
}

function cleanupUploadProgress(id, delayMs = 5 * 60 * 1000) {
  if (!id) return
  setTimeout(() => {
    uploadProgress.delete(id)
    if (HAS_UPSTASH) {
      redisDel(`multidrive:progress:${id}`).catch(() => { })
    }
  }, delayMs)
}


function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase()
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase()
}

function makeAccountKey(provider, email) {
  return normalizeProvider(provider) + "::" + normalizeEmail(email)
}
// Upsert account by provider and email

function upsertAccount(session, account) {
  if (!session) return
  const key = makeAccountKey(account.provider, account.email)
  const current = Array.isArray(session.accounts) ? session.accounts : []
  session.accounts = current.filter((item) => makeAccountKey(item.provider, item.email) !== key)
  session.accounts.push(account)
}

function exportSessionAccountsForClient(session) {
  const list = Array.isArray(session?.accounts) ? session.accounts : []
  return list.map((account) => {
    const provider = normalizeProvider(account.provider)
    const email = normalizeEmail(account.email)
    if (provider === "mega") {
      return {
        provider,
        email,
        megaSessionToken: typeof account.megaSessionToken === "string" ? account.megaSessionToken : ""
      }
    }
    return {
      provider,
      email,
      token: typeof account.token === "string" ? account.token : ""
    }
  }).filter((item) => item.email && item.provider)
}

//run a promise with a hard deadline. serverless functions get killed by the platform
//(10s on the Vercel hobby plan) and a killed function returns an HTML error page that
//the front end cannot parse, so every slow call needs its own budget.
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || "Operation"} timed out after ${ms}ms`)
      err.isTimeout = true
      reject(err)
    }, ms)
    if (typeof timer.unref === "function") timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isGoogleAccount(account) {
  return normalizeProvider(account?.provider) === "google"
}

function googleTokenLooksExpired(account) {
  const expiresAt = Number(account?.expiresAt || 0)
  if (!expiresAt) return false
  return Date.now() + GOOGLE_TOKEN_SKEW_MS >= expiresAt
}

function sessionNeedsGoogleRefresh(session) {
  const accounts = Array.isArray(session?.accounts) ? session.accounts : []
  return accounts.some((account) => {
    if (!isGoogleAccount(account)) return false
    if (!account.refreshToken || !account.clientId || !account.clientSecret) return false
    return googleTokenLooksExpired(account) || !account.token
  })
}

//Google access tokens live for about an hour. the refresh token plus the user's own
//oauth client id/secret are stored with the account so the server can mint a new one
//instead of showing an empty home screen.
async function refreshGoogleAccount(account) {
  if (!isGoogleAccount(account)) return false
  if (!account.refreshToken || !account.clientId || !account.clientSecret) return false

  const body = new URLSearchParams({
    client_id: account.clientId,
    client_secret: account.clientSecret,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token"
  })

  const response = await axios.post(GOOGLE_TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000
  })

  const accessToken = response.data?.access_token
  if (!accessToken) return false

  account.token = accessToken
  account.expiresAt = Date.now() + (Number(response.data?.expires_in || 3600) * 1000)
  if (typeof response.data?.refresh_token === "string" && response.data.refresh_token) {
    account.refreshToken = response.data.refresh_token
  }
  return true
}

async function ensureFreshGoogleTokens(req) {
  const session = req?.userSession
  if (!session || !sessionNeedsGoogleRefresh(session)) return

  const accounts = Array.isArray(session.accounts) ? session.accounts : []
  let changed = false

  await Promise.all(accounts.map(async (account) => {
    if (!isGoogleAccount(account)) return
    if (!googleTokenLooksExpired(account) && account.token) return
    try {
      if (await refreshGoogleAccount(account)) changed = true
    } catch (err) {
      logError(err)
      //leave the stale token in place; the per-account error path reports it as
      //"reconnect needed" instead of hiding the whole account list.
    }
  }))

  if (changed && typeof req.saveUserSession === "function") {
    try {
      await req.saveUserSession()
    } catch (e) { }
  }
}

function parseMegaSessionToken(raw) {
  if (!raw || typeof raw !== "string") return null

  const text = raw.trim()
  if (!text) return null

  const attempts = [text]
  try {
    attempts.push(Buffer.from(text, "base64").toString("utf8"))
  } catch (e) { }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && parsed.sid && parsed.key) {
        return parsed
      }
    } catch (e) { }
  }

  return null
}

function buildMegaEmail(storage) {
  if (typeof MEGA_ACCOUNT_EMAIL === "string" && MEGA_ACCOUNT_EMAIL.trim()) {
    return MEGA_ACCOUNT_EMAIL.trim()
  }
  if (storage && storage.options && typeof storage.options.email === "string" && storage.options.email.trim()) {
    return storage.options.email.trim()
  }
  if (storage && typeof storage.user === "string" && storage.user.trim()) {
    return "mega:" + storage.user.trim()
  }
  return "mega-account"
}

function getFirstNameFromEmail(email) {
  const raw = normalizeEmail(email)
  if (!raw || !raw.includes("@")) return ""

  const local = raw.split("@")[0].replace(/[._+\-]+/g, " ").trim()
  if (!local) return ""

  const token = local.split(/\s+/).find(Boolean) || ""
  if (!token) return ""

  return token.charAt(0).toUpperCase() + token.slice(1)
}

function getFirstNameFromDisplayName(name) {
  const raw = String(name || "").trim()
  if (!raw) return ""

  const first = raw.split(/\s+/).find(Boolean) || ""
  const normalized = first.toLowerCase()
  if (normalized === "mega" || normalized === "google" || normalized === "drive") {
    return ""
  }
  return first
}

function normalizeMegaNode(node, parentId) {
  const isFolder = !!node.directory
  const timestampMs = Number.isFinite(node.timestamp) ? Number(node.timestamp) * 1000 : null
  return {
    id: String(node.nodeId || ""),
    name: node.name || "(unnamed)",
    mimeType: isFolder ? FOLDER_MIME : "application/octet-stream",
    size: isFolder ? null : Number(node.size || 0),
    modifiedTime: timestampMs ? new Date(timestampMs).toISOString() : null,
    webViewLink: null,
    iconLink: null,
    thumbnailLink: null,
    parents: parentId ? [parentId] : [],
    driveId: null
  }
}

function getBodyTrimmed(req, key) {
  const value = req.body?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function getBodyRaw(req, key) {
  const value = req.body?.[key]
  return typeof value === "string" ? value : ""
}

function getQueryTrimmed(req, key) {
  const value = req.query?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function resolveRedirectUri(req) {
  if (REDIRECT_URI) return REDIRECT_URI
  //x-forwarded-* can be a comma separated chain behind more than one proxy.
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim()
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim()
  return `${proto}://${host}/auth/google/callback`
}

function makeOAuthStateToken() {
  return "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

function cleanupOAuthStates(session) {
  if (!session || !session.oauthStates) return
  const states = session.oauthStates && typeof session.oauthStates === "object" ? session.oauthStates : {}
  const now = Date.now()
  for (const key of Object.keys(states)) {
    const value = states[key]
    if (!value || now - Number(value.createdAt || 0) > 15 * 60 * 1000) {
      delete states[key]
    }
  }
  session.oauthStates = states
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

function logError(err) {
  console.log(err.response?.data || err.message)
}

function sendErrorJson(res, err, fallbackMessage) {
  logError(err)
  const status = err.response?.status || 500
  const googleError = err.response?.data?.error

  //give the short actionable version of the known Google failures (Drive API disabled,
  //rate limit, dead token) here too, so browsing and uploading report the same fix as
  //the account card instead of Google's 300 character paragraph.
  if (googleError) {
    const classified = classifyGoogleApiError(err)
    if (classified.kind !== "other") {
      return res.status(status).json({
        error: classified.message + (classified.helpUrl ? " " + classified.helpUrl : ""),
        needsReauth: classified.needsReauth,
        helpUrl: classified.helpUrl
      })
    }
  }

  const message = googleError?.message || fallbackMessage
  res.status(status).json({ error: message })
}

function getAccountByEmail(session, email, provider) {
  if (!session) return null
  const target = normalizeEmail(email)
  const targetProvider = normalizeProvider(provider)
  const accounts = Array.isArray(session.accounts) ? session.accounts : []

  return accounts.find((account) => {
    const sameEmail = normalizeEmail(account.email) === target
    if (!sameEmail) return false
    if (!targetProvider) return true
    return normalizeProvider(account.provider) === targetProvider
  })
}

function getMegaNodeById(storage, nodeId) {
  if (!storage || !storage.files || !nodeId) return null
  return storage.files[nodeId] || null
}

//megajs keeps a "keepalive" long poll open after every request (api.pull -> api.wait).
//on a serverless host that socket never closes, the function is billed until the
//platform freezes it, and when the frozen socket finally errors megajs emits an
//"error" event on an EventEmitter nobody listens to - which crashes the whole
//instance and makes unrelated requests fail with a 500. So: keepalive off, and an
//error listener on the api object as a second line of defence.
function hardenMegaStorage(storage) {
  if (!storage) return storage
  try {
    if (storage.options) storage.options.keepalive = false
    if (storage.api) {
      storage.api.keepalive = false
      if (typeof storage.api.on === "function" && storage.api.listenerCount("error") === 0) {
        storage.api.on("error", (err) => {
          console.error("[multi-drive] mega api error:", err?.message || err)
        })
      }
    }
    if (typeof storage.on === "function" && storage.listenerCount("error") === 0) {
      storage.on("error", (err) => {
        console.error("[multi-drive] mega storage error:", err?.message || err)
      })
    }
  } catch (e) { }
  return storage
}

//storage.toJSON() carries the raw login options (email, and on some paths the
//password / 2FA code). Only the key + sid are needed to resume a session, so strip
//the credentials before this string is written to Redis or handed to the browser.
function serializeMegaStorage(storage) {
  if (!storage || typeof storage.toJSON !== "function") return ""
  try {
    const snapshot = storage.toJSON()
    const options = { ...(snapshot.options || {}) }
    delete options.password
    delete options.secondFactorCode
    delete options.email
    options.keepalive = false
    options.autoload = false
    options.autologin = false
    return JSON.stringify({ ...snapshot, options })
  } catch (e) {
    return ""
  }
}

//a warm instance can reuse an already logged in storage instead of re-doing the
//MEGA handshake and full tree download on every single request.
const megaStorageCache = new Map()
const MEGA_STORAGE_CACHE_MAX = 5

function cacheKeyForMegaAccount(account) {
  const token = typeof account?.megaSessionToken === "string" ? account.megaSessionToken : ""
  if (!token) return ""
  return crypto.createHash("sha256").update(token).digest("hex")
}

function getCachedMegaStorage(account) {
  const key = cacheKeyForMegaAccount(account)
  if (!key) return null
  const entry = megaStorageCache.get(key)
  if (!entry) return null
  megaStorageCache.delete(key)
  megaStorageCache.set(key, entry)
  return entry
}

function setCachedMegaStorage(account, storage, treeLoaded) {
  const key = cacheKeyForMegaAccount(account)
  if (!key || !storage) return
  megaStorageCache.set(key, { storage, treeLoaded: !!treeLoaded })
  while (megaStorageCache.size > MEGA_STORAGE_CACHE_MAX) {
    const oldest = megaStorageCache.keys().next().value
    megaStorageCache.delete(oldest)
  }
}

//needTree: only pay for the full file tree download when the caller actually browses
//files. /storage just needs the quota (api "uq"), which works with the sid alone.
async function ensureMegaStorageForAccount(account, options = {}) {
  const needTree = options.needTree !== false
  if (!account || normalizeProvider(account.provider) !== "mega") {
    throw new Error("Invalid MEGA account")
  }

  const finish = async (storage) => {
    hardenMegaStorage(storage)
    if (needTree) {
      //the tree is re-read whenever a caller needs it, so browsing never shows a
      //stale listing. what the cache saves is the session handshake, not the listing.
      await storage.reload(true)
      storage.status = "ready"
    }
    account.storage = storage
    setCachedMegaStorage(account, storage, needTree)
    return storage
  }

  if (account.storage) {
    try {
      return await finish(account.storage)
    } catch (e) {
      account.storage = null
    }
  }

  const cached = getCachedMegaStorage(account)
  if (cached && cached.storage) {
    try {
      return await finish(cached.storage)
    } catch (e) {
      megaStorageCache.delete(cacheKeyForMegaAccount(account))
    }
  }

  const rawSession = account.megaSessionToken
  const parsed = typeof rawSession === "string" ? parseMegaSessionToken(rawSession) : null
  if (parsed) {
    const restored = mega.Storage.fromJSON({
      ...parsed,
      options: { ...(parsed.options || {}), keepalive: false, autoload: false, autologin: false }
    })
    return await finish(restored)
  }

  if (MEGA_SESSION_TOKEN) {
    const fallback = await getMegaStorage()
    account.storage = fallback
    return fallback
  }

  throw new Error("MEGA session expired. Reconnect the account.")
}

function escapeDriveQueryId(id) {
  return String(id).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

function escapeDriveContains(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function getMegaStorage() {
  if (megaStorage) {
    try {
      if (megaStorage.status === "ready") return megaStorage
      await megaStorage.reload(true)
      megaStorage.status = "ready"
      return megaStorage
    } catch (e) {
      megaStorage = null
    }
  }

  const parsed = parseMegaSessionToken(MEGA_SESSION_TOKEN)
  if (!parsed) {
    throw new Error("MEGA_SESSION_TOKEN is missing or invalid. Use JSON from storage.toJSON() or its base64.")
  }

  const storage = mega.Storage.fromJSON({
    ...parsed,
    options: { ...(parsed.options || {}), keepalive: false, autoload: false, autologin: false }
  })
  hardenMegaStorage(storage)
  await storage.reload(true)
  storage.status = "ready"
  megaStorage = storage
  return storage
}

async function connectMegaAccount(session) {
  const storage = await getMegaStorage()
  const email = buildMegaEmail(storage)
  upsertAccount(session, {
    provider: "mega",
    email,
    storage,
    megaSessionToken: serializeMegaStorage(storage) || MEGA_SESSION_TOKEN
  })
  return email
}

async function connectMegaAccountWithCredentials(session, { email, password, secondFactorCode }) {
  if (!email || !password) {
    throw new Error("MEGA email and password are required")
  }

  const storage = new mega.Storage({
    email: String(email).trim(),
    password: String(password),
    secondFactorCode: secondFactorCode ? String(secondFactorCode).trim() : undefined,
    autoload: true,
    autologin: true,
    //no background long poll: see hardenMegaStorage for why this matters on Vercel.
    keepalive: false
  })
  hardenMegaStorage(storage)

  //MEGA login + first tree download is the slowest thing this app does. give it a
  //deadline so the request answers with a real error instead of being killed by the
  //platform (which returns an HTML page the front end cannot parse).
  await withTimeout(storage.ready, MEGA_LOGIN_TIMEOUT_MS, "MEGA login")
  hardenMegaStorage(storage)

  const accountEmail = normalizeEmail(email)
  const account = {
    provider: "mega",
    email: accountEmail,
    storage,
    megaSessionToken: serializeMegaStorage(storage)
  }
  upsertAccount(session, account)
  setCachedMegaStorage(account, storage, true)
  return accountEmail
}

async function getParentDriveId(accessToken, parentId) {
  if (parentId === "root") return null

  try {
    const response = await axios.get(`${DRIVE_FILES_URL}/${encodeURIComponent(parentId)}`, {
      headers: authHeaders(accessToken),
      params: { fields: "driveId", supportsAllDrives: true }
    })

    const id = response.data.driveId
    return id ? String(id) : null
  } catch (err) {
    logError(err)
    return null
  }
}

function buildListParams(parentId, q, pageToken, driveId, rootMinimal) {
  const params = {
    q,
    pageSize: 1000,
    fields: DRIVE_FILES_FIELDS,
    supportsAllDrives: true
  }

  if (rootMinimal) {
    params.corpora = "user"
    params.includeItemsFromAllDrives = false
  } else {
    params.includeItemsFromAllDrives = true

    if (parentId === "root") {
      params.corpora = "user"
    } else if (driveId) {
      params.corpora = "drive"
      params.driveId = driveId
    } else {
      params.corpora = "user"
    }
  }

  params.orderBy = "folder,name_natural"
  if (pageToken) params.pageToken = pageToken
  return params
}

async function listChildrenInFolder(accessToken, parentId) {
  const escaped = parentId === "root" ? "root" : escapeDriveQueryId(parentId)
  const q = `'${escaped}' in parents and trashed=false`
  const driveId = parentId === "root" ? null : await getParentDriveId(accessToken, parentId)

  async function fetchAllPages(rootMinimal) {
    const all = []
    let pageToken = null

    do {
      const params = buildListParams(parentId, q, pageToken, driveId, rootMinimal)
      const response = await axios.get(DRIVE_FILES_URL, {
        headers: authHeaders(accessToken),
        params
      })
      all.push(...(response.data.files || []))
      pageToken = response.data.nextPageToken || null
    } while (pageToken)

    return all
  }

  try {
    const all = await fetchAllPages(false)
    if (all.length > 0 || parentId !== "root") return all
    return await fetchAllPages(true)
  } catch (err) {
    if (parentId !== "root") throw err
    logError(err)
    return await fetchAllPages(true)
  }
}

async function listSharedDrives(accessToken) {
  const drives = []
  let pageToken = null

  do {
    const params = {
      pageSize: 100,
      fields: "nextPageToken, drives(id, name)"
    }
    if (pageToken) params.pageToken = pageToken

    const response = await axios.get(DRIVE_DRIVES_URL, {
      headers: authHeaders(accessToken),
      params
    })


    drives.push(...(response.data.drives || []))
    pageToken = response.data.nextPageToken || null
  } while (pageToken)

  return drives.map((drive) => ({
    id: drive.id,
    name: drive.name || "Shared drive",
    mimeType: FOLDER_MIME,
    size: null,
    modifiedTime: null,
    webViewLink: null,
    parents: [],
    driveId: drive.id,
    isSharedDriveRoot: true
  }))
}

async function listMegaChildren(storage, parentId) {
  await storage.reload(true)

  const parentNode = parentId === "root" ? storage.root : getMegaNodeById(storage, parentId)
  if (!parentNode || !parentNode.directory) {
    const err = new Error("Destination folder not found")
    err.statusCode = 404
    throw err
  }

  const children = Array.isArray(parentNode.children) ? parentNode.children : []
  return children.map((node) => normalizeMegaNode(node, parentNode.nodeId || "root"))
}

app.get("/auth/google", (req, res) => {
  return res.status(400).send("Use /auth/google/start with custom Google OAuth credentials.")
})

app.post("/auth/google/start", async (req, res) => {
  try {
    cleanupOAuthStates(req.userSession)
    const customClientId = getBodyTrimmed(req, "clientId")
    const customClientSecret = getBodyTrimmed(req, "clientSecret")
    if (!customClientId || !customClientSecret) {
      return res.status(400).json({ error: "Both Client ID and Client Secret are required." })
    }
    const clientId = customClientId
    const clientSecret = customClientSecret

    const redirectUri = resolveRedirectUri(req)
    const state = makeOAuthStateToken()
    req.userSession.oauthStates[state] = {
      clientId,
      clientSecret,
      redirectUri,
      createdAt: Date.now()
    }
    await req.saveUserSession()

    const url =
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(GOOGLE_OAUTH_SCOPE)}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`
    return res.json({ url })
  } catch (err) {
    logError(err)
    return res.status(500).json({ error: "Unable to start Google login." })
  }
})

//there is no /mega-login.html in public/ (the MEGA form lives in a modal on the home
//page), so these used to redirect the user straight into a 404.
app.get("/auth/mega", (req, res) => {
  res.redirect("/?connect=mega")
})

app.post("/auth/mega/login", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const password = getBodyRaw(req, "password")
    const secondFactorCode = getBodyTrimmed(req, "secondFactorCode")
    await connectMegaAccountWithCredentials(req.userSession, { email, password, secondFactorCode })
    await req.saveUserSession()
    res.redirect("/")
  } catch (err) {
    logError(err)
    const msg = err && err.message ? err.message : "Unable to login to MEGA"
    res.redirect("/?connect=mega&error=" + encodeURIComponent(msg))
  }
})

app.post("/auth/mega/login-json", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const password = getBodyRaw(req, "password")
    const secondFactorCode = getBodyTrimmed(req, "secondFactorCode")
    const accountEmail = await connectMegaAccountWithCredentials(req.userSession, { email, password, secondFactorCode })
    await req.saveUserSession()
    return res.json({ success: true, email: accountEmail })
  } catch (err) {
    const msg = err && err.message ? err.message : "Unable to login to MEGA"
    return res.status(400).json({ error: msg })
  }
})

app.post("/auth/mega/token", (req, res) => {
  connectMegaAccount(req.userSession)
    .then(async () => {
      await req.saveUserSession()
      res.redirect("/")
    })
    .catch((err) => {
      logError(err)
      const msg = encodeURIComponent(err && err.message ? err.message : "Unable to connect MEGA token")
      res.redirect("/?connect=mega&error=" + msg)
    })
})

app.post("/auth/mega/token-json", async (req, res) => {
  try {
    const email = await connectMegaAccount(req.userSession)
    await req.saveUserSession()
    return res.json({ success: true, email })
  } catch (err) {
    const msg = err && err.message ? err.message : "Unable to connect MEGA token"
    return res.status(400).json({ error: msg })
  }
})

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code
    const state = getQueryTrimmed(req, "state")
    const googleError = getQueryTrimmed(req, "error")
    if (googleError) {
      return res.redirect("/?connectError=" + encodeURIComponent("Google returned: " + googleError))
    }
    cleanupOAuthStates(req.userSession)

    const oauthStates = req.userSession.oauthStates || {}
    if (!state || !oauthStates[state]) {
      //this is the "cookie or session was lost between the two requests" case. saying
      //so plainly beats a bare 400 page.
      return res.redirect("/?connectError=" + encodeURIComponent(
        "Google sign-in session expired before the redirect came back. Start the Google connect step again."
      ))
    }
    const stateData = oauthStates[state]
    delete oauthStates[state]
    req.userSession.oauthStates = oauthStates
    const oauthClientId = stateData.clientId
    const oauthClientSecret = stateData.clientSecret
    const oauthRedirectUri = stateData.redirectUri || resolveRedirectUri(req)

    const tokenResponse = await axios.post(GOOGLE_TOKEN_URL, {
      code,
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      redirect_uri: oauthRedirectUri,
      grant_type: "authorization_code"
    }, { timeout: 15000 })

    const accessToken = tokenResponse.data.access_token
    const profileResponse = await axios.get(GOOGLE_PROFILE_URL, {
      headers: authHeaders(accessToken),
      timeout: 15000
    })

    //the refresh token and the user's own client id/secret are stored with the account
    //so the access token can be renewed later. without them the account went dark
    //(and looked "disconnected") about an hour after connecting.
    upsertAccount(req.userSession, {
      provider: "google",
      email: profileResponse.data.email,
      token: accessToken,
      refreshToken: typeof tokenResponse.data.refresh_token === "string" ? tokenResponse.data.refresh_token : "",
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      expiresAt: Date.now() + (Number(tokenResponse.data.expires_in || 3600) * 1000)
    })

    //one single save that persists both the consumed oauth state and the new account.
    //it must complete BEFORE the redirect: on Vercel the instance can be frozen as
    //soon as the response is flushed, so a save left running in the background may
    //never reach Redis and the home page would come back with zero accounts.
    await req.saveUserSession()

    //the account is connected either way, but a quick probe here means a project with
    //the Drive API switched off is reported at connect time - with the fix - instead of
    //turning into a broken card on the home screen.
    let warning = ""
    try {
      await axios.get(DRIVE_ABOUT_URL, { headers: authHeaders(accessToken), timeout: 5000 })
    } catch (probeErr) {
      const classified = classifyGoogleApiError(probeErr)
      if (classified.kind === "service_disabled") {
        warning = "Account connected, but " + classified.message.charAt(0).toLowerCase() + classified.message.slice(1)
        if (classified.helpUrl) warning += " " + classified.helpUrl
      }
    }

    console.log("Google account connected:", normalizeEmail(profileResponse.data.email), warning ? "(drive api disabled)" : "")
    res.redirect(warning ? "/?connectError=" + encodeURIComponent(warning) : "/?connected=google")
  } catch (err) {
    logError(err)
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message || "unknown error"
    res.redirect("/?connectError=" + encodeURIComponent("Google connect failed: " + String(detail).slice(0, 300)))
  }
})

//one card per connected account.
//every account is resolved independently, in parallel, behind its own timeout, and a
//failing account becomes a card with an error instead of taking the whole response
//down. the old version bailed out to res.send("Error fetching storage info") - a
//200 with a text/html body - so the browser's res.json() threw and the home screen
//rendered "no connected accounts" even though the session had accounts in it.
async function buildMegaStorageCard(account) {
  const storage = await ensureMegaStorageForAccount(account, { needTree: false })
  const info = await storage.getAccountInfo()
  const email = account.email || buildMegaEmail(storage)
  const givenName = getFirstNameFromEmail(email)

  //MEGA rotates its session id, so keep the stored token in step with the live one.
  const refreshedToken = serializeMegaStorage(storage)
  const tokenChanged = !!refreshedToken && refreshedToken !== account.megaSessionToken
  if (tokenChanged) account.megaSessionToken = refreshedToken

  return {
    card: {
      provider: "mega",
      user: {
        emailAddress: email,
        displayName: givenName || "MEGA",
        givenName,
        photoLink: ""
      },
      storageQuota: {
        usage: Number(info.spaceUsed || 0),
        limit: Number(info.spaceTotal || 0),
        usageInDrive: Number(info.spaceUsed || 0),
        usageInDriveTrash: 0
      }
    },
    sessionChanged: tokenChanged
  }
}

//megajs surfaces MEGA's numeric API errors as strings like
//"ESID (-15): Invalid or expired user session, please relogin". Same idea as the Google
//classifier: only some of them are fixed by reconnecting.
function classifyMegaError(err) {
  const raw = String(err?.message || "").trim()

  const is = (code) => new RegExp("\\b" + code + "\\b", "i").test(raw)

  if (is("ESID") || /session expired|please relogin|reconnect the account/i.test(raw)) {
    return { needsReauth: true, message: "This MEGA session expired. Reconnect the account." }
  }
  if (is("EMFAREQUIRED")) {
    return { needsReauth: true, message: "MEGA wants your two-factor code. Reconnect the account and enter it." }
  }
  if (is("ENOENT")) {
    return { needsReauth: true, message: "MEGA rejected these credentials. Reconnect the account." }
  }
  if (is("EBLOCKED")) {
    return { needsReauth: false, message: "MEGA has blocked this account." }
  }
  if (is("EOVERQUOTA") || is("EGOINGOVERQUOTA") || is("ESHAREROVERQUOTA")) {
    return { needsReauth: false, message: "This MEGA account is over its quota." }
  }
  if (is("EAGAIN") || is("ERATELIMIT") || is("ETEMPUNAVAIL") || is("ETOOMANYCONNECTIONS")) {
    return { needsReauth: false, message: "MEGA is busy right now. Retry in a moment." }
  }

  return { needsReauth: false, message: raw || "Unable to read this MEGA account right now." }
}

//Google answers 403 for several unrelated situations and only one of them is fixed by
//reconnecting. Telling a user to reconnect when the Drive API is switched off in their
//Cloud project sends them round a loop that can never succeed, so classify first.
function classifyGoogleApiError(err) {
  const status = Number(err?.response?.status || 0)
  const payload = err?.response?.data?.error
  const rawMessage = String(payload?.message || err?.message || "").trim()
  const reasons = []
  if (Array.isArray(payload?.errors)) {
    payload.errors.forEach((item) => reasons.push(String(item?.reason || "").toLowerCase()))
  }
  if (Array.isArray(payload?.details)) {
    payload.details.forEach((item) => reasons.push(String(item?.reason || "").toLowerCase()))
  }
  reasons.push(String(payload?.status || "").toLowerCase())

  const has = (needle) => reasons.some((reason) => reason === needle)

  //the "Help" detail carries the exact console URL for this project
  let helpUrl = ""
  if (Array.isArray(payload?.details)) {
    for (const item of payload.details) {
      const link = Array.isArray(item?.links) ? item.links.find((l) => l && l.url) : null
      if (link) {
        helpUrl = String(link.url)
        break
      }
    }
  }
  if (!helpUrl) {
    const found = rawMessage.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/)
    if (found) helpUrl = found[0].replace(/[.,)]+$/, "")
  }

  //project number, so the message can say which project to go and fix
  let project = ""
  if (Array.isArray(payload?.details)) {
    for (const item of payload.details) {
      const consumer = String(item?.metadata?.consumer || "")
      const match = consumer.match(/projects?\/(\d+)/)
      if (match) {
        project = match[1]
        break
      }
    }
  }
  if (!project) {
    const match = rawMessage.match(/project\s+(\d{6,})/i)
    if (match) project = match[1]
  }

  const serviceDisabled =
    has("accessnotconfigured") ||
    has("service_disabled") ||
    /has not been used in project|is disabled|api is not enabled/i.test(rawMessage)

  if (status === 403 && serviceDisabled) {
    if (!helpUrl) {
      helpUrl = "https://console.cloud.google.com/apis/library/drive.googleapis.com" +
        (project ? `?project=${project}` : "")
    }
    return {
      kind: "service_disabled",
      needsReauth: false,
      helpUrl,
      message:
        "The Google Drive API is turned off in the Google Cloud project" +
        (project ? ` ${project}` : "") +
        " that these OAuth credentials belong to. Enable \"Google Drive API\" for that project, wait a minute for it to take effect, then reload this page."
    }
  }

  if (has("ratelimitexceeded") || has("userratelimitexceeded") || has("quotaexceeded") || status === 429) {
    return {
      kind: "rate_limited",
      needsReauth: false,
      helpUrl: "",
      message: "Google is rate limiting this account right now. Wait a moment and reload."
    }
  }

  const scopeProblem =
    has("insufficientpermissions") ||
    has("access_token_scope_insufficient") ||
    /insufficient (authentication )?scopes?/i.test(rawMessage)

  if (status === 401 || (status === 403 && scopeProblem) || /invalid_grant|invalid credentials|token has been expired or revoked/i.test(rawMessage)) {
    return {
      kind: "auth",
      needsReauth: true,
      helpUrl: "",
      message: scopeProblem
        ? "This account did not grant Drive access. Reconnect it and allow the Drive permission."
        : "Access to this account expired. Reconnect it to continue."
    }
  }

  return {
    kind: "other",
    needsReauth: false,
    helpUrl,
    message: rawMessage || "Unable to read this account right now."
  }
}

async function buildGoogleStorageCard(account) {
  let sessionChanged = false

  const load = async () => Promise.all([
    axios.get(DRIVE_ABOUT_URL, { headers: authHeaders(account.token), timeout: STORAGE_ACCOUNT_TIMEOUT_MS }),
    axios.get(GOOGLE_PROFILE_URL, { headers: authHeaders(account.token), timeout: STORAGE_ACCOUNT_TIMEOUT_MS })
  ])

  let responses
  try {
    responses = await load()
  } catch (err) {
    //only retry when the token itself is the problem. a 403 for a disabled Drive API or
    //a rate limit is not fixed by minting a new token, and retrying just burns time
    //against the function's deadline.
    const classified = classifyGoogleApiError(err)
    const canRetry = classified.needsReauth && !!account.refreshToken
    if (!canRetry) throw err
    if (!(await refreshGoogleAccount(account))) throw err
    sessionChanged = true
    responses = await load()
  }

  const [driveResponse, profileResponse] = responses
  const driveUser = driveResponse.data.user || {}
  const profile = profileResponse.data || {}
  const email = driveUser.emailAddress || profile.email || account.email
  const displayName = driveUser.displayName || profile.name || ""

  return {
    card: {
      provider: "google",
      ...driveResponse.data,
      user: {
        ...driveUser,
        emailAddress: email,
        displayName,
        givenName: profile.given_name || getFirstNameFromDisplayName(displayName) || getFirstNameFromEmail(email),
        photoLink: driveUser.photoLink || profile.picture
      }
    },
    sessionChanged
  }
}

function buildFailedStorageCard(account, err) {
  const provider = normalizeProvider(account.provider) || "google"
  const email = normalizeEmail(account.email)
  const givenName = getFirstNameFromEmail(email)

  let message = ""
  let needsReauth = false
  let helpUrl = ""

  if (err?.isTimeout) {
    message = "This account took too long to answer. Reload to try again."
  } else if (provider === "mega") {
    const classified = classifyMegaError(err)
    message = classified.message
    needsReauth = classified.needsReauth
  } else {
    const classified = classifyGoogleApiError(err)
    message = classified.message
    needsReauth = classified.needsReauth
    helpUrl = classified.helpUrl
  }

  return {
    provider,
    error: message,
    needsReauth,
    //a link the user can act on (for example the "enable the Drive API" console page)
    helpUrl,
    user: {
      emailAddress: email,
      displayName: givenName || (provider === "mega" ? "MEGA" : "Google Drive"),
      givenName,
      photoLink: ""
    },
    //always present so the front end can render the card without optional chaining.
    storageQuota: {
      usage: 0,
      limit: 0,
      usageInDrive: 0,
      usageInDriveTrash: 0
    }
  }
}

app.get("/storage", async (req, res) => {
  try {
    await ensureFreshGoogleTokens(req)

    const sessionAccounts = Array.isArray(req.userSession.accounts) ? req.userSession.accounts : []
    let sessionChanged = false

    const settled = await Promise.all(sessionAccounts.map(async (account) => {
      try {
        const build = normalizeProvider(account.provider) === "mega"
          ? buildMegaStorageCard(account)
          : buildGoogleStorageCard(account)
        const result = await withTimeout(build, STORAGE_ACCOUNT_TIMEOUT_MS, `Reading ${account.email}`)
        if (result.sessionChanged) sessionChanged = true
        return result.card
      } catch (err) {
        console.error(`[multi-drive] /storage failed for ${account.provider}:${account.email}:`, err.response?.data || err.message)
        return buildFailedStorageCard(account, err)
      }
    }))

    if (sessionChanged) {
      try {
        await req.saveUserSession()
      } catch (e) { }
    }

    res.json(settled)
  } catch (err) {
    logError(err)
    //still JSON, still an array-shaped failure the client can reason about.
    res.status(500).json({ error: "Error fetching storage info", accounts: [] })
  }
})

app.post("/logout", async (req, res) => {
  const email = req.body?.email
  const provider = normalizeProvider(req.body?.provider)

  if (!email) {
    return res.status(400).json({ error: "Email is required" })
  }

  const sessionAccounts = Array.isArray(req.userSession.accounts) ? req.userSession.accounts : []
  const previousLength = sessionAccounts.length
  const removed = []
  req.userSession.accounts = sessionAccounts.filter((account) => {
    const sameEmail = normalizeEmail(account.email) === normalizeEmail(email)
    if (!sameEmail) return true
    if (provider && normalizeProvider(account.provider) !== provider) return true
    removed.push(account)
    return false
  })

  if (req.userSession.accounts.length === previousLength) {
    return res.status(404).json({ error: "Account not found" })
  }

  //drop the warm MEGA session too, otherwise a re-login on the same instance keeps
  //talking to the old cached storage object.
  for (const account of removed) {
    const key = cacheKeyForMegaAccount(account)
    if (key) megaStorageCache.delete(key)
  }

  //await it: on serverless a background save can be frozen before it lands, which
  //makes a removed account reappear on the next page load.
  try {
    await req.saveUserSession()
  } catch (e) { }
  res.json({ success: true })
})

app.get("/session/export", (req, res) => {
  try {
    return res.json({ accounts: exportSessionAccountsForClient(req.userSession) })
  } catch (err) {
    logError(err)
    return res.status(500).json({ error: "Unable to export session" })
  }
})

//the browser keeps a copy of its accounts in localStorage as a safety net for a lost
//cookie. that copy is always older than the server's, so it may only ADD accounts the
//session does not have - never overwrite one that is already there. the previous
//version overwrote unconditionally, so the page load right after a successful Google
//connect replaced the brand new access token with a stale cached one, every /storage
//call then 401'd, and the freshly connected account never appeared.
app.post("/session/restore", async (req, res) => {
  try {
    const source = Array.isArray(req.body?.accounts) ? req.body.accounts : []
    const restored = []
    const skipped = []

    for (const raw of source) {
      const provider = normalizeProvider(raw?.provider)
      const email = normalizeEmail(raw?.email)
      if (!provider || !email) continue

      if (getAccountByEmail(req.userSession, email, provider)) {
        skipped.push({ provider, email })
        continue
      }

      if (provider === "mega") {
        const megaSessionToken = typeof raw?.megaSessionToken === "string" ? raw.megaSessionToken.trim() : ""
        if (!megaSessionToken) continue
        upsertAccount(req.userSession, {
          provider: "mega",
          email,
          megaSessionToken
        })
        restored.push({ provider: "mega", email })
        continue
      }

      const token = typeof raw?.token === "string" ? raw.token.trim() : ""
      if (!token) continue
      upsertAccount(req.userSession, {
        provider: "google",
        email,
        token
      })
      restored.push({ provider: "google", email })
    }

    if (restored.length) {
      await req.saveUserSession()
    }
    return res.json({ success: true, restored, skipped })
  } catch (err) {
    logError(err)
    return res.status(500).json({ error: "Unable to restore session" })
  }
})

//safe to expose: says whether sessions can survive between requests, without leaking
//any credential. this is the first thing to check when the deployed site "forgets"
//accounts but localhost does not.
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    serverless: IS_SERVERLESS,
    sessionStore: HAS_UPSTASH ? "upstash-redis" : "in-memory",
    sessionsSurviveRestarts: HAS_UPSTASH,
    warning: IS_SERVERLESS && !HAS_UPSTASH
      ? "Serverless host without Upstash: connected accounts will not survive between requests. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
      : null,
    googleOauthRedirectUri: resolveRedirectUri(req),
    accountsInThisSession: Array.isArray(req.userSession?.accounts) ? req.userSession.accounts.length : 0
  })
})

app.get("/files", async (req, res) => {
  try {
    const email = getQueryTrimmed(req, "email")
    const provider = getQueryTrimmed(req, "provider")

    if (!email) {
      return res.status(400).json({ error: "Query parameter email is required" })
    }

    const parentId = getQueryTrimmed(req, "parentId") || "root"
    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      //needTree:false - listMegaChildren does its own reload.
      const items = await listMegaChildren(await ensureMegaStorageForAccount(account, { needTree: false }), parentId)
      return res.json({ parentId, items })
    }

    if (parentId === "__shared_drives__") {
      const items = await listSharedDrives(account.token)
      return res.json({ parentId, items })
    }

    const items = await listChildrenInFolder(account.token, parentId)
    res.json({ parentId, items })
  } catch (err) {
    sendErrorJson(res, err, "Error fetching files")
  }
})

app.get("/open-file", async (req, res) => {
  try {
    const email = getQueryTrimmed(req, "email")
    const provider = getQueryTrimmed(req, "provider")
    const fileId = getQueryTrimmed(req, "fileId")

    if (!email || !fileId) {
      return res.status(400).json({ error: "Query parameters email and fileId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      const storage = await ensureMegaStorageForAccount(account)
      const node = getMegaNodeById(storage, fileId)
      if (!node) {
        return res.status(404).json({ error: "File not found" })
      }
      if (node.directory) {
        return res.status(400).json({ error: "Cannot open a folder link from this endpoint" })
      }

      const megaUrl = await node.link(false)
      return res.redirect(megaUrl)
    }

    const response = await axios.get(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
      headers: authHeaders(account.token),
      params: {
        fields: "id, webViewLink, webContentLink, mimeType",
        supportsAllDrives: true
      }
    })
    const openUrl = response.data?.webViewLink || response.data?.webContentLink
    if (!openUrl) {
      return res.status(404).json({ error: "No open link available for this file" })
    }
    return res.redirect(openUrl)
  } catch (err) {
    sendErrorJson(res, err, "Error opening file")
  }
})

app.get("/search", async (req, res) => {
  try {
    const query = getQueryTrimmed(req, "q")
    if (!query) {
      return res.status(400).json({ error: "Query parameter q is required" })
    }

    const sessionAccounts = Array.isArray(req.userSession.accounts) ? req.userSession.accounts : []
    if (sessionAccounts.length === 0) {
      return res.json({ query, results: [] })
    }

    const escapedQuery = escapeDriveContains(query)
    const driveQuery = `name contains '${escapedQuery}' and trashed=false`

    const tasks = sessionAccounts.map(async (account) => {
      if (account.provider === "mega") {
        //ensureMegaStorageForAccount already reloads the tree when needTree is on.
        const storage = await ensureMegaStorageForAccount(account)
        const needle = query.toLowerCase()

        return (storage.filter(() => true, true) || [])
          .filter((node) => node && node.name && String(node.name).toLowerCase().includes(needle))
          .slice(0, 100)
          .map((node) => ({
            ...normalizeMegaNode(node, node.parent ? node.parent.nodeId : "root"),
            accountEmail: account.email,
            accountProvider: account.provider
          }))
      }

      const response = await axios.get(DRIVE_FILES_URL, {
        headers: authHeaders(account.token),
        params: {
          q: driveQuery,
          pageSize: 100,
          fields: "files(id, name, mimeType, size, modifiedTime, webViewLink, driveId, parents)",
          orderBy: "modifiedTime desc",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "allDrives"
        }
      })

      return (response.data.files || []).map((file) => ({
        ...file,
        accountEmail: account.email,
        accountProvider: account.provider
      }))
    })

    //one dead account must not wipe out the results of the healthy ones, so failures
    //are collected and reported next to the hits instead of rejecting the request.
    const settled = await Promise.allSettled(
      tasks.map((task, index) => withTimeout(task, STORAGE_ACCOUNT_TIMEOUT_MS, `Searching ${sessionAccounts[index]?.email}`))
    )

    const results = []
    const failed = []
    settled.forEach((item, index) => {
      const account = sessionAccounts[index] || {}
      if (item.status === "fulfilled") {
        results.push(...(Array.isArray(item.value) ? item.value : []))
        return
      }
      const err = item.reason
      console.error(`[multi-drive] /search failed for ${account.provider}:${account.email}:`, err?.response?.data || err?.message)
      failed.push({
        provider: normalizeProvider(account.provider),
        email: normalizeEmail(account.email),
        error: err?.isTimeout ? "Timed out" : (err?.response?.data?.error?.message || err?.message || "Search failed")
      })
    })

    res.json({ query, results, failed })
  } catch (err) {
    sendErrorJson(res, err, "Error searching files")
  }
})

app.post("/delete-item", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const fileId = getBodyTrimmed(req, "fileId")

    if (!email || !fileId) {
      return res.status(400).json({ error: "email and fileId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      return res.status(403).json({ error: "Delete feature is only available in Google Drive account for now. i am working on it, stay tuned!" })
    }

    await axios.delete(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
      headers: authHeaders(account.token),
      params: { supportsAllDrives: true }
    })

    res.json({ success: true })
  } catch (err) {
    sendErrorJson(res, err, "Error deleting file")
  }
})

app.post("/copy-item", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const fileId = getBodyTrimmed(req, "fileId")
    const destinationFolderId = getBodyTrimmed(req, "destinationFolderId")

    if (!email || !fileId || !destinationFolderId) {
      return res.status(400).json({ error: "email, fileId and destinationFolderId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      const storage = await ensureMegaStorageForAccount(account)
      const source = getMegaNodeById(storage, fileId)
      const target = destinationFolderId === "root" ? storage.root : getMegaNodeById(storage, destinationFolderId)
      if (!source || !target || !target.directory) {
        return res.status(404).json({ error: "Source or destination not found" })
      }
      await source.copyTo(target)
      return res.json({ success: true })
    }

    await axios.post(
      `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/copy`,
      { parents: [destinationFolderId] },
      {
        headers: {
          ...authHeaders(account.token),
          "Content-Type": "application/json"
        },
        params: { supportsAllDrives: true }
      }
    )

    res.json({ success: true })
  } catch (err) {
    sendErrorJson(res, err, "Error copying file")
  }
})

app.post("/move-item", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const fileId = getBodyTrimmed(req, "fileId")
    const destinationFolderId = getBodyTrimmed(req, "destinationFolderId")

    if (!email || !fileId || !destinationFolderId) {
      return res.status(400).json({ error: "email, fileId and destinationFolderId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      const storage = await ensureMegaStorageForAccount(account)
      const source = getMegaNodeById(storage, fileId)
      const target = destinationFolderId === "root" ? storage.root : getMegaNodeById(storage, destinationFolderId)
      if (!source || !target || !target.directory) {
        return res.status(404).json({ error: "Source or destination not found" })
      }
      await source.moveTo(target)
      return res.json({ success: true })
    }

    const currentFile = await axios.get(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
      headers: authHeaders(account.token),
      params: { fields: "parents", supportsAllDrives: true }
    })

    const existingParents = Array.isArray(currentFile.data?.parents) ? currentFile.data.parents.filter(Boolean) : []
    const removeParents = existingParents.join(",")
    const params = { addParents: destinationFolderId, supportsAllDrives: true }
    if (removeParents) params.removeParents = removeParents

    await axios.patch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, null, {
      headers: authHeaders(account.token),
      params
    })

    res.json({ success: true })
  } catch (err) {
    sendErrorJson(res, err, "Error moving file")
  }
})

app.post("/create-folder", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const parentId = getBodyTrimmed(req, "parentId") || "root"
    const folderName = getBodyTrimmed(req, "folderName")

    if (!email || !folderName) {
      return res.status(400).json({ error: "email and folderName are required" })
    }

    if (parentId === "__shared_drives__") {
      return res.status(400).json({ error: "Open a destination folder first" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (account.provider === "mega") {
      const storage = await ensureMegaStorageForAccount(account)
      const targetFolder = parentId === "root" ? storage.root : getMegaNodeById(storage, parentId)
      if (!targetFolder || !targetFolder.directory) {
        return res.status(404).json({ error: "Destination folder not found" })
      }
      const created = await targetFolder.mkdir(folderName)
      //no second reload: the created node is returned straight away and the next
      //request re-reads the tree anyway. one less full tree download per folder.
      return res.json({ success: true, item: normalizeMegaNode(created, targetFolder.nodeId || "root") })
    }

    const response = await axios.post(
      DRIVE_FILES_URL,
      {
        name: folderName,
        mimeType: FOLDER_MIME,
        parents: [parentId]
      },
      {
        headers: {
          ...authHeaders(account.token),
          "Content-Type": "application/json"
        },
        params: {
          fields: "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId",
          supportsAllDrives: true
        }
      }
    )

    return res.json({ success: true, item: response.data })
  } catch (err) {
    sendErrorJson(res, err, "Error creating folder")
  }
})


//Uploading a file no longer means pushing it through this server.
//The browser asks here for a Google resumable session URL, then PUTs the bytes straight to
//Google. This request carries no file data, so it finishes in milliseconds and fits inside
//any serverless request body limit - which is the only reason uploads work on Vercel at
//all. It also means the browser's progress events finally measure the real transfer.
app.post("/upload-session", async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const parentId = getBodyTrimmed(req, "parentId")
    const name = getBodyTrimmed(req, "name") || "upload.bin"
    const mimeType = getBodyTrimmed(req, "mimeType") || "application/octet-stream"
    const size = Number(req.body?.size || 0) || 0

    if (!email || !parentId) {
      return res.status(400).json({ error: "email and parentId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found. Reconnect it and try again." })
    }

    //MEGA has no equivalent handoff: its upload needs the account session and megajs's
    //chunk encryption, so those bytes still travel through this server. Telling the browser
    //the cap up front turns an over sized MEGA upload into a sentence it can show instead
    //of the host's own error page.
    if (normalizeProvider(account.provider) === "mega") {
      return res.json({
        mode: "server",
        providerName: "MEGA",
        maxBytes: PROXY_UPLOAD_MAX_BYTES
      })
    }

    const startRes = await axios.post(
      DRIVE_UPLOAD_URL,
      { name, parents: [parentId] },
      {
        headers: {
          ...authHeaders(account.token),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          ...(size > 0 ? { "X-Upload-Content-Length": String(size) } : {})
        },
        params: {
          uploadType: "resumable",
          supportsAllDrives: true,
          fields: "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId"
        }
      }
    )

    const uploadUrl = startRes.headers && (startRes.headers.location || startRes.headers.Location)
    if (!uploadUrl) {
      return res.status(502).json({ error: "Google did not return an upload session URL" })
    }

    //the session URL is the credential for the PUT, so no access token reaches the browser.
    res.json({ mode: "direct", uploadUrl, maxBytes: PROXY_UPLOAD_MAX_BYTES })
  } catch (err) {
    sendErrorJson(res, err, "Could not start the upload")
  }
})

//MEGA only. Google Drive bytes never arrive here any more, see /upload-session.
app.post("/upload-item-stream", async (req, res) => {
  const bb = busboy({
    headers: req.headers,
    limits: { fileSize: PROXY_UPLOAD_MAX_BYTES }
  })

  const fields = {}
  let responded = false

  function safeRespond(status, body) {
    if (responded) return
    responded = true
    res.status(status).json(body)
  }

  bb.on("field", (name, val) => {
    fields[name] = String(val).trim()
  })

  bb.on("file", async (_fieldname, fileStream, info) => {
    const email = fields.email || getQueryTrimmed({ query: req.headers }, "x-upload-email")
    const provider = fields.provider || getQueryTrimmed({ query: req.headers }, "x-upload-provider")
    const parentId = fields.parentId || getQueryTrimmed({ query: req.headers }, "x-upload-parent-id")
    const uploadId = fields.uploadId || getQueryTrimmed({ query: req.headers }, "x-upload-id")
    const fileName = info.filename || "upload.bin"
    const fileMime = info.mimeType || "application/octet-stream"
    const fileSize = parseInt(req.headers["x-file-size"] || "0", 10) || 0

    if (!email || !parentId) {
      fileStream.resume()
      return safeRespond(400, { error: "email and parentId are required" })
    }

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      fileStream.resume()
      return safeRespond(404, { error: "Account not found" })
    }

    setUploadProgress(uploadId, {
      sessionId: req.sessionId,
      status: "uploading",
      phase: "initiating",
      provider: normalizeProvider(account.provider),
      fileName,
      bytesUploaded: 0,
      bytesTotal: fileSize,
      message: "Preparing upload"
    })

    if (normalizeProvider(account.provider) === "mega") {
      try {
        const storage = await ensureMegaStorageForAccount(account)

        const targetFolder =
          parentId === "root" ? storage.root : getMegaNodeById(storage, parentId)

        if (!targetFolder || !targetFolder.directory) {
          fileStream.resume()
          return safeRespond(404, { error: "Destination folder not found" })
        }

        if (!fileSize || fileSize <= 0) {
          fileStream.resume()
          return safeRespond(400, { error: "x-file-size header is required for MEGA stream upload" })
        }

        setUploadProgress(uploadId, {
          status: "uploading",
          phase: "mega",
          bytesUploaded: 0,
          bytesTotal: fileSize,
          message: "Uploading to MEGA"
        })

        const uploadStream = targetFolder.upload(
          { name: fileName, size: fileSize, allowUploadBuffering: false },
          fileStream
        )
        uploadStream.on("progress", (p) => {
          const megaUploaded = Number(p?.bytesUploaded || 0)
          const megaTotal = Number(p?.bytesTotal || fileSize)
          setUploadProgress(uploadId, {
            status: "uploading",
            phase: "mega",
            bytesUploaded: Math.max(0, Math.min(fileSize, megaUploaded)),
            bytesTotal: Math.max(fileSize, megaTotal),
            message: "Uploading to MEGA"
          })
        })

        uploadStream.on("error", (err) => {
          setUploadProgress(uploadId, {
            status: "error",
            phase: "error",
            message: err && err.message ? err.message : "MEGA upload stream error"
          })
        })

        await uploadStream.complete

        setUploadProgress(uploadId, {
          status: "done",
          phase: "done",
          bytesUploaded: fileSize,
          bytesTotal: fileSize,
          message: "Upload complete"
        })
        cleanupUploadProgress(uploadId)
        return safeRespond(200, { success: true })
      } catch (err) {
        setUploadProgress(uploadId, { status: "error", phase: "error", message: err.message })
        cleanupUploadProgress(uploadId, 60000)
        logError(err)
        return safeRespond(500, { error: err.message || "MEGA upload failed" })
      }
    }

    //Google Drive used to be streamed on to Google from here. It was also the worst place
    //for it: the bytes crossed the network twice, the old progress counter measured the
    //browser -> server hop rather than the server -> Google one, and on a serverless host
    //the request body never even arrived. The browser PUTs to Google itself now, so
    //anything non-MEGA reaching this route is a page loaded before the change.
    fileStream.resume()
    return safeRespond(400, {
      error: "Google Drive uploads no longer go through the server. Reload the page and try again."
    })
  })

  bb.on("error", (err) => {
    logError(err)
    if (!responded) {
      responded = true
      res.status(500).json({ error: "Multipart parse error: " + err.message })
    }
  })

  req.pipe(bb)
})

app.post("/upload-item", upload.single("file"), async (req, res) => {
  try {
    const email = getBodyTrimmed(req, "email")
    const provider = getBodyTrimmed(req, "provider")
    const parentId = getBodyTrimmed(req, "parentId")
    const uploadId = getBodyTrimmed(req, "uploadId")
    const file = req.file

    if (!email || !parentId || !file) {
      return res.status(400).json({ error: "email, parentId and file are required" })
    }

    setUploadProgress(uploadId, {
      sessionId: req.sessionId,
      status: "received",
      phase: "server",
      provider: normalizeProvider(provider),
      fileName: file.originalname || "upload.bin",
      bytesUploaded: 0,
      bytesTotal: Number(file.size || 0),
      message: "File received by server"
    })

    const account = getAccountByEmail(req.userSession, email, provider)
    if (!account) {
      return res.status(404).json({ error: "Account not found" })
    }

    if (normalizeProvider(account.provider) === "mega") {
      const storage = await ensureMegaStorageForAccount(account)
      const targetFolder = parentId === "root" ? storage.root : getMegaNodeById(storage, parentId)
      if (!targetFolder || !targetFolder.directory) {
        return res.status(404).json({ error: "Destination folder not found" })
      }

      const uploadStream = targetFolder.upload({ name: file.originalname || "upload.bin" }, file.buffer)
      setUploadProgress(uploadId, {
        status: "uploading",
        phase: "mega",
        bytesUploaded: 0,
        bytesTotal: Number(file.size || 0),
        message: "Uploading to MEGA"
      })
      uploadStream.on("progress", (p) => {
        const up = Number(p && p.bytesUploaded ? p.bytesUploaded : 0)
        const total = Number(p && p.bytesTotal ? p.bytesTotal : file.size || 0)
        setUploadProgress(uploadId, {
          status: "uploading",
          phase: "mega",
          bytesUploaded: up,
          bytesTotal: total,
          message: "Uploading to MEGA"
        })
      })
      await uploadStream.complete
      setUploadProgress(uploadId, {
        status: "done",
        phase: "done",
        bytesUploaded: Number(file.size || 0),
        bytesTotal: Number(file.size || 0),
        message: "Upload complete"
      })
      cleanupUploadProgress(uploadId)
      return res.json({ success: true })
    }

    //Google Drive goes browser -> Google now, see /upload-session.
    return res.status(400).json({
      error: "Google Drive uploads no longer go through the server. Reload the page and try again."
    })
  } catch (err) {
    const uploadId = getBodyTrimmed(req, "uploadId")
    setUploadProgress(uploadId, {
      status: "error",
      phase: "error",
      message: err && err.message ? err.message : "Upload failed"
    })
    cleanupUploadProgress(uploadId, 60 * 1000)
    sendErrorJson(res, err, "Error uploading file")
  }
})

app.get("/upload-progress", async (req, res) => {
  const uploadId = getQueryTrimmed(req, "uploadId")
  if (!uploadId) {
    return res.status(400).json({ error: "uploadId is required" })
  }
  let state = null
  if (HAS_UPSTASH) {
    state = await redisGetJson(`multidrive:progress:${uploadId}`).catch(() => null)
  } else {
    state = uploadProgress.get(uploadId)
  }
  if (!state || String(state.sessionId || "") !== String(req.sessionId || "")) {
    return res.json({ status: "unknown" })
  }
  res.json(state)
})

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large for a server side upload. Max is " +
        Math.round(MULTER_MAX_BYTES / (1024 * 1024)) + " MB."
    })
  }
  if (err) {
    return res.status(500).json({ error: err.message || "Server error" })
  }
  next()
})

const PORT = Number(process.env.PORT || 3000)

//megajs emits errors on its own EventEmitters (api "error", storage "error") from
//background sockets. an unhandled one takes the whole process down - on a serverless
//host that means every other request landing on that instance fails too. log and
//survive instead.
process.on("unhandledRejection", (reason) => {
  console.error("[multi-drive] unhandled rejection:", reason?.message || reason)
})

process.on("uncaughtException", (err) => {
  console.error("[multi-drive] uncaught exception:", err?.stack || err?.message || err)
})

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}/`)
    console.log(`Session store: ${HAS_UPSTASH ? "Upstash Redis (shared)" : "in-memory (single process only)"}`)
  })
}

module.exports = app

