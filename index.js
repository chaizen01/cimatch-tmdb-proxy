require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dns = require("dns");
const { Agent, setGlobalDispatcher } = require("undici");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);


// =======================
// TMDB PROXY (server-side)
// =======================
const TMDB_BASE = "https://api.themoviedb.org/3";

// ✅ fetch'in DNS'i OS'tan değil resolve4'ten gelsin
const tmdbDispatcher = new Agent({
  connect: {
    lookup: (hostname, opts, cb) => {
      dns.resolve4(hostname, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) {
          return cb(err || new Error("DNS resolve failed"));
        }
        cb(null, addresses[0], 4);
      });
    },
  },
});
setGlobalDispatcher(tmdbDispatcher);

function tmdbHeaders() {
  const token = process.env.TMDB_BEARER;
  if (!token) throw new Error("TMDB_BEARER missing in .env");
  return {
    Authorization: `Bearer ${token}`,
    accept: "application/json",
  };
}

async function tmdbGet(pathPart, req) {
  const url = new URL(TMDB_BASE + pathPart);

  for (const [k, v] of Object.entries(req.query || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), { headers: tmdbHeaders() });
  const text = await r.text();
  return { status: r.status, body: text };
}

// =======================
// PERSIST (db.json)
// =======================
const DB_FILE = path.join(__dirname, "db.json");

// db: userId -> { threads: {threadId: thread}, messages: {threadId: [msg]} }
let db = {};

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      db = {};
      return;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    db = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("DB load failed:", e);
    db = {};
  }
}

let _saveTimer = null;

function saveDbNow() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("DB save failed:", e);
  }
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveDbNow();
  }, 200); // hızlı spam olmasın diye minik debounce
}

loadDb();

// =======================
// HELPERS
// =======================
function getUser(req) {
  const userId = req.header("x-user-id") || "demo";
  if (!db[userId]) {
    db[userId] = {
      threads: {},   // threadId -> thread obj
      messages: {},  // threadId -> [message]
    };
    scheduleSave();
  }
  return { userId, store: db[userId] };
}

function ensureThread(store, threadId) {
  if (!store.threads[threadId]) {
    const now = new Date().toISOString();
    store.threads[threadId] = {
      id: threadId,
      name: threadId,
      avatarUrl: "",
      online: false,
      lastMessage: "",
      unread: 0,
      updatedAt: now,
      muted: false,
      archived: false,
    };
  }
  if (!store.messages[threadId]) {
    store.messages[threadId] = [];
  }
}

// =======================
// ROUTES
// =======================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});
// ✅ TMDB: Popular
app.get("/tmdb/popular", async (req, res) => {
  try {
    const r = await tmdbGet("/movie/popular", req);
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).json({
      error: String(e?.message || e),
      name: e?.name,
      code: e?.code,
      cause: e?.cause ? String(e.cause) : null,
    });

  }
});

// ✅ TMDB: Search
app.get("/tmdb/search", async (req, res) => {
  try {
    const r = await tmdbGet("/search/movie", req);
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).json({
      error: String(e?.message || e),
      name: e?.name,
      code: e?.code,
      cause: e?.cause ? String(e.cause) : null,
    });

  }
});

// ✅ TMDB: Genres
app.get("/tmdb/genres", async (req, res) => {
  try {
    const r = await tmdbGet("/genre/movie/list", req);
    res.status(r.status).send(r.body);
  } catch (e) {
    res.status(500).json({
      error: String(e?.message || e),
      name: e?.name,
      code: e?.code,
      cause: e?.cause ? String(e.cause) : null,
    });

  }
});


// GET threads
app.get("/v1/chat/threads", (req, res) => {
  const { store } = getUser(req);

  const threads = Object.values(store.threads || {});
  threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  res.json(threads);
});

// POST create thread (opsiyonel)
app.post("/v1/chat/threads", (req, res) => {
  const { store } = getUser(req);
  const t = req.body || {};

  if (!t.id) return res.status(400).json({ error: "thread.id required" });

  const now = new Date().toISOString();
  const thread = {
    id: String(t.id),
    name: String(t.name ?? t.id),
    avatarUrl: String(t.avatarUrl ?? ""),
    online: Boolean(t.online ?? false),
    lastMessage: String(t.lastMessage ?? ""),
    unread: Number(t.unread ?? 0),
    updatedAt: String(t.updatedAt ?? now),
    muted: Boolean(t.muted ?? false),
    archived: Boolean(t.archived ?? false),
  };

  store.threads[thread.id] = thread;
  if (!store.messages[thread.id]) store.messages[thread.id] = [];

  scheduleSave();
  res.status(201).json({ ok: true });
});

// GET messages (after optional)
app.get("/v1/chat/threads/:id/messages", (req, res) => {
  const { store } = getUser(req);
  const threadId = req.params.id;

  ensureThread(store, threadId);

  const after = req.query.after ? new Date(req.query.after) : null;

  const msgs = store.messages[threadId] || [];
  const filtered = after
    ? msgs.filter((m) => new Date(m.at) > after)
    : msgs;

  res.json(filtered);
});

// POST read (thread unread = 0)
app.post("/v1/chat/threads/:id/read", (req, res) => {
  const { store } = getUser(req);
  const threadId = req.params.id;

  ensureThread(store, threadId);

  const th = store.threads[threadId];
  th.unread = 0;

  scheduleSave();
  return res.json({ ok: true });
});


// POST message (thread yoksa otomatik açar)
// ✅ id destekli + id duplicate engeli
app.post("/v1/chat/threads/:id/messages", (req, res) => {
  const { store } = getUser(req);
  const threadId = req.params.id;

  ensureThread(store, threadId);

  const b = req.body || {};
  const serverAt = new Date().toISOString();
  const msg = {
    id: b.id ? String(b.id) : crypto.randomUUID(),
    fromMe: Boolean(b.fromMe),
    text: String(b.text ?? ""),
    at: serverAt, // ✅ server timestamp
  };

  const list = store.messages[threadId];

  // ✅ aynı id varsa tekrar ekleme
  const existing = list.find((m) => m.id === msg.id);
  if (existing) {
    // ✅ idempotent: aynı msg id tekrar geldiyse aynısını dön
    return res.status(200).json({ ok: true, id: existing.id, at: existing.at });
  }

  list.push(msg);

  // ✅ thread preview güncelle (sadece yeni mesajda)
  const th = store.threads[threadId];
  th.lastMessage = msg.text;
  th.updatedAt = msg.at;

  scheduleSave();
  return res.status(201).json({ ok: true, id: msg.id, at: msg.at });
}); // ✅ route burada biter

app.listen(PORT, () => {
  console.log(`Chat backend running on http://localhost:${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
});
