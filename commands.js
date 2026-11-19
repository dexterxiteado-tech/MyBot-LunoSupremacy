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
          "1. Responde a una imagen o video con .s.\n" +
          "2. También puedes enviar una imagen con el texto .s."
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
        text: "🖼️ Responde a un sticker con .toimg."
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
        text: "🎵 Responde a un video o audio con .toaudio."
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
      text: "Uso: .qr texto o enlace"
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


// ======================================================
// CONFIGURACION (variables de entorno opcionales)
// ======================================================

const BOT_NAME = process.env.BOT_NAME || "DEXTER MODZ";
const BOT_VERSION = process.env.BOT_VERSION || "v.1.0.0";
const BOT_FOOTER = process.env.BOT_FOOTER || "by Dxx Modz";
const YOUTUBE_LINK = process.env.YOUTUBE_LINK || "";
const CHANNEL_JID = process.env.CHANNEL_JID || "";          // 120363...@newsletter
const CHANNEL_NAME = process.env.CHANNEL_NAME || BOT_NAME;
const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || "";
const MENU_IMAGE_FILE = ["menu.jpg", "menu.jpeg", "menu.png"]
  .map(n => path.join(__dirname, n))
  .find(p => fs.existsSync(p));

const DATA_DIR = process.env.DATA_DIR ||
  (process.env.SESSIONS_DIR ? path.dirname(process.env.SESSIONS_DIR) : path.join(__dirname, "data"));
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}


// ======================================================
// DESCARGAS CON YT-DLP (se descarga solo, no requiere Docker)
// ======================================================

const DOWNLOAD_TIMEOUT = 12 * 60 * 1000;
const activeDownloads = new Set();

const YTDLP_LOCAL = path.join(os.tmpdir(), "dexter-bin", "yt-dlp");
let YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";

