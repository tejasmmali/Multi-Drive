const THEME_STORAGE_KEY = "multidrive-theme";
const SEARCH_HISTORY_STORAGE_KEY = "multidrive-search-history";
const SEARCH_HISTORY_MAX = 7;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const queryEmail =
  new URLSearchParams(window.location.search).get("email") || "";
const queryProvider =
  new URLSearchParams(window.location.search).get("provider") || "google";
const queryFolderId =
  new URLSearchParams(window.location.search).get("folderId") || "";
const queryFolderNameRaw =
  new URLSearchParams(window.location.search).get("folderName") || "";
let browseEmail = queryEmail.trim();
let browseProvider = normalizeProvider(queryProvider);
let browsePath = [{ id: "root", name: "My Drive" }];
let fileContextTarget = null;
let driveClipboard = null;
let dragDepth = 0;
let uploadInProgress = false;
let uploadCancelRequested = false;
let activeUploadPollTimer = null;
let browseSearchMode = false;
let browseSuggestTimer = null;
let browseSuggestRequestId = 0;
let allowBrowseSuggestions = false;

if (queryFolderId && queryFolderId !== "root") {
  let folderName = queryFolderNameRaw || "(folder)";
  try {
    folderName = decodeURIComponent(folderName);
  } catch (e) {}
  browsePath = [
    { id: "root", name: "My Drive" },
    { id: queryFolderId, name: folderName || "(folder)" },
  ];
}

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

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function readJsonSafe(res) {
  const raw = await res.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {
      error: "Unexpected server response. Please refresh and try again.",
    };
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
  statsEl.textContent = details.stats || "0% | 0 B / 0 B | 0 B/s | ETA -";
  barEl.style.width = ratio.toFixed(1) + "%";
}

//the upload itself lives in js/upload.js, shared with the home page.

function setUploadCancelConfirmVisible(show) {
  const modal = document.getElementById("uploadCancelConfirmModal");
  if (!modal) return;
  modal.classList.toggle("open", !!show);
  modal.setAttribute("aria-hidden", show ? "false" : "true");
}

function renderBrowseSkeleton(rowCount) {
  const count = Math.max(4, Number(rowCount) || 8);
  const rows = Array.from({ length: count })
    .map(() => {
      return '<tr><td><span class="skeletonLine skeletonName"></span></td><td><span class="skeletonLine skeletonType"></span></td><td><span class="skeletonLine skeletonSize"></span></td><td><span class="skeletonLine skeletonDate"></span></td></tr>';
    })
    .join("");

  return (
    '<table class="skeletonTable"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>' +
    rows +
    "</tbody></table>"
  );
}

function updateBrowseSearchClearButton() {
  const input = document.getElementById("browseSearchInput");
  const clearBtn = document.getElementById("browseSearchClearBtn");
  if (!input || !clearBtn) return;
  if (input.value.trim()) {
    clearBtn.classList.add("show");
  } else {
    clearBtn.classList.remove("show");
  }
}

function hideBrowseSuggestions() {
  const box = document.getElementById("browseSearchSuggest");
  if (!box) return;
  box.style.display = "none";
  box.innerHTML = "";
}

