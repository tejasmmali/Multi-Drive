const THEME_STORAGE_KEY = "multidrive-theme";
const USER_NAME_STORAGE_KEY = "multidrive-user-name";
const SEARCH_HISTORY_STORAGE_KEY = "multidrive-search-history";
const SEARCH_HISTORY_MAX = 7;
const GOOGLE_CLIENT_ID_STORAGE_KEY = "multidrive-google-client-id";
const GOOGLE_CLIENT_SECRET_STORAGE_KEY = "multidrive-google-client-secret";
const BROWSER_ACCOUNTS_CACHE_KEY = "multidrive-browser-accounts-v1";

// Provider logos are inlined on purpose. They used to be loaded from dl.svgcdn.com,
// which no longer resolves, so the sidebar rendered a broken image glyph next to
// "GOOGLE DRIVE". Inline SVG cannot break, needs no network round trip, and works
// behind a proxy or offline.
const GOOGLE_DRIVE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 87.3 78" role="img" aria-label="Google Drive" focusable="false">' +
  '<path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>' +
  '<path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44C.4 49.9 0 51.45 0 53h27.5z" fill="#00ac47"/>' +
  '<path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z" fill="#ea4335"/>' +
  '<path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>' +
  '<path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>' +
  '<path d="M73.4 26.5l-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>' +
  "</svg>";
const MEGA_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="MEGA" focusable="false">' +
  '<circle cx="12" cy="12" r="12" fill="#d9272e"/>' +
  '<path d="M4.9 7.3h2.5L12 11.9l4.6-4.6h2.5v9.4h-2.2v-6l-4.9 4.9-4.9-4.9v6H4.9z" fill="#fff"/>' +
  "</svg>";

function getSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, SEARCH_HISTORY_MAX);
  } catch (e) {
    return [];
  }
}

function saveSearchHistoryTerm(term) {
  const value = String(term || "").trim();
  if (!value) return;
  const next = [
    value,
    ...getSearchHistory().filter(
      (item) => item.toLowerCase() !== value.toLowerCase(),
    ),
  ].slice(0, SEARCH_HISTORY_MAX);
  localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
}

function readBrowserAccountsCache() {
  try {
    const raw = localStorage.getItem(BROWSER_ACCOUNTS_CACHE_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeBrowserAccountsCache(accounts) {
  try {
    localStorage.setItem(
      BROWSER_ACCOUNTS_CACHE_KEY,
      JSON.stringify(Array.isArray(accounts) ? accounts : []),
    );
  } catch (e) {}
}

async function syncBrowserAccountsCacheFromServer() {
  try {
    const res = await fetch("/session/export", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    writeBrowserAccountsCache(
      payload && Array.isArray(payload.accounts) ? payload.accounts : [],
    );
  } catch (e) {}
}

// The localStorage copy of the accounts is only a safety net for a lost md_sid cookie.
// It is always older than what the server has, so it must never be pushed on top of a
// live session: doing that used to replace a just-issued Google access token with a
// stale one, every /storage call then failed, and the account that was connected
// seconds earlier never showed up on the home screen.
async function restoreSessionFromBrowserCache() {
  const cached = readBrowserAccountsCache();
  if (!cached.length) return;

  try {
    const res = await fetch("/session/export", { cache: "no-store" });
    if (res.ok) {
      const payload = await res.json();
      const serverAccounts =
        payload && Array.isArray(payload.accounts) ? payload.accounts : [];
      // server already knows about accounts - it is the source of truth, leave it alone.
      if (serverAccounts.length) return;
    }
  } catch (e) {
    // could not ask the server; fall through and try to restore.
  }

  try {
    await fetch("/session/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: cached }),
    });
  } catch (e) {}
}

// Small inline banner. Used for OAuth failures handed back on the URL and for accounts
// that need reconnecting, so those states are visible instead of silently rendering an
// empty home screen.
function showConnectNotice(message, isError) {
  const text = String(message || "").trim();
  if (!text) return;

  let bar = document.getElementById("connectNoticeBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "connectNoticeBar";
    bar.setAttribute("role", "status");
    bar.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);top:16px;z-index:9999;" +
      "max-width:min(720px,92vw);padding:12px 40px 12px 16px;border-radius:10px;" +
      "font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18);" +
      "word-break:break-word;";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss message");
    close.textContent = "×";
    close.style.cssText =
      "position:absolute;top:6px;right:10px;background:none;border:0;color:inherit;" +
      "font-size:20px;line-height:1;cursor:pointer;";
    close.addEventListener("click", () => bar.remove());
    bar.appendChild(document.createElement("span"));
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  bar.style.background = isError ? "#fdecea" : "#e8f4ea";
  bar.style.color = isError ? "#8a1c14" : "#14532d";
  bar.style.border = "1px solid " + (isError ? "#f3b7b1" : "#a8d5b5");

  // A message can end with a URL the user has to open (for example the Google Cloud
  // console page for enabling the Drive API), so make that part clickable.
  const holder = bar.firstChild;
  holder.textContent = "";
  const urlMatch = text.match(/https?:\/\/\S+$/);
  if (urlMatch) {
    holder.appendChild(
      document.createTextNode(text.slice(0, urlMatch.index).trim() + " "),
    );
    const link = document.createElement("a");
    link.href = urlMatch[0];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open Google Cloud console";
    link.style.color = "inherit";
    link.style.fontWeight = "700";
    holder.appendChild(link);
  } else {
    holder.textContent = text;
  }

  window.clearTimeout(showConnectNotice._timer);
  showConnectNotice._timer = window.setTimeout(() => {
    if (bar && bar.parentNode) bar.remove();
  }, isError ? 30000 : 6000);
}

// Messages the server hands back on a redirect (Google/MEGA connect results).
function consumeConnectMessagesFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("connectError") || params.get("error");
    const connected = params.get("connected");
    if (!error && !connected) return;

    if (error) showConnectNotice(error, true);
    else if (connected) {
      showConnectNotice(
        connected === "google"
          ? "Google account connected."
          : "Account connected.",
        false,
      );
    }

    ["connectError", "error", "connected", "connect"].forEach((key) =>
      params.delete(key),
    );
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? "?" + query : ""),
    );
  } catch (e) {}
}

function connectDrive() {
  openConnectProviderModal();
}

function openConnectProviderModal() {
  const modal = document.getElementById("connectProviderModal");
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const firstBtn = document.getElementById("connectGoogleBtn");
  if (firstBtn) {
    window.setTimeout(() => firstBtn.focus(), 0);
  }
}

function closeConnectProviderModal() {
  const modal = document.getElementById("connectProviderModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  setGoogleProviderSettingsMenuVisible(false);
}

function setGoogleProviderSettingsMenuVisible(show) {
  const menu = document.getElementById("googleProviderSettingsMenu");
  if (!menu) return;
  menu.classList.toggle("open", !!show);
  menu.setAttribute("aria-hidden", show ? "false" : "true");
}

function changeGoogleSavedCredentials() {
  setGoogleProviderSettingsMenuVisible(false);
  openGoogleOauthModal();
}

function resetGoogleSavedCredentials() {
  localStorage.removeItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
  localStorage.removeItem(GOOGLE_CLIENT_SECRET_STORAGE_KEY);
  setGoogleProviderSettingsMenuVisible(false);
  setGoogleOauthStatus("Saved credentials were reset.", false);
}

function connectProvider(provider) {
  if (normalizeProvider(provider) === "mega") {
    closeConnectProviderModal();
    openMegaLoginModal();
    return;
  }
  closeConnectProviderModal();
  const savedId = localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY) || "";
  const savedSecret =
    localStorage.getItem(GOOGLE_CLIENT_SECRET_STORAGE_KEY) || "";
  if (savedId && savedSecret) {
    startGoogleOAuthFlow(savedId, savedSecret);
    return;
  }
  openGoogleOauthModal();
}

function openGoogleOauthModal() {
  const modal = document.getElementById("googleOauthModal");
  const statusEl = document.getElementById("googleOauthStatus");
  const idInput = document.getElementById("googleClientIdInput");
  const secretInput = document.getElementById("googleClientSecretInput");
  const rememberInput = document.getElementById("googleOauthRememberInput");
  if (!modal || !idInput || !secretInput || !rememberInput) return;

  const savedId = localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY) || "";
  const savedSecret =
    localStorage.getItem(GOOGLE_CLIENT_SECRET_STORAGE_KEY) || "";
  idInput.value = savedId;
  secretInput.value = savedSecret;
  rememberInput.checked = !!(savedId && savedSecret);
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => idInput.focus(), 0);
}

function closeGoogleOauthModal() {
  const modal = document.getElementById("googleOauthModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function setGoogleOauthStatus(message, isError) {
  const statusEl = document.getElementById("googleOauthStatus");
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", !!isError);
}

async function startGoogleOAuthFlow(clientId, clientSecret) {
  const continueBtn = document.getElementById("googleOauthContinueBtn");
  if (continueBtn) continueBtn.disabled = true;
  setGoogleOauthStatus("Starting Google sign-in...", false);

  try {
    const body = {};
    if (clientId) body.clientId = String(clientId).trim();
    if (clientSecret) body.clientSecret = String(clientSecret).trim();

    const res = await fetch("/auth/google/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok || !payload || !payload.url) {
      const msg =
        payload && payload.error
          ? payload.error
          : "Unable to start Google login";
      setGoogleOauthStatus(msg, true);
      return;
    }

    window.location.href = String(payload.url);
  } catch (e) {
    setGoogleOauthStatus("Unable to start Google login.", true);
  } finally {
    if (continueBtn) continueBtn.disabled = false;
  }
}

async function submitGoogleOauthForm(ev) {
  if (ev) ev.preventDefault();
  const idInput = document.getElementById("googleClientIdInput");
  const secretInput = document.getElementById("googleClientSecretInput");
  const rememberInput = document.getElementById("googleOauthRememberInput");
  if (!idInput || !secretInput || !rememberInput) return;

  const clientId = String(idInput.value || "").trim();
  const clientSecret = String(secretInput.value || "").trim();
  if (!clientId || !clientSecret) {
    setGoogleOauthStatus("Enter both Client ID and Client Secret.", true);
    return;
  }

  if (rememberInput.checked && clientId && clientSecret) {
    localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, clientId);
    localStorage.setItem(GOOGLE_CLIENT_SECRET_STORAGE_KEY, clientSecret);
  } else {
    localStorage.removeItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
    localStorage.removeItem(GOOGLE_CLIENT_SECRET_STORAGE_KEY);
  }

  await startGoogleOAuthFlow(clientId, clientSecret);
}

