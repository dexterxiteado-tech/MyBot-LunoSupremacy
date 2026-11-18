// ======================================================
// DEXTER MODZ - SERVIDOR WEB DE VINCULACION
// Uso: npm install express @whiskeysockets/baileys pino qrcode
//      node server.js   ->   http://localhost:3000
// ======================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pino = require("pino");
const QRCode = require("qrcode");
const { handleMessage } = require("./commands");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, "web_sessions");
const MAX_SESSIONS = 5;                 // sesiones simultáneas
const PAIR_TIMEOUT_MS = 3 * 60 * 1000;  // tiempo para vincular antes de borrar
const RATE_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 }; // por IP

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// id -> { id, mode, phone, status, qr, code, error, sock, createdAt, closed }
const sessions = new Map();
const rateMap = new Map();

// ------------------------------------------------------
// UTILIDADES
// ------------------------------------------------------

const validId = id => /^[a-f0-9]{16}$/.test(String(id || ""));
const sessionPath = id => path.join(SESSIONS_DIR, id);

function rateLimited(ip) {
  const now = Date.now();
  const list = (rateMap.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.max) {
    rateMap.set(ip, list);
    return true;
  }
  list.push(now);
  rateMap.set(ip, list);
  return false;
}

async function destroySession(id, { logout = false } = {}) {
  const s = sessions.get(id);
  if (s) {
    s.closed = true;
    if (s.sock) {
      if (logout) { try { await s.sock.logout(); } catch (_) {} }
      try { s.sock.end(undefined); } catch (_) {}
    }
    sessions.delete(id);
  }
  await sleep(300);
  try { fs.rmSync(sessionPath(id), { recursive: true, force: true }); } catch (_) {}
  log("Sesión eliminada:", id);
}

// ------------------------------------------------------
// SESION DE BAILEYS
// ------------------------------------------------------

async function startSocket(id) {
  const s = sessions.get(id);
  if (!s || s.closed) return;

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath(id));

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  s.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async update => {
    if (s.closed || s.sock !== sock) return;
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        if (s.mode === "qr") {
          // El QR se renueva cada ~20 s: guardamos siempre el último.
          s.qr = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
          s.status = "waiting";
        } else if (!s.codeRequested) {
          // El primer evento "qr" indica que el socket ya puede emparejar.
          s.codeRequested = true;
          const raw = await sock.requestPairingCode(s.phone);
          s.code = String(raw).match(/.{1,4}/g).join("-");
          s.status = "waiting";
          log("Código generado para sesión", id);
        }
      } catch (e) {
        s.status = "error";
        s.error = e.message || String(e);
        log("Error generando vinculación:", s.error);
      }
    }

    if (connection === "open") {
      s.status = "connected";
      s.qr = null;
      s.code = null;
      s.number = (sock.user?.id || "").split(":")[0].split("@")[0];
      log("Conectado:", id, s.number);
    }

    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (status === DisconnectReason.loggedOut) {
        log("Sesión cerrada desde WhatsApp:", id);
        await destroySession(id);
        return;
      }

      if (s.closed) return;

      // Tras vincular, WhatsApp pide reiniciar el socket (código 515).
      if (status === DisconnectReason.restartRequired) {
        s.status = "linking";
      } else if (s.status !== "connected") {
        s.codeRequested = false;
        s.code = null;
      }

      await sleep(1500);
      startSocket(id).catch(e => log("Error reconectando:", e.message));
    }
  });

  // Comandos completos de DEXTER MODZ en cada cuenta vinculada.
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages || []) {
      try {
        await handleMessage(sock, msg);
      } catch (e) {
        log("[ERROR MENSAJE]", e.message);
      }
    }
  });
}

// ------------------------------------------------------
// API
// ------------------------------------------------------

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10kb" }));

// Solo se sirve el HTML; las carpetas de sesión nunca quedan expuestas.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/api/pair", async (req, res) => {
  try {
    const mode = req.body?.mode === "qr" ? "qr" : "code";
    const phone = String(req.body?.phone || "").replace(/\D/g, "");

    if (mode === "code" && !/^[1-9]\d{9,14}$/.test(phone)) {
      return res.status(400).json({
        error: "Número inválido. Usa código de país, sin + ni espacios."
      });
    }

    if (rateLimited(req.ip)) {
      return res.status(429).json({
        error: "Demasiados intentos. Espera unos minutos."
      });
    }

    if (sessions.size >= MAX_SESSIONS) {
      return res.status(503).json({
        error: "Servidor lleno. Inténtalo más tarde."
      });
    }

    const id = crypto.randomBytes(8).toString("hex");
    sessions.set(id, {
      id, mode, phone,
      status: "starting",
      qr: null, code: null, error: null, number: null,
      sock: null, createdAt: Date.now(), closed: false, codeRequested: false
    });

    await startSocket(id);
    res.json({ id });
  } catch (e) {
    log("[ERROR /api/pair]", e.message);
    res.status(500).json({ error: "No se pudo iniciar la vinculación." });
  }
});

app.get("/api/status/:id", (req, res) => {
  const s = validId(req.params.id) && sessions.get(req.params.id);
  if (!s) return res.status(404).json({ status: "gone" });
  res.json({
    status: s.status,
    mode: s.mode,
    qr: s.qr,
    code: s.code,
    number: s.number,
    error: s.error
  });
});

app.delete("/api/session/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "ID inválido" });
  await destroySession(req.params.id, { logout: true });
  res.json({ ok: true });
});

// Borra sesiones que no se vincularon a tiempo o que quedaron con error.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === "connected") continue;
    if (now - s.createdAt > PAIR_TIMEOUT_MS || s.status === "error") {
      destroySession(s.id).catch(() => {});
    }
  }
}, 30000);

process.on("uncaughtException", e => log("[UNCAUGHT]", e));
process.on("unhandledRejection", e => log("[UNHANDLED]", e));

app.listen(PORT, () => log(`🔥 DEXTER MODZ web en http://localhost:${PORT}`));