function renderBrowseSuggestions(items) {
  const box = document.getElementById("browseSearchSuggest");
  if (!box) return;
  if (!Array.isArray(items) || items.length === 0) {
    hideBrowseSuggestions();
    return;
  }

  box.innerHTML = items
    .map((item) => {
      const name = item && item.name ? String(item.name) : "";
      const cls =
        item && item.kind === "history"
          ? "browseSuggestItem history"
          : "browseSuggestItem";
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

  box.querySelectorAll(".browseSuggestItem").forEach((btn) => {
    btn.addEventListener("click", function () {
      const input = document.getElementById("browseSearchInput");
      const raw = btn.getAttribute("data-suggest") || "";
      if (!input) return;
      let value = "";
      try {
        value = decodeURIComponent(raw);
      } catch (e) {
        value = raw;
      }
      input.value = value;
      updateBrowseSearchClearButton();
      hideBrowseSuggestions();
      searchInOpenedAccount();
    });
  });
}

async function fetchBrowseSuggestions() {
  const input = document.getElementById("browseSearchInput");
  if (!input || !browseEmail) return;
  if (!allowBrowseSuggestions || document.activeElement !== input) {
    hideBrowseSuggestions();
    return;
  }
  const term = input.value.trim();
  updateBrowseSearchClearButton();

  if (!term) {
    const history = getSearchHistory()
      .slice(0, 4)
      .map((name) => ({ name, kind: "history" }));
    renderBrowseSuggestions(history);
    return;
  }

  if (term.length < 2) {
    hideBrowseSuggestions();
    return;
  }

  const reqId = ++browseSuggestRequestId;
  try {
    const res = await fetch("/search?q=" + encodeURIComponent(term), {
      cache: "no-store",
    });
    const payload = await readJsonSafe(res);
    if (reqId !== browseSuggestRequestId) return;
    if (!res.ok) {
      hideBrowseSuggestions();
      return;
    }

    const all = Array.isArray(payload.results) ? payload.results : [];
    const history = getSearchHistory().filter((name) =>
      name.toLowerCase().includes(term.toLowerCase()),
    );
    const names = [];
    const seen = new Set();

    for (const name of history) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push({ name, kind: "history" });
      if (names.length >= 8) break;
    }

    for (const item of all) {
      const itemEmail = String((item && item.accountEmail) || "")
        .trim()
        .toLowerCase();
      const itemProvider = normalizeProvider(
        (item && item.accountProvider) || "google",
      );
      if (
        itemEmail !== browseEmail.trim().toLowerCase() ||
        itemProvider !== browseProvider
      ) {
        continue;
      }
      const name = item && item.name ? String(item.name).trim() : "";
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push({ name, kind: "search" });
      if (names.length >= 8) break;
    }

    renderBrowseSuggestions(names);
  } catch (e) {
    if (reqId !== browseSuggestRequestId) return;
    hideBrowseSuggestions();
  }
}

function queueBrowseSuggestions() {
  if (browseSuggestTimer) {
    clearTimeout(browseSuggestTimer);
  }
  browseSuggestTimer = setTimeout(fetchBrowseSuggestions, 220);
}

function goToMyDriveRoot() {
  browseSearchMode = false;
  const bc = document.getElementById("browseBreadcrumb");
  if (bc) bc.style.display = "";
  browsePath = [{ id: "root", name: "My Drive" }];
  loadBrowseFolder();
}

function goToSharedDrivesList() {
  browseSearchMode = false;
  const bc = document.getElementById("browseBreadcrumb");
  if (bc) bc.style.display = "";
  browsePath = [{ id: "__shared_drives__", name: "Shared drives" }];
  loadBrowseFolder();
}

function openBrowseFolder(id, name) {
  browseSearchMode = false;
  const bc = document.getElementById("browseBreadcrumb");
  if (bc) bc.style.display = "";
  browsePath.push({ id, name: name || "(folder)" });
  loadBrowseFolder();
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
  menu.style.left = Math.max(8, Math.min(x, maxLeft)) + "px";
  menu.style.top = Math.max(8, Math.min(y, maxTop)) + "px";
}

function getCurrentBrowseFolderId() {
  const current = browsePath[browsePath.length - 1];
  if (!current || !current.id || current.id === "__shared_drives__") {
    return "";
  }
  return current.id;
}

async function createFolderFromTopBar() {
  if (!browseEmail) {
    alert("Missing account email.");
    return;
  }
  const parentId = getCurrentBrowseFolderId();
  if (!parentId) {
    alert("Open a destination folder first.");
    return;
  }
  setFolderCreateModalVisible(true);
}

function setFolderCreateModalVisible(show) {
  const modal = document.getElementById("folderCreateModal");
  const input = document.getElementById("folderCreateNameInput");
  if (!modal || !input) return;
  modal.classList.toggle("open", !!show);
  modal.setAttribute("aria-hidden", show ? "false" : "true");
  if (show) {
    input.value = "";
    window.setTimeout(() => input.focus(), 0);
  }
}

async function submitFolderCreateModal() {
  if (!browseEmail) {
    alert("Missing account email.");
    return;
  }
  const parentId = getCurrentBrowseFolderId();
  if (!parentId) {
    alert("Open a destination folder first.");
    setFolderCreateModalVisible(false);
    return;
  }
  const input = document.getElementById("folderCreateNameInput");
  const folderName = String(input && input.value ? input.value : "").trim();
  if (!folderName) {
    if (input) input.focus();
    return;
  }

  try {
    const res = await fetch("/create-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: browseEmail,
        provider: browseProvider,
        parentId,
        folderName,
      }),
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      alert(
        payload && payload.error ? payload.error : "Unable to create folder",
      );
      return;
    }
    setFolderCreateModalVisible(false);
    await loadBrowseFolder();
  } catch (e) {
    alert("Create folder failed. Please try again.");
  }
}