function openMegaLoginModal() {
  const modal = document.getElementById("megaLoginModal");
  const statusEl = document.getElementById("megaLoginStatus");
  if (!modal) return;
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const emailInput = document.getElementById("megaEmailInput");
  if (emailInput) {
    window.setTimeout(() => emailInput.focus(), 0);
  }
}

function closeMegaLoginModal() {
  const modal = document.getElementById("megaLoginModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function setMegaLoginStatus(message, isError) {
  const statusEl = document.getElementById("megaLoginStatus");
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", !!isError);
}

async function submitMegaLoginForm(ev) {
  if (ev) ev.preventDefault();
  const form = document.getElementById("megaLoginForm");
  if (!form) return;

  const email = String(form.email?.value || "").trim();
  const password = String(form.password?.value || "");
  const secondFactorCode = String(form.secondFactorCode?.value || "").trim();
  if (!email || !password) {
    setMegaLoginStatus("Email and password are required.", true);
    return;
  }

  const submitBtn = document.getElementById("megaLoginSubmitBtn");
  if (submitBtn) submitBtn.disabled = true;
  setMegaLoginStatus("Connecting MEGA account...", false);

  try {
    const res = await fetch("/auth/mega/login-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, secondFactorCode }),
    });
    const payload = await res.json();
    if (!res.ok) {
      const msg =
        payload && payload.error ? payload.error : "Unable to login to MEGA";
      setMegaLoginStatus(msg, true);
      return;
    }
    setMegaLoginStatus("MEGA account connected.", false);
    await loadStorage();
    window.setTimeout(() => {
      closeMegaLoginModal();
      form.reset();
    }, 300);
  } catch (e) {
    setMegaLoginStatus("Connection failed. Please try again.", true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function connectMegaWithSavedToken() {
  const tokenBtn = document.getElementById("megaTokenSubmitBtn");
  if (tokenBtn) tokenBtn.disabled = true;
  setMegaLoginStatus("Connecting saved MEGA token...", false);
  try {
    const res = await fetch("/auth/mega/token-json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) {
      const msg =
        payload && payload.error
          ? payload.error
          : "Unable to connect MEGA token";
      setMegaLoginStatus(msg, true);
      return;
    }
    setMegaLoginStatus("MEGA token connected.", false);
    await loadStorage();
    window.setTimeout(closeMegaLoginModal, 300);
  } catch (e) {
    setMegaLoginStatus("Connection failed. Please try again.", true);
  } finally {
    if (tokenBtn) tokenBtn.disabled = false;
  }
}

function applyTheme(theme) {
  const useDark = theme === "dark";
  document.body.classList.toggle("darkMode", useDark);
  const btn = document.getElementById("themeSwitchBtn");
  const icon = document.getElementById("themeSwitchIcon");
  if (btn && icon) {
    if (useDark) {
      icon.textContent = "light_mode";
      btn.setAttribute("aria-label", "Switch to light mode");
      btn.setAttribute("title", "Switch to light mode");
    } else {
      icon.textContent = "dark_mode";
      btn.setAttribute("aria-label", "Switch to dark mode");
      btn.setAttribute("title", "Switch to dark mode");
    }
  }
}

function formatFileSize(bytes) {
  if (bytes == null || bytes === "") return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }

  return (i === 0 ? Math.round(v) : v.toFixed(i >= 3 ? 2 : 1)) + " " + units[i];
}

function renderSidebarSkeleton(count) {
  const total = Math.max(3, Number(count) || 5);
  const rows = Array.from({ length: total })
    .map(() => {
      return '<span class="skeletonWave sidebarSkeletonLine"></span>';
    })
    .join("");
  return '<div class="sidebarSkeleton">' + rows + "</div>";
}

function renderCardSkeletons(count) {
  const total = Math.max(1, Number(count) || 4);
  const cards = Array.from({ length: total })
    .map(() => {
      return (
        '<div class="card cardSkeleton">' +
        '<div class="cardSkeletonHead">' +
        '<div class="cardSkeletonAvatarWrap"><span class="skeletonWave cardSkeletonAvatar"></span></div>' +
        "<div>" +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonEmail"></span>' +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonProvider"></span>' +
        "</div>" +
        "</div>" +
        '<span class="skeletonWave cardSkeletonBar"></span>' +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonMid"></span>' +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonShort"></span>' +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonShort"></span>' +
        '<span class="skeletonWave cardSkeletonLine cardSkeletonShort"></span>' +
        '<span class="skeletonWave cardSkeletonBtn"></span>' +
        "</div>"
      );
    })
    .join("");

  return cards;
}

function renderBrowseSkeleton(rowCount) {
  const count = Math.max(4, Number(rowCount) || 8);
  const rows = Array.from({ length: count })
    .map(() => {
      return '<tr><td><span class="skeletonWave searchSkeletonCell" style="width:58%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:72%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:56%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:82%;"></span></td></tr>';
    })
    .join("");
  return (
    '<table class="browseSkeletonTable"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>' +
    rows +
    "</tbody></table>"
  );
}

function renderSearchSkeleton(rowCount) {
  const count = Math.max(4, Number(rowCount) || 6);
  const rows = Array.from({ length: count })
    .map(() => {
      return '<tr><td><span class="skeletonWave searchSkeletonCell" style="width:68%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:82%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:56%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:62%;"></span></td><td><span class="skeletonWave searchSkeletonCell" style="width:16px;height:16px;border-radius:9999px;margin-left:auto;"></span></td></tr>';
    })
    .join("");
  return (
    '<table class="searchSkeletonTable"><thead><tr><th>Name</th><th>Account</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>' +
    rows +
    "</tbody></table>"
  );
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function normalizeProvider(provider) {
  return String(provider || "google")
    .trim()
    .toLowerCase() === "mega"
    ? "mega"
    : "google";
}

function providerName(provider) {
  return normalizeProvider(provider) === "mega" ? "MEGA" : "Google Drive";
}

function normalizeUserName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSavedUserName() {
  return normalizeUserName(localStorage.getItem(USER_NAME_STORAGE_KEY) || "");
}

function setGreetingFromSavedName() {
  const greetingEl = document.getElementById("greeting");
  if (!greetingEl) return;
  const savedName = getSavedUserName();
  greetingEl.textContent = savedName
    ? "hello, " + savedName
    : "Storage Dashboard";
}

function openNamePromptModal() {
  const modal = document.getElementById("namePromptModal");
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const input = document.getElementById("namePromptInput");
  if (input) {
    window.setTimeout(() => input.focus(), 0);
  }
}

function closeNamePromptModal() {
  const modal = document.getElementById("namePromptModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function initFirstVisitNamePrompt() {
  setGreetingFromSavedName();
  if (!getSavedUserName()) {
    openNamePromptModal();
  }
}

function submitNamePrompt(ev) {
  if (ev) ev.preventDefault();
  const form = document.getElementById("namePromptForm");
  if (!form) return;
  const rawName = form.name ? form.name.value : "";
  const name = normalizeUserName(rawName);
  if (!name) {
    const input = document.getElementById("namePromptInput");
    if (input) input.focus();
    return;
  }
  localStorage.setItem(USER_NAME_STORAGE_KEY, name);
  setGreetingFromSavedName();
  closeNamePromptModal();
}

function getAccountDisplayName(account) {
  const rawName = String(
    account && account.user && account.user.displayName
      ? account.user.displayName
      : "",
  ).trim();
  if (!rawName) return "";
  const name = rawName.toLowerCase();
  if (name === "mega" || name === "google drive" || name === "google") {
    return "";
  }
  return rawName;
}

function getAccountFirstName(account) {
  const givenName = String(
    account && account.user && account.user.givenName
      ? account.user.givenName
      : "",
  ).trim();
  if (givenName) {
    return givenName;
  }

  const display = getAccountDisplayName(account);
  if (display) {
    return (display.split(/\s+/).find(Boolean) || "").trim();
  }

  const email = String(
    account && account.user && account.user.emailAddress
      ? account.user.emailAddress
      : "",
  ).trim();
  if (!email || email.indexOf("@") === -1) {
    return "";
  }
  const local = email
    .split("@")[0]
    .replace(/[._+\-]+/g, " ")
    .trim();
  return (local.split(/\s+/).find(Boolean) || "").trim();
}

function makeAccountKey(email, provider) {
  return (
    normalizeProvider(provider) +
    "::" +
    String(email || "")
      .trim()
      .toLowerCase()
  );
}

function parseAccountKey(key) {
  const raw = String(key || "");
  const idx = raw.indexOf("::");
  if (idx === -1) {
    return { provider: "google", email: raw.trim() };
  }
  return {
    provider: normalizeProvider(raw.slice(0, idx)),
    email: raw.slice(idx + 2).trim(),
  };
}

function closeBrowseModal() {
  const el = document.getElementById("browseModal");
  if (el) {
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }
}

function openBrowseModal() {
  const el = document.getElementById("browseModal");
  if (el) {
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
let connectedAccountCount = 0;
let searchSuggestTimer = null;
let searchSuggestRequestId = 0;
let allowSearchSuggestions = false;
let homeAccounts = [];
let homeDropFiles = [];
let homeDragDepth = 0;
let homeUploadInProgress = false;
let homeUploadCancelRequested = false;
let homeActivePollTimer = null;

let browseEmail = "";
let browseProvider = "google";
let browsePath = [];
let fileContextTarget = null;
let driveClipboard = null;

function goToMyDriveRoot() {
  browsePath = [{ id: "root", name: "My Drive" }];
  loadBrowseFolder();
}

function goToSharedDrivesList() {
  browsePath = [{ id: "__shared_drives__", name: "Shared drives" }];
  loadBrowseFolder();
}

function openBrowseFolder(id, name) {
  browsePath.push({ id, name: name || "(folder)" });
  loadBrowseFolder();
}

function closeFileContextMenu() {
  const menu = document.getElementById("fileContextMenu");
  if (!menu) return;
  menu.style.display = "none";
  menu.setAttribute("aria-hidden", "true");
  fileContextTarget = null;
}

function openFileContextMenu(x, y, item) {
  const menu = document.getElementById("fileContextMenu");
  if (!menu) return;
  fileContextTarget = item;
  updateFileContextButtonsState();
  menu.style.display = "block";
  menu.setAttribute("aria-hidden", "false");

  const maxLeft = window.innerWidth - menu.offsetWidth - 8;
  const maxTop = window.innerHeight - menu.offsetHeight - 8;
  const left = Math.max(8, Math.min(x, maxLeft));
  const top = Math.max(8, Math.min(y, maxTop));

  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function getCurrentBrowseFolderId() {
  const current = browsePath[browsePath.length - 1];
  if (!current || !current.id || current.id === "__shared_drives__") {
    return "";
  }
  return current.id;
}

function updateFileContextButtonsState() {
  const pasteBtn = document.getElementById("fileContextPasteBtn");
  const moveBtn = document.getElementById("fileContextMoveBtn");
  const deleteBtn = document.getElementById("fileContextDeleteBtn");
  const hasTarget = !!(fileContextTarget && fileContextTarget.id);
  const hasClipboard = !!(
    driveClipboard &&
    driveClipboard.id &&
    driveClipboard.email
  );
  const deleteProvider = normalizeProvider(
    (fileContextTarget && fileContextTarget.provider) || browseProvider,
  );
  const isMegaDeleteTarget = hasTarget && deleteProvider === "mega";

  if (pasteBtn) {
    pasteBtn.disabled = !hasClipboard || !getCurrentBrowseFolderId();
  }
  if (moveBtn) {
    moveBtn.disabled = !hasTarget;
  }
  if (deleteBtn) {
    deleteBtn.disabled = !hasTarget;
    deleteBtn.title = isMegaDeleteTarget
      ? "Delete feature is only available in Google Drive account for now. i am working on it, stay tuned!"
      : "";
  }
}

function stashClipboard(mode) {
  if (!fileContextTarget || !fileContextTarget.id || !fileContextTarget.email) {
    closeFileContextMenu();
    return;
  }
  driveClipboard = {
    mode,
    id: fileContextTarget.id,
    name: fileContextTarget.name || "(unnamed)",
    email: fileContextTarget.email,
    provider: normalizeProvider(fileContextTarget.provider || browseProvider),
  };
  closeFileContextMenu();
}

function cutBrowseItemFromContext() {
  stashClipboard("cut");
}

function copyBrowseItemFromContext() {
  stashClipboard("copy");
}

async function pasteBrowseItemFromContext() {
  if (!driveClipboard || !driveClipboard.id || !driveClipboard.email) {
    closeFileContextMenu();
    return;
  }
  const destinationFolderId = getCurrentBrowseFolderId();
  if (!destinationFolderId) {
    alert("Open a destination folder first, then paste.");
    closeFileContextMenu();
    return;
  }

  closeFileContextMenu();
  const endpoint = driveClipboard.mode === "cut" ? "/move-item" : "/copy-item";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: driveClipboard.email,
        provider: driveClipboard.provider,
        fileId: driveClipboard.id,
        destinationFolderId,
      }),
    });
    const payload = await res.json();
    if (!res.ok) {
      const msg =
        payload && payload.error ? payload.error : "Unable to complete paste";
      alert(msg);
      return;
    }
    if (driveClipboard.mode === "cut") {
      driveClipboard = null;
    }
    loadBrowseFolder();
  } catch (e) {
    alert("Paste failed. Please try again.");
  }
}

async function moveBrowseItemFromContext() {
  if (!fileContextTarget || !fileContextTarget.id || !fileContextTarget.email) {
    closeFileContextMenu();
    return;
  }

  const destinationFolderId = (
    window.prompt("Enter destination folder ID:", "") || ""
  ).trim();
  if (!destinationFolderId) {
    closeFileContextMenu();
    return;
  }
  if (destinationFolderId === fileContextTarget.id) {
    alert("Destination folder ID cannot be same as selected item ID.");
    closeFileContextMenu();
    return;
  }

  closeFileContextMenu();
  try {
    const res = await fetch("/move-item", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: fileContextTarget.email,
        provider: normalizeProvider(
          fileContextTarget.provider || browseProvider,
        ),
        fileId: fileContextTarget.id,
        destinationFolderId,
      }),
    });
    const payload = await res.json();
    if (!res.ok) {
      const msg =
        payload && payload.error ? payload.error : "Unable to move item";
      alert(msg);
      return;
    }
    loadBrowseFolder();
  } catch (e) {
    alert("Move failed. Please try again.");
  }
}