async function ensureYtDlp() {
  if (process.env.YTDLP_PATH) return;
  try {
    await runProcess("yt-dlp", ["--version"], 15000);   // ¿hay uno instalado?
    YTDLP_BIN = "yt-dlp";
    return;
  } catch (_) {}

  try {
    fs.mkdirSync(path.dirname(YTDLP_LOCAL), { recursive: true });
    const asset = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
    const res = await fetch(
      `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
      { redirect: "follow", signal: AbortSignal.timeout(180000) }
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000000) throw new Error("descarga incompleta");
    const tmp = YTDLP_LOCAL + ".tmp";
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, YTDLP_LOCAL);
    log("[YTDLP] Instalado:", formatBytes(buf.length));
  } catch (e) {
    log("[YTDLP] No se pudo descargar:", e.message);
  }
  if (fs.existsSync(YTDLP_LOCAL)) YTDLP_BIN = YTDLP_LOCAL;
}

function getYtDlpCommand() {
  return YTDLP_BIN;
}

let ytDlpReady = ensureYtDlp().catch(e => log("[YTDLP]", e.message));
// Se actualiza cada 24 h para seguir el ritmo de cambios de YouTube.
setInterval(() => {
  if (process.env.YTDLP_PATH) return;
  ytDlpReady = ensureYtDlp().catch(e => log("[YTDLP]", e.message));
}, 24 * 60 * 60 * 1000).unref();

const ALLOWED_MEDIA_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "x.com",
  "twitter.com",
  "vimeo.com",
  "reddit.com",
  "redd.it"
];

function getUrlHost(value) {
  try {
    const parsed = new URL(value);

    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return null;
  }
}

function isAllowedMediaUrl(value) {
  const host = getUrlHost(value);
  if (!host) return false;

  return ALLOWED_MEDIA_DOMAINS.some(domain =>
    host === domain || host.endsWith(`.${domain}`)
  );
}

function isYoutubeUrl(value) {
  const host = getUrlHost(value);
  if (!host) return false;

  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  );
}

function hostMatches(value, domain) {
  const host = getUrlHost(value);
  return !!host && (host === domain || host.endsWith(`.${domain}`));
}


function formatVideoDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return "No disponible";
  const n = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function getSourceLabel(command, url) {
  if (command === "facebook" || hostMatches(url, "facebook.com") || hostMatches(url, "fb.watch")) return "FACEBOOK";
  if (command === "ytmp4" || command === "play" || isYoutubeUrl(url)) return "YOUTUBE";
  if (command === "tiktok" || hostMatches(url, "tiktok.com")) return "TIKTOK";
  if (command === "instagram" || hostMatches(url, "instagram.com")) return "INSTAGRAM";
  return String(command || "WEB").toUpperCase();
}

async function downloadAndSend(sock, jid, url, mode, sourceCommand) {
  await ytDlpReady;
  if (activeDownloads.has(jid)) {
    await sock.sendMessage(jid, {
      text: "⏳ Ya hay una descarga en proceso en este chat."
    });
    return;
  }

  const playIsUrl = sourceCommand === "play" && !!getUrlHost(url);
  if (sourceCommand === "play") {
    if (playIsUrl && !isYoutubeUrl(url)) {
      await sock.sendMessage(jid, { text: "❌ .play acepta enlaces de YouTube o el nombre de una canción." });
      return;
    }
    mode = "audio";
  } else if (!isAllowedMediaUrl(url)) {
    await sock.sendMessage(jid, { text: "❌ Sitio no compatible o URL no válida." });
    return;
  }

  if (sourceCommand === "ytmp4" && !isYoutubeUrl(url)) {
    await sock.sendMessage(jid, { text: "❌ .ytmp4 solo acepta enlaces de YouTube." });
    return;
  }

  if (
    sourceCommand === "tiktok" &&
    !hostMatches(url, "tiktok.com")
  ) {
    await sock.sendMessage(jid, {
      text: "❌ Ese enlace no parece ser de TikTok."
    });
    return;
  }

  if (
    sourceCommand === "instagram" &&
    !hostMatches(url, "instagram.com")
  ) {
    await sock.sendMessage(jid, {
      text: "❌ Ese enlace no parece ser de Instagram."
    });
    return;
  }

  if (
    sourceCommand === "facebook" &&
    !(
      hostMatches(url, "facebook.com") ||
      hostMatches(url, "fb.watch")
    )
  ) {
    await sock.sendMessage(jid, {
      text: "❌ Ese enlace no parece ser de Facebook."
    });
    return;
  }

  activeDownloads.add(jid);

  let jobDir = null;
  let savedPath = null;

  try {
    jobDir = fs.mkdtempSync(path.join(TEMP_DIR, "download-"));

    await sock.sendMessage(jid, {
      text:
        "╔════════════════════╗\n" +
        "       DEXTER MODZ\n" +
        "╚════════════════════╝\n\n" +
        "⏳ Procesando descarga...\n" +
        `📁 Tipo: ${mode.toUpperCase()}\n` +
        `🌐 Sitio: ${sourceCommand.toUpperCase()}\n\n` +
        "Espera un momento."
    });

    let videoInfo = null;
    if (mode === "video") {
      try {
        const info = await runProcess(getYtDlpCommand(), [
          "--no-warnings", "--no-playlist", "--skip-download", "--dump-single-json", url
        ], 90000);
        videoInfo = JSON.parse(info.stdout.trim());
      } catch (e) { log("[YTDLP INFO]", e.message); }
    }

    const outputTemplate = path.join(
      jobDir,
      "%(title).70s_%(id)s.%(ext)s"
    );

    const args = [
      "--no-playlist",
      "--no-progress",
      "--no-colors",
      "--no-warnings",
      "--no-write-info-json",
      "--no-write-thumbnail",
      "--no-write-subs",
      "--no-write-auto-subs",
      "--restrict-filenames",
      "-o",
      outputTemplate,
      "--print",
      "after_move:filepath",
      "--no-simulate"
    ];

    const cookieFile = [
      path.join(DATA_DIR, "cookies.txt"),
      path.join(__dirname, "cookies.txt")
    ].find(p => fs.existsSync(p));
    if (cookieFile) {
      args.push("--cookies", cookieFile);
      log("[YTDLP] Cookies activadas.");
    }

    // Límites para proteger el servidor: máx. 30 min y ~80 MB, sin directos.
    args.push(
      "--max-filesize", "80M",
      "--match-filter", "!is_live & duration<=?1800"
    );
    if (path.isAbsolute(FFMPEG)) args.push("--ffmpeg-location", FFMPEG);

    if (mode === "audio") {
      args.push(
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "5"
      );
    } else {
      args.push(
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format",
        "mp4"
      );
    }

    const input = sourceCommand === "play" && !playIsUrl
      ? `ytsearch1:${url}`
      : url;
    args.push(input);

    log("[YTDLP] Descargando:", sourceCommand, mode, playIsUrl ? "URL" : "BÚSQUEDA");

    const result = await runProcess(
      getYtDlpCommand(),
      args,
      DOWNLOAD_TIMEOUT
    );

    const lines = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const downloadedPath = lines[lines.length - 1];

    if (!downloadedPath || !fs.existsSync(downloadedPath)) {
      throw new Error("No se descargó nada: el video es muy largo (máx. 30 min), es un directo o pesa demasiado.");
    }

    const originalStats = fs.statSync(downloadedPath);

    if (!originalStats.isFile() || originalStats.size <= 0) {
      throw new Error("El archivo descargado está vacío.");
    }

    // Archivo temporal: se envía directamente a WhatsApp y luego se elimina.
    savedPath = downloadedPath;
    const stats = fs.statSync(savedPath);
    const extension = path.extname(savedPath).toLowerCase();
    const mimeTypes = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".opus": "audio/ogg",
      ".ogg": "audio/ogg"
    };

    log(
      "[YTDLP] Temporal listo para enviar:",
      savedPath,
      formatBytes(stats.size)
    );

    if (
      mode === "audio" &&
      extension === ".mp3" &&
      stats.size <= 64 * 1024 * 1024
    ) {
      await sock.sendMessage(jid, {
        audio: { url: savedPath },
        mimetype: "audio/mpeg",
        ptt: false
      });
    } else if (
      mode === "video" &&
      extension === ".mp4" &&
      stats.size <= 64 * 1024 * 1024
    ) {
      await sock.sendMessage(jid, {
        video: { url: savedPath },
        mimetype: "video/mp4",
        caption: `🔥 DEXTER MODZ\n\n🎬 Nombre: ${videoInfo?.title || path.basename(savedPath, extension)}\n⏱️ Duración: ${formatVideoDuration(videoInfo?.duration)}\n📥 Proveniente: ${getSourceLabel(sourceCommand, url)}\n\n👤 by Dxx Modz Sk`
      });
    } else {
      await sock.sendMessage(jid, {
        document: { url: savedPath },
        mimetype: mimeTypes[extension] || "application/octet-stream",
        fileName: path.basename(savedPath),
        caption: mode === "video" ? `🔥 DEXTER MODZ\n\n🎬 Nombre: ${videoInfo?.title || path.basename(savedPath, extension)}\n⏱️ Duración: ${formatVideoDuration(videoInfo?.duration)}\n📥 Proveniente: ${getSourceLabel(sourceCommand, url)}\n\n👤 by Dxx Modz Sk` : "🔥 DEXTER MODZ"
      });
    }

    await sock.sendMessage(jid, {
      text:
        "✅ Archivo enviado directamente a WhatsApp.\n" +
        `📦 Tamaño: ${formatBytes(stats.size)}\n` +
        "🧹 Archivo temporal eliminado al terminar."
    });

  } catch (error) {
    const message = error.message || String(error);
    const lower = message.toLowerCase();

    log("[ERROR YTDLP]", message);

    let response;

    if (lower.includes("no está instalado") || lower.includes("enoent")) {
      response =
        "❌ No se encontró yt-dlp.\n" +
        "Comprueba: yt-dlp --version";
    } else if (
      lower.includes("sign in to confirm") ||
      lower.includes("confirm you're not a bot") ||
      lower.includes("http error 429") ||
      lower.includes("login required") ||
      lower.includes("cookies")
    ) {
      response =
        "⚠️ YouTube o el sitio solicita verificación.\n\n" +
        "Esto pasa seguido en servidores. Se puede probar con un cookies.txt en la raíz del proyecto.";
    } else if (
      lower.includes("private video") ||
      lower.includes("video unavailable") ||
      lower.includes("has been removed")
    ) {
      response =
        "❌ El contenido es privado, fue eliminado o no está disponible.";
    } else if (
      lower.includes("requested format is not available")
    ) {
      response =
        "❌ No se encontró un formato compatible.";
    } else if (
      lower.includes("ffmpeg") ||
      lower.includes("ffprobe")
    ) {
      response =
        "❌ Error de FFmpeg. Comprueba: command -v ffmpeg";
    } else if (lower.includes("tiempo de espera")) {
      response = "⏱️ La descarga tardó demasiado y fue cancelada.";
    } else {
      response = `❌ Error de descarga:\n\n${message.slice(-600)}`;
    }


    try {
      await sock.sendMessage(jid, { text: response });
    } catch (sendError) {
      log("[ERROR AVISANDO DESCARGA]", sendError.message);
    }

  } finally {
    activeDownloads.delete(jid);

    if (jobDir && fs.existsSync(jobDir)) {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
      } catch (error) {
        log("[ERROR LIMPIANDO TEMP]", error.message);
      }
    }
  }
}


// ======================================================
// UTILIDADES DE JID / GRUPOS
// ======================================================

const norm = j => String(j || "").split(":")[0].split("@")[0];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const stripAccents = t => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "");

function idsOf(p) {
  return [p.id, p.phoneNumber, p.lid].filter(Boolean).map(norm);
}
function isAdminIn(meta, candidates) {
  const set = new Set(candidates.filter(Boolean).map(norm));
  return (meta?.participants || []).some(
    p => p.admin && idsOf(p).some(x => set.has(x))
  );
}
const senderIds = msg => [msg.key?.participant, msg.key?.participantAlt];
const botIds = sock => [sock.user?.id, sock.user?.lid];

function senderJid(msg, sock, jid) {
  if (jid.endsWith("@g.us")) return msg.key.participant || sock.user?.id || jid;
  return msg.key.fromMe ? (sock.user?.id || jid) : jid;
}

const metaCache = new Map();
async function getMeta(sock, jid, force = false) {
  const key = norm(sock.user?.id) + ":" + jid;
  const hit = metaCache.get(key);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.meta;
  try {
    const meta = await sock.groupMetadata(jid);
    metaCache.set(key, { meta, at: Date.now() });
    if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
    return meta;
  } catch (e) {
    log("[GROUP META]", e.message);
    return null;
  }
}

async function groupGuard(sock, msg, jid, needBotAdmin = true) {
  if (!jid.endsWith("@g.us")) {
    await sock.sendMessage(jid, { text: "👥 Este comando solo funciona en grupos." });
    return null;
  }
  const meta = await getMeta(sock, jid, true);
  if (!meta) {
    await sock.sendMessage(jid, { text: "❌ No pude leer la información del grupo." });
    return null;
  }
  if (!msg.key.fromMe && !isAdminIn(meta, senderIds(msg))) {
    await sock.sendMessage(jid, { text: "⛔ Solo los administradores pueden usar este comando." });
    return null;
  }
  if (needBotAdmin && !isAdminIn(meta, botIds(sock))) {
    await sock.sendMessage(jid, { text: "⚠️ Necesito ser administrador del grupo para hacer esto." });
    return null;
  }
  return meta;
}

// ======================================================
// AJUSTES POR GRUPO (se guardan en DATA_DIR/groups.json)
// ======================================================

const SETTINGS_FILE = path.join(DATA_DIR, "groups.json");
let groupSettings = {};
try { groupSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (_) {}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings)); }
  catch (e) { log("[SETTINGS]", e.message); }
}
const settingsKey = (sock, jid) => norm(sock.user?.id) + ":" + jid;

const ANTI_LABELS = {
  antilink: "enlaces",
  antispam: "spam",
  antisticker: "stickers",
  antifotos: "fotos",
  antivideos: "videos",
  antiaudios: "audios"
};

async function handleAntiToggle(sock, msg, jid, cmd, arg) {
  const meta = await groupGuard(sock, msg, jid, false);
  if (!meta) return;
  const value = arg.toLowerCase();
  if (!["on", "off"].includes(value)) {
    await sock.sendMessage(jid, { text: `Uso: .${cmd} on  |  .${cmd} off` });
    return;
  }
  const key = settingsKey(sock, jid);
  groupSettings[key] = groupSettings[key] || {};
  groupSettings[key][cmd] = value === "on";
  saveSettings();
  let text = `${value === "on" ? "✅" : "🚫"} ${cmd} ${value === "on" ? "activado" : "desactivado"}.`;
  if (value === "on" && !isAdminIn(meta, botIds(sock))) {
    text += "\n⚠️ Para borrar mensajes necesito ser administrador del grupo.";
  }
  await sock.sendMessage(jid, { text });
}

const spamLog = new Map();
function isSpam(key) {
  const now = Date.now();
  const list = (spamLog.get(key) || []).filter(t => now - t < 8000);
  list.push(now);
  spamLog.set(key, list);
  if (spamLog.size > 5000) spamLog.delete(spamLog.keys().next().value);
  return list.length > 6;
}

// Devuelve true si el mensaje fue borrado.
async function antiChecks(sock, msg, jid) {
  const st = groupSettings[settingsKey(sock, jid)];
  if (!st || !Object.keys(ANTI_LABELS).some(k => st[k])) return false;
  if (msg.key.fromMe) return false;

  const content = unwrapMessage(msg.message);
  const text = extractText(msg.message);
  const who = msg.key.participant;
  let reason = null;

  if (st.antilink && /(https?:\/\/|www\.|chat\.whatsapp\.com\/)\S+/i.test(text)) reason = ANTI_LABELS.antilink;
  else if (st.antisticker && content.stickerMessage) reason = ANTI_LABELS.antisticker;
  else if (st.antifotos && content.imageMessage) reason = ANTI_LABELS.antifotos;
  else if (st.antivideos && content.videoMessage) reason = ANTI_LABELS.antivideos;
  else if (st.antiaudios && content.audioMessage) reason = ANTI_LABELS.antiaudios;
  else if (st.antispam && who && isSpam(jid + ":" + who)) reason = ANTI_LABELS.antispam;

  if (!reason) return false;

  const meta = await getMeta(sock, jid);
  if (isAdminIn(meta, senderIds(msg))) return false;      // los admins quedan libres
  if (!isAdminIn(meta, botIds(sock))) return false;       // sin admin no se puede borrar

  try {
    await sock.sendMessage(jid, { delete: msg.key });
    await sock.sendMessage(jid, {
      text: `⚠️ @${norm(who)}, no se permiten ${reason} en este grupo.`,
      mentions: [who]
    });
  } catch (e) {
    log("[ANTI]", e.message);
  }
  return true;
}

// ======================================================
// COMANDOS DE GRUPO
// ======================================================

async function handleOpenClose(sock, msg, jid, open) {
  const meta = await groupGuard(sock, msg, jid, true);
  if (!meta) return;
  try {
    await sock.groupSettingUpdate(jid, open ? "not_announcement" : "announcement");
    await sock.sendMessage(jid, {
      text: open ? "🔓 Grupo abierto: todos pueden escribir." : "🔒 Grupo cerrado: solo los admins pueden escribir."
    });
  } catch (e) {
    await sock.sendMessage(jid, { text: "❌ No se pudo cambiar el grupo: " + e.message });
  }
}

function memberJids(meta, sock) {
  const me = new Set(botIds(sock).filter(Boolean).map(norm));
  return (meta.participants || [])
    .filter(p => !idsOf(p).some(x => me.has(x)))
    .map(p => p.id);
}

async function handleInvoke(sock, msg, jid, args) {
  const meta = await groupGuard(sock, msg, jid, false);
  if (!meta) return;
  const members = memberJids(meta, sock);
  const list = members.map(j => `• @${norm(j)}`).join("\n");
  await sock.sendMessage(jid, {
    text: `📣 *INVOCACIÓN*${args ? "\n" + args : ""}\n\n${list}`,
    mentions: members
  });
}

async function handleTag(sock, msg, jid, args) {
  const meta = await groupGuard(sock, msg, jid, false);
  if (!meta) return;
  const quoted = findContextInfo(msg.message)?.quotedMessage;
  const text = args || (quoted ? extractText(quoted) : "") || "🔔";
  await sock.sendMessage(jid, { text, mentions: memberJids(meta, sock) });
}

async function handleRaffle(sock, msg, jid, args) {
  const meta = await groupGuard(sock, msg, jid, false);
  if (!meta) return;
  const members = memberJids(meta, sock);
  if (!members.length) return;
  const winner = pick(members);
  await sock.sendMessage(jid, {
    text: `🎉 *SORTEO*${args ? "\n🎁 Premio: " + args : ""}\n\n🏆 Ganador: @${norm(winner)}`,
    mentions: [winner]
  });
}

// ======================================================
// TEXTOS
// ======================================================

async function handleTextStyle(sock, jid, cmd, text) {
  if (!text) {
    await sock.sendMessage(jid, { text: `Uso: .${cmd} tu texto` });
    return;
  }
  const out = {
    negrita: t => `*${t}*`,
    cursiva: t => `_${t}_`,
    tachado: t => `~${t}~`,
    subrayada: t => [...t].map(c => (c === " " ? c : c + "̲")).join("")
  }[cmd](text.slice(0, 1000));
  await sock.sendMessage(jid, { text: out });
}

// ======================================================
// JUEGOS
// ======================================================

const HANG_WORDS = [
  "computadora", "telefono", "mariposa", "elefante", "guitarra", "chocolate",
  "montana", "bicicleta", "universo", "aventura", "dinosaurio", "cocodrilo",
  "refrigerador", "escuela", "pelicula", "estrella", "tormenta", "helado",
  "volcan", "planeta", "pirata", "fantasma", "tesoro", "castillo", "dragon",
  "musica", "futbol", "playa", "ventana", "cohete"
];
const hangGames = new Map();

function hangView(g) {
  const shown = [...g.word].map(c => (g.guessed.has(c) ? c : "_")).join(" ");
  return (
    `🎯 *AHORCADO*\n\n${shown.toUpperCase()}\n\n` +
    `${"❤️".repeat(g.lives)}${"🖤".repeat(6 - g.lives)}\n` +
    `Letras usadas: ${[...g.guessed].join(", ") || "-"}\n\n` +
    "Responde con *.ahorcado letra* o *.ahorcado palabra*"
  );
}

async function handleHangman(sock, jid, arg) {
  let g = hangGames.get(jid);
  const guess = stripAccents(arg.toLowerCase().trim());

  if (guess === "salir" && g) {
    hangGames.delete(jid);
    await sock.sendMessage(jid, { text: `🏳️ Juego terminado. La palabra era: *${g.word.toUpperCase()}*` });
    return;
  }
  if (!g) {
    g = { word: pick(HANG_WORDS), guessed: new Set(), lives: 6 };
    hangGames.set(jid, g);
    if (hangGames.size > 500) hangGames.delete(hangGames.keys().next().value);
    await sock.sendMessage(jid, { text: hangView(g) });
    return;
  }
  if (!guess) {
    await sock.sendMessage(jid, { text: hangView(g) });
    return;
  }

  if (guess.length === 1) {
    if (!/[a-zñ]/.test(guess)) return;
    if (g.guessed.has(guess)) {
      await sock.sendMessage(jid, { text: "Esa letra ya la usaste.\n\n" + hangView(g) });
      return;
    }
    g.guessed.add(guess);
    if (!g.word.includes(guess)) g.lives--;
  } else if (guess === g.word) {
    [...g.word].forEach(c => g.guessed.add(c));
  } else {
    g.lives--;
  }

  const won = [...g.word].every(c => g.guessed.has(c));
  if (won) {
    hangGames.delete(jid);
    await sock.sendMessage(jid, { text: `🏆 ¡Ganaste! La palabra era *${g.word.toUpperCase()}*` });
  } else if (g.lives <= 0) {
    hangGames.delete(jid);
    await sock.sendMessage(jid, { text: `💀 Perdiste. La palabra era *${g.word.toUpperCase()}*` });
  } else {
    await sock.sendMessage(jid, { text: hangView(g) });
  }
}

const TRUE_FALSE = [
  ["El Sol es una estrella.", true],
  ["La Gran Muralla China se ve a simple vista desde el espacio.", false],
  ["Los murciélagos son ciegos.", false],
  ["El agua hierve a 100 °C al nivel del mar.", true],
  ["Los humanos usan solo el 10% de su cerebro.", false],
  ["Un pulpo tiene tres corazones.", true],
  ["Júpiter es el planeta más grande del sistema solar.", true],
  ["El tomate es botánicamente una fruta.", true],
  ["Un rayo nunca cae dos veces en el mismo lugar.", false],
  ["La capital de Australia es Sídney.", false],
  ["Los delfines son peces.", false],
  ["El fémur es el hueso más largo del cuerpo humano.", true],
  ["La luz viaja más rápido que el sonido.", true],
  ["Las arañas son insectos.", false],
  ["El símbolo químico del oro es Au.", true],
  ["Venus es el planeta más cercano al Sol.", false],
  ["El corazón humano tiene cuatro cavidades.", true],
  ["Los camellos almacenan agua en sus jorobas.", false],
  ["El océano Pacífico es el más grande del mundo.", true],
  ["Un año luz mide tiempo.", false]
];
const tfGames = new Map();

async function handleTrueFalse(sock, jid) {
  const [text, value] = pick(TRUE_FALSE);
  tfGames.set(jid, value);
  if (tfGames.size > 500) tfGames.delete(tfGames.keys().next().value);
  await sock.sendMessage(jid, {
    text: `🧠 *VERDADERO O FALSO*\n\n${text}\n\nResponde con *.v* (verdadero) o *.f* (falso)`
  });
}

async function handleTfAnswer(sock, jid, answer) {
  if (!tfGames.has(jid)) {
    await sock.sendMessage(jid, { text: "No hay pregunta activa. Escribe *.v/f* para empezar." });
    return;
  }
  const correct = tfGames.get(jid) === answer;
  tfGames.delete(jid);
  await sock.sendMessage(jid, {
    text: correct ? "✅ ¡Correcto!" : `❌ Incorrecto. La respuesta era *${answer ? "FALSO" : "VERDADERO"}*.`
  });
}

// ======================================================
// TROOL (bromas con menciones)
// ======================================================

const ACTIONS = {
  abrazar: (a, b) => `🤗 ${a} abrazó a ${b}`,
  bezar: (a, b) => `😘 ${a} le dio un beso a ${b}`,
  besar: (a, b) => `😘 ${a} le dio un beso a ${b}`,
  nalguear: (a, b) => `😳 ${a} le dio una nalgada a ${b}`,
  coquetear: (a, b) => `😏 ${a} está coqueteando con ${b}`,
  jugar: (a, b) => `🎮 ${a} invitó a ${b} a jugar`,
  golpear: (a, b) => `👊 ${a} golpeó a ${b}`,
  bofetear: (a, b) => `🖐️ ${a} le dio una bofetada a ${b}`
};
const METERS = {
  menso: "menso", burro: "burro", idiota: "idiota", pendejo: "pendejo", pajero: "pajero"
};

function findTarget(msg) {
  const ctx = findContextInfo(msg.message);
  return ctx?.mentionedJid?.[0] || ctx?.participant || null;
}

async function handleTrool(sock, msg, jid, cmd) {
  const me = senderJid(msg, sock, jid);
  const target = findTarget(msg);

  if (ACTIONS[cmd]) {
    if (!target) {
      await sock.sendMessage(jid, { text: `Menciona o responde a alguien.\nEjemplo: .${cmd} @usuario` });
      return;
    }
    await sock.sendMessage(jid, {
      text: ACTIONS[cmd](`@${norm(me)}`, `@${norm(target)}`),
      mentions: [me, target]
    });
    return;
  }

  const who = target || me;
  const pct = Math.floor(Math.random() * 101);
  await sock.sendMessage(jid, {
    text: `🤪 @${norm(who)} es ${pct}% ${METERS[cmd]}`,
    mentions: [who]
  });
}

// ======================================================
// MENU (formato Luno Bot, con "reenviado de canal")
// ======================================================

function getMenu() {
  const fecha = new Date().toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric"
  });
  const cmds = list => list.map(c => `> *${c}*`).join("\n");
  const sections = [
    ["DESCARGAS", [".play", ".ytmp4", ".fb", ".ig", ".tiktok"]],
    ["STICKERS", [".s", ".toimg", ".tag"]],
    ["TEXTOS", [".negrita", ".cursiva", ".tachado", ".subrayada"]],
    ["JUEGOS", [".ahorcado", ".v/f"]],
    ["GRUPOS", [".abrir", ".cerrar", ".invocar", ".sorteo", ".antilink", ".antispam",
                ".antisticker", ".antifotos", ".antivideos", ".antiaudios"]],
    ["TROOL", [".abrazar", ".bezar", ".nalguear", ".coquetear", ".jugar", ".golpear",
               ".bofetear", ".menso", ".burro", ".pendejo", ".idiota", ".pajero"]],
    ["UTILIDADES", [".toaudio", ".qr", ".ping", ".uptime", ".runtime", ".info"]]
  ];

  const out = [`*_${BOT_NAME} ${BOT_VERSION}_* ☪️`, " "];
  if (YOUTUBE_LINK) out.push(`*_Youtube_* \`${YOUTUBE_LINK}\``, "");
  out.push(`_*Fecha*_ \`${fecha}\``, "");
  for (const [title, list] of sections) {
    out.push(`_🌙 ${title}_`, "", cmds(list), "");
  }
  out.push(`\`©️ ${BOT_FOOTER}\``);
  return out.join("\n");
}

function channelContext() {
  if (!CHANNEL_JID) return undefined;
  return {
    isForwarded: true,
    forwardingScore: 999,
    forwardedNewsletterMessageInfo: {
      newsletterJid: CHANNEL_JID,
      newsletterName: CHANNEL_NAME,
      serverMessageId: 100
    }
  };
}

async function sendMenu(sock, jid) {
  const caption = getMenu();
  const contextInfo = channelContext();
  const image = MENU_IMAGE_FILE ? { url: MENU_IMAGE_FILE }
    : MENU_IMAGE_URL ? { url: MENU_IMAGE_URL } : null;
  try {
    if (image) await sock.sendMessage(jid, { image, caption, contextInfo });
    else await sock.sendMessage(jid, { text: caption, contextInfo });
  } catch (e) {
    log("[MENU]", e.message);
    await sock.sendMessage(jid, { text: caption });
  }
}

// ======================================================
// MANEJADOR PRINCIPAL (uno por cuenta vinculada)
// ======================================================

const seenBySocket = new WeakMap();
const lastCommandAt = new Map();
const pendingJobs = new Set();
const COOLDOWN_MS = 1500;
const NOT_AVAILABLE = new Set([
  "tiktoksearch", "google", "ia", "deepseek", "chatgpt"
]);

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

  // Moderación del grupo (antilink, antispam, etc.).
  if (jid.endsWith("@g.us")) {
    try { if (await antiChecks(sock, msg, jid)) return; }
    catch (e) { log("[ANTI ERROR]", e.message); }
  }

  const trimmed = extractText(msg.message).trim();
  if (!trimmed) return;

  const m = trimmed.match(/^[!.\/]([^\s]+)(?:\s+([\s\S]*))?$/);
  const cmd = m ? m[1].toLowerCase() : (trimmed.toLowerCase() === "hola" ? "hola" : null);
  const args = m ? (m[2] || "").trim() : "";
  if (!cmd) return;

  const now = Date.now();
  if (now - (lastCommandAt.get(jid) || 0) < COOLDOWN_MS) return;
  lastCommandAt.set(jid, now);
  if (lastCommandAt.size > 2000) lastCommandAt.delete(lastCommandAt.keys().next().value);

  switch (true) {
    // Stickers y multimedia
    case cmd === "s" || cmd === "sticker":
      return heavy(sock, jid, () => handleSticker(sock, jid, msg.message));
    case cmd === "toimg":
      return heavy(sock, jid, () => handleToImage(sock, jid, msg.message));
    case cmd === "toaudio":
      return heavy(sock, jid, () => handleToAudio(sock, jid, msg.message));
    case cmd === "qr":
      return handleQR(sock, jid, args.slice(0, 1000));

    // Descargas
    case cmd === "play": {
      if (!args) {
        return void await sock.sendMessage(jid, {
          text: "🎵 Uso:\n.play nombre de canción\n.play enlace de YouTube"
        });
      }
      return heavy(sock, jid, () =>
        downloadAndSend(sock, jid, args.slice(0, 300), "audio", "play"));
    }
    case ["ytmp4", "fb", "ig", "tiktok"].includes(cmd): {
      const source = { ytmp4: "ytmp4", fb: "facebook", ig: "instagram", tiktok: "tiktok" }[cmd];
      const url = args.split(/\s+/)[0];
      if (!/^https?:\/\/\S+$/i.test(url)) {
        return void await sock.sendMessage(jid, { text: `📥 Uso: .${cmd} enlace` });
      }
      return heavy(sock, jid, () => downloadAndSend(sock, jid, url, "video", source));
    }

    // Textos
    case ["negrita", "cursiva", "tachado", "subrayada"].includes(cmd):
      return handleTextStyle(sock, jid, cmd, args);

    // Juegos
    case cmd === "ahorcado":
      return handleHangman(sock, jid, args);
    case cmd === "v/f" || cmd === "vf":
      return handleTrueFalse(sock, jid);
    case cmd === "v":
      return handleTfAnswer(sock, jid, true);
    case cmd === "f":
      return handleTfAnswer(sock, jid, false);

    // Grupos
    case cmd === "abrir":
      return handleOpenClose(sock, msg, jid, true);
    case cmd === "cerrar":
      return handleOpenClose(sock, msg, jid, false);
    case cmd === "invocar":
      return handleInvoke(sock, msg, jid, args);
    case cmd === "tag":
      return handleTag(sock, msg, jid, args);
    case cmd === "sorteo":
      return handleRaffle(sock, msg, jid, args);
    case Object.prototype.hasOwnProperty.call(ANTI_LABELS, cmd):
      return handleAntiToggle(sock, msg, jid, cmd, args);

    // Trool
    case Object.prototype.hasOwnProperty.call(ACTIONS, cmd) ||
         Object.prototype.hasOwnProperty.call(METERS, cmd):
      return handleTrool(sock, msg, jid, cmd);

    // Generales
    case cmd === "hola":
      return void await sock.sendMessage(jid, { text: `🔥 ${BOT_NAME} BOT ACTIVO\n\nBienvenido.` });
    case cmd === "menu" || cmd === "help" || cmd === "comandos":
      return sendMenu(sock, jid);
    case cmd === "ping":
      return void await sock.sendMessage(jid, { text: `🏓 PONG!\n🔥 ${BOT_NAME} ACTIVO` });
    case cmd === "info":
      return void await sock.sendMessage(jid, {
        text: `🔥 ${BOT_NAME} ${BOT_VERSION}\nMotor: Baileys\nProcesamiento: FFmpeg\nSistema: Activo`
      });
    case cmd === "uptime":
      return void await sock.sendMessage(jid, {
        text: `⏱️ Bot activo durante:\n${formatDuration((Date.now() - startedAt) / 1000)}`
      });
    case cmd === "runtime":
      return showRuntime(sock, jid);

    case NOT_AVAILABLE.has(cmd):
      return void await sock.sendMessage(jid, { text: "🚧 Este comando todavía no está disponible." });
  }
}

module.exports = { handleMessage, getMenu };