function updateFileContextButtonsState() {
  const pasteBtn = document.getElementById("fileContextPasteBtn");
  const moveBtn = document.getElementById("fileContextMoveBtn");
  const deleteBtn = document.getElementById("fileContextDeleteBtn");
  const hasTarget = !!(fileContextTarget && fileContextTarget.id);
  const hasClipboard = !!(driveClipboard && driveClipboard.id);
  const isMegaDeleteTarget =
    hasTarget && normalizeProvider(browseProvider) === "mega";

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
  if (!fileContextTarget || !fileContextTarget.id) {
    closeFileContextMenu();
    return;
  }
  driveClipboard = {
    mode,
    id: fileContextTarget.id,
    name: fileContextTarget.name || "(unnamed)",
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
  if (!driveClipboard || !driveClipboard.id) {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: browseEmail,
        provider: browseProvider,
        fileId: driveClipboard.id,
        destinationFolderId,
      }),
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      alert(
        payload && payload.error ? payload.error : "Unable to complete paste",
      );
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
  if (!fileContextTarget || !fileContextTarget.id) {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: browseEmail,
        provider: browseProvider,
        fileId: fileContextTarget.id,
        destinationFolderId,
      }),
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      alert(payload && payload.error ? payload.error : "Unable to move item");
      return;
    }
    loadBrowseFolder();
  } catch (e) {
    alert("Move failed. Please try again.");
  }
}

async function deleteBrowseItemFromContext() {
  if (!fileContextTarget) return;
  const fileId = fileContextTarget.id;
  const itemName = fileContextTarget.name || "this item";
  if (!browseEmail || !fileId) {
    closeFileContextMenu();
    return;
  }
  if (normalizeProvider(browseProvider) === "mega") {
    alert(
      "Delete feature is only available in Google Drive account for now. i am working on it, stay tuned!",
    );
    closeFileContextMenu();
    return;
  }
  const ok = await confirmDeleteBrowseItem(itemName);
  if (!ok) {
    closeFileContextMenu();
    return;
  }
  closeFileContextMenu();
  try {
    const res = await fetch("/delete-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: browseEmail,
        provider: browseProvider,
        fileId,
      }),
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      alert(payload && payload.error ? payload.error : "Unable to delete item");
      return;
    }
    removeBrowseRowById(fileId);
    if (browseSearchMode) {
      await searchInOpenedAccount();
    } else {
      await loadBrowseFolder();
    }
  } catch (e) {
    alert("Delete failed. Please try again.");
  }
}

