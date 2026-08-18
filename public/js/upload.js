
(function () {
  var STREAM_THRESHOLD = 50 * 1024 * 1024;
  var activeXhr = null;

  function abortActiveUpload() {
    if (!activeXhr) return;
    try {
      activeXhr.abort();
    } catch (e) { }
  }

  function parseJson(raw) {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  //our server answers {error: "text"}, Google answers {error: {code, message}}.
  function errorText(payload, status) {
    var e = payload && payload.error;
    if (typeof e === "string" && e.trim()) return e.trim();
    if (e && typeof e.message === "string" && e.message.trim()) return e.message.trim();
    return "Upload failed (HTTP " + status + ").";
  }

  function sendXhr(xhr, body, onProgress) {
    return new Promise(function (resolve, reject) {
      activeXhr = xhr;
      xhr.upload.onprogress = function (ev) {
        if (!ev || !ev.lengthComputable) return;
        if (onProgress) onProgress(ev.loaded, ev.total);
      };
      xhr.onload = function () {
        activeXhr = null;
        var payload = parseJson(xhr.responseText || "");
        if (xhr.status >= 200 && xhr.status < 300) return resolve(payload);
        var err = new Error(errorText(payload, xhr.status));
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = function () {
        activeXhr = null;
        //status 0 means the browser never got a reply: dropped connection, or a blocked
        //cross origin request. it is not something the server told us.
        var err = new Error("Upload connection failed. Check your network and try again.");
        err.status = xhr.status || 0;
        reject(err);
      };
      xhr.onabort = function () {
        activeXhr = null;
        reject(new Error("Upload cancelled by user."));
      };
      xhr.send(body);
    });
  }

  async function requestUploadSession(file, meta) {
    var res = await fetch("/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        email: meta.email,
        provider: meta.provider,
        parentId: meta.parentId,
        name: file.name || "upload.bin",
        size: Number(file.size) || 0,
        mimeType: file.type || "application/octet-stream"
      })
    });
    var payload = {};
    try {
      payload = await res.json();
    } catch (e) { }
    if (!res.ok) throw new Error(errorText(payload, res.status));
    return payload;
  }

  function uploadToGoogle(uploadUrl, file, onProgress) {
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    return sendXhr(xhr, file, onProgress);
  }

  function uploadToServer(file, meta, onProgress) {
    var size = Number(file.size) || 0;
    var form = new FormData();
    form.append("email", meta.email);
    form.append("provider", meta.provider);
    form.append("parentId", meta.parentId);
    if (meta.uploadId) form.append("uploadId", meta.uploadId);
    form.append("file", file, file.name);

    //big files skip multer's in memory buffer and get streamed through busboy instead.
    var useStream = size > STREAM_THRESHOLD;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", useStream ? "/upload-item-stream" : "/upload-item", true);
    if (useStream) {
      xhr.setRequestHeader("x-file-size", String(size));
      xhr.setRequestHeader("x-upload-email", String(meta.email || ""));
      xhr.setRequestHeader("x-upload-provider", String(meta.provider || ""));
      xhr.setRequestHeader("x-upload-parent-id", String(meta.parentId || ""));
      if (meta.uploadId) xhr.setRequestHeader("x-upload-id", String(meta.uploadId));
    }
    return sendXhr(xhr, form, onProgress);
  }

  function describeMb(bytes) {
    var mb = Number(bytes) / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
    return Math.round(mb) + " MB";
  }

 
  async function mdUploadFile(file, meta, onProgress) {
    var size = Number(file && file.size) || 0;
    var session = await requestUploadSession(file, meta);
    var proxyMax = Number(session.maxBytes || 0);

    if (session.mode === "direct" && session.uploadUrl) {
      try {
        return await uploadToGoogle(session.uploadUrl, file, onProgress);
      } catch (err) {
        
        if (err && err.status === 0 && size > 0 && size <= proxyMax) {
          return uploadToServer(file, meta, onProgress);
        }
        throw err;
      }
    }

    if (proxyMax > 0 && size > proxyMax) {
      throw new Error(
        "This file is " + describeMb(size) + ". " + (session.providerName || "This provider") +
        " uploads run through the server, which is capped at " + describeMb(proxyMax) +
        " here. Run Multi Drive on localhost for bigger files."
      );
    }
    return uploadToServer(file, meta, onProgress);
  }

  window.mdUploadFile = mdUploadFile;
  window.mdAbortUpload = abortActiveUpload;
})();
