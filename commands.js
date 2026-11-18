// ======================================================
// DEXTER MODZ - COMANDOS (VERSIÓN LITE, SIN yt-dlp)
// Multimedia con ffmpeg-static: no requiere Docker.
// ======================================================

const { spawn } = require("child_process");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const os = require("os");
const path = require("path");

let QRCode = null;
try { QRCode = require("qrcode"); } catch (_) {}

// ffmpeg incluido por npm (ffmpeg-static); si falla, usa el del sistema.
let FFMPEG = "ffmpeg";
try { FFMPEG = require("ffmpeg-static") || "ffmpeg"; } catch (_) {}

const TEMP_DIR = path.join(os.tmpdir(), "dexter-modz-temp");
const MAX_MEDIA_DOWNLOAD = 50 * 1024 * 1024;
const MAX_STICKER_SIZE = 1024 * 1024;
const MAX_GLOBAL_JOBS = Number(process.env.MAX_JOBS || 2);

try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(TEMP_DIR, { recursive: true });

const startedAt = Date.now();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Cola global para conversiones pesadas.
let runningJobs = 0;
const jobQueue = [];
function enqueueJob(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      runningJobs++;
      try { resolve(await task()); }
      catch (e) { reject(e); }
      finally {
        runningJobs--;
        const next = jobQueue.shift();
        if (next) next();
      }
    };
    if (runningJobs < MAX_GLOBAL_JOBS) run();
    else jobQueue.push(run);
  });
}

function extractText(message) {
  if (!message) return "";

  if (message.ephemeralMessage)
    return extractText(message.ephemeralMessage.message);

  if (message.viewOnceMessage)
    return extractText(message.viewOnceMessage.message);

  if (message.viewOnceMessageV2)
    return extractText(message.viewOnceMessageV2.message);

  if (message.documentWithCaptionMessage)
    return extractText(message.documentWithCaptionMessage.message);

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  ).trim();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Desconocido";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(2)} ${units[index]}`;
}

function formatDuration(seconds) {
  seconds = Math.floor(seconds);

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function runProcess(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let finished = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Tiempo de espera agotado."));
    }, timeoutMs);

    child.stdout.on("data", data => {
      stdout = (stdout + data.toString()).slice(-1024 * 1024);
    });

    child.stderr.on("data", data => {
      stderr = (stderr + data.toString()).slice(-20000);
    });

    child.on("error", error => {
      if (error.code === "ENOENT") {
        finish(new Error(`${command} no está instalado o no está en PATH.`));
      } else {
        finish(error);
      }
    });

    child.on("close", code => {
      if (code === 0) {
        finish(null, { stdout, stderr });
      } else {
        finish(
          new Error(
            stderr.trim() || `${command} terminó con código ${code}.`
          )
        );
      }
    });
  });
}

function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }

    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }

    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }

    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }

    break;
  }

  return current || {};
}

function findContextInfo(message) {
  const content = unwrapMessage(message);

  for (const value of Object.values(content)) {
    if (value?.contextInfo) return value.contextInfo;
  }

  return null;
}

function findMediaInContent(message) {
  const content = unwrapMessage(message);

  const definitions = [
    { key: "imageMessage", downloadType: "image", kind: "image" },
    { key: "videoMessage", downloadType: "video", kind: "video" },
    { key: "audioMessage", downloadType: "audio", kind: "audio" },
    { key: "stickerMessage", downloadType: "sticker", kind: "sticker" },
    { key: "documentMessage", downloadType: "document", kind: "document" }
  ];

  for (const item of definitions) {
    const media = content[item.key];

    if (!media) continue;

    let kind = item.kind;
    const mime = (media.mimetype || "").toLowerCase();

    if (item.key === "documentMessage") {
      if (mime.startsWith("image/")) kind = "image";
      else if (mime.startsWith("video/")) kind = "video";
      else if (mime.startsWith("audio/")) kind = "audio";
    }

    return {
      media,
      downloadType: item.downloadType,
      kind,
      mimetype: mime
    };
  }

  return null;
}

