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
const { handleMessage, normPhone } = require("./commands");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, "web_sessions");
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5);   // sesiones simultáneas (web + sub-bots)
const PAIR_TIMEOUT_MS = 3 * 60 * 1000;  // tiempo para vincular antes de borrar
const RATE_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 }; // por IP

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// id -> { id, mode, phone, status, qr, code, error, sock, createdAt, closed }
const sessions = new Map();
const rateMap = new Map();
const SUB_RATE = { max: 3, windowMs: 10 * 60 * 1000 };  // sub-bots pedidos por chat
const subRate = new Map();

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

async function notifyUser(s, payload) {
  if (!s.notify) return;
  try { await s.notify.sock.sendMessage(s.notify.jid, payload); }
  catch (e) { log("[NOTIFY]", e.message); }
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
          // Desde un chat: se envía el QR (y hasta 2 renovaciones) como imagen.
          if (s.notify && (s.qrSent || 0) < 3) {
            s.qrSent = (s.qrSent || 0) + 1;
            const png = await QRCode.toBuffer(qr, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 700 });
            await notifyUser(s, {
              image: png,
              mimetype: "image/png",
              caption:
                (s.qrSent > 1 ? "🔄 *QR actualizado*\n\n" : "🤖 *SUB-BOT*\n\n") +
                "Escanéalo desde WhatsApp > Dispositivos vinculados > Vincular dispositivo."
            });
          }
        } else if (!s.codeRequested) {
          // El primer evento "qr" indica que el socket ya puede emparejar.
          s.codeRequested = true;
          const raw = await sock.requestPairingCode(s.phone);
          s.code = String(raw).match(/.{1,4}/g).join("-");
          s.status = "waiting";
          log("Código generado para sesión", id);
          if (s.notify) {
            await notifyUser(s, {
              text:
                "🤖 *SUB-BOT*\n\n" +
                "📲 *TUTORIAL DE ACTIVACIÓN*\n\n" +
                "1. Abre WhatsApp en el número que vas a vincular.\n" +
                "2. Entra en *Dispositivos vinculados*.\n" +
                "3. Pulsa *Vincular un dispositivo*.\n" +
                "4. Selecciona *Vincular con número de teléfono*.\n" +
                "5. Introduce el código del siguiente mensaje.\n\n" +
                "⚠️ No cierres WhatsApp durante el proceso."
            });
            await notifyUser(s, { text: "*" + s.code + "*" });
          }
        }
      } catch (e) {
        s.status = "error";
        s.error = e.message || String(e);
        log("Error generando vinculación:", s.error);
        await notifyUser(s, { text: "❌ No se pudo generar la vinculación: " + s.error + "\n\nInténtalo de nuevo con .code" });
      }
    }

    if (connection === "open") {
      s.status = "connected";
      s.qr = null;
      s.code = null;
      s.number = (sock.user?.id || "").split(":")[0].split("@")[0];
      log("Conectado:", id, s.number);
      if (s.notify && !s.openNotified) {
        s.openNotified = true;
        await notifyUser(s, {
          text:
            "✅ *SUB-BOT CONECTADO*\n\n" +
            "El bot ya está activo en tu número. Escribe .menu desde tu WhatsApp para ver los comandos.\n\n" +
            "Para eliminarlo escribe .delsesion"
        });
      }
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
        await handleMessage(sock, msg, { subbots });
      } catch (e) {
        log("[ERROR MENSAJE]", e.message);
      }
    }
  });
}

// ------------------------------------------------------
// SUB-BOTS (los comandos .code / .qr / .delsesion usan esto)
// ------------------------------------------------------