async function deleteBrowseItemFromContext() {
  if (!fileContextTarget) return;

  const email = fileContextTarget.email || browseEmail;
  const fileId = fileContextTarget.id;
  const itemName = fileContextTarget.name || "this item";
  const provider = normalizeProvider(
    fileContextTarget.provider || browseProvider,
  );

  if (!email || !fileId) {
    closeFileContextMenu();
    return;
  }
  if (provider === "mega") {
    alert(
      "Delete feature is only available in Google Drive account for now. i am working on it, stay tuned!",
    );
    closeFileContextMenu();
    return;
  }

  const ok = window.confirm(
    'Delete "' + itemName + '"? This cannot be undone.',
  );
  if (!ok) {
    closeFileContextMenu();
    return;
  }

  closeFileContextMenu();

  try {
    const res = await fetch("/delete-item", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        provider: normalizeProvider(
          fileContextTarget.provider || browseProvider,
        ),
        fileId,
      }),
    });
    const payload = await res.json();

    if (!res.ok) {
      const msg =
        payload && payload.error ? payload.error : "Unable to delete item";
      alert(msg);
      return;
    }

    loadBrowseFolder();
  } catch (e) {
    alert("Delete failed. Please try again.");
  }
}

function renderBrowseBreadcrumb() {
  const el = document.getElementById("browseBreadcrumb");
  if (!el) return;

  const html = browsePath
    .map((seg, i) => {
      const isLast = i === browsePath.length - 1;
      const label = escapeHtml(seg.name);
      if (isLast) {
        return '<span class="bcCurrent">' + label + "</span>";
      }
      return (
        '<button type="button" class="bcPart" data-bcidx="' +
        i +
        '">' +
        label +
        "</button>"
      );
    })
    .join('<span class="bcSep">›</span>');

  el.innerHTML = html;

  el.querySelectorAll(".bcPart").forEach((btn) => {
    btn.addEventListener("click", function () {
      const idx = parseInt(btn.getAttribute("data-bcidx"), 10);
      if (Number.isNaN(idx)) return;
      browsePath = browsePath.slice(0, idx + 1);
      loadBrowseFolder();
    });
  });
}

function browseAccount(email, provider) {
  if (!email) return;
  window.location.href =
    "/browse.html?email=" +
    encodeURIComponent(email) +
    "&provider=" +
    encodeURIComponent(normalizeProvider(provider));
}

function toBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function pickAutoUploadAccount() {
  if (!Array.isArray(homeAccounts) || homeAccounts.length === 0) {
    return null;
  }

  const scored = homeAccounts.map((acc) => {
    const used = toBytes(acc?.storageQuota?.usage);
    const limit = toBytes(acc?.storageQuota?.limit);
    const free = limit > 0 ? Math.max(0, limit - used) : -1;
    const usedRatio = limit > 0 ? used / limit : Number.POSITIVE_INFINITY;
    return { acc, used, limit, free, usedRatio };
  });

  const withLimit = scored.filter((s) => s.limit > 0);
  if (withLimit.length > 0) {
    withLimit.sort((a, b) => b.free - a.free);
    return withLimit[0].acc;
  }

  scored.sort((a, b) => a.usedRatio - b.usedRatio);
  return scored[0].acc;
}

function setHomeDropOverlay(show) {
  const overlay = document.getElementById("homeDropOverlay");
  if (!overlay) return;
  overlay.classList.toggle("show", !!show);
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
}

function openHomeUploadChoiceModal(files) {
  const modal = document.getElementById("homeUploadChoiceModal");
  const status = document.getElementById("homeUploadChoiceStatus");
  const sub = document.getElementById("homeUploadChoiceSub");
  const select = document.getElementById("homeUploadAccountSelect");
  if (!modal || !status || !sub || !select) return;

  homeDropFiles = Array.from(files || []);
  if (homeDropFiles.length === 0) {
    return;
  }

  if (connectedAccountCount === 0) {
    alert("Connect at least one account before uploading.");
    homeDropFiles = [];
    return;
  }

  select.innerHTML = homeAccounts
    .map((acc) => {
      const email = acc?.user?.emailAddress || "";
      if (!email) return "";
      const provider = normalizeProvider(acc.provider);
      const value = makeAccountKey(email, provider);
      return (
        '<option value="' +
        escapeHtml(value) +
        '">' +
        escapeHtml(providerName(provider) + " - " + email) +
        "</option>"
      );
    })
    .join("");
  status.textContent = "";
  sub.textContent =
    "Dropped " + homeDropFiles.length + " file(s). Choose where to upload.";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeHomeUploadChoiceModal() {
  const modal = document.getElementById("homeUploadChoiceModal");
  const status = document.getElementById("homeUploadChoiceStatus");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  if (status) {
    status.textContent = "";
  }
  homeDropFiles = [];
  homeUploadInProgress = false;
}

function setUploadStatusCardVisible(show) {
  const card = document.getElementById("uploadStatusCard");
  if (!card) return;
  card.classList.toggle("show", !!show);
}

function updateUploadStatusCard(details) {
  const titleEl = document.getElementById("uploadStatusTitle");
  const accountEl = document.getElementById("uploadStatusAccount");
  const fileEl = document.getElementById("uploadStatusFile");
  const progressEl = document.getElementById("uploadStatusProgress");
  const statsEl = document.getElementById("uploadStatusStats");
  const barEl = document.getElementById("uploadStatusBarFill");
  if (!titleEl || !accountEl || !fileEl || !progressEl || !statsEl || !barEl)
    return;

  const total = Math.max(0, Number(details.total) || 0);
  const index = Math.max(0, Number(details.index) || 0);
  const ratio = Number.isFinite(details.percent)
    ? Math.max(0, Math.min(100, Number(details.percent)))
    : total > 0
      ? Math.max(0, Math.min(100, (index / total) * 100))
      : 0;

  titleEl.textContent = details.title || "Uploading files";
  accountEl.textContent = "Account: " + (details.account || "—");
  fileEl.textContent = "File: " + (details.file || "—");
  progressEl.textContent = String(index) + "/" + String(total) + " files";
  statsEl.textContent = details.stats || "0% • 0 B / 0 B • 0 B/s • ETA —";
  barEl.style.width = ratio.toFixed(1) + "%";
}

function formatRate(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (!Number.isFinite(n) || n <= 0) return "0 B/s";
  return formatFileSize(n) + "/s";
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm > 0) return String(mm) + "m " + String(ss).padStart(2, "0") + "s";
  return String(ss) + "s";
}