function getMediaTarget(message) {
  const direct = findMediaInContent(message);
  if (direct) return direct;

  const contextInfo = findContextInfo(message);
  if (!contextInfo?.quotedMessage) return null;

  return findMediaInContent(contextInfo.quotedMessage);
}

function extensionFromMime(mime, fallback = ".bin") {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus"
  };

  return map[mime] || fallback;
}

async function downloadMediaBuffer(target) {
  const stream = await downloadContentFromMessage(
    target.media,
    target.downloadType
  );

  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;

    if (total > MAX_MEDIA_DOWNLOAD) {
      if (typeof stream.destroy === "function") stream.destroy();
      throw new Error("El archivo supera el límite de 50 MB para conversiones.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// ======================================================
// STICKER
// ======================================================

async function handleSticker(sock, jid, message) {
  let workDir = null;

  try {
    const target = getMediaTarget(message);

    if (!target || !["image", "video"].includes(target.kind)) {
      await sock.sendMessage(jid, {
        text:
          "🖼️ Para crear un sticker:\n\n" +
          "1. Responde a una imagen o video con !sticker.\n" +
          "2. También puedes enviar una imagen con el texto !sticker."
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: "⏳ Creando sticker DEXTER MODZ..."
    });

    workDir = fs.mkdtempSync(path.join(TEMP_DIR, "sticker-"));

    const buffer = await downloadMediaBuffer(target);
    const inputPath = path.join(
      workDir,
      "input" + extensionFromMime(target.mimetype)
    );
    const outputPath = path.join(workDir, "sticker.webp");

    fs.writeFileSync(inputPath, buffer);

    const filter =
      "scale=512:512:force_original_aspect_ratio=decrease," +
      "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000," +
      "format=yuva420p";

    let args;

    if (target.kind === "video") {
      args = [
        "-y",
        "-i", inputPath,
        "-t", "6",
        "-an",
        "-vf", `fps=15,${filter}`,
        "-loop", "0",
        "-c:v", "libwebp",
        "-quality", "65",
        "-compression_level", "6",
        outputPath
      ];
    } else {
      args = [
        "-y",
        "-i", inputPath,
        "-vf", filter,
        "-frames:v", "1",
        "-c:v", "libwebp",
        "-quality", "80",
        outputPath
      ];
    }

    await runProcess(FFMPEG, args, 180000);

    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg no generó el sticker.");
    }

    const stats = fs.statSync(outputPath);

    if (stats.size > MAX_STICKER_SIZE) {
      throw new Error(
        "El sticker supera 1 MB. Prueba con una imagen o video más pequeño."
      );
    }

    await sock.sendMessage(jid, {
      sticker: { url: outputPath },
      packname: "DEXTER MODZ",
      author: "DEXTER MODZ"
    });

    log("[STICKER] Enviado:", formatBytes(stats.size));

  } catch (error) {
    log("[ERROR STICKER]", error.message);

    await sock.sendMessage(jid, {
      text:
        "❌ No se pudo crear el sticker.\n\n" +
        `${error.message}\n\n` +
        "Comprueba que FFmpeg tenga el codificador libwebp."
    });

  } finally {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

// ======================================================
// STICKER A IMAGEN
// ======================================================

async function handleToImage(sock, jid, message) {
  let workDir = null;

  try {
    const target = getMediaTarget(message);

    if (!target || target.kind !== "sticker") {
      await sock.sendMessage(jid, {
        text: "🖼️ Responde a un sticker con !toimg."
      });
      return;
    }

    workDir = fs.mkdtempSync(path.join(TEMP_DIR, "toimg-"));

    const buffer = await downloadMediaBuffer(target);
    const inputPath = path.join(workDir, "sticker.webp");
    const outputPath = path.join(workDir, "image.png");

    fs.writeFileSync(inputPath, buffer);

    await runProcess(FFMPEG, [
      "-y",
      "-i", inputPath,
      "-frames:v", "1",
      outputPath
    ]);

    if (!fs.existsSync(outputPath)) {
      throw new Error("No se pudo convertir el sticker.");
    }

    await sock.sendMessage(jid, {
      image: { url: outputPath },
      caption: "🔥 DEXTER MODZ"
    });

  } catch (error) {
    log("[ERROR TOIMG]", error.message);

    await sock.sendMessage(jid, {
      text: `❌ Error al convertir sticker:\n${error.message}`
    });

  } finally {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

// ======================================================
// VIDEO/AUDIO A MP3
// ======================================================

async function handleToAudio(sock, jid, message) {
  let workDir = null;

  try {
    const target = getMediaTarget(message);

    if (!target || !["video", "audio"].includes(target.kind)) {
      await sock.sendMessage(jid, {
        text: "🎵 Responde a un video o audio con !toaudio."
      });
      return;
    }

    workDir = fs.mkdtempSync(path.join(TEMP_DIR, "toaudio-"));

    const buffer = await downloadMediaBuffer(target);
    const inputPath = path.join(
      workDir,
      "input" + extensionFromMime(target.mimetype)
    );
    const outputPath = path.join(workDir, "audio.mp3");

    fs.writeFileSync(inputPath, buffer);

    await runProcess(FFMPEG, [
      "-y",
      "-i", inputPath,
      "-vn",
      "-c:a", "libmp3lame",
      "-q:a", "4",
      outputPath
    ], 180000);

    if (!fs.existsSync(outputPath)) {
      throw new Error("No se pudo extraer el audio.");
    }

    await sock.sendMessage(jid, {
      audio: { url: outputPath },
      mimetype: "audio/mpeg",
      ptt: false
    });

  } catch (error) {
    log("[ERROR TOAUDIO]", error.message);

    await sock.sendMessage(jid, {
      text: `❌ Error al extraer audio:\n${error.message}`
    });

  } finally {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

// ======================================================
// CODIGO QR
// ======================================================

async function handleQR(sock, jid, text) {
  const content = text.trim();

  if (!content) {
    await sock.sendMessage(jid, {
      text: "Uso: !qr texto o enlace"
    });
    return;
  }

  if (!QRCode) {
    await sock.sendMessage(jid, {
      text: "Para activar QR instala el paquete con:\nnpm install qrcode"
    });
    return;
  }

  let workDir = null;

  try {
    workDir = fs.mkdtempSync(path.join(TEMP_DIR, "qr-"));
    const outputPath = path.join(workDir, "dexter-qr.png");

    await QRCode.toFile(outputPath, content, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 700
    });

    await sock.sendMessage(jid, {
      image: { url: outputPath },
      caption: "🔥 DEXTER MODZ - QR"
    });

  } catch (error) {
    log("[ERROR QR]", error.message);

    await sock.sendMessage(jid, {
      text: `❌ No se pudo generar el QR:\n${error.message}`
    });

  } finally {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

async function showRuntime(sock, jid) {
  const memory = process.memoryUsage();

  await sock.sendMessage(jid, {
    text:
      "╔════════════════════╗\n" +
      "      DEXTER RUNTIME\n" +
      "╚════════════════════╝\n\n" +
      `Node.js: ${process.version}\n` +
      `Plataforma: ${process.platform}\n` +
      `Arquitectura: ${process.arch}\n` +
      `Sistema: ${os.release()}\n` +
      `CPU: ${os.cpus().length} núcleos\n` +
      `RAM total: ${formatBytes(os.totalmem())}\n` +
      `RAM libre: ${formatBytes(os.freemem())}\n` +
      `RAM usada por bot: ${formatBytes(memory.rss)}\n` +
      `Uptime bot: ${formatDuration(process.uptime())}`
  });
}


function getMenu() {
  return (
    "╔══════════════════════════╗\n" +
    "       🔥 DEXTER MODZ 🔥\n" +
    "╚══════════════════════════╝\n\n" +
    "🖼️ MULTIMEDIA\n" +
    "• !sticker - Imagen/video a sticker\n" +
    "• !toimg - Sticker a imagen\n" +
    "• !toaudio - Video/audio a MP3\n" +
    "• !qr texto - Crear código QR\n\n" +
    "⚙️ SISTEMA\n" +
    "• !ping - Estado del bot\n" +
    "• !uptime - Tiempo activo\n" +
    "• !runtime - Información del sistema\n" +
    "• !info - Información del bot\n\n" +
    "• hola - Saludo automático\n\n" +
    "🟢 DEXTER MODZ ACTIVO"
  );
}

const seenBySocket = new WeakMap();
const lastCommandAt = new Map();
const pendingJobs = new Set();
const COOLDOWN_MS = 1500;

async function heavy(sock, jid, task) {
  if (pendingJobs.has(jid)) {
    await sock.sendMessage(jid, { text: "⏳ Ya tienes una tarea en proceso. Espera a que termine." });
    return;
  }
  pendingJobs.add(jid);
  try {
    if (runningJobs >= MAX_GLOBAL_JOBS) {
      await sock.sendMessage(jid, {
        text: `🕒 Servidor ocupado. Tu solicitud está en cola (posición ${jobQueue.length + 1}).`
      });
    }
    await enqueueJob(task);
  } finally {
    pendingJobs.delete(jid);
  }
}

async function handleMessage(sock, msg) {
  if (!msg?.message) return;

  const jid = msg.key?.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  let seen = seenBySocket.get(sock);
  if (!seen) { seen = new Set(); seenBySocket.set(sock, seen); }
  const id = msg.key.id;
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  const trimmed = extractText(msg.message).trim();
  const isPrefixed = /^[!.\/]/.test(trimmed);
  if (!trimmed || (!isPrefixed && trimmed.toLowerCase() !== "hola")) return;

  const now = Date.now();
  if (now - (lastCommandAt.get(jid) || 0) < COOLDOWN_MS) return;
  lastCommandAt.set(jid, now);
  if (lastCommandAt.size > 2000) lastCommandAt.delete(lastCommandAt.keys().next().value);

  if (/^[!.\/]sticker$/i.test(trimmed))
    return heavy(sock, jid, () => handleSticker(sock, jid, msg.message));
  if (/^[!.\/]toimg$/i.test(trimmed))
    return heavy(sock, jid, () => handleToImage(sock, jid, msg.message));
  if (/^[!.\/]toaudio$/i.test(trimmed))
    return heavy(sock, jid, () => handleToAudio(sock, jid, msg.message));
  if (/^[!.\/]qr(?:\s|$)/i.test(trimmed))
    return handleQR(sock, jid, trimmed.replace(/^[!.\/]qr/i, "").trim().slice(0, 1000));

  const command = trimmed.toLowerCase().replace(/^[!.\/]/, "").trim();

  if (command === "hola") {
    await sock.sendMessage(jid, { text: "🔥 DEXTER MODZ BOT ACTIVO\n\nBienvenido." });
  } else if (command === "menu" || command === "help") {
    await sock.sendMessage(jid, { text: getMenu() });
  } else if (command === "ping") {
    await sock.sendMessage(jid, { text: "🏓 PONG!\n🔥 DEXTER MODZ ACTIVO" });
  } else if (command === "info") {
    await sock.sendMessage(jid, {
      text: "🔥 DEXTER MODZ\nMotor: Baileys\nProcesamiento: FFmpeg\nMultimedia: Activo\nSistema: Activo"
    });
  } else if (command === "uptime") {
    await sock.sendMessage(jid, {
      text: `⏱️ Bot activo durante:\n${formatDuration((Date.now() - startedAt) / 1000)}`
    });
  } else if (command === "runtime") {
    await showRuntime(sock, jid);
  }
}

module.exports = { handleMessage };