const subbots = {
  async create({ mode, phone, sock, jid, requester }) {
    const now = Date.now();
    const key = String(requester || jid);
    const recent = (subRate.get(key) || []).filter(t => now - t < SUB_RATE.windowMs);
    if (recent.length >= SUB_RATE.max) {
      return { error: "⏳ Demasiados intentos. Espera unos minutos e inténtalo de nuevo." };
    }

    const wanted = normPhone(phone);
    if (wanted) {
      for (const s of [...sessions.values()]) {
        if (normPhone(s.number || s.phone) !== wanted) continue;
        if (s.status === "connected") {
          return {
            error: "ℹ️ Ese número ya tiene un sub-bot activo.\n\nPara eliminarlo escribe .delsesion desde ese número."
          };
        }
        await destroySession(s.id);   // intento anterior sin terminar: se reinicia
      }
    }

    if (sessions.size >= MAX_SESSIONS) {
      return { error: "⚠️ El servidor está lleno por ahora. Inténtalo más tarde." };
    }

    recent.push(now);
    subRate.set(key, recent);
    if (subRate.size > 1000) subRate.delete(subRate.keys().next().value);

    const id = crypto.randomBytes(8).toString("hex");
    sessions.set(id, {
      id, mode, phone: wanted || "",
      origin: "chat",
      status: "starting",
      qr: null, code: null, error: null, number: null,
      sock: null, notify: { sock, jid },
      createdAt: now, closed: false, codeRequested: false
    });

    try {
      await startSocket(id);
    } catch (e) {
      await destroySession(id);
      return { error: "❌ No se pudo iniciar el sub-bot: " + (e.message || e) };
    }
    return { ok: true, id };
  },

  findBySock(sock) {
    for (const s of sessions.values()) {
      if (s.sock === sock) return { id: s.id, number: s.number || s.phone };
    }
    return null;
  },

  findByPhone(phone) {
    const wanted = normPhone(phone);
    if (!wanted) return null;
    for (const s of sessions.values()) {
      if (normPhone(s.number || s.phone) === wanted) return { id: s.id, number: s.number || s.phone };
    }
    return null;
  },

  remove(id) {
    return destroySession(id, { logout: true });
  }
};

// Al arrancar, vuelve a conectar las sesiones ya vinculadas (si el disco las conservó).
function restoreSessions() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && validId(d.name))
      .map(d => d.name);
  } catch (_) {}

  let restored = 0;
  for (const id of dirs) {
    let creds = null;
    try { creds = JSON.parse(fs.readFileSync(path.join(sessionPath(id), "creds.json"), "utf8")); }
    catch (_) {}

    if (!creds?.me) {
      // Vinculación que nunca se completó: se limpia.
      try { fs.rmSync(sessionPath(id), { recursive: true, force: true }); } catch (_) {}
      continue;
    }
    if (sessions.size >= MAX_SESSIONS) {
      log("Límite de sesiones: no se restauró", id);
      continue;
    }

    const number = String(creds.me.id || "").split(":")[0].split("@")[0];
    sessions.set(id, {
      id, mode: "restored", phone: number, number,
      origin: "restored", restored: true,
      status: "connecting",
      qr: null, code: null, error: null,
      sock: null, notify: null,
      createdAt: Date.now(), closed: false, codeRequested: false
    });
    startSocket(id).catch(e => log("Error restaurando", id, e.message));
    restored++;
  }
  if (restored) log(`Sesiones restauradas: ${restored}`);
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
  for (const s of [...sessions.values()]) {
    if (s.status === "connected" || s.restored) continue;
    // Tras introducir el código WhatsApp tarda un poco en terminar de vincular.
    const limit = s.status === "linking" ? PAIR_TIMEOUT_MS + 2 * 60 * 1000 : PAIR_TIMEOUT_MS;
    if (now - s.createdAt > limit || s.status === "error") {
      if (s.notify && s.status !== "error") {
        notifyUser(s, { text: "⌛ Se agotó el tiempo de vinculación.\n\nEscribe .code (o .qr) para intentarlo de nuevo." });
      }
      destroySession(s.id).catch(() => {});
    }
  }
  for (const [k, list] of subRate) {
    if (!list.some(t => now - t < SUB_RATE.windowMs)) subRate.delete(k);
  }
}, 30000);

process.on("uncaughtException", e => log("[UNCAUGHT]", e));
process.on("unhandledRejection", e => log("[UNHANDLED]", e));

restoreSessions();
app.listen(PORT, () => log(`🔥 Web de vinculación en http://localhost:${PORT}`));