function makeUploadId() {
  return "up_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

//the upload itself lives in js/upload.js, shared with the browse page.

async function uploadDroppedFilesToAccount(accountKey) {
  const status = document.getElementById("homeUploadChoiceStatus");
  if (homeUploadInProgress) return;
  const selectedAccount = parseAccountKey(accountKey);
  const email = selectedAccount.email;
  const provider = selectedAccount.provider;
  if (!email) {
    if (status) status.textContent = "Choose an account first.";
    return;
  }
  if (!Array.isArray(homeDropFiles) || homeDropFiles.length === 0) {
    if (status) status.textContent = "No dropped files found.";
    return;
  }

  homeUploadInProgress = true;
  homeUploadCancelRequested = false;
  const totalBytes = homeDropFiles.reduce(
    (sum, f) => sum + (Number(f && f.size) || 0),
    0,
  );
  let uploadedCompletedBytes = 0;
  let lastSampleBytes = 0;
  let lastSampleTime = Date.now();
  let smoothedSpeed = 0;

  setUploadStatusCardVisible(true);
  updateUploadStatusCard({
    title: "Uploading files",
    account: providerName(provider) + " - " + email,
    file: "Preparing...",
    index: 0,
    total: homeDropFiles.length,
    percent: 0,
    stats: "0% • 0 B / " + formatFileSize(totalBytes) + " • 0 B/s • ETA —",
  });
  if (status) {
    status.textContent =
      "Uploading " +
      homeDropFiles.length +
      " file(s) to " +
      providerName(provider) +
      " - " +
      email +
      "...";
  }

  try {
    for (let i = 0; i < homeDropFiles.length; i++) {
      if (homeUploadCancelRequested) {
        throw new Error("Upload cancelled by user.");
      }
      const file = homeDropFiles[i];
      lastSampleBytes = uploadedCompletedBytes;
      lastSampleTime = Date.now();
      smoothedSpeed = 0;
      updateUploadStatusCard({
        title: "Uploading files",
        account: providerName(provider) + " - " + email,
        file: file && file.name ? file.name : "Unnamed file",
        index: i + 1,
        total: homeDropFiles.length,
        percent:
          totalBytes > 0 ? (uploadedCompletedBytes / totalBytes) * 100 : 0,
        stats:
          (totalBytes > 0
            ? Math.round((uploadedCompletedBytes / totalBytes) * 100)
            : 0) +
          "% • " +
          formatFileSize(uploadedCompletedBytes) +
          " / " +
          formatFileSize(totalBytes) +
          " • " +
          formatRate(smoothedSpeed) +
          " • ETA —",
      });
      const fileSize = Number(file && file.size) || 0;
      const uploadId = makeUploadId();
      const isMegaProvider = normalizeProvider(provider) === "mega";
      let megaPhaseActive = true;
      let hasServerSample = false;
      let currentFileClientLoaded = 0;
      let lastServerRatio = 0;
      let pollTimer = null;
      //only MEGA needs the server side progress feed: its bytes still pass through the
      //server, so the browser's own progress events stop at that hop. A Google upload goes
      //straight to Google, where xhr progress is already the real number.
      if (isMegaProvider) {
        pollTimer = window.setInterval(async () => {
        if (!megaPhaseActive) return;
        try {
          const pRes = await fetch(
            "/upload-progress?uploadId=" + encodeURIComponent(uploadId),
          );
          const pData = await pRes.json();
          if (!pRes.ok || !pData || pData.status === "unknown") return;
          hasServerSample = true;
          const bytesUploaded = Number(pData.bytesUploaded || 0);
          const bytesTotal = Number(pData.bytesTotal || fileSize || 0);
          const isMegaPhase = pData.phase === "mega";
          const rawRatio = bytesTotal > 0 ? bytesUploaded / bytesTotal : 0;
          const clampedRatio = Math.max(0, Math.min(1, rawRatio));
          lastServerRatio = Math.max(lastServerRatio, clampedRatio);
          const safePhaseLoaded = Math.max(
            0,
            Math.min(fileSize, lastServerRatio * fileSize),
          );
          const overallLoaded = uploadedCompletedBytes + safePhaseLoaded;
          const percent =
            totalBytes > 0 ? (overallLoaded / totalBytes) * 100 : 0;
          const serverRate = Number(pData.avgBps || 0);
          smoothedSpeed = serverRate > 0 ? serverRate : smoothedSpeed;
          lastSampleBytes = overallLoaded;
          lastSampleTime = Date.now();
          const remaining = Math.max(0, totalBytes - overallLoaded);
          const etaSec =
            smoothedSpeed > 0 ? Math.ceil(remaining / smoothedSpeed) : 0;

          updateUploadStatusCard({
            title: isMegaProvider
              ? "Uploading to MEGA"
              : isMegaPhase
                ? "Uploading to provider"
                : "Uploading files",
            account: providerName(provider) + " - " + email,
            file: file && file.name ? file.name : "Unnamed file",
            index: i + 1,
            total: homeDropFiles.length,
            percent,
            stats:
              Math.round(percent) +
              "% • " +
              formatFileSize(overallLoaded) +
              " / " +
              formatFileSize(totalBytes) +
              " • " +
              formatRate(smoothedSpeed) +
              " • ETA " +
              (smoothedSpeed > 0 ? formatDuration(etaSec) : "—"),
          });
        } catch (e) { }
        }, 300);
      }
      homeActivePollTimer = pollTimer;

      await mdUploadFile(
        file,
        {
          email: email,
          provider: provider,
          parentId: "root",
          uploadId: uploadId,
        },
        function (loaded) {
          currentFileClientLoaded = Math.min(
            fileSize,
            Math.max(0, Number(loaded) || 0),
          );
          if (hasServerSample) {
            return;
          }
          const now = Date.now();
          const overallLoaded =
            uploadedCompletedBytes + currentFileClientLoaded;
          const dt = Math.max(0.001, (now - lastSampleTime) / 1000);
          const dBytes = Math.max(0, overallLoaded - lastSampleBytes);
          if (dt >= 0.2 && dBytes > 0) {
            const instant = dBytes / dt;
            smoothedSpeed =
              smoothedSpeed > 0
                ? smoothedSpeed * 0.75 + instant * 0.25
                : instant;
            lastSampleBytes = overallLoaded;
            lastSampleTime = now;
          }

          const percent =
            totalBytes > 0 ? (overallLoaded / totalBytes) * 100 : 0;
          const remaining = Math.max(0, totalBytes - overallLoaded);
          const etaSec =
            smoothedSpeed > 0 ? Math.ceil(remaining / smoothedSpeed) : 0;

          updateUploadStatusCard({
            title: isMegaProvider ? "Uploading to MEGA" : "Uploading files",
            account: providerName(provider) + " - " + email,
            file: file && file.name ? file.name : "Unnamed file",
            index: i + 1,
            total: homeDropFiles.length,
            percent,
            stats:
              Math.round(percent) +
              "% • " +
              formatFileSize(overallLoaded) +
              " / " +
              formatFileSize(totalBytes) +
              " • " +
              formatRate(smoothedSpeed) +
              " • ETA " +
              (smoothedSpeed > 0 ? formatDuration(etaSec) : "—"),
          });
        },
      );
      megaPhaseActive = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      homeActivePollTimer = null;
      uploadedCompletedBytes += fileSize;
    }

    if (status) status.textContent = "Upload complete.";
    updateUploadStatusCard({
      title: "Upload complete",
      account: providerName(provider) + " - " + email,
      file: "All files uploaded successfully",
      index: homeDropFiles.length,
      total: homeDropFiles.length,
      percent: 100,
      stats:
        "100% • " +
        formatFileSize(totalBytes) +
        " / " +
        formatFileSize(totalBytes) +
        " • Done",
    });
    await loadStorage();
    window.setTimeout(closeHomeUploadChoiceModal, 450);
    window.setTimeout(() => setUploadStatusCardVisible(false), 2000);
  } catch (err) {
    const isCancelled =
      homeUploadCancelRequested ||
      (err &&
        String(err.message || "")
          .toLowerCase()
          .includes("cancel"));
    if (status) {
      status.textContent = isCancelled
        ? "Upload cancelled."
        : err && err.message
          ? err.message
          : "Upload failed. Please try again.";
    }
    updateUploadStatusCard({
      title: isCancelled ? "Upload cancelled" : "Upload failed",
      account: providerName(provider) + " - " + email,
      file: isCancelled
        ? "Upload cancelled by user."
        : err && err.message
          ? err.message
          : "Upload failed. Please try again.",
      index: 0,
      total: homeDropFiles.length,
    });
    if (isCancelled) {
      setUploadStatusCardVisible(false);
    }
    homeUploadInProgress = false;
  } finally {
    if (homeActivePollTimer) {
      clearInterval(homeActivePollTimer);
      homeActivePollTimer = null;
    }
    homeUploadInProgress = false;
  }
}

function setUploadCancelConfirmVisible(show) {
  const modal = document.getElementById("uploadCancelConfirmModal");
  if (!modal) return;
  if (show) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  } else {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

function hasDraggedFiles(ev) {
  if (!ev || !ev.dataTransfer || !ev.dataTransfer.types) return false;
  return Array.from(ev.dataTransfer.types).includes("Files");
}

function handleHomeUploadSelectClick() {
  const select = document.getElementById("homeUploadAccountSelect");
  if (!select) return;
  uploadDroppedFilesToAccount((select.value || "").trim());
}

function handleHomeUploadAutoClick() {
  const picked = pickAutoUploadAccount();
  const email = picked && picked.user ? picked.user.emailAddress : "";
  uploadDroppedFilesToAccount(
    email ? makeAccountKey(String(email), picked.provider) : "",
  );
}

async function loadBrowseFolder() {
  const body = document.getElementById("browseModalBody");
  const emailEl = document.getElementById("browseModalEmail");

  if (!body || !browseEmail) return;

  const parentSeg = browsePath[browsePath.length - 1];
  const parentId = parentSeg ? parentSeg.id : "root";

  body.innerHTML = renderBrowseSkeleton(8);
  if (emailEl) emailEl.textContent = browseEmail;

  try {
    const url =
      "/files?email=" +
      encodeURIComponent(browseEmail) +
      "&provider=" +
      encodeURIComponent(browseProvider) +
      "&parentId=" +
      encodeURIComponent(parentId);
    const res = await fetch(url);
    const payload = await res.json();

    if (!res.ok) {
      const err =
        payload && payload.error ? payload.error : "Could not load folder";
      body.innerHTML =
        '<div class="modalError">' + escapeHtml(String(err)) + "</div>";
      return;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];

    const inMyDriveBranch =
      browsePath.length > 0 && browsePath[0].id === "root";
    const inSharedBranch =
      browsePath.length > 0 && browsePath[0].id === "__shared_drives__";

    const nav =
      normalizeProvider(browseProvider) === "mega"
        ? '<div class="browseBreadcrumb" id="browseBreadcrumb"></div>'
        : '<div class="browseNav">' +
        '<button type="button" class="browseNavBtn' +
        (inMyDriveBranch ? " active" : "") +
        '" data-nav="my">My Drive</button>' +
        '<button type="button" class="browseNavBtn' +
        (inSharedBranch ? " active" : "") +
        '" data-nav="shared">Shared drives</button>' +
        "</div>" +
        '<div class="browseBreadcrumb" id="browseBreadcrumb"></div>';

    if (items.length === 0) {
      const emptyHint =
        parentId === "root"
          ? '<p style="margin:8px 0 0;font-size:12px;font-weight:700;color:var(--muted);max-width:420px;margin-left:auto;margin-right:auto;">If your files live on a team or shared drive, open <strong>Shared drives</strong> above.</p>'
          : "";
      body.innerHTML =
        nav +
        '<div class="modalLoading">No folders or files here.' +
        emptyHint +
        '<img class="emptyStateImg" src="/images/nothing_here__.png" alt="Nothing here"></div>';
      renderBrowseBreadcrumb();
      wireBrowseNav(body);
      return;
    }

    const folderIcon =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f59e0b" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
    const fileIcon =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#64748b" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';

    const rows = items
      .map((f) => {
        const name = f.name || "(unnamed)";
        const mime = f.mimeType ? String(f.mimeType) : "";
        const isFolder = mime === FOLDER_MIME;
        const isSharedRoot = !!f.isSharedDriveRoot;
        const link = f.webViewLink ? String(f.webViewLink) : "";
        const typeLabel = isFolder
          ? "Folder"
          : mime
            ? mime.split("/").pop()
            : "—";
        const mod = f.modifiedTime
          ? new Date(f.modifiedTime).toLocaleString()
          : "—";
        const size = isFolder ? "—" : formatFileSize(f.size);

        const iconHtml =
          '<span class="iconCell">' +
          (isFolder ? folderIcon : fileIcon) +
          "</span>";

        let innerName;
        if (isFolder) {
          innerName =
            '<button type="button" class="folderLink" data-folder-id="' +
            escapeHtml(f.id) +
            '" data-folder-name="' +
            encodeURIComponent(name) +
            '">' +
            escapeHtml(name) +
            "</button>";
        } else if (link) {
          innerName =
            '<a href="' +
            escapeHtml(link) +
            '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(name) +
            "</a>";
        } else {
          innerName = escapeHtml(name);
        }

        const nameCell =
          '<div class="browseRowName">' +
          iconHtml +
          '<span class="namePart">' +
          innerName +
          "</span></div>";

        return (
          '<tr class="browseItemRow" data-item-id="' +
          escapeHtml(String(f.id || "")) +
          '" data-item-name="' +
          encodeURIComponent(name) +
          '" data-item-email="' +
          encodeURIComponent(browseEmail) +
          '" data-item-provider="' +
          encodeURIComponent(browseProvider) +
          '" data-shared-root="' +
          (isSharedRoot ? "1" : "0") +
          '"><td class="fileNameCell">' +
          nameCell +
          '</td><td class="fileMime" title="' +
          escapeHtml(mime || "—") +
          '">' +
          escapeHtml(typeLabel) +
          '</td><td class="fileSize">' +
          escapeHtml(size) +
          "</td><td>" +
          escapeHtml(mod) +
          "</td></tr>"
        );
      })
      .join("");

    body.innerHTML =
      nav +
      '<table class="fileTable"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>' +
      rows +
      "</tbody></table>";

    renderBrowseBreadcrumb();
    wireBrowseNav(body);

    body.querySelectorAll(".folderLink").forEach((btn) => {
      btn.addEventListener("click", function () {
        const fid = btn.getAttribute("data-folder-id");
        let fname = btn.getAttribute("data-folder-name") || "";
        try {
          fname = decodeURIComponent(fname);
        } catch (e) { }
        openBrowseFolder(fid, fname);
      });
    });

    body.querySelectorAll(".browseItemRow").forEach((row) => {
      row.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        const fileId = row.getAttribute("data-item-id") || "";
        const isSharedRoot = row.getAttribute("data-shared-root") === "1";
        if (!fileId || isSharedRoot) {
          closeFileContextMenu();
          return;
        }

        const rawName = row.getAttribute("data-item-name") || "";
        const rawEmail = row.getAttribute("data-item-email") || "";
        const rawProvider = row.getAttribute("data-item-provider") || "";
        let name = "(unnamed)";
        let email = browseEmail;
        let provider = browseProvider;
        try {
          name = decodeURIComponent(rawName) || "(unnamed)";
        } catch (e) { }
        try {
          email = decodeURIComponent(rawEmail) || browseEmail;
        } catch (e) { }
        try {
          provider = normalizeProvider(
            decodeURIComponent(rawProvider) || browseProvider,
          );
        } catch (e) { }

        openFileContextMenu(ev.clientX, ev.clientY, {
          id: fileId,
          name,
          email,
          provider,
        });
      });
    });
  } catch (e) {
    body.innerHTML = '<div class="modalError">Failed to load folder.</div>';
  }
}