function confirmDeleteBrowseItem(itemName) {
  return new Promise((resolve) => {
    const modal = document.getElementById("deleteConfirmModal");
    const text = document.getElementById("deleteConfirmText");
    const cancelBtn = document.getElementById("deleteConfirmCancelBtn");
    const deleteBtn = document.getElementById("deleteConfirmDeleteBtn");
    if (!modal || !text || !cancelBtn || !deleteBtn) {
      resolve(false);
      return;
    }

    text.textContent =
      'Delete "' +
      String(itemName || "this item") +
      '"? This cannot be undone.';
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    const cleanup = () => {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      cancelBtn.removeEventListener("click", onCancel);
      deleteBtn.removeEventListener("click", onDelete);
      modal.removeEventListener("click", onOverlay);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onDelete = () => {
      cleanup();
      resolve(true);
    };
    const onOverlay = (ev) => {
      if (ev.target === modal) {
        cleanup();
        resolve(false);
      }
    };

    cancelBtn.addEventListener("click", onCancel);
    deleteBtn.addEventListener("click", onDelete);
    modal.addEventListener("click", onOverlay);
  });
}

function renderBrowseRows(items) {
  const folderIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f59e0b" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  const fileIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#64748b" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';

  return items
    .map((f) => {
      const name = f.name || "(unnamed)";
      const mime = f.mimeType ? String(f.mimeType) : "";
      const isFolder = mime === FOLDER_MIME;
      const isSharedRoot = !!f.isSharedDriveRoot;
      const link = f.webViewLink ? String(f.webViewLink) : "";
      const fileId = String(f.id || "");
      const openUrl =
        link ||
        (fileId
          ? "/open-file?email=" +
            encodeURIComponent(browseEmail) +
            "&provider=" +
            encodeURIComponent(browseProvider) +
            "&fileId=" +
            encodeURIComponent(fileId)
          : "");
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
      } else if (openUrl) {
        innerName =
          '<a href="' +
          escapeHtml(openUrl) +
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
}

function renderBrowseTable(items) {
  const body = document.getElementById("browseBody");
  if (!body) return;
  body.innerHTML =
    '<table class="fileTable"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>' +
    renderBrowseRows(items) +
    "</tbody></table>";

  body.querySelectorAll(".folderLink").forEach((btn) => {
    btn.addEventListener("click", function () {
      const fid = btn.getAttribute("data-folder-id");
      let fname = btn.getAttribute("data-folder-name") || "";
      try {
        fname = decodeURIComponent(fname);
      } catch (e) {}
      if (browseSearchMode) {
        browsePath = [{ id: "root", name: "My Drive" }];
      }
      openBrowseFolder(fid, fname);
    });
  });

  body.querySelectorAll(".browseItemRow").forEach((row) => {
    row.addEventListener("click", function (ev) {
      if (ev.target.closest("a, button")) return;
      const folderBtn = row.querySelector(".folderLink");
      if (folderBtn) {
        const fid = folderBtn.getAttribute("data-folder-id");
        let fname = folderBtn.getAttribute("data-folder-name") || "";
        try {
          fname = decodeURIComponent(fname);
        } catch (e) {}
        if (browseSearchMode) {
          browsePath = [{ id: "root", name: "My Drive" }];
        }
        openBrowseFolder(fid, fname);
        return;
      }
      const fileLink = row.querySelector(".fileNameCell a");
      if (fileLink && fileLink.getAttribute("href")) {
        window.open(
          fileLink.getAttribute("href"),
          "_blank",
          "noopener,noreferrer",
        );
      }
    });

    row.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      const fileId = row.getAttribute("data-item-id") || "";
      const isSharedRoot = row.getAttribute("data-shared-root") === "1";
      if (!fileId || isSharedRoot) {
        closeFileContextMenu();
        return;
      }
      let name = "(unnamed)";
      try {
        name =
          decodeURIComponent(row.getAttribute("data-item-name") || "") ||
          "(unnamed)";
      } catch (e) {}
      openFileContextMenu(ev.clientX, ev.clientY, { id: fileId, name });
    });
  });
}

async function searchInOpenedAccount() {
  const input = document.getElementById("browseSearchInput");
  const body = document.getElementById("browseBody");
  const bc = document.getElementById("browseBreadcrumb");
  const btn = document.getElementById("browseSearchBtn");
  if (!input || !body || !bc || !btn) return;

  const term = input.value.trim();
  updateBrowseSearchClearButton();
  hideBrowseSuggestions();
  allowBrowseSuggestions = false;
  browseSuggestRequestId += 1;
  if (browseSuggestTimer) {
    clearTimeout(browseSuggestTimer);
    browseSuggestTimer = null;
  }
  input.blur();

  if (!term) {
    browseSearchMode = false;
    bc.style.display = "";
    loadBrowseFolder();
    return;
  }
  saveSearchHistoryTerm(term);

  browseSearchMode = true;
  bc.style.display = "none";
  closeFileContextMenu();
  btn.disabled = true;
  body.innerHTML = renderBrowseSkeleton(8);

  try {
    const res = await fetch("/search?q=" + encodeURIComponent(term), {
      cache: "no-store",
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      const err =
        payload && payload.error ? payload.error : "Could not search files";
      body.innerHTML =
        '<div class="state error">' + escapeHtml(String(err)) + "</div>";
      return;
    }

    const all = Array.isArray(payload.results) ? payload.results : [];
    const filtered = all.filter((item) => {
      const itemEmail = String((item && item.accountEmail) || "")
        .trim()
        .toLowerCase();
      const itemProvider = normalizeProvider(
        (item && item.accountProvider) || "google",
      );
      return (
        itemEmail === browseEmail.trim().toLowerCase() &&
        itemProvider === browseProvider
      );
    });

    if (filtered.length === 0) {
      body.innerHTML =
        '<div class="state">No files or folders matched in this account.</div>';
      return;
    }

    renderBrowseTable(filtered);
  } catch (e) {
    body.innerHTML =
      '<div class="state error">Failed to search right now.</div>';
  } finally {
    btn.disabled = false;
  }
}

async function loadBrowseFolder() {
  const body = document.getElementById("browseBody");
  const emailEl = document.getElementById("browseEmail");
  if (!body || !browseEmail) return;

  if (emailEl) emailEl.textContent = browseEmail;
  const titleEl = document.getElementById("browseTitle");
  if (titleEl) titleEl.textContent = providerName(browseProvider) + " files";
  body.innerHTML = renderBrowseSkeleton(8);
  closeFileContextMenu();

  const parentSeg = browsePath[browsePath.length - 1];
  const parentId = parentSeg ? parentSeg.id : "root";

  try {
    const url =
      "/files?email=" +
      encodeURIComponent(browseEmail) +
      "&provider=" +
      encodeURIComponent(browseProvider) +
      "&parentId=" +
      encodeURIComponent(parentId) +
      "&_ts=" +
      Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const payload = await readJsonSafe(res);

    if (!res.ok) {
      if (normalizeProvider(browseProvider) === "mega" && parentId !== "root") {
        browsePath = [{ id: "root", name: "My Drive" }];
        return await loadBrowseFolder();
      }
      const err =
        payload && payload.error ? payload.error : "Could not load folder";
      body.innerHTML =
        '<div class="state error">' + escapeHtml(String(err)) + "</div>";
      return;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const inMyDriveBranch =
      browsePath.length > 0 && browsePath[0].id === "root";
    const navWrap = document.querySelector(".browseNav");
    if (navWrap) {
      navWrap.style.display =
        normalizeProvider(browseProvider) === "mega" ? "none" : "";
    }
    document.querySelectorAll(".browseNavBtn[data-nav]").forEach((btn) => {
      const nav = btn.getAttribute("data-nav");
      const active =
        (nav === "my" && inMyDriveBranch) ||
        (nav === "shared" && !inMyDriveBranch);
      btn.classList.toggle("active", active);
    });
    renderBrowseBreadcrumb();

    if (items.length === 0) {
      const emptyHint =
        parentId === "root" && normalizeProvider(browseProvider) !== "mega"
          ? '<p style="margin:8px 0 0;font-size:12px;font-weight:700;color:var(--muted);max-width:420px;margin-left:auto;margin-right:auto;">If your files live on a team or shared drive, open <strong>Shared drives</strong> above.</p>'
          : "";
      body.innerHTML =
        '<div class="state">No folders or files here.' +
        emptyHint +
        '<img class="emptyStateImg" src="/images/nothing_here__.png" alt="Nothing here"></div>';
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
        const fileId = String(f.id || "");
        const openUrl =
          link ||
          (fileId
            ? "/open-file?email=" +
              encodeURIComponent(browseEmail) +
              "&provider=" +
              encodeURIComponent(browseProvider) +
              "&fileId=" +
              encodeURIComponent(fileId)
            : "");
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
        } else if (openUrl) {
          innerName =
            '<a href="' +
            escapeHtml(openUrl) +
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
      '<table class="fileTable"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead><tbody>' +
      rows +
      "</tbody></table>";

    body.querySelectorAll(".folderLink").forEach((btn) => {
      btn.addEventListener("click", function () {
        const fid = btn.getAttribute("data-folder-id");
        let fname = btn.getAttribute("data-folder-name") || "";
        try {
          fname = decodeURIComponent(fname);
        } catch (e) {}
        openBrowseFolder(fid, fname);
      });
    });

    body.querySelectorAll(".browseItemRow").forEach((row) => {
      row.addEventListener("click", function (ev) {
        if (ev.target.closest("a, button")) return;
        const folderBtn = row.querySelector(".folderLink");
        if (folderBtn) {
          const fid = folderBtn.getAttribute("data-folder-id");
          let fname = folderBtn.getAttribute("data-folder-name") || "";
          try {
            fname = decodeURIComponent(fname);
          } catch (e) {}
          openBrowseFolder(fid, fname);
          return;
        }
        const fileLink = row.querySelector(".fileNameCell a");
        if (fileLink && fileLink.getAttribute("href")) {
          window.open(
            fileLink.getAttribute("href"),
            "_blank",
            "noopener,noreferrer",
          );
        }
      });

      row.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        const fileId = row.getAttribute("data-item-id") || "";
        const isSharedRoot = row.getAttribute("data-shared-root") === "1";
        if (!fileId || isSharedRoot) {
          closeFileContextMenu();
          return;
        }
        let name = "(unnamed)";
        try {
          name =
            decodeURIComponent(row.getAttribute("data-item-name") || "") ||
            "(unnamed)";
        } catch (e) {}
        openFileContextMenu(ev.clientX, ev.clientY, { id: fileId, name });
      });
    });
  } catch (e) {
    body.innerHTML = '<div class="state error">Failed to load folder.</div>';
  }
}

function hasDraggedFiles(ev) {
  if (!ev || !ev.dataTransfer || !ev.dataTransfer.types) return false;
  return Array.from(ev.dataTransfer.types).includes("Files");
}

function setDropOverlay(active) {
  const body = document.getElementById("browseBody");
  if (!body) return;
  body.classList.toggle("dragActive", active);
}

function currentDropParentId() {
  const current = browsePath[browsePath.length - 1];
  if (!current || !current.id || current.id === "__shared_drives__") {
    return "";
  }
  return current.id;
}

async function uploadDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0 || uploadInProgress) return;
  if (!browseEmail) {
    alert("Missing account email for upload.");
    return;
  }
  const parentId = currentDropParentId();
  if (!parentId) {
    alert("Open a destination folder, then drop files.");
    return;
  }

  uploadInProgress = true;
  uploadCancelRequested = false;
  const totalBytes = files.reduce(
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
    account: providerName(browseProvider) + " - " + browseEmail,
    file: "Preparing...",
    index: 0,
    total: files.length,
    percent: 0,
    stats: "0% | 0 B / " + formatFileSize(totalBytes) + " | 0 B/s | ETA -",
  });

  try {
    for (let i = 0; i < files.length; i++) {
      if (uploadCancelRequested) {
        throw new Error("Upload cancelled by user.");
      }
      const file = files[i];
      lastSampleBytes = uploadedCompletedBytes;
      lastSampleTime = Date.now();
      smoothedSpeed = 0;
      const fileSize = Number(file && file.size) || 0;
      const uploadId = makeUploadId();
      const isMegaProvider = normalizeProvider(browseProvider) === "mega";
      let active = true;
      let hasServerSample = false;
      let currentFileClientLoaded = 0;
      let lastServerRatio = 0;

      //only MEGA needs the server side progress feed: its bytes still pass through the
      //server, so the browser's own progress events stop at that hop. A Google upload goes
      //straight to Google, where xhr progress is already the real number.
      const pollTimer = !isMegaProvider
        ? null
        : window.setInterval(async () => {
        if (!active) return;
        try {
          const pRes = await fetch(
            "/upload-progress?uploadId=" + encodeURIComponent(uploadId),
          );
          const pData = await pRes.json();
          if (!pRes.ok || !pData || pData.status === "unknown") return;
          hasServerSample = true;
          const bytesUploaded = Number(pData.bytesUploaded || 0);
          const bytesTotal = Number(pData.bytesTotal || fileSize || 0);
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
            title:
              normalizeProvider(browseProvider) === "mega"
                ? "Uploading to MEGA"
                : "Uploading files",
            account: providerName(browseProvider) + " - " + browseEmail,
            file: file && file.name ? file.name : "Unnamed file",
            index: i + 1,
            total: files.length,
            percent,
            stats:
              Math.round(percent) +
              "% | " +
              formatFileSize(overallLoaded) +
              " / " +
              formatFileSize(totalBytes) +
              " | " +
              formatRate(smoothedSpeed) +
              " | ETA " +
              (smoothedSpeed > 0 ? formatDuration(etaSec) : "-"),
          });
        } catch (e) {}
      }, 300);
      activeUploadPollTimer = pollTimer;

      await mdUploadFile(
        file,
        {
          email: browseEmail,
          provider: browseProvider,
          parentId: parentId,
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
            title:
              normalizeProvider(browseProvider) === "mega"
                ? "Uploading to MEGA"
                : "Uploading files",
            account: providerName(browseProvider) + " - " + browseEmail,
            file: file && file.name ? file.name : "Unnamed file",
            index: i + 1,
            total: files.length,
            percent,
            stats:
              Math.round(percent) +
              "% | " +
              formatFileSize(overallLoaded) +
              " / " +
              formatFileSize(totalBytes) +
              " | " +
              formatRate(smoothedSpeed) +
              " | ETA " +
              (smoothedSpeed > 0 ? formatDuration(etaSec) : "-"),
          });
        },
      );

      active = false;
      clearInterval(pollTimer);
      activeUploadPollTimer = null;
      uploadedCompletedBytes += fileSize;
    }

    updateUploadStatusCard({
      title: "Upload complete",
      account: providerName(browseProvider) + " - " + browseEmail,
      file: "All files uploaded successfully",
      index: files.length,
      total: files.length,
      percent: 100,
      stats:
        "100% | " +
        formatFileSize(totalBytes) +
        " / " +
        formatFileSize(totalBytes) +
        " | Done",
    });
    window.setTimeout(() => setUploadStatusCardVisible(false), 2000);
    await loadBrowseFolder();
  } catch (err) {
    const isCancelled =
      uploadCancelRequested ||
      (err &&
        String(err.message || "")
          .toLowerCase()
          .includes("cancel"));
    if (!isCancelled) {
      alert(
        err && err.message ? err.message : "Upload failed. Please try again.",
      );
    }
    updateUploadStatusCard({
      title: isCancelled ? "Upload cancelled" : "Upload failed",
      account: providerName(browseProvider) + " - " + browseEmail,
      file: isCancelled
        ? "Upload cancelled by user."
        : err && err.message
          ? err.message
          : "Upload failed. Please try again.",
      index: 0,
      total: files.length,
      percent: 0,
      stats: "0% | 0 B / " + formatFileSize(totalBytes) + " | 0 B/s | ETA -",
    });
    if (isCancelled) {
      setUploadStatusCardVisible(false);
    }
    await loadBrowseFolder();
  } finally {
    if (activeUploadPollTimer) {
      clearInterval(activeUploadPollTimer);
      activeUploadPollTimer = null;
    }
    uploadInProgress = false;
  }
}

