//Smallest check that fails if upload routing breaks: node test-upload.js
//What it protects:
//  - Google Drive bytes must never be posted to this server (that is what broke on Vercel,
//    and what made the progress bar measure the wrong hop).
//  - A MEGA file over the proxy cap must be refused before anything is uploaded.
const fs = require("fs")
const path = require("path")
const assert = require("assert")

global.window = global
global.FormData = class {
  constructor() { this.parts = {} }
  append(key, value) { this.parts[key] = value }
}

const calls = []

class FakeXHR {
  constructor() {
    this.upload = {}
    this.status = 200
    this.responseText = '{"success":true}'
    this.headers = {}
  }
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(key, value) { this.headers[String(key).toLowerCase()] = value }
  send(body) {
    calls.push({ method: this.method, url: this.url, headers: this.headers, body })
    if (this.upload.onprogress) {
      this.upload.onprogress({ lengthComputable: true, loaded: 7, total: 9 })
    }
    setTimeout(() => this.onload(), 0)
  }
  abort() { }
}
global.XMLHttpRequest = FakeXHR

let sessionReply = null
global.fetch = async (url, options) => {
  calls.push({ method: "POST", url, body: JSON.parse(options.body) })
  return { ok: true, status: 200, json: async () => sessionReply }
}

eval(fs.readFileSync(path.join(__dirname, "public", "js", "upload.js"), "utf8"))

const file = (size) => ({ name: "clip.mp4", size, type: "video/mp4" })
const meta = (provider) => ({ email: "a@b.c", provider, parentId: "root", uploadId: "up_1" })

async function main() {
  //1. Google: the browser PUTs to Google itself, and progress is that transfer.
  sessionReply = {
    mode: "direct",
    uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc",
    maxBytes: 4 * 1024 * 1024
  }
  calls.length = 0
  let progressSeen = 0
  await window.mdUploadFile(file(3 * 1024 * 1024 * 1024), meta("google"), (loaded) => {
    progressSeen = loaded
  })
  assert.strictEqual(calls[0].url, "/upload-session")
  assert.strictEqual(calls[1].method, "PUT")
  assert.ok(
    calls[1].url.startsWith("https://www.googleapis.com/"),
    "Google bytes must go straight to Google, not through this server"
  )
  assert.strictEqual(progressSeen, 7, "progress must come from the real transfer")

  //2. MEGA under the cap still goes through the server.
  sessionReply = { mode: "server", providerName: "MEGA", maxBytes: 4 * 1024 * 1024 }
  calls.length = 0
  await window.mdUploadFile(file(1024), meta("mega"), () => { })
  assert.strictEqual(calls[1].url, "/upload-item")

  //3. MEGA over the cap is refused up front, naming the cap, before any bytes move.
  calls.length = 0
  await assert.rejects(
    () => window.mdUploadFile(file(50 * 1024 * 1024), meta("mega"), () => { }),
    /4 MB/
  )
  assert.strictEqual(calls.length, 1, "nothing may be uploaded after the size refusal")

  //4. A big MEGA upload locally uses the streaming route and declares its size.
  sessionReply = { mode: "server", providerName: "MEGA", maxBytes: 10 * 1024 * 1024 * 1024 }
  calls.length = 0
  const big = 200 * 1024 * 1024
  await window.mdUploadFile(file(big), meta("mega"), () => { })
  assert.strictEqual(calls[1].url, "/upload-item-stream")
  assert.strictEqual(calls[1].headers["x-file-size"], String(big))

  console.log("upload routing OK")
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