function wireBrowseNav(body) {
  body.querySelectorAll(".browseNavBtn[data-nav]").forEach((btn) => {
    btn.addEventListener("click", function () {
      const nav = btn.getAttribute("data-nav");
      if (nav === "my") {
        goToMyDriveRoot();
      } else if (nav === "shared") {
        goToSharedDrivesList();
      }
    });
  });
}

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") {
    closeBrowseModal();
    closeFileContextMenu();
    closeConnectProviderModal();
    closeMegaLoginModal();
    closeLogoutModal();
  }
});

document.getElementById("browseModal").addEventListener("click", function (ev) {
  if (ev.target === this) {
    closeBrowseModal();
  }
  closeFileContextMenu();
});
document
  .getElementById("logoutConfirmModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      closeLogoutModal();
    }
  });
document.addEventListener("click", function (ev) {
  const menu = document.getElementById("fileContextMenu");
  if (!menu) return;
  if (menu.style.display !== "none" && !menu.contains(ev.target)) {
    closeFileContextMenu();
  }

  const searchMenu = document.getElementById("searchActionMenu");
  if (
    searchMenu &&
    searchMenu.style.display !== "none" &&
    !searchMenu.contains(ev.target) &&
    !ev.target.closest(".searchActionBtn")
  ) {
    closeSearchActionMenu();
  }
});
document
  .getElementById("fileContextCutBtn")
  .addEventListener("click", cutBrowseItemFromContext);
document
  .getElementById("fileContextCopyBtn")
  .addEventListener("click", copyBrowseItemFromContext);
document
  .getElementById("fileContextPasteBtn")
  .addEventListener("click", pasteBrowseItemFromContext);
document
  .getElementById("fileContextMoveBtn")
  .addEventListener("click", moveBrowseItemFromContext);
document
  .getElementById("fileContextDeleteBtn")
  .addEventListener("click", deleteBrowseItemFromContext);
document
  .getElementById("searchActionShareBtn")
  .addEventListener("click", handleSearchActionShare);
document
  .getElementById("searchActionCopyBtn")
  .addEventListener("click", handleSearchActionCopy);
document
  .getElementById("searchActionDeleteBtn")
  .addEventListener("click", handleSearchActionDelete);

let pendingLogout = null;

function closeLogoutModal() {
  const modal = document.getElementById("logoutConfirmModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  pendingLogout = null;
}

function openLogoutModal(email, provider) {
  if (!email) return;
  const modal = document.getElementById("logoutConfirmModal");
  const emailEl = document.getElementById("logoutConfirmEmail");
  const providerEl = document.getElementById("logoutConfirmProvider");
  if (!modal || !emailEl || !providerEl) return;
  const providerName =
    normalizeProvider(provider) === "mega" ? "MEGA" : "Google Drive";
  emailEl.textContent = email;
  providerEl.textContent = providerName;
  pendingLogout = { email, provider };
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

async function confirmLogoutModal() {
  if (!pendingLogout) return;
  const next = pendingLogout;
  closeLogoutModal();
  await logoutAccount(next.email, next.provider);
}

async function logoutAccount(email, provider) {
  if (!email) return;

  const res = await fetch("/logout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, provider }),
  });

  if (!res.ok) {
    alert("Unable to logout this account");
    return;
  }

  loadStorage();
}

function renderGlobalSearchState(html) {
  const root = document.getElementById("globalSearchResults");
  if (!root) return;
  root.classList.remove("filled");
  root.innerHTML = html ? '<div class="searchState">' + html + "</div>" : "";
}

let searchActionTarget = null;

function closeSearchActionMenu() {
  const menu = document.getElementById("searchActionMenu");
  if (!menu) return;
  menu.style.display = "none";
  menu.setAttribute("aria-hidden", "true");
  searchActionTarget = null;
}

function openSearchActionMenu(triggerBtn) {
  const menu = document.getElementById("searchActionMenu");
  if (!menu || !triggerBtn) return;
  const rect = triggerBtn.getBoundingClientRect();
  searchActionTarget = {
    fileId: triggerBtn.getAttribute("data-file-id") || "",
    email: triggerBtn.getAttribute("data-email") || "",
    provider: triggerBtn.getAttribute("data-provider") || "google",
    name: triggerBtn.getAttribute("data-name") || "(unnamed)",
    openUrl: triggerBtn.getAttribute("data-open-url") || "",
  };
  menu.style.display = "block";
  menu.setAttribute("aria-hidden", "false");
  const menuWidth = 170;
  const left = Math.max(
    8,
    Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
  );
  const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 140));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