function removeBrowseRowById(fileId) {
  const id = String(fileId || "").trim();
  if (!id) return;
  const rows = Array.from(document.querySelectorAll(".browseItemRow"));
  const match = rows.find(
    (row) => String(row.getAttribute("data-item-id") || "") === id,
  );
  if (!match) return;
  match.remove();

  if (document.querySelectorAll(".browseItemRow").length > 0) return;
  const body = document.getElementById("browseBody");
  if (!body) return;
  body.innerHTML =
    '<div class="state">No folders or files here.<img class="emptyStateImg" src="/images/nothing_here__.png" alt="Nothing here"></div>';
}

function goBackHomeFromBrowse() {
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === window.location.origin) {
      window.history.back();
      return;
    }
  } catch (e) {}
  window.location.href = "/";
}

document
  .getElementById("browseBackBtn")
  .addEventListener("click", goBackHomeFromBrowse);

document
  .getElementById("uploadStatusCloseBtn")
  .addEventListener("click", function () {
    if (!uploadInProgress) {
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
    uploadCancelRequested = true;
    if (activeUploadPollTimer) {
      clearInterval(activeUploadPollTimer);
      activeUploadPollTimer = null;
    }
    mdAbortUpload();
    setUploadCancelConfirmVisible(false);
  });
document
  .getElementById("uploadCancelConfirmModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      setUploadCancelConfirmVisible(false);
    }
  });

