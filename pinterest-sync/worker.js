// pinterest-sync — copies new pins from public Pinterest boards into Google Drive folders.
// Full-resolution originals, no watermark, no edits. Triggered weekly by GitHub Actions
// (no Worker cron). Runs in small batches to stay under the free-plan subrequest limit.
//
// Secrets (Cloudflare dashboard -> Settings -> Variables and Secrets):
//   GOOGLE_SA_KEY         full JSON key of the pinterest-sync service account
//   DRIVE_ROOT_FOLDER_ID  Drive folder ("Ideas") that holds one subfolder per board
//   SYNC_TOKEN            shared secret; required on every route except /health
// KV binding: SEEN (remembers which pins were already copied)

// ---- Board list: add a line here for each new board. -----------------------
// key      = short id used in URLs and KV
// feed     = the board's public RSS feed (board URL + ".rss")
// folder   = Drive subfolder name created inside the root folder
const BOARDS = {
  "whiskey-barrel-planters": {
    feed: "https://www.pinterest.com/blambert0015/whiskey-barrel-planters.rss",
    folder: "Planters",
  },
};

const MAX_PINS_PER_RUN = 15; // 2 subrequests per pin; free plan allows 50
const UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      // TEMPORARY diagnostic: shows which settings the running Worker actually received
      // (yes/no and token length only, never values). Remove once setup is confirmed.
      if (url.pathname === "/diag") {
        const h = request.headers.get("Authorization") || "";
        return json({
          hasSyncToken: !!env.SYNC_TOKEN,
          syncTokenLength: env.SYNC_TOKEN ? env.SYNC_TOKEN.length : 0,
          headerTokenLength: h.startsWith("Bearer ") ? h.length - 7 : 0,
          hasGoogleKey: !!env.GOOGLE_SA_KEY,
          hasRootFolder: !!env.DRIVE_ROOT_FOLDER_ID,
          hasKv: !!env.SEEN,
        });
      }
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      if (url.pathname === "/boards") return json({ boards: Object.keys(BOARDS) });

      if (url.pathname === "/test-pinterest") {
        const key = url.searchParams.get("board") || Object.keys(BOARDS)[0];
        const board = BOARDS[key];
        if (!board) return json({ error: "unknown board" }, 404);
        const r = await fetch(board.feed, { headers: { "User-Agent": UA } });
        const text = await r.text();
        return json({
          board: key,
          status: r.status,
          contentType: r.headers.get("content-type"),
          isRss: text.includes("<rss"),
          items: (text.match(/<item>/g) || []).length,
        });
      }

      if (url.pathname === "/test-drive") {
        const token = await googleToken(env);
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files/${env.DRIVE_ROOT_FOLDER_ID}?fields=id,name,capabilities/canAddChildren&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return json({ status: r.status, body: await r.json() });
      }

      if (url.pathname === "/sync") {
        if (request.method !== "POST" && request.method !== "GET") return json({ error: "method" }, 405);
        const key = url.searchParams.get("board");
        if (!BOARDS[key]) return json({ error: "unknown board", boards: Object.keys(BOARDS) }, 404);
        return json(await syncBoard(key, BOARDS[key], env));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------

async function syncBoard(key, board, env) {
  const result = { board: key, feedItems: 0, alreadySeen: 0, uploaded: 0, failed: [], remaining: 0 };

  const feedRes = await fetch(board.feed, { headers: { "User-Agent": UA } });
  if (!feedRes.ok) throw new Error(`Pinterest feed returned ${feedRes.status}`);
  const xml = await feedRes.text();
  if (!xml.includes("<rss")) throw new Error("Pinterest did not return an RSS feed (possibly blocked)");
  const pins = parseFeed(xml);
  result.feedItems = pins.length;

  // Which pins are new?
  const fresh = [];
  for (const p of pins) {
    const seen = await env.SEEN.get(`seen:${key}:${p.id}`);
    if (seen) result.alreadySeen++;
    else fresh.push(p);
  }
  if (fresh.length === 0) return result;

  const token = await googleToken(env);
  const folderId = await getFolderId(key, board.folder, env, token);

  const batch = fresh.slice(0, MAX_PINS_PER_RUN);
  for (const p of batch) {
    try {
      const img = await fetchOriginal(p.imageUrl);
      const name = `${p.date}_${p.id}.${img.ext}`;
      const fileId = await uploadToDrive(name, img.type, img.bytes, folderId, token);
      await env.SEEN.put(`seen:${key}:${p.id}`, JSON.stringify({ name, fileId, at: new Date().toISOString() }));
      result.uploaded++;
    } catch (e) {
      result.failed.push({ pin: p.id, error: String((e && e.message) || e) });
    }
  }
  result.remaining = fresh.length - result.uploaded - result.failed.length;
  return result;
}

function parseFeed(xml) {
  const pins = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const guid = (it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || "";
    const id = (guid.match(/\/pin\/(\d+)/) || [])[1];
    // description is HTML-escaped or CDATA; handle both
    const desc = decodeEntities(((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    const src = (desc.match(/src="(https:\/\/i\.pinimg\.com\/[^"]+)"/) || [])[1];
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!id || !src) continue;
    const d = pub ? new Date(pub) : new Date();
    const date = isNaN(d) ? "unknown-date" : d.toISOString().slice(0, 10);
    pins.push({ id, imageUrl: src, date });
  }
  return pins;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Feed gives /236x/ thumbnails. Try full-size originals, then fall back to 736x.
async function fetchOriginal(thumbUrl) {
  const sizes = ["originals", "736x"];
  let lastStatus = 0;
  for (const s of sizes) {
    const u = thumbUrl.replace(/\/\d+x\//, `/${s}/`);
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (r.ok) {
      const type = r.headers.get("content-type") || "image/jpeg";
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength < 1000) throw new Error("image too small, likely an error page");
      return { bytes, type, ext: extFor(type, u) };
    }
    lastStatus = r.status;
  }
  throw new Error(`image download failed (${lastStatus})`);
}

function extFor(type, url) {
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

// ---- Google Drive -----------------------------------------------------------

async function getFolderId(key, name, env, token) {
  const cached = await env.SEEN.get(`folder:${key}`);
  if (cached) return cached;

  const q = `name='${name.replace(/'/g, "\\'")}' and '${env.DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!list.ok) throw new Error(`Drive folder lookup failed (${list.status}): ${await list.text()}`);
  const found = (await list.json()).files || [];
  let id = found[0] && found[0].id;

  if (!id) {
    const create = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [env.DRIVE_ROOT_FOLDER_ID] }),
    });
    if (!create.ok) throw new Error(`Drive folder create failed (${create.status}): ${await create.text()}`);
    id = (await create.json()).id;
  }
  await env.SEEN.put(`folder:${key}`, id);
  return id;
}

async function uploadToDrive(name, type, bytes, folderId, token) {
  const boundary = "pinsync" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [folderId] }) +
      `\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(bytes), head.length);
  body.set(tail, head.length + bytes.byteLength);

  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`Drive upload failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).id;
}

// Service-account auth: signed JWT -> access token
async function googleToken(env) {
  if (!env.GOOGLE_SA_KEY) throw new Error("GOOGLE_SA_KEY secret is not set");
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`Google token request failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- helpers ----------------------------------------------------------------

function authorized(request, env) {
  if (!env.SYNC_TOKEN) return false;
  const h = request.headers.get("Authorization") || "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (given.length !== env.SYNC_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.SYNC_TOKEN.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