async function handleSearchActionCopy() {
  if (!searchActionTarget) return;
  const textToCopy =
    searchActionTarget.openUrl || searchActionTarget.name || "";
  if (!textToCopy) return;
  try {
    await navigator.clipboard.writeText(textToCopy);
  } catch (e) {
    alert("Unable to copy right now.");
  } finally {
    closeSearchActionMenu();
  }
}

async function handleSearchActionShare() {
  if (!searchActionTarget) return;
  const shareUrl = searchActionTarget.openUrl || "";
  const shareText = searchActionTarget.name || "File";
  try {
    if (navigator.share && shareUrl) {
      await navigator.share({
        title: shareText,
        text: shareText,
        url: shareUrl,
      });
    } else if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl);
      alert("Share link copied.");
    } else {
      await navigator.clipboard.writeText(shareText);
      alert("File name copied.");
    }
  } catch (e) {
    if (e && e.name !== "AbortError") {
      alert("Unable to share right now.");
    }
  } finally {
    closeSearchActionMenu();
  }
}

async function handleSearchActionDelete() {
  if (!searchActionTarget) return;
  const fileId = searchActionTarget.fileId;
  const email = searchActionTarget.email;
  const provider = normalizeProvider(searchActionTarget.provider);
  const name = searchActionTarget.name || "this file";
  if (!fileId || !email) {
    closeSearchActionMenu();
    return;
  }
  if (provider === "mega") {
    alert("Delete feature is only available in Google Drive account for now. i am working on it, stay tuned!");
    closeSearchActionMenu();
    return;
  }
  if (!window.confirm('Delete "' + name + '"? This cannot be undone.')) {
    closeSearchActionMenu();
    return;
  }
  try {
    const res = await fetch("/delete-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, provider, fileId }),
    });
    const payload = await res.json();
    if (!res.ok) {
      alert(
        payload && payload.error ? payload.error : "Unable to delete this file",
      );
      closeSearchActionMenu();
      return;
    }
    closeSearchActionMenu();
    searchAcrossConnectedDrives();
  } catch (e) {
    alert("Delete failed. Please try again.");
    closeSearchActionMenu();
  }
}

function renderGlobalSearchResults(results) {
  const root = document.getElementById("globalSearchResults");
  if (!root) return;
  hideSearchSuggestions();
  allowSearchSuggestions = false;

  if (!Array.isArray(results) || results.length === 0) {
    root.classList.remove("filled");
    root.innerHTML =
      '<div class="searchState">No files or folders matched your search.</div>';
    return;
  }
  root.classList.add("filled");

  const rows = results
    .map((item) => {
      const name = escapeHtml(item.name || "(unnamed)");
      const provider = providerName(item.accountProvider);
      const email = escapeHtml(item.accountEmail || "Unknown account");
      const mime = String(item.mimeType || "");
      const isFolder = mime === FOLDER_MIME;
      const modified = item.modifiedTime
        ? new Date(item.modifiedTime).toLocaleDateString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
        : "—";
      const size = mime === FOLDER_MIME ? "—" : formatFileSize(item.size);
      const link = item.webViewLink ? String(item.webViewLink) : "";
      const fileId = item && item.id ? String(item.id) : "";
      const accountEmail =
        item && item.accountEmail ? String(item.accountEmail) : "";
      const accountProvider =
        item && item.accountProvider ? String(item.accountProvider) : "google";
      const openUrl = isFolder
        ? "/browse.html?email=" +
        encodeURIComponent(accountEmail) +
        "&provider=" +
        encodeURIComponent(accountProvider) +
        "&folderId=" +
        encodeURIComponent(fileId) +
        "&folderName=" +
        encodeURIComponent(item.name || "(folder)")
        : link ||
        (fileId && accountEmail
          ? "/open-file?email=" +
          encodeURIComponent(accountEmail) +
          "&provider=" +
          encodeURIComponent(accountProvider) +
          "&fileId=" +
          encodeURIComponent(fileId)
          : "");
      const nameText = openUrl
        ? '<a class="searchLink searchNameText" href="' +
        escapeHtml(openUrl) +
        '" target="_blank" rel="noopener noreferrer">' +
        name +
        "</a>"
        : '<span class="searchNameText">' + name + "</span>";
      const nameCell =
        '<div class="searchNameWrap">' +
        '<span class="searchNameIcon" aria-hidden="true">' +
        (isFolder ? "folder" : "description") +
        "</span>" +
        nameText +
        "</div>";

      const accountCell =
        '<div class="searchAccountCell">' +
        '<span class="searchAccountProvider">' +
        escapeHtml(provider) +
        "</span>" +
        '<span class="searchAccountEmail" title="' +
        email +
        '">' +
        email +
        "</span>" +
        "</div>";

      const actionBtn =
        '<button type="button" class="searchActionBtn" aria-label="More actions" title="More actions"' +
        ' data-file-id="' +
        escapeHtml(fileId) +
        '"' +
        ' data-email="' +
        escapeHtml(accountEmail) +
        '"' +
        ' data-provider="' +
        escapeHtml(accountProvider) +
        '"' +
        ' data-name="' +
        escapeHtml(item.name || "(unnamed)") +
        '"' +
        ' data-open-url="' +
        escapeHtml(openUrl) +
        '"' +
        ">more_vert</button>";

      return (
        '<tr class="searchResultRow" data-open-url="' +
        escapeHtml(openUrl) +
        '"><td class="searchNameCell">' +
        nameCell +
        "</td><td>" +
        accountCell +
        '</td><td class="searchSizeCell">' +
        escapeHtml(size) +
        '</td><td class="searchDateCell">' +
        escapeHtml(modified) +
        '</td><td class="searchActionsCell">' +
        actionBtn +
        "</td></tr>"
      );
    })
    .join("");

  root.innerHTML =
    '<table class="searchTable"><thead><tr><th>Name</th><th>Account</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>' +
    rows +
    "</tbody></table>";

  root.querySelectorAll(".searchActionBtn").forEach((btn) => {
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openSearchActionMenu(btn);
    });
  });

  root.querySelectorAll(".searchResultRow").forEach((row) => {
    row.addEventListener("click", function (ev) {
      if (ev.target.closest("a, button")) return;
      const openUrl = row.getAttribute("data-open-url") || "";
      if (!openUrl) return;
      window.open(openUrl, "_blank", "noopener,noreferrer");
    });
  });
}

function updateSearchClearButton() {
  const input = document.getElementById("globalSearchInput");
  const clearBtn = document.getElementById("globalSearchClearBtn");
  if (!input || !clearBtn) return;
  if (input.value.trim()) {
    clearBtn.classList.add("show");
  } else {
    clearBtn.classList.remove("show");
  }
}

function hideSearchSuggestions() {
  const box = document.getElementById("globalSearchSuggest");
  if (!box) return;
  box.style.display = "none";
  box.innerHTML = "";
}

function renderSearchSuggestions(items) {
  const box = document.getElementById("globalSearchSuggest");
  if (!box) return;
  if (!Array.isArray(items) || items.length === 0) {
    hideSearchSuggestions();
    return;
  }

  box.innerHTML = items
    .map((item) => {
      const name = item && item.name ? String(item.name) : "";
      const cls =
        item && item.kind === "history"
          ? "searchSuggestItem history"
          : "searchSuggestItem";
      return (
        '<button type="button" class="' +
        cls +
        '" data-suggest="' +
        encodeURIComponent(name) +
        '">' +
        escapeHtml(name) +
        "</button>"
      );
    })
    .join("");
  box.style.display = "block";

  box.querySelectorAll(".searchSuggestItem").forEach((btn) => {
    btn.addEventListener("click", function () {
      const input = document.getElementById("globalSearchInput");
      const raw = btn.getAttribute("data-suggest") || "";
      if (!input) return;
      let value = "";
      try {
        value = decodeURIComponent(raw);
      } catch (e) {
        value = raw;
      }
      input.value = value;
      updateSearchClearButton();
      hideSearchSuggestions();
      searchAcrossConnectedDrives();
    });
  });
}

async function fetchSearchSuggestions() {
  const input = document.getElementById("globalSearchInput");
  if (!input) return;
  if (!allowSearchSuggestions || document.activeElement !== input) {
    hideSearchSuggestions();
    return;
  }

  const term = input.value.trim();
  updateSearchClearButton();

  if (connectedAccountCount === 0) {
    hideSearchSuggestions();
    return;
  }

  if (!term) {
    const history = getSearchHistory()
      .slice(0, 4)
      .map((name) => ({ name, kind: "history" }));
    renderSearchSuggestions(history);
    return;
  }

  if (term.length < 2) {
    hideSearchSuggestions();
    return;
  }

  const reqId = ++searchSuggestRequestId;

  try {
    const res = await fetch("/search?q=" + encodeURIComponent(term));
    const payload = await res.json();
    if (reqId !== searchSuggestRequestId) return;
    if (!res.ok) {
      hideSearchSuggestions();
      return;
    }

    const history = getSearchHistory().filter((name) =>
      name.toLowerCase().includes(term.toLowerCase()),
    );
    const suggestions = [];
    const seen = new Set();
    const files = Array.isArray(payload.results) ? payload.results : [];

    for (const name of history) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ name, kind: "history" });
      if (suggestions.length >= 8) break;
    }

    for (const item of files) {
      const name = item && item.name ? String(item.name).trim() : "";
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ name, kind: "search" });
      if (suggestions.length >= 8) break;
    }

    renderSearchSuggestions(suggestions);
  } catch (e) {
    if (reqId !== searchSuggestRequestId) return;
    hideSearchSuggestions();
  }
}