window.addEventListener("dragenter", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  dragDepth += 1;
  setDropOverlay(true);
});

window.addEventListener("dragover", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  if (ev.dataTransfer) {
    ev.dataTransfer.dropEffect = "copy";
  }
  setDropOverlay(true);
});

window.addEventListener("dragleave", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    setDropOverlay(false);
  }
});

window.addEventListener("drop", function (ev) {
  if (!hasDraggedFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  setDropOverlay(false);
  uploadDroppedFiles(ev.dataTransfer ? ev.dataTransfer.files : []);
});

document.querySelectorAll(".browseNavBtn[data-nav]").forEach((btn) => {
  btn.addEventListener("click", function () {
    const nav = btn.getAttribute("data-nav");
    if (nav === "my") {
      goToMyDriveRoot();
    } else if (nav === "shared") {
      goToSharedDrivesList();
    }
  });
});

document.addEventListener("click", function (ev) {
  const menu = document.getElementById("fileContextMenu");
  if (!menu) return;
  if (menu.style.display !== "none" && !menu.contains(ev.target)) {
    closeFileContextMenu();
  }
});

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") {
    closeFileContextMenu();
    setFolderCreateModalVisible(false);
    const delModal = document.getElementById("deleteConfirmModal");
    if (delModal) {
      delModal.classList.remove("open");
      delModal.setAttribute("aria-hidden", "true");
    }
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

  .getElementById("newFolderBtn")
  .addEventListener("click", createFolderFromTopBar);
document
  .getElementById("folderCreateCancelBtn")
  .addEventListener("click", function () {
    setFolderCreateModalVisible(false);
  });
document
  .getElementById("folderCreateSubmitBtn")
  .addEventListener("click", submitFolderCreateModal);
document
  .getElementById("folderCreateNameInput")
  .addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submitFolderCreateModal();
    }
  });
document
  .getElementById("folderCreateModal")
  .addEventListener("click", function (ev) {
    if (ev.target === this) {
      setFolderCreateModalVisible(false);
    }
  });
document
  .getElementById("browseSearchBtn")
  .addEventListener("click", searchInOpenedAccount);
document
  .getElementById("browseSearchInput")
  .addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchInOpenedAccount();
    }
  });
document
  .getElementById("browseSearchInput")
  .addEventListener("input", function () {
    allowBrowseSuggestions = true;
    queueBrowseSuggestions();
  });
document
  .getElementById("browseSearchInput")
  .addEventListener("focus", function () {
    allowBrowseSuggestions = true;
    queueBrowseSuggestions();
  });
document
  .getElementById("browseSearchClearBtn")
  .addEventListener("click", function () {
    const input = document.getElementById("browseSearchInput");
    const bc = document.getElementById("browseBreadcrumb");
    if (!input) return;
    input.value = "";
    hideBrowseSuggestions();
    allowBrowseSuggestions = false;
    updateBrowseSearchClearButton();
    browseSearchMode = false;
    if (bc) bc.style.display = "";
    loadBrowseFolder();
    input.focus();
  });
document.addEventListener("click", function (ev) {
  const wrap = document.querySelector(".browseSearch");
  if (!wrap) return;
  if (!wrap.contains(ev.target)) {
    hideBrowseSuggestions();
  }
});
document.getElementById("browseBody").addEventListener("click", function () {
  hideBrowseSuggestions();
  allowBrowseSuggestions = false;
});
document
  .getElementById("themeSwitchBtn")
  .addEventListener("click", function () {
    const next = document.body.classList.contains("darkMode")
      ? "light"
      : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(savedTheme === "dark" ? "dark" : "light");


if (!browseEmail) {
  document.getElementById("browseEmail").textContent = "No account selected";
  document.getElementById("browseBody").innerHTML =
    '<div class="state error">Missing account email. Go back and click Browse on an account card.</div>';
} else {
  loadBrowseFolder();
}