function queueSearchSuggestions() {
  if (searchSuggestTimer) {
    clearTimeout(searchSuggestTimer);
  }
  searchSuggestTimer = setTimeout(fetchSearchSuggestions, 220);
}

async function searchAcrossConnectedDrives() {
  const input = document.getElementById("globalSearchInput");
  const btn = document.getElementById("globalSearchBtn");
  const hint = document.getElementById("globalSearchHint");
  if (!input || !btn || !hint) return;

  const term = input.value.trim();
  hideSearchSuggestions();
  allowSearchSuggestions = false;
  searchSuggestRequestId += 1;
  if (searchSuggestTimer) {
    clearTimeout(searchSuggestTimer);
    searchSuggestTimer = null;
  }
  input.blur();
  updateSearchClearButton();

  if (connectedAccountCount === 0) {
    renderGlobalSearchState(
      "Connect at least one cloud account before searching.",
    );
    return;
  }

  if (!term) {
    renderGlobalSearchState("Enter a file or folder name to start searching.");
    return;
  }
  saveSearchHistoryTerm(term);

  btn.disabled = true;
  btn.textContent = "Searching...";
  const searchRoot = document.getElementById("globalSearchResults");
  if (searchRoot) {
    searchRoot.classList.add("filled");
    searchRoot.innerHTML = renderSearchSkeleton(6);
  }

  try {
    const res = await fetch("/search?q=" + encodeURIComponent(term));
    const payload = await res.json();

    if (!res.ok) {
      const msg = payload && payload.error ? payload.error : "Search failed";
      renderGlobalSearchState(escapeHtml(String(msg)));
      return;
    }

    renderGlobalSearchResults(payload.results || []);
    hint.textContent =
      'Showing results for "' +
      term +
      '" across ' +
      connectedAccountCount +
      " connected account(s).";
  } catch (e) {
    renderGlobalSearchState("Failed to search right now. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
  }
}

function formatStorage(bytes) {
  const gb = bytes / 1024 ** 3;

  if (gb >= 1000) {
    return (gb / 1024).toFixed(2) + " TB";
  }

  return gb.toFixed(2) + " GB";
}

function updateTotalStorageSummary(totalUsed, totalLimit, accountCount) {
  const fill = document.getElementById("totalStorageFill");
  const text = document.getElementById("totalStorageText");
  const meta = document.getElementById("totalStorageMeta");
  const bar = document.querySelector(".totalStorageBar");
  if (!fill || !text || !meta || !bar) return;

  const safeUsed = Number.isFinite(totalUsed) ? Math.max(0, totalUsed) : 0;
  const safeLimit = Number.isFinite(totalLimit) ? Math.max(0, totalLimit) : 0;
  const percentRaw = safeLimit > 0 ? (safeUsed / safeLimit) * 100 : 0;
  const percent = Math.max(0, Math.min(100, percentRaw));

  fill.style.width = percent.toFixed(1) + "%";
  bar.setAttribute("aria-valuenow", percent.toFixed(1));
  text.textContent =
    formatStorage(safeUsed) +
    " / " +
    formatStorage(safeLimit) +
    " (" +
    percent.toFixed(1) +
    "% Used)";
  meta.textContent =
    String(accountCount || 0) +
    " account" +
    ((accountCount || 0) === 1 ? "" : "s");
}

function setTotalStorageLoading(isLoading) {
  const card = document.querySelector(".totalStorageCard");
  if (!card) return;
  if (isLoading) {
    card.style.display = "";
  }
  card.classList.toggle("loading", Boolean(isLoading));
}

function setTotalStorageVisibility(accountCount) {
  const card = document.querySelector(".totalStorageCard");
  if (!card) return;
  card.style.display = accountCount > 0 ? "" : "none";
}

// Turn a cached {provider,email} entry into a card-shaped placeholder so a failed
// /storage call can still show which accounts are connected.
function placeholderCardFromCachedAccount(entry) {
  const email = String(entry?.email || "");
  const provider = normalizeProvider(entry?.provider);
  const first = email.includes("@") ? email.split("@")[0] : email;
  return {
    provider,
    error: "Storage details unavailable right now.",
    needsReauth: false,
    user: {
      emailAddress: email,
      displayName: first || (provider === "mega" ? "MEGA" : "Google Drive"),
      givenName: first,
      photoLink: "",
    },
    storageQuota: { usage: 0, limit: 0, usageInDrive: 0, usageInDriveTrash: 0 },
  };
}

async function loadStorage() {
  const accountsEl = document.getElementById("accounts");
  const cardsEl = document.getElementById("cards");
  if (accountsEl) {
    accountsEl.innerHTML = renderSidebarSkeleton(5);
  }
  if (cardsEl) {
    cardsEl.innerHTML = renderCardSkeletons(4);
  }
  setTotalStorageVisibility(connectedAccountCount);
  setTotalStorageLoading(true);
  updateTotalStorageSummary(0, 0, 0);

  // A failed request is not the same thing as "no accounts connected". The old code
  // treated any non-JSON answer (a platform timeout page, a 500, a proxy error) as an
  // empty account list, which is why a working session could still render the
  // "please connect" empty state on the hosted site.
  let data = [];
  let loadFailed = false;
  try {
    const res = await fetch("/storage", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const contentType = String(res.headers.get("content-type") || "");
    if (!res.ok || contentType.indexOf("application/json") === -1) {
      loadFailed = true;
    } else {
      const payload = await res.json();
      if (Array.isArray(payload)) {
        data = payload;
      } else if (payload && Array.isArray(payload.accounts)) {
        data = payload.accounts;
      } else {
        loadFailed = true;
      }
    }
  } catch (e) {
    loadFailed = true;
  }

  if (loadFailed) {
    data = readBrowserAccountsCache().map(placeholderCardFromCachedAccount);
    showConnectNotice(
      "Could not read your accounts from the server. Reload the page to try again.",
      true,
    );
  }

  let sidebarHTML = "";
  let cardsHTML = "";

  const seenAccounts = new Set();
  let uniqueData = (data || []).filter((acc) => {
    const email = acc?.user?.emailAddress;
    if (!email) return false;
    const key = makeAccountKey(email, acc.provider);
    if (seenAccounts.has(key)) return false;
    seenAccounts.add(key);
    return true;
  });

  connectedAccountCount = uniqueData.length;
  homeAccounts = uniqueData;
  setTotalStorageVisibility(connectedAccountCount);

  const totalUsed = uniqueData.reduce(
    (sum, acc) => sum + (Number(acc?.storageQuota?.usage) || 0),
    0,
  );
  const totalLimit = uniqueData.reduce(
    (sum, acc) => sum + (Number(acc?.storageQuota?.limit) || 0),
    0,
  );
  updateTotalStorageSummary(totalUsed, totalLimit, connectedAccountCount);
  setTotalStorageLoading(false);

  const groupedAccounts = {
    google: uniqueData.filter(
      (acc) => normalizeProvider(acc.provider) === "google",
    ),
    mega: uniqueData.filter(
      (acc) => normalizeProvider(acc.provider) === "mega",
    ),
  };

  function renderSidebarSection(title, items) {
    if (!items.length) {
      return;
    }
    const normalizedTitle = String(title || "")
      .trim()
      .toLowerCase();
    const iconHtml =
      '<span class="accountSectionIcon" aria-hidden="true">' +
      (normalizedTitle === "mega" ? MEGA_ICON_SVG : GOOGLE_DRIVE_ICON_SVG) +
      "</span>";
    sidebarHTML +=
      '<div class="accountSectionTitle">' +
      iconHtml +
      "<span>" +
      escapeHtml(title) +
      "</span></div>";
    items.forEach((acc) => {
      const email = acc.user?.emailAddress || "";
      sidebarHTML += `
<div class="account">
${escapeHtml(email)}
</div>
`;
    });
  }

  renderSidebarSection("Google Drive", groupedAccounts.google);
  renderSidebarSection("MEGA", groupedAccounts.mega);

  uniqueData.forEach((acc) => {
    const email = acc.user?.emailAddress || "";
    const displayName = getAccountDisplayName(acc);
    const provider = providerName(acc.provider);

    // A card can arrive without a quota when the server could not read that one
    // account. Read it defensively so one broken account cannot throw here and wipe
    // out the whole rendered list.
    const quota = acc.storageQuota || {};
    const used = Number(quota.usage) || 0;
    const limit = Number(quota.limit) || 0;
    const driveUsed = Number(quota.usageInDrive) || 0;
    const trashUsed = Number(quota.usageInDriveTrash) || 0;

    const percentRaw = limit > 0 ? (used / limit) * 100 : 0;
    const percent = Math.max(0, Math.min(100, percentRaw)).toFixed(1);

    const usedFormatted = formatStorage(used);
    const limitFormatted = formatStorage(limit);
    const driveFormatted = formatStorage(driveUsed);
    const trashFormatted = formatStorage(trashUsed);

    const avatar = displayName
      ? displayName.charAt(0).toUpperCase()
      : email
        ? email.charAt(0).toUpperCase()
        : "?";
    const photo = acc.user?.photoLink;
    const safeAvatar = escapeHtml(avatar);
    const safeAlt = escapeHtml(
      (displayName || email || "User") + " profile photo",
    );
    const avatarHTML = photo
      ? `<img src="${escapeHtml(photo)}" alt="${safeAlt}" referrerpolicy="no-referrer" onerror="this.style.display='none'; var fb=this.parentElement && this.parentElement.querySelector('.avatarFallback'); if(fb){fb.style.display='flex';}"><span class="avatarFallback" style="display:none;">${safeAvatar}</span>`
      : `<span class="avatarFallback">${safeAvatar}</span>`;

    // An account the server could not read stays visible with the reason attached,
    // instead of disappearing from the home screen without explanation.
    // "Reconnect" is only offered when reconnecting can actually fix it - a disabled
    // Drive API or a rate limit needs a different action, and sending the user round
    // the OAuth loop for those would never work.
    const accountError = String(acc.error || "").trim();
    const helpUrl = String(acc.helpUrl || "").trim();
    const safeHelpUrl = /^https:\/\//i.test(helpUrl) ? helpUrl : "";
    const helpLinkHTML = safeHelpUrl
      ? ` <a href="${escapeHtml(safeHelpUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit;font-weight:700;">Open Google Cloud console</a>`
      : "";
    const noticeHTML = accountError
      ? `
<div class="storageText" style="margin:8px 0 0;padding:8px 10px;border-radius:8px;background:rgba(200,60,45,.10);color:#a32b1f;">
${escapeHtml(accountError)}${helpLinkHTML}
</div>
`
      : "";
    // needsReauth  -> reconnecting is the fix
    // error only    -> the fix is elsewhere (enable the API, wait out a rate limit), so
    //                  offer a retry rather than a Browse that is bound to fail
    const actionHTML = acc.needsReauth
      ? `<button type="button" class="browseBtn" onclick='connectDrive()'>Reconnect</button>`
      : accountError
        ? `<button type="button" class="browseBtn" onclick='loadStorage()'>Retry</button>`
        : `<button type="button" class="browseBtn" onclick='browseAccount(${JSON.stringify(email)}, ${JSON.stringify(acc.provider || "google")})'>Browse</button>`;

    cardsHTML += `
<div class="card">

<div class="cardHeader">

<div class="cardHeaderMain">

<div class="avatar">${avatarHTML}</div>

<div>
<div class="email">${escapeHtml(email)}</div>
<div class="storageText" style="margin:4px 0 0;">${escapeHtml(provider)}</div>
</div>

</div>

<button class="logoutBtn"
  onclick='openLogoutModal(${JSON.stringify(email)}, ${JSON.stringify(acc.provider || "google")})'>
  <span class="logoutIcon">logout</span>
</button>

</div>

<div class="progressBar">
<div class="progressFill" style="width:${percent}%"></div>
</div>

<div class="storageText">
${usedFormatted} / ${limitFormatted} (${percent}% Used)
</div>

<div class="storageBreakdown">

<div class="row">


<span class="storageMetric"><span class="storageMetricIcon">folder</span> ${driveFormatted}</span>

</div>

<div class="row">



<span class="storageMetric"><span class="storageMetricIcon">delete</span> ${trashFormatted}</span>

</div>

</div>
${noticeHTML}
${actionHTML}

</div>
`;
  });

  document.getElementById("accounts").innerHTML = sidebarHTML;
  document.getElementById("cards").innerHTML = cardsHTML;

  if (connectedAccountCount === 0) {
    renderGlobalSearchState(
      '<div class="searchStateConnect">' +
      "<div>No connected cloud accounts yet.</div>" +
      '<img class="searchStateConnectImg" src="/images/dinosaur_waving (1).png" alt="dinosaur waving">' +
      '<p class="searchStateConnectText">hi, please connect</p>' +
      "</div>",
    );
  } else {
    renderGlobalSearchState("");
  }

  try {
    setGreetingFromSavedName();
  } catch (e) { }
  // Only refresh the safety-net copy from a response we actually trust. Writing it
  // after a failed load would overwrite the good cached list with an empty one.
  if (!loadFailed) {
    syncBrowserAccountsCacheFromServer();
  }
}

initFirstVisitNamePrompt();
consumeConnectMessagesFromUrl();
restoreSessionFromBrowserCache().finally(loadStorage);
window.addEventListener("pageshow", function (ev) {
  // Skip the very first pageshow: the line above already ran this. Only a real
  // back/forward restore needs to re-check.
  if (!ev || !ev.persisted) return;
  restoreSessionFromBrowserCache().finally(loadStorage);
});

document
  .getElementById("globalSearchBtn")
  .addEventListener("click", searchAcrossConnectedDrives);
document
  .getElementById("globalSearchInput")
  .addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchAcrossConnectedDrives();
    }
  });
document
  .getElementById("globalSearchInput")
  .addEventListener("input", function () {
    allowSearchSuggestions = true;
    queueSearchSuggestions();
  });
document
  .getElementById("globalSearchInput")
  .addEventListener("focus", function () {
    allowSearchSuggestions = true;
    queueSearchSuggestions();
  });
document
  .getElementById("globalSearchClearBtn")
  .addEventListener("click", function () {
    const input = document.getElementById("globalSearchInput");
    const hint = document.getElementById("globalSearchHint");
    if (!input || !hint) return;
    input.value = "";
    hideSearchSuggestions();
    allowSearchSuggestions = false;
    updateSearchClearButton();
    renderGlobalSearchState("");
    hint.textContent =
      "Type a file or folder name to search across every connected account.";
    input.focus();
  });
document
  .getElementById("globalSearchResults")
  .addEventListener("click", function () {
    hideSearchSuggestions();
    allowSearchSuggestions = false;
  });
document.addEventListener("click", function (ev) {
  const wrap = document.querySelector(".homeSearch");
  if (!wrap) return;
  if (!wrap.contains(ev.target)) {
    hideSearchSuggestions();
  }
});
window.addEventListener("dragenter", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  homeDragDepth += 1;
  setHomeDropOverlay(true);
});
window.addEventListener("dragover", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  if (ev.dataTransfer) {
    ev.dataTransfer.dropEffect = "copy";
  }
  setHomeDropOverlay(true);
});
window.addEventListener("dragleave", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();

  homeDragDepth = Math.max(0, homeDragDepth - 1);
  if (homeDragDepth === 0) {
    setHomeDropOverlay(false);
  }
});
window.addEventListener("drop", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  homeDragDepth = 0;
  setHomeDropOverlay(false);
  openHomeUploadChoiceModal(ev.dataTransfer ? ev.dataTransfer.files : []);
});

document
  .getElementById("homeUploadChoiceCloseBtn")
  .addEventListener("click", closeHomeUploadChoiceModal);
document
  .getElementById("uploadStatusCloseBtn")
  .addEventListener("click", function () {
    if (!homeUploadInProgress) {
      setUploadStatusCardVisible(false);
      return;
    }
    setUploadCancelConfirmVisible(true);
  });
document
  .getElementById("uploadCancelBackBtn")
  .addEventListener("click", function () {
    setUploadCancelConfirmVisible(false);
  });
document
  .getElementById("uploadCancelConfirmBtn")
  .addEventListener("click", function () {
    homeUploadCancelRequested = true;
    if (homeActivePollTimer) {
      clearInterval(homeActivePollTimer);
      homeActivePollTimer = null;
    }
    mdAbortUpload();
    setUploadCancelConfirmVisible(false);
  });
document
  .getElementById("uploadCancelConfirmModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) setUploadCancelConfirmVisible(false);
  });
document
  .getElementById("homeUploadSelectBtn")
  .addEventListener("click", handleHomeUploadSelectClick);
document
  .getElementById("homeUploadAutoBtn")
  .addEventListener("click", handleHomeUploadAutoClick);
document
  .getElementById("homeUploadChoiceModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      closeHomeUploadChoiceModal();
    }
  });
document
  .getElementById("connectProviderCloseBtn")
  .addEventListener("click", closeConnectProviderModal);
document
  .getElementById("connectProviderModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      closeConnectProviderModal();
    }
  });
document
  .getElementById("googleProviderSettingsBtn")
  .addEventListener("click", function (ev) {
    ev.stopPropagation();
    const menu = document.getElementById("googleProviderSettingsMenu");
    const isOpen = menu && menu.classList.contains("open");
    setGoogleProviderSettingsMenuVisible(!isOpen);
  });
document
  .getElementById("googleCredsChangeBtn")
  .addEventListener("click", function (ev) {
    ev.stopPropagation();
    changeGoogleSavedCredentials();
  });
document
  .getElementById("googleCredsResetBtn")
  .addEventListener("click", function (ev) {
    ev.stopPropagation();
    resetGoogleSavedCredentials();
  });
document.addEventListener("click", function (ev) {
  const wrap = document.getElementById("googleProviderOptionWrap");
  if (!wrap) return;
  if (!wrap.contains(ev.target)) {
    setGoogleProviderSettingsMenuVisible(false);
  }
});
document
  .getElementById("connectGoogleBtn")
  .addEventListener("click", function () {
    connectProvider("google");
  });
document
  .getElementById("connectMegaBtn")
  .addEventListener("click", function () {
    connectProvider("mega");
  });
document
  .getElementById("googleOauthCloseBtn")
  .addEventListener("click", closeGoogleOauthModal);
document
  .getElementById("googleOauthModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      closeGoogleOauthModal();
    }
  });
document
  .getElementById("googleOauthForm")
  .addEventListener("submit", submitGoogleOauthForm);
document
  .getElementById("googleOauthGuideBtn")
  .addEventListener("click", function () {
    window.open("/guide.html", "_blank", "noopener,noreferrer");
  });
document
  .getElementById("megaLoginCloseBtn")
  .addEventListener("click", closeMegaLoginModal);
document
  .getElementById("megaLoginModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      closeMegaLoginModal();
    }
  });
document
  .getElementById("logoutConfirmCancelBtn")
  .addEventListener("click", closeLogoutModal);
document
  .getElementById("logoutConfirmSubmitBtn")
  .addEventListener("click", confirmLogoutModal);
document
  .getElementById("megaLoginForm")
  .addEventListener("submit", submitMegaLoginForm);
document
  .getElementById("megaTokenSubmitBtn")
  .addEventListener("click", connectMegaWithSavedToken);
document
  .getElementById("namePromptForm")
  .addEventListener("submit", submitNamePrompt);
document
  .getElementById("themeSwitchBtn")
  .addEventListener("click", function () {
    const next = document.body.classList.contains("darkMode")
      ? "light"
      : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
document.getElementById("demoVideoBtn").addEventListener("click", function () {
  window.open("https://www.youtube.com/watch?v=NxMBscRX9ag", "_blank", "noopener,noreferrer");
});
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(savedTheme === "dark" ? "dark" : "light");
updateSearchClearButton();
