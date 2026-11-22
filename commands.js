// ======================================================
// DEXTER MODZ - COMANDOS (VERSIÓN LITE, SIN yt-dlp)
// Multimedia con ffmpeg-static: no requiere Docker.
// ======================================================

const { spawn, spawnSync } = require("child_process");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
let sendInteractiveButtons = null;
try { sendInteractiveButtons = require("baileys_helper").sendButtons; } catch (_) {}
const fs = require("fs");
const os = require("os");
const path = require("path");

let QRCode = null;
try { QRCode = require("qrcode"); } catch (_) {}

let xvideosClient = null;
try { xvideosClient = require("@rodrigogs/xvideos"); } catch (_) {}

let pornhubClient = null;
try {
  const { PornHub } = require("pornhub.js");
  if (typeof PornHub === "function") pornhubClient = new PornHub();
} catch (e) {
  // La búsqueda de Pornhub queda desactivada si la dependencia no se instala.
}

// ffmpeg: usa el del sistema si existe (Termux, VPS); si no, el de ffmpeg-static (Render).
let FFMPEG = "ffmpeg";
try {
  const sys = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10000 });
  if (sys.status !== 0) FFMPEG = require("ffmpeg-static") || "ffmpeg";
} catch (_) {
  try { FFMPEG = require("ffmpeg-static") || "ffmpeg"; } catch (_) {}
}

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
    message.buttonsResponseMessage?.selectedButtonId ||
    message.templateButtonReplyMessage?.selectedId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
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
      if (timer) clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    };

    // timeoutMs <= 0 desactiva el temporizador (descargas sin límite artificial).
    const timer = Number(timeoutMs) > 0 ? setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Tiempo de espera agotado."));
    }, timeoutMs) : null;

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
// CATALOGO NSFW: ImgPile (archivos) + GitHub (indice JSON)
// Solo añadir desde el propietario; consulta aleatoria pública.
// ======================================================

const NSFW_CATEGORIES = {
  tetas: { label: "Tetas", file: "tetas.json" },
  culos: { label: "Culos", file: "culos.json" }
};
const NSFW_INDEX_DIR = "nsfw";
const GITHUB_API = "https://api.github.com";

function nsfwConfig() {
  const required = ["IMGPILE_API_KEY", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
  const missing = required.filter(k => !String(process.env[k] || "").trim());
  if (missing.length) throw new Error("Faltan variables de Render: " + missing.join(", "));
  return {
    imgpileKey: process.env.IMGPILE_API_KEY.trim(),
    githubToken: process.env.GITHUB_TOKEN.trim(),
    owner: process.env.GITHUB_OWNER.trim(),
    repo: process.env.GITHUB_REPO.trim(),
    branch: (process.env.GITHUB_BRANCH || "main").trim()
  };
}

function githubContentUrl(cfg, filePath) {
  const safePath = filePath.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${safePath}?ref=${encodeURIComponent(cfg.branch)}`;
}

async function githubRequest(url, cfg, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${cfg.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const detail = data.message || raw || `HTTP ${response.status}`;
    throw new Error(`GitHub ${response.status}: ${String(detail).slice(0, 220)}`);
  }
  return data;
}

async function readNsfwIndex(category) {
  const cfg = nsfwConfig();
  const definition = NSFW_CATEGORIES[category];
  const filePath = `${NSFW_INDEX_DIR}/${definition.file}`;
  const response = await fetch(githubContentUrl(cfg, filePath), {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${cfg.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (response.status === 404) return { cfg, filePath, sha: null, items: [] };
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error("GitHub devolvió una respuesta JSON inválida."); }
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data.message || raw}`);
  if (!data.content) throw new Error("El índice de GitHub no contiene datos legibles.");
  const decoded = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  const parsed = JSON.parse(decoded);
  return { cfg, filePath, sha: data.sha, items: Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []) };
}

async function writeNsfwIndex(index, items, category) {
  const payload = {
    message: `DEXTER MODZ: agregar imagen a ${category}`,
    content: Buffer.from(JSON.stringify(items, null, 2), "utf8").toString("base64"),
    branch: index.cfg.branch
  };
  if (index.sha) payload.sha = index.sha;
  await githubRequest(githubContentUrl(index.cfg, index.filePath), index.cfg, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function uploadToImgPile(buffer, mimetype, filename, cfg) {
  const endpoint = new URL("https://imgpile.com/uploads");
  endpoint.searchParams.set("filename", filename);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.imgpileKey}`,
      "Content-Type": mimetype || "application/octet-stream"
    },
    body: buffer
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = {}; }
  if (!response.ok) {
    throw new Error(`ImgPile ${response.status}: ${data.message || data.error || raw || "No se pudo subir la imagen."}`);
  }
  const media = data.data || data.media || data;
  const url = media.urls?.original || media.url || data.url;
  if (!url || !/^https:\/\//i.test(url)) throw new Error("ImgPile no devolvió una URL directa válida.");
  return { url, pageUrl: media.pageUrl || media.page_url || "", slug: media.slug || "" };
}

async function handleNsfwAdd(sock, msg, jid, category) {
  if (!isOwner(msg, jid, sock)) {
    await sock.sendMessage(jid, { text: "⛔ Este comando solo puede usarlo el propietario del bot." });
    return;
  }
  const target = getMediaTarget(msg.message);
  if (!target || target.kind !== "image" || !String(target.mimetype || "").startsWith("image/")) {
    await sock.sendMessage(jid, {
      text: `🖼️ Responde a una *imagen* con .add${category} para guardarla.

⚠️ Solo imágenes de personas adultas y compartidas con consentimiento explícito. No subas contenido íntimo de terceros sin permiso.`
    });
    return;
  }

  let uploaded = null;
  try {
    await sock.sendMessage(jid, { text: `⏳ Subiendo imagen a ImgPile y registrándola en GitHub...` });
    const index = await readNsfwIndex(category);
    const buffer = await downloadMediaBuffer(target);
    const ext = extensionFromMime(target.mimetype, ".jpg").replace(/^\./, "");
    const number = index.items.length + 1;
    const logicalName = `${NSFW_CATEGORIES[category].label}${number}.${ext}`;
    uploaded = await uploadToImgPile(buffer, target.mimetype, logicalName, index.cfg);
    const item = {
      name: logicalName,
      url: uploaded.url,
      pageUrl: uploaded.pageUrl || null,
      slug: uploaded.slug || null,
      uploadedAt: new Date().toISOString()
    };
    index.items.push(item);
    await writeNsfwIndex(index, index.items, category);
    await sock.sendMessage(jid, {
      text: `✅ *IMAGEN REGISTRADA*

📁 Categoría: ${NSFW_CATEGORIES[category].label}
🏷️ Nombre: ${logicalName}
🔢 Total: ${index.items.length}
☁️ ImgPile + GitHub sincronizados.`
    });
  } catch (error) {
    log(`[NSFW ${category}]`, error.message);
    const suffix = uploaded?.url ? `

La imagen sí se subió a ImgPile, pero no se pudo guardar en GitHub:
${uploaded.url}` : "";
    await sock.sendMessage(jid, { text: `❌ No se pudo registrar la imagen.
${String(error.message || error).slice(0, 450)}${suffix}` });
  }
}

async function handleNsfwRandom(sock, jid, category) {
  try {
    const index = await readNsfwIndex(category);
    if (!index.items.length) {
      await sock.sendMessage(jid, { text: `📂 Todavía no hay imágenes en la categoría *${NSFW_CATEGORIES[category].label}*. ` });
      return;
    }
    const item = index.items[Math.floor(Math.random() * index.items.length)];
    if (!item?.url || !/^https:\/\//i.test(item.url)) throw new Error("El registro seleccionado no tiene una URL válida.");
    const commandCaption = category === "tetas" ? ".tetas" : ".culos";
    await sock.sendMessage(jid, {
      image: { url: item.url },
      caption: `☪️ *Luno Supremacy* ☪️

` +
        `\`Liko 🤤 vrd usa el comando ${commandCaption} para ver mas\`

` +
        `👤 By Dxx Modz`
    });
  } catch (error) {
    log(`[NSFW RANDOM ${category}]`, error.message);
    await sock.sendMessage(jid, { text: `❌ No pude obtener una imagen de ${category}.
${String(error.message || error).slice(0, 350)}` });
  }
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
      text: `⏳ Creando sticker ${BOT_NAME}...`
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
      packname: "Luno Supremacy",
      author: "Dxx Modz"
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
      caption: `🔥 ${BOT_NAME}`
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
      caption: `🔥 ${BOT_NAME} - QR`
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

const BOT_NAME = process.env.BOT_NAME || "Luno Supremacy";
// Reacción a cada comando. Cambia el emoji con REACT_EMOJI, o desactívala con "off".
const REACT_RAW = (process.env.REACT_EMOJI || "🌙").trim();
const REACT_EMOJI = /^(off|none|no|0)$/i.test(REACT_RAW) ? "" : REACT_RAW;
const BOT_VERSION = process.env.BOT_VERSION || "v.1.0.0";
const BOT_FOOTER = process.env.BOT_FOOTER || "by Dxx Modz";
const YOUTUBE_LINK = process.env.YOUTUBE_LINK || "";
const CHANNEL_JID = process.env.CHANNEL_JID || "";          // Opcional: 120363...@newsletter
const CHANNEL_INVITE_URL = process.env.CHANNEL_INVITE_URL || "https://whatsapp.com/channel/0029Vb7jQB43mFY68g0CEA1U";
const CHANNEL_POST_ID = Number(process.env.CHANNEL_POST_ID || 1957);
const CHANNEL_NAME = "Dxx Modz";
let resolvedChannelMetadata = null;
let channelMetadataPromise = null;
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

// Las descargas no tienen límite artificial de duración ni de tiempo.
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
  "redd.it",
  "xvideos.com",
  "pornhub.com",
  "erome.com"
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


// Tarjeta con la información del contenido, antes de empezar a descargar.
async function sendInfoCard(sock, jid, info, mode, sourceCommand, url) {
  const title = String(info.title || "Sin título").replace(/\s+/g, " ").slice(0, 100);
  const channel = String(info.channel || info.uploader || "").slice(0, 60);
  const link = info.webpage_url || (/^https?:\/\//i.test(url) ? url : "");
  const lines = [
    `🔥 *${BOT_NAME}*`,
    "",
    `${mode === "audio" ? "🎵" : "🎬"} *Título:* ${title}`
  ];
  if (channel) lines.push(`👤 *Canal:* ${channel}`);
  lines.push(
    `⏱️ *Duración:* ${formatVideoDuration(info.duration)}`,
    `🌐 *Sitio:* ${getSourceLabel(sourceCommand, url)}`
  );
  if (link) lines.push(`🔗 ${link}`);
  lines.push("", `⏳ Descargando ${mode === "audio" ? "audio" : "video"}... espera un momento.`);
  const caption = lines.join("\n");

  const thumb = typeof info.thumbnail === "string" && /^https:\/\//i.test(info.thumbnail)
    ? info.thumbnail
    : null;
  if (thumb) {
    try {
      await sock.sendMessage(jid, { image: { url: thumb }, caption });
      return;
    } catch (e) {
      log("[INFO CARD] Sin miniatura:", e.message);
    }
  }
  await sock.sendMessage(jid, { text: caption });
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

    let notified = false;
    const sendGeneric = async () => {
      if (notified) return;
      notified = true;
      await sock.sendMessage(jid, {
        text:
          "╔════════════════════╗\n" +
          "       " + BOT_NAME + "\n" +
          "╚════════════════════╝\n\n" +
          "⏳ Procesando descarga...\n" +
          `📁 Tipo: ${mode.toUpperCase()}\n` +
          `🌐 Sitio: ${sourceCommand.toUpperCase()}\n\n` +
          "Espera un momento."
      });
    };

    let videoInfo = null;
    let downloadedPath = null;

    // 1) API de terceros (si está configurada)
    if (DL_API_URL || DL_YT_API_URL) {
      await sendGeneric();
      try {
        let target = url;
        if (sourceCommand === "play" && !playIsUrl) {
          target = await searchYoutubeUrl(url);
          if (!target) throw new Error("no se pudo buscar por nombre desde el servidor");
        }
        const r = await downloadViaApi(target, mode, jobDir);
        downloadedPath = r.path;
        videoInfo = { title: r.title || undefined, duration: r.duration };
        log("[API] Descarga lista:", sourceCommand, mode);
      } catch (e) {
        log("[API] Falló:", e.message);
      }
    }

    // 2) yt-dlp (si no hubo API o falló)
    if (!downloadedPath) {
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

    // Cookies: variable de entorno COOKIES_TXT (recomendado) o archivo cookies.txt.
    const envCookies = path.join(os.tmpdir(), "dexter-bin", "cookies.txt");
    if (process.env.COOKIES_TXT) {
      try {
        fs.mkdirSync(path.dirname(envCookies), { recursive: true });
        fs.writeFileSync(envCookies, normalizeCookies(process.env.COOKIES_TXT), { mode: 0o600 });
      } catch (e) { log("[COOKIES]", e.message); }
    }
    const cookieFile = [
      process.env.COOKIES_TXT ? envCookies : null,
      path.join(DATA_DIR, "cookies.txt"),
      path.join(__dirname, "cookies.txt")
    ].filter(Boolean).find(p => fs.existsSync(p));
    if (cookieFile) {
      args.push("--cookies", cookieFile);
      log("[YTDLP] Cookies activadas.");
    }

    // Sin topes artificiales de duración, tamaño o tipo de transmisión.
    // El archivo se guarda temporalmente y se elimina en el finally de esta tarea.
    if (path.isAbsolute(FFMPEG)) args.push("--ffmpeg-location", FFMPEG);
    // yt-dlp reciente necesita un motor de JavaScript para YouTube; se usa Node.
    if (YTDLP_BIN === YTDLP_LOCAL) args.push("--js-runtimes", "node");

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

    // Búsqueda por nombre: primero se intenta la página de resultados de YouTube
    // (suele bloquearse menos que la API interna que usa yt-dlp para buscar).
    let searchTarget = null;
    if (sourceCommand === "play" && !playIsUrl) {
      try { searchTarget = await searchYoutubeUrl(url); }
      catch (e) { log("[BUSQUEDA]", e.message); }
    }
    const input = searchTarget || (sourceCommand === "play" && !playIsUrl
      ? `ytsearch1:${url}`
      : url);
    args.push(input);

    // Información del contenido (título, canal, duración, miniatura) antes de descargar.
    try {
      const infoArgs = ["--no-warnings", "--no-playlist", "--skip-download", "--dump-single-json"];
      if (cookieFile) infoArgs.push("--cookies", cookieFile);
      if (YTDLP_BIN === YTDLP_LOCAL) infoArgs.push("--js-runtimes", "node");
      infoArgs.push(input);
      const infoRes = await runProcess(getYtDlpCommand(), infoArgs, 60000);
      let info = JSON.parse(infoRes.stdout.trim());
      if (Array.isArray(info.entries)) info = info.entries[0] || {};
      if (info && (info.title || info.duration)) {
        videoInfo = info;
        if (!notified) {
          notified = true;
          await sendInfoCard(sock, jid, info, mode, sourceCommand, url);
        }
      }
    } catch (e) {
      const em = String(e.message || e).toLowerCase();
      log("[YTDLP INFO]", e.message);
      // Errores que se repetirían al descargar: se avisa de una vez.
      if (/sign in|not a bot|http error (403|429)|private video|unavailable|has been removed|login required|no está instalado|transmisión en vivo/.test(em)) {
        throw e;
      }
    }
    await sendGeneric();

    log("[YTDLP] Descargando:", sourceCommand, mode, playIsUrl ? "URL" : "BÚSQUEDA");

    const result = await runProcess(
      getYtDlpCommand(),
      args,
      0 // Sin límite artificial de tiempo para la descarga.
    );

    const lines = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    downloadedPath = lines[lines.length - 1];
    }

    if (!downloadedPath || !fs.existsSync(downloadedPath)) {
      throw new Error("No se generó el archivo de descarga. El sitio pudo bloquearla o no entregar un formato compatible.");
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
        caption: `🔥 ${BOT_NAME}\n\n🎬 Nombre: ${videoInfo?.title || path.basename(savedPath, extension)}\n⏱️ Duración: ${formatVideoDuration(videoInfo?.duration)}\n📥 Proveniente: ${getSourceLabel(sourceCommand, url)}\n\n👤 by Dxx Modz Sk`
      });
    } else {
      await sock.sendMessage(jid, {
        document: { url: savedPath },
        mimetype: mimeTypes[extension] || "application/octet-stream",
        fileName: path.basename(savedPath),
        caption: mode === "video" ? `🔥 ${BOT_NAME}\n\n🎬 Nombre: ${videoInfo?.title || path.basename(savedPath, extension)}\n⏱️ Duración: ${formatVideoDuration(videoInfo?.duration)}\n📥 Proveniente: ${getSourceLabel(sourceCommand, url)}\n\n👤 by Dxx Modz Sk` : `🔥 ${BOT_NAME}`
      });
    }

    log("[DESCARGA] Enviado:", sourceCommand, mode, formatBytes(stats.size));

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
    } else if (lower.includes("http error 403") || lower.includes("403: forbidden")) {
      response =
        "⚠️ YouTube bloqueó la búsqueda desde el servidor.\n\n" +
        "Prueba con el enlace del video:\n.play https://youtu.be/...";
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




// Acepta cookies en formato Netscape o en JSON (Cookie-Editor) y devuelve Netscape.
function normalizeCookies(raw) {
  const text = String(raw || "").trim();
  if (!/^[\[{]/.test(text)) {
    // Netscape: si al pegar las tabulaciones se volvieron espacios, se reparan.
    const fixed = text.replace(/\\n/g, "\n").split(/\r?\n/).map(line => {
      const l = line.trim();
      if (!l) return "";
      if (l.startsWith("#") && !l.startsWith("#HttpOnly_")) return l;
      if (l.includes("\t")) return l;
      const t = l.split(/\s+/);
      return t.length >= 7 ? t.slice(0, 6).join("\t") + "\t" + t.slice(6).join(" ") : l;
    });
    return "# Netscape HTTP Cookie File\n" + fixed.filter(Boolean).join("\n") + "\n";
  }
  let list;
  try { list = JSON.parse(text); } catch (_) { return text; }
  if (!Array.isArray(list)) list = list.cookies || [];
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of list) {
    if (!c || !c.name || !c.domain) continue;
    const domain = (c.httpOnly ? "#HttpOnly_" : "") + c.domain;
    const sub = String(c.domain).startsWith(".") ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([domain, sub, c.path || "/", c.secure ? "TRUE" : "FALSE", expiry, c.name, c.value ?? ""].join("\t"));
  }
  return lines.join("\n") + "\n";
}

// ======================================================
// DESCARGAS VIA API DE TERCEROS (opcional, para evitar el bloqueo de YouTube)
// Variables de entorno:
//   DL_API_URL      URL de la API con {url} (o {id} para el ID de YouTube)
//   DL_YT_API_URL   (opcional) endpoint distinto solo para YouTube
//   DL_API_KEY      clave de RapidAPI (cabeceras x-rapidapi-* automáticas)
//   DL_API_HEADERS  (opcional) cabeceras extra en JSON
//   DL_API_METHOD   GET (por defecto) o POST
//   DL_API_BODY     (opcional, POST) cuerpo JSON con {url} o {id}
// ======================================================

const DL_API_URL = process.env.DL_API_URL || "";
const DL_YT_API_URL = process.env.DL_YT_API_URL || "";   // opcional: endpoint solo para YouTube
const DL_API_KEY = process.env.DL_API_KEY || "";
const DL_API_METHOD = (process.env.DL_API_METHOD || "GET").toUpperCase();
const DL_API_BODY = process.env.DL_API_BODY || "";
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36";

function youtubeId(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12);
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : "";
  } catch (_) { return ""; }
}

function fillTemplate(template, url, asJson = false) {
  const enc = asJson ? v => JSON.stringify(v).slice(1, -1) : encodeURIComponent;
  return template.replace(/\{url\}/g, enc(url)).replace(/\{id\}/g, enc(youtubeId(url)));
}

function apiHeaders(template) {
  const h = { Accept: "application/json", "User-Agent": BROWSER_UA };
  try {
    const host = new URL(fillTemplate(template, "x")).hostname;
    if (DL_API_KEY && /rapidapi\.com$/i.test(host)) {
      h["x-rapidapi-key"] = DL_API_KEY;
      h["x-rapidapi-host"] = host;
    }
  } catch (_) {}
  if (process.env.DL_API_HEADERS) {
    try { Object.assign(h, JSON.parse(process.env.DL_API_HEADERS)); }
    catch (_) { log("[API] DL_API_HEADERS no es JSON válido."); }
  }
  return h;
}

function collectUrls(node, key = "", out = []) {
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node)) out.push({ key: key.toLowerCase(), url: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => collectUrls(v, key + "." + i, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectUrls(v, key + "." + k, out);
  }
  return out;
}

function pickMediaUrl(json, mode) {
  const bad = /(thumb|cover|image|avatar|poster|preview|icon|logo|author|profile|watermark)/;
  const imgExt = /\.(jpe?g|png|webp|gif)(\?|$)/i;
  let list = collectUrls(json).filter(c => !bad.test(c.key) && !imgExt.test(c.url));
  const audioKey = /(audio|mp3|music|sound)/;
  if (mode === "video") {
    const noAudio = list.filter(c => !audioKey.test(c.key));
    if (noAudio.length) list = noAudio;
  }
  const priorities = mode === "audio"
    ? [/mp3/, /audio/, /music|sound/, /link|download|url|dl/]
    : [/hd/, /nowm|nowatermark|no_watermark/, /video|mp4/, /play|download|dl|link|url/];
  for (const re of priorities) {
    const hit = list.find(c => re.test(c.key));
    if (hit) return hit.url;
  }
  return list[0]?.url || null;
}

function findTitle(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return "";
  for (const [k, v] of Object.entries(node)) {
    if (/^(title|name|caption)$/i.test(k) && typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  for (const v of Object.values(node)) {
    const t = findTitle(v, depth + 1);
    if (t) return t;
  }
  return "";
}

function isPrivateHost(host) {
  if (process.env.DL_ALLOW_PRIVATE) return false;
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(host);
}

async function downloadToFile(fileUrl, dir, mode) {
  const u = new URL(fileUrl);
  if (!["http:", "https:"].includes(u.protocol) || isPrivateHost(u.hostname)) {
    throw new Error("enlace de descarga no permitido");
  }
  const res = await fetch(fileUrl, {
    redirect: "follow",
    headers: { "User-Agent": BROWSER_UA },
  });
  if (!res.ok || !res.body) throw new Error("el archivo respondió HTTP " + res.status);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (/(json|html|text\/)/.test(type)) throw new Error("la API no devolvió un archivo sino una página");

  const ext = /mpeg|mp3/.test(type) ? ".mp3" : /mp4a|m4a|audio\/mp4/.test(type) ? ".m4a"
    : /video\/mp4/.test(type) ? ".mp4" : mode === "audio" ? ".mp3" : ".mp4";
  const filePath = path.join(dir, "api_download" + ext);

  const { Readable } = require("stream");
  const { pipeline } = require("stream/promises");
  let total = 0;
  const counter = new (require("stream").Transform)({
    transform(chunk, _enc, cb) { total += chunk.length; cb(null, chunk); }
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(filePath));
  if (total < 1024) throw new Error("archivo vacío");
  return filePath;
}

async function downloadViaApi(targetUrl, mode, dir) {
  const template = isYoutubeUrl(targetUrl) && DL_YT_API_URL ? DL_YT_API_URL : DL_API_URL;
  const url = fillTemplate(template, targetUrl);
  const options = { method: DL_API_METHOD, headers: apiHeaders(template) };
  if (DL_API_METHOD === "POST") {
    options.headers["Content-Type"] = "application/json";
    options.body = fillTemplate(DL_API_BODY || '{"url":"{url}"}', targetUrl, true);
  }
  const res = await fetch(url, options);
  const raw = await res.text();
  if (!res.ok) throw new Error(`la API respondió HTTP ${res.status}`);
  let json;
  try { json = JSON.parse(raw); } catch (_) { throw new Error("la API no devolvió JSON"); }

  const mediaUrl = pickMediaUrl(json, mode);
  if (!mediaUrl) throw new Error("la API no devolvió un enlace de descarga");
  const filePath = await downloadToFile(mediaUrl, dir, mode);
  const duration = Number(json.duration ?? json.data?.duration ?? json.result?.duration);
  return { path: filePath, title: findTitle(json), duration: Number.isFinite(duration) ? duration : undefined };
}

async function searchYoutubeUrl(query) {
  const res = await fetch(
    "https://www.youtube.com/results?hl=es&search_query=" + encodeURIComponent(query),
    {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "es-MX,es;q=0.9", Cookie: "CONSENT=YES+1" },
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!res.ok) return null;
  const m = (await res.text()).match(/"videoId":"([\w-]{11})"/);
  return m ? "https://www.youtube.com/watch?v=" + m[1] : null;
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
// SUB-BOTS (.code, .qr, .delsesion)
// Los crea el servidor (server.js) y llegan aquí en ctx.subbots.
// ======================================================

// Números del propietario del servidor (opcional): OWNER_NUMBER=5212345678901,5219876543210
function normPhone(n) {
  n = String(n || "").replace(/\D/g, "");
  if (/^521\d{10}$/.test(n)) return "52" + n.slice(3);   // México con "1"
  if (/^549\d{10}$/.test(n)) return "54" + n.slice(3);   // Argentina con "9"
  return n;
}
const OWNER_NUMBERS = new Set(
  (process.env.OWNER_NUMBER || "").split(/[,\s]+/).map(normPhone).filter(Boolean)
);

function jidNumber(j) {
  return /@s\.whatsapp\.net$/.test(String(j || "")) ? norm(j).replace(/\D/g, "") : "";
}

// Número de quien escribió, si WhatsApp lo revela (con LID a veces no se puede).
function senderNumber(msg, jid, sock) {
  const k = msg.key || {};
  if (k.fromMe) return jidNumber(sock.user?.id);
  const candidates = jid.endsWith("@g.us")
    ? [k.participant, k.participantAlt]
    : [k.remoteJid, k.remoteJidAlt];
  for (const c of candidates) {
    const n = jidNumber(c);
    if (n) return n;
  }
  return "";
}

function isServerOwner(msg, jid, sock) {
  const n = normPhone(senderNumber(msg, jid, sock));
  return !!n && OWNER_NUMBERS.has(n);
}
// Dueño de la cuenta (escribe desde su propio teléfono) o dueño del servidor.
function isOwner(msg, jid, sock) {
  return !!msg.key?.fromMe || isServerOwner(msg, jid, sock);
}

async function handleSubCode(sock, msg, jid, args, ctx) {
  if (!ctx.subbots) {
    await sock.sendMessage(jid, { text: "🚧 Los sub-bots no están disponibles aquí." });
    return;
  }
  if (jid.endsWith("@g.us")) {
    await sock.sendMessage(jid, {
      text: "📩 Por seguridad, solicita el código por mensaje privado al bot."
    });
    return;
  }

  const me = senderNumber(msg, jid, sock);
  let phone = args.replace(/\D/g, "");
  if (!phone) phone = me;   // sin número: se usa el de quien escribe

  if (!/^[1-9]\d{9,14}$/.test(phone || "")) {
    await sock.sendMessage(jid, {
      text:
        "📱 Uso: .code 521234567890\n" +
        "Escribe tu número con código de país, sin + ni espacios."
    });
    return;
  }

  // Evita que alguien pida códigos para números ajenos (llegan avisos a esos teléfonos).
  if (!isOwner(msg, jid, sock) && me && normPhone(phone) !== normPhone(me)) {
    await sock.sendMessage(jid, {
      text: `⛔ Solo puedes vincular tu propio número (+${me}).`
    });
    return;
  }

  const r = await ctx.subbots.create({
    mode: "code", phone, sock, jid, requester: me || jid
  });
  await sock.sendMessage(jid, {
    text: r.error || "⏳ Generando tu código de vinculación...\nEspera unos segundos."
  });
}

async function handleSubQr(sock, msg, jid, ctx) {
  if (!ctx.subbots) {
    await sock.sendMessage(jid, { text: "🚧 Los sub-bots no están disponibles aquí." });
    return;
  }
  const r = await ctx.subbots.create({
    mode: "qr", phone: "", sock, jid, requester: senderNumber(msg, jid, sock) || jid
  });
  await sock.sendMessage(jid, {
    text: r.error || "⏳ Preparando el QR del sub-bot...\nEspera a que llegue la imagen."
  });
}

async function handleDelSession(sock, msg, jid, args, ctx) {
  if (!ctx.subbots) {
    await sock.sendMessage(jid, { text: "🚧 Los sub-bots no están disponibles aquí." });
    return;
  }

  const wanted = args.replace(/\D/g, "");
  let target = null;

  if (wanted) {
    // Borrar el sub-bot de otro número: solo el propietario del servidor.
    if (!isServerOwner(msg, jid, sock)) {
      await sock.sendMessage(jid, { text: "⛔ Solo el propietario del servidor puede borrar sesiones de otros números." });
      return;
    }
    target = ctx.subbots.findByPhone(wanted);
  } else if (msg.key?.fromMe) {
    target = ctx.subbots.findBySock(sock);          // dueño de esta cuenta
  } else {
    const me = senderNumber(msg, jid, sock);
    target = me ? ctx.subbots.findByPhone(me) : null; // su propio sub-bot
  }

  if (!target) {
    await sock.sendMessage(jid, { text: "ℹ️ No encontré ningún sub-bot para eliminar." });
    return;
  }

  // Primero se avisa: después de cerrar sesión ya no se puede enviar nada.
  await sock.sendMessage(jid, {
    text: `🗑️ Sub-bot${target.number ? " +" + target.number : ""} eliminado.\n\nPara vincular otro escribe .code`
  });
  await ctx.subbots.remove(target.id);
}


// ======================================================
// COMANDOS LOCALES (sin API externa)
// ======================================================
const warningCounts = new Map();
const eightBall = ["Sí, definitivamente.", "Todo apunta a que sí.", "Puedes contar con ello.", "No cuentes con eso.", "Mejor pregunta más tarde.", "Las señales no son claras.", "Es muy probable.", "Mi respuesta es no."];

function mentionedJids(msg) {
  const ci = findContextInfo(msg.message) || {};
  const mentioned = ci.mentionedJid || [];
  if (mentioned.length) return mentioned;
  const quoted = ci.participant;
  return quoted ? [quoted] : [];
}

async function handleGroupUtility(sock, msg, jid, cmd, args) {
  const meta = await groupGuard(sock, msg, jid, false);
  if (!meta) return;
  const members = memberJids(meta, sock);
  if (cmd === "tagall" || cmd === "hidetag") {
    const text = args || (cmd === "hidetag" ? "📢 Aviso del grupo" : "📢 Atención grupo");
    const body = cmd === "hidetag" ? text : `${text}\n\n${members.map(x => `@${norm(x)}`).join(" ")}`;
    return sock.sendMessage(jid, { text: body, mentions: members });
  }
  if (cmd === "admins") {
    const admins = (meta.participants || []).filter(x => x.admin).map(x => x.id);
    return sock.sendMessage(jid, { text: `👑 *ADMINISTRADORES*\n\n${admins.map(x => `• @${norm(x)}`).join("\n") || "Sin administradores detectados"}`, mentions: admins });
  }
  if (cmd === "infogrupo") {
    const admins = (meta.participants || []).filter(x => x.admin).length;
    return sock.sendMessage(jid, { text: `👥 *${meta.subject || "Grupo"}*\n🆔 ${jid}\n👤 Participantes: ${meta.participants?.length || 0}\n👑 Administradores: ${admins}\n📅 Creado: ${meta.creation ? new Date(meta.creation * 1000).toLocaleDateString("es-MX") : "No disponible"}\n📝 Descripción: ${meta.desc || "Sin descripción"}` });
  }
  if (["kick", "promote", "demote"].includes(cmd)) {
    const targets = mentionedJids(msg);
    if (!targets.length) return sock.sendMessage(jid, { text: `Uso: .${cmd} @usuario (menciona o responde a su mensaje)` });
    const guarded = await groupGuard(sock, msg, jid, true);
    if (!guarded) return;
    try {
      await sock.groupParticipantsUpdate(jid, targets, cmd === "kick" ? "remove" : cmd === "promote" ? "promote" : "demote");
      return sock.sendMessage(jid, { text: `${cmd === "kick" ? "👢 Acción completada" : cmd === "promote" ? "⬆️ Administrador(es) promovido(s)" : "⬇️ Administrador(es) degradado(s)"}: ${targets.map(x => `@${norm(x)}`).join(" ")}`, mentions: targets });
    } catch (e) { return sock.sendMessage(jid, { text: `❌ No se pudo completar: ${e.message}` }); }
  }
  if (cmd === "warn") {
    const targets = mentionedJids(msg);
    if (!targets.length) return sock.sendMessage(jid, { text: "Uso: .warn @usuario (menciona o responde a su mensaje)" });
    const target = targets[0], key = `${jid}:${target}`;
    const count = (warningCounts.get(key) || 0) + 1;
    warningCounts.set(key, count);
    return sock.sendMessage(jid, { text: `⚠️ @${norm(target)} recibió una advertencia.\nAdvertencias en esta ejecución: ${count}/3`, mentions: [target] });
  }
  if (cmd === "encuesta") {
    const parts = args.split("|").map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) return sock.sendMessage(jid, { text: "Uso: .encuesta Pregunta | Opción 1 | Opción 2" });
    return sock.sendMessage(jid, { poll: { name: parts[0].slice(0, 250), values: parts.slice(1, 13).map(x => x.slice(0, 100)), selectableCount: 1 } });
  }
}

function handleLocalFun(sock, jid, cmd, args) {
  if (cmd === "dados") return sock.sendMessage(jid, { text: `🎲 Salió: ${1 + Math.floor(Math.random() * 6)}` });
  if (cmd === "moneda") return sock.sendMessage(jid, { text: Math.random() < .5 ? "🪙 Cara" : "🪙 Cruz" });
  if (cmd === "8ball") return sock.sendMessage(jid, { text: `🎱 ${pick(eightBall)}` });
  if (cmd === "ppt") {
    const options = ["piedra", "papel", "tijera"];
    const user = args.toLowerCase();
    if (!options.includes(user)) return sock.sendMessage(jid, { text: "Uso: .ppt piedra | papel | tijera" });
    const bot = pick(options);
    const win = user === bot ? "Empate" : ((user === "piedra" && bot === "tijera") || (user === "papel" && bot === "piedra") || (user === "tijera" && bot === "papel") ? "¡Ganaste!" : "Gané yo 😎");
    return sock.sendMessage(jid, { text: `✊ Tú: ${user}\n🤖 Bot: ${bot}\n\n${win}` });
  }
  if (cmd === "ship") {
    const n = Math.floor(Math.random() * 101);
    return sock.sendMessage(jid, { text: `💘 Compatibilidad: ${n}%\n${n > 80 ? "¡Pareja legendaria!" : n > 50 ? "Hay posibilidades 👀" : "Mejor como amigos 😂"}` });
  }
  if (cmd === "trivia") {
    const q = pick([{q:"¿Cuál es el planeta más grande?",a:"jupiter"},{q:"¿Cuántos lados tiene un hexágono?",a:"6"},{q:"¿Cuál es el océano más grande?",a:"pacifico"},{q:"¿Cuánto es 9 × 8?",a:"72"}]);
    triviaAnswers.set(jid, q.a);
    return sock.sendMessage(jid, { text: `🧠 *TRIVIA*\n${q.q}\nResponde: .respuesta tu respuesta` });
  }
  if (cmd === "respuesta") {
    const answer = triviaAnswers.get(jid);
    if (!answer) return sock.sendMessage(jid, { text: "Primero inicia una con .trivia" });
    triviaAnswers.delete(jid);
    return sock.sendMessage(jid, { text: args.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") === answer ? "✅ ¡Correcto!" : `❌ La respuesta era: ${answer}` });
  }
  if (cmd === "mayus" || cmd === "upper") return sock.sendMessage(jid, { text: args ? args.toUpperCase() : "Uso: .mayus texto" });
  if (cmd === "minus" || cmd === "lower") return sock.sendMessage(jid, { text: args ? args.toLowerCase() : "Uso: .minus texto" });
  if (cmd === "reverse") return sock.sendMessage(jid, { text: args ? [...args].reverse().join("") : "Uso: .reverse texto" });
  if (cmd === "contar") return sock.sendMessage(jid, { text: args ? `📝 Caracteres: ${[...args].length}\n🔤 Palabras: ${args.trim().split(/\s+/).length}` : "Uso: .contar texto" });
  if (cmd === "base64") {
    if (!args) return sock.sendMessage(jid, { text: "Uso: .base64 texto  |  .base64 -d texto_codificado" });
    try { const decode = args.startsWith("-d "); const value = args.replace(/^-d\s+/, ""); return sock.sendMessage(jid, { text: decode ? Buffer.from(value, "base64").toString("utf8") : Buffer.from(value, "utf8").toString("base64") }); }
    catch (_) { return sock.sendMessage(jid, { text: "❌ No se pudo convertir el texto." }); }
  }
  if (cmd === "random") {
    const [a,b] = args.split(/[ ,]+/).map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a > b || b-a > 100000000) return sock.sendMessage(jid, { text: "Uso: .random 1 100" });
    return sock.sendMessage(jid, { text: `🎲 Número aleatorio: ${Math.floor(Math.random() * (b-a+1)) + a}` });
  }
}

const triviaAnswers = new Map();
async function handleSystemInfo(sock, jid, cmd) {
  const mem = process.memoryUsage();
  if (cmd === "status") return sock.sendMessage(jid, { text: `🟢 *${BOT_NAME} ACTIVO*\n⏱️ Uptime: ${formatDuration((Date.now()-startedAt)/1000)}\n🧠 RAM proceso: ${formatBytes(mem.rss)}\n⚙️ Node: ${process.version}\n📱 Plataforma: ${process.platform}` });
  if (cmd === "ram") return sock.sendMessage(jid, { text: `🧠 *MEMORIA RAM*\nProceso: ${formatBytes(mem.rss)}\nHeap usado: ${formatBytes(mem.heapUsed)}\nHeap total: ${formatBytes(mem.heapTotal)}\nSistema libre: ${formatBytes(os.freemem())}\nSistema total: ${formatBytes(os.totalmem())}` });
  if (cmd === "disk") {
    try { const st = fs.statfsSync(DATA_DIR); return sock.sendMessage(jid, { text: `💾 *ALMACENAMIENTO*\nTotal: ${formatBytes(st.blocks * st.bsize)}\nLibre: ${formatBytes(st.bavail * st.bsize)}` }); }
    catch (_) { return sock.sendMessage(jid, { text: "No se pudo consultar el almacenamiento en este sistema." }); }
  }
  if (cmd === "version") return sock.sendMessage(jid, { text: `🔥 ${BOT_NAME}\nVersión: ${BOT_VERSION}\nNode.js: ${process.version}\nBaileys: @whiskeysockets/baileys` });
  if (cmd === "changelog") return sock.sendMessage(jid, { text: `📋 *CHANGELOG ${BOT_VERSION}*\n• Comandos locales ampliados\n• Herramientas de grupo\n• Juegos sin API\n• Utilidades de texto y sistema\n• Menú reorganizado` });
}

// ======================================================
// BUSCADOR XVideos (18+): fichas con miniatura y enlace.
// WhatsApp/Baileys no garantiza carruseles nativos en todos
// los clientes; se envía una ficha por resultado.
// ======================================================
async function handleXVideos(sock, jid, query) {
  if (!query || query.length < 2) {
    return sock.sendMessage(jid, { text: "🔎 Uso: .xvideos término de búsqueda\nEjemplo: .xvideos búsqueda" });
  }
  if (!xvideosClient) {
    return sock.sendMessage(jid, { text: "⚠️ Falta instalar la dependencia. Ejecuta: npm install @rodrigogs/xvideos" });
  }
  try {
    const page = await xvideosClient.videos.search({ k: query.slice(0, 100), page: 1 });
    const videos = Array.isArray(page) ? page : (page?.videos || page?.results || []);
    if (!videos.length) return sock.sendMessage(jid, { text: `🔎 No encontré resultados para: ${query}` });
    await sock.sendMessage(jid, { text: `🔞 *XVIDEOS — RESULTADOS*\n🔎 ${query.slice(0,100)}\n📄 ${Math.min(videos.length,5)} resultados\n⚠️ Contenido para mayores de 18 años.` });
    for (const [index, video] of videos.slice(0, 5).entries()) {
      const title = String(video.title || "Sin título").replace(/[\r\n]+/g, " ").slice(0, 180);
      const url = /^https?:\/\//i.test(video.url || video.link || "") ? (video.url || video.link) : "";
      const thumb = [video.thumbnail, video.thumb, video.image, video.preview, video.thumbnailUrl].find(v => typeof v === "string" && /^https?:\/\//i.test(v));
      const duration = video.duration ? String(video.duration).slice(0,30) : "No disponible";
      const views = video.views ? String(video.views).slice(0,40) : "No disponible";
      const caption = `╭─「 🔞 *XVIDEOS ${index+1}* 」\n│ 🎬 *${title}*\n│ ⏱️ Duración: ${duration}\n│ 👁️ Vistas: ${views}\n╰──────────────\n⚠️ Solo mayores de 18 años.`;
      // Enviar primero la ficha (imagen + datos) y después los botones
      // en un mensaje independiente: algunos clientes/Baileys no muestran
      // botones interactivos cuando se adjuntan directamente a una imagen.
      if (thumb) {
        await sock.sendMessage(jid, { image: { url: thumb }, caption });
      } else {
        await sock.sendMessage(jid, { text: caption });
      }
      if (url) {
        // Botón de respuesta compatible con el formato clásico de Baileys.
        // El ID contiene la URL de ESTE resultado, para no mezclar descargas.
        try {
          const buttonText = `📥 *OPCIONES — XVideos ${index + 1}*\nPulsa el botón para descargar este resultado.`;
          if (!sendInteractiveButtons) throw new Error("baileys_helper no está instalado");
          await sendInteractiveButtons(sock, jid, {
            text: buttonText,
            footer: "DEXTER MODZ • Descarga individual",
            buttons: [
              { id: `.xvdownload ${url}`, text: "⬇️ DESCARGAR" }
            ]
          });
        } catch (buttonError) {
          log("[XVIDEOS BUTTONS]", buttonError.message);
          await sock.sendMessage(jid, {
            text: `⬇️ *DESCARGA MANUAL — XVideos ${index + 1}*\nCopia y envía este comando:\n.xvdownload ${url}\n\n🔗 Abrir: ${url}`
          });
        }
      } else {
        await sock.sendMessage(jid, { text: "⚠️ Este resultado no proporcionó un enlace válido para descargar." });
      }
    }
  } catch (error) {
    log("[XVIDEOS]", error.message);
    return sock.sendMessage(jid, { text: "❌ No pude consultar XVideos. Puede estar bloqueando la conexión o haber cambiado su sitio. Intenta más tarde." });
  }
}

// ======================================================
// BUSCADOR PORNHUB (18+): usa pornhub.js y reutiliza yt-dlp
// para descargar únicamente URLs públicas no premium.
// ======================================================
async function handlePornHub(sock, jid, query) {
  if (!query || query.length < 2) {
    return sock.sendMessage(jid, {
      text: "🔎 Uso: .pornhub término de búsqueda\nEjemplo: .pornhub búsqueda\n\n🔞 Solo para mayores de 18 años."
    });
  }
  if (!pornhubClient) {
    return sock.sendMessage(jid, {
      text: "⚠️ No se pudo cargar pornhub.js. Revisa que esté en dependencies y vuelve a desplegar Render."
    });
  }

  try {
    const result = await pornhubClient.searchVideo(query.slice(0, 100), { page: 1 });
    const videos = Array.isArray(result) ? result : (result?.data || result?.videos || []);
    const publicVideos = videos.filter(v => v && v.premium !== true).slice(0, 5);

    if (!publicVideos.length) {
      return sock.sendMessage(jid, { text: `🔎 No encontré videos públicos para: ${query}` });
    }

    await sock.sendMessage(jid, {
      text: `🔞 *PORNHUB — RESULTADOS*\n🔎 ${query.slice(0, 100)}\n📄 ${publicVideos.length} resultados\n⚠️ Contenido exclusivo para mayores de 18 años.`
    });

    for (const [index, video] of publicVideos.entries()) {
      const title = String(video.title || "Sin título").replace(/[\r\n]+/g, " ").slice(0, 180);
      const url = /^https?:\/\//i.test(video.url || "") ? video.url : "";
      const thumb = typeof video.preview === "string" && /^https?:\/\//i.test(video.preview)
        ? video.preview
        : (typeof video.thumbnail === "string" && /^https?:\/\//i.test(video.thumbnail) ? video.thumbnail : "");
      const duration = String(video.duration || "No disponible").slice(0, 30);
      const views = String(video.views || "No disponible").slice(0, 40);
      const caption = `╭─「 🔞 *PORNHUB ${index + 1}* 」\n│ 🎬 *${title}*\n│ ⏱️ Duración: ${duration}\n│ 👁️ Vistas: ${views}\n╰──────────────\n⚠️ Solo mayores de 18 años.`;

      if (thumb) {
        await sock.sendMessage(jid, { image: { url: thumb }, caption });
      } else {
        await sock.sendMessage(jid, { text: caption });
      }

      if (url && hostMatches(url, "pornhub.com")) {
        try {
          const buttonText = `📥 *OPCIONES — Pornhub ${index + 1}*\nPulsa el botón para descargar este resultado.`;
          if (!sendInteractiveButtons) throw new Error("baileys_helper no está instalado");
          await sendInteractiveButtons(sock, jid, {
            text: buttonText,
            footer: "DEXTER MODZ • Descarga individual",
            buttons: [
              { id: `.phdownload ${url}`, text: "⬇️ DESCARGAR" }
            ]
          });
        } catch (buttonError) {
          log("[PORNHUB BUTTONS]", buttonError.message);
          await sock.sendMessage(jid, {
            text: `⬇️ *DESCARGA MANUAL — Pornhub ${index + 1}*\nCopia y envía:\n.phdownload ${url}\n\n🔗 Abrir: ${url}`
          });
        }
      } else {
        await sock.sendMessage(jid, { text: "⚠️ Este resultado no proporcionó un enlace válido de Pornhub." });
      }
    }
  } catch (error) {
    log("[PORNHUB]", error.message);
    return sock.sendMessage(jid, {
      text: "❌ No pude consultar Pornhub. Puede estar bloqueando la conexión o haber cambiado su sitio. Intenta más tarde."
    });
  }
}

// ======================================================
// BUSCADOR EROME: álbumes públicos con miniatura y descarga.
// gallery-dl descarga el contenido del álbum (fotos y videos)
// en almacenamiento temporal; el archivo se elimina al enviarse.
// ======================================================
function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function absoluteEromeUrl(value) {
  try {
    const u = new URL(decodeHtmlEntities(value), "https://www.erome.com/");
    return u.protocol === "https:" && (u.hostname === "erome.com" || u.hostname.endsWith(".erome.com")) ? u.href : "";
  } catch (_) { return ""; }
}

async function fetchEromePage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml",
      "referer": "https://www.erome.com/"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Erome respondió HTTP ${response.status}`);
  return response.text();
}

function parseEromeSearch(html) {
  const links = [];
  let m;
  const anchorRe = /<a\b[^>]*>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const tag = m[0];
    const cls = tag.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!/(^|\s)album-link(\s|$)/i.test(cls)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const url = href ? absoluteEromeUrl(href) : "";
    if (url && /\/a\/[A-Za-z0-9_-]+/.test(new URL(url).pathname) && !links.includes(url)) links.push(url);
  }
  const titles = [];
  const titleRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = titleRe.exec(html)) !== null) {
    const cls = m[0].match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (/(^|\s)album-title(\s|$)/i.test(cls)) titles.push(cleanHtmlText(m[1]));
  }
  const thumbs = [];
  const imgRe = /<img\b[^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const cls = tag.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!/(^|\s)album-thumbnail(\s|$)/i.test(cls)) continue;
    const src = tag.match(/\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i);
    thumbs.push(src ? absoluteEromeUrl(src[1]) : "");
  }
  return links.map((url, i) => ({ url, title: titles[i] || `Álbum Erome ${i + 1}`, thumb: thumbs[i] || "" }));
}

async function getEromeAlbumCard(url) {
  const html = await fetchEromePage(url);
  const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const thumbMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i) || html.match(/<video[^>]+poster=["']([^"']+)/i);
  const videoCount = (html.match(/<video\b/gi) || []).length;
  const imageCount = (html.match(/class=["'][^"']*\bimg\b[^"']*["']/gi) || []).length;
  return {
    url,
    title: cleanHtmlText(titleMatch ? titleMatch[1] : "Álbum Erome"),
    thumb: thumbMatch ? absoluteEromeUrl(thumbMatch[1]) : "",
    count: Math.max(videoCount, 0) + Math.max(imageCount, 0)
  };
}

async function handleErome(sock, jid, query) {
  if (!query || query.length < 2) {
    return sock.sendMessage(jid, { text: "🔎 Uso:\n.erome término de búsqueda\n.erome https://www.erome.com/a/ID\n\nSolo se consultan álbumes públicos." });
  }
  try {
    let albums = [];
    if (/^https?:\/\//i.test(query.trim())) {
      const url = absoluteEromeUrl(query.trim());
      if (!url || !/\/a\/[A-Za-z0-9_-]+(?:$|[/?#])/i.test(new URL(url).pathname + new URL(url).search)) {
        return sock.sendMessage(jid, { text: "❌ Enlace de álbum Erome no válido. Usa https://www.erome.com/a/ID" });
      }
      albums = [await getEromeAlbumCard(url)];
    } else {
      const searchUrl = `https://www.erome.com/search?q=${encodeURIComponent(query.slice(0, 100))}&page=1`;
      const html = await fetchEromePage(searchUrl);
      albums = parseEromeSearch(html).slice(0, 5);
      if (!albums.length) return sock.sendMessage(jid, { text: `🔎 No encontré álbumes públicos para: ${query}` });
    }

    await sock.sendMessage(jid, {
      text: `🔞 *EROME — ÁLBUMES*\n🔎 ${query.slice(0, 100)}\n📄 ${albums.length} resultado(s)\n⚠️ Solo contenido público para mayores de 18 años.`
    });

    for (const [index, album] of albums.entries()) {
      let details = album;
      if (!details.count && /^https?:\/\//i.test(details.url)) {
        try { details = await getEromeAlbumCard(details.url); } catch (_) {}
      }
      const title = String(details.title || `Álbum Erome ${index + 1}`).replace(/[\r\n]+/g, " ").slice(0, 180);
      const countText = details.count ? `📁 Elementos detectados: ${details.count}` : "📁 Álbum público";
      const caption = `╭─「 🔞 *EROME ${index + 1}* 」\n│ 📚 *${title}*\n│ ${countText}\n╰──────────────\n⚠️ Solo mayores de 18 años.`;
      if (details.thumb) await sock.sendMessage(jid, { image: { url: details.thumb }, caption });
      else await sock.sendMessage(jid, { text: caption });
      try {
        if (!sendInteractiveButtons) throw new Error("baileys_helper no está instalado");
        await sendInteractiveButtons(sock, jid, {
          text: `📥 *OPCIONES — Erome ${index + 1}*\nDescarga el álbum público completo.`,
          footer: "DEXTER MODZ • Descarga de álbum",
          buttons: [{ id: `.eromedownload ${details.url}`, text: "⬇️ DESCARGAR ÁLBUM" }]
        });
      } catch (buttonError) {
        log("[EROME BUTTONS]", buttonError.message);
        await sock.sendMessage(jid, { text: `⬇️ *DESCARGAR ÁLBUM ${index + 1}*\n.eromedownload ${details.url}\n\n🔗 Abrir: ${details.url}` });
      }
    }
  } catch (error) {
    log("[EROME SEARCH]", error.message);
    return sock.sendMessage(jid, { text: "❌ No pude consultar Erome. Puede estar temporalmente inaccesible o haber cambiado su página. Intenta más tarde." });
  }
}

async function handleEromeDownload(sock, jid, albumUrl) {
  const url = absoluteEromeUrl(albumUrl);
  if (!url || !/\/a\/[A-Za-z0-9_-]+(?:$|[/?#])/i.test(new URL(url).pathname + new URL(url).search)) {
    return sock.sendMessage(jid, { text: "❌ Enlace de álbum Erome no válido." });
  }
  if (activeDownloads.has(jid)) {
    return sock.sendMessage(jid, { text: "⏳ Ya tienes una descarga en proceso en este chat." });
  }

  let jobDir = null;
  let archivePath = null;
  activeDownloads.add(jid);
  try {
    jobDir = fs.mkdtempSync(path.join(TEMP_DIR, "erome-"));
    await sock.sendMessage(jid, { text: "📥 *EROME — DESCARGA DE ÁLBUM*\n⏳ Descargando imágenes y videos públicos. Los archivos se guardarán temporalmente en Render y se eliminarán al terminar el envío." });
    await runProcess("gallery-dl", ["--directory", jobDir, url], 0);

    const files = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full !== archivePath) files.push(full);
      }
    };
    walk(jobDir);
    if (!files.length) throw new Error("gallery-dl no encontró archivos descargables en el álbum.");

    archivePath = path.join(TEMP_DIR, `erome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
    await runProcess("tar", ["-czf", archivePath, "-C", jobDir, "."], 0);
    const stats = fs.statSync(archivePath);
    if (!stats.size) throw new Error("El archivo temporal del álbum quedó vacío.");

    await sock.sendMessage(jid, {
      document: { url: archivePath },
      mimetype: "application/gzip",
      fileName: `DEXTER_MODZ_EROME_${files.length}_archivos.tar.gz`,
      caption: `✅ *ÁLBUM EROME LISTO*\n📁 Archivos: ${files.length}\n💾 Tamaño: ${formatBytes(stats.size)}\n🧹 El archivo temporal se eliminará del servidor después del envío.`
    });
  } catch (error) {
    log("[EROME DOWNLOAD]", error.message);
    await sock.sendMessage(jid, { text: `❌ No se pudo descargar el álbum Erome.\n${String(error.message || error).slice(0, 500)}\n\nComprueba que sea un álbum público y que Render tenga gallery-dl instalado.` });
  } finally {
    activeDownloads.delete(jid);
    if (archivePath) { try { fs.rmSync(archivePath, { force: true }); } catch (_) {} }
    if (jobDir) { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {} }
  }
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
    ["DESCARGAS", [".play", ".ytmp4", ".fb", ".ig", ".tiktok", ".xvideos", ".pornhub", ".erome"]],
    ["CATÁLOGO", [".tetas", ".culos", ".addtetas (owner)", ".addculos (owner)"]],
    ["STICKERS", [".s", ".toimg"]],
    ["TEXTOS", [".negrita", ".cursiva", ".tachado", ".subrayada"]],
    ["JUEGOS", [".ahorcado", ".v/f", ".trivia", ".respuesta", ".ppt", ".dados", ".moneda", ".8ball", ".ship"]],
    ["GRUPOS", [".abrir", ".cerrar", ".tag", ".tagall", ".hidetag", ".admins", ".infogrupo", ".warn", ".kick", ".promote", ".demote", ".encuesta", ".invocar", ".sorteo", ".antilink", ".antispam",
                ".antisticker", ".antifotos", ".antivideos", ".antiaudios"]],
    ["TROOL", [".abrazar", ".bezar", ".nalguear", ".coquetear", ".jugar", ".golpear",
               ".bofetear", ".menso", ".burro", ".pendejo", ".idiota", ".pajero"]],
    ["SUB-BOT", [".code", ".qr", ".delsesion"]],
    ["UTILIDADES", [".toaudio", ".qr", ".ping", ".uptime", ".runtime", ".info", ".status", ".ram", ".disk", ".version", ".changelog", ".mayus", ".minus", ".reverse", ".contar", ".base64", ".random"]]
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

async function resolveChannelMetadata(sock) {
  if (CHANNEL_JID) {
    return { id: CHANNEL_JID, name: CHANNEL_NAME };
  }
  if (resolvedChannelMetadata) return resolvedChannelMetadata;
  if (!channelMetadataPromise) {
    channelMetadataPromise = (async () => {
      const match = CHANNEL_INVITE_URL.match(/\/channel\/([^/?#]+)/i);
      if (!match) throw new Error("CHANNEL_INVITE_URL no contiene un código de canal válido");
      if (typeof sock.newsletterMetadata !== "function") {
        throw new Error("Esta versión de Baileys no ofrece newsletterMetadata()");
      }
      const metadata = await sock.newsletterMetadata("invite", match[1]);
      if (!metadata?.id || !String(metadata.id).endsWith("@newsletter")) {
        throw new Error("WhatsApp no devolvió un JID válido para el canal");
      }
      resolvedChannelMetadata = { id: metadata.id, name: metadata.name || CHANNEL_NAME };
      log("[CANAL] JID resuelto:", resolvedChannelMetadata.id, "| Nombre:", resolvedChannelMetadata.name);
      return resolvedChannelMetadata;
    })().catch(error => {
      channelMetadataPromise = null;
      throw error;
    });
  }
  return channelMetadataPromise;
}

function channelContext(metadata) {
  if (!metadata?.id) return undefined;
  return {
    isForwarded: true,
    forwardingScore: 999,
    forwardedNewsletterMessageInfo: {
      newsletterJid: metadata.id,
      newsletterName: metadata.name || CHANNEL_NAME,
      serverMessageId: CHANNEL_POST_ID
    }
  };
}

async function sendMenu(sock, jid) {
  const caption = getMenu();
  const image = MENU_IMAGE_FILE ? { url: MENU_IMAGE_FILE }
    : MENU_IMAGE_URL ? { url: MENU_IMAGE_URL } : null;
  try {
    let metadata;
    try {
      metadata = await resolveChannelMetadata(sock);
    } catch (error) {
      log("[CANAL] No se pudo resolver el JID automáticamente:", error.message);
    }
    const contextInfo = channelContext(metadata);
    if (image) await sock.sendMessage(jid, { image, caption, ...(contextInfo ? { contextInfo } : {}) });
    else await sock.sendMessage(jid, { text: caption, ...(contextInfo ? { contextInfo } : {}) });
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
const KNOWN_COMMANDS = new Set([
  "s", "sticker", "toimg", "toaudio", "qr", "addtetas", "addculos", "tetas", "culos",
  "negrita", "cursiva", "tachado", "subrayada",
  "ahorcado", "v/f", "vf", "v", "f",
  "abrir", "cerrar", "invocar", "tag", "tagall", "hidetag", "admins", "infogrupo", "warn", "kick", "promote", "demote", "encuesta", "sorteo",
  "play", "ytmp4", "fb", "ig", "tiktok", "xvideos", "xvdownload", "pornhub", "phdownload", "erome", "eromedownload",
  "hola", "menu", "help", "comandos", "ping", "info", "uptime", "runtime",
  "code", "delsesion", "dados", "moneda", "8ball", "ppt", "ship", "trivia", "respuesta", "mayus", "upper", "minus", "lower", "reverse", "contar", "base64", "random", "status", "ram", "disk", "version", "changelog"
]);
function isKnownCommand(cmd) {
  return KNOWN_COMMANDS.has(cmd) ||
    Object.prototype.hasOwnProperty.call(ANTI_LABELS, cmd) ||
    Object.prototype.hasOwnProperty.call(ACTIONS, cmd) ||
    Object.prototype.hasOwnProperty.call(METERS, cmd) ||
    NOT_AVAILABLE.has(cmd);
}
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

async function handleMessage(sock, msg, ctx = {}) {
  if (!msg?.message) return;

  // Ignora mensajes viejos (por ejemplo los que llegan al reconectar).
  const sentAt = Number(msg.messageTimestamp?.toString?.() ?? msg.messageTimestamp);
  if (Number.isFinite(sentAt) && sentAt > 0 && Date.now() / 1000 - sentAt > 180) return;

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

  // Reacciona al mensaje del comando (solo si el comando existe).
  if (REACT_EMOJI && isKnownCommand(cmd)) {
    sock.sendMessage(jid, { react: { text: REACT_EMOJI, key: msg.key } }).catch(() => {});
  }

  switch (true) {
    // Catálogo de imágenes: consulta pública, altas solo del propietario.
    case cmd === "addtetas":
      return heavy(sock, jid, () => handleNsfwAdd(sock, msg, jid, "tetas"));
    case cmd === "addculos":
      return heavy(sock, jid, () => handleNsfwAdd(sock, msg, jid, "culos"));
    case cmd === "tetas":
      return heavy(sock, jid, () => handleNsfwRandom(sock, jid, "tetas"));
    case cmd === "culos":
      return heavy(sock, jid, () => handleNsfwRandom(sock, jid, "culos"));

    // Stickers y multimedia
    case cmd === "s" || cmd === "sticker":
      return heavy(sock, jid, () => handleSticker(sock, jid, msg.message));
    case cmd === "toimg":
      return heavy(sock, jid, () => handleToImage(sock, jid, msg.message));
    case cmd === "toaudio":
      return heavy(sock, jid, () => handleToAudio(sock, jid, msg.message));
    case cmd === "qr":
      // ".qr" solo, del propietario = QR para vincular un sub-bot; ".qr texto" = QR de ese texto.
      if (!args && ctx.subbots && isOwner(msg, jid, sock)) return handleSubQr(sock, msg, jid, ctx);
      return handleQR(sock, jid, args.slice(0, 1000));

    // Sub-bots
    case cmd === "code":
      return handleSubCode(sock, msg, jid, args, ctx);
    case cmd === "delsesion":
      return handleDelSession(sock, msg, jid, args, ctx);

    // Búsqueda XVideos (18+), disponible en privado y grupos.
    case cmd === "xvideos":
      return heavy(sock, jid, () => handleXVideos(sock, jid, args));
    // Buscador Pornhub (18+), solo resultados públicos.
    case cmd === "pornhub":
      return heavy(sock, jid, () => handlePornHub(sock, jid, args));
    // El botón de cada resultado responde con .phdownload + URL.
    case cmd === "phdownload": {
      const url = args.split(/\s+/)[0];
      if (!/^https?:\/\/\S+$/i.test(url) || !hostMatches(url, "pornhub.com")) {
        return sock.sendMessage(jid, { text: "❌ Enlace de Pornhub no válido." });
      }
      return heavy(sock, jid, () => downloadAndSend(sock, jid, url, "video", "pornhub"));
    }

    // Buscador Erome (18+), solo álbumes públicos.
    case cmd === "erome":
      return heavy(sock, jid, () => handleErome(sock, jid, args));
    // Descarga el álbum público completo en un archivo temporal.
    case cmd === "eromedownload": {
      const url = args.split(/\s+/)[0];
      return heavy(sock, jid, () => handleEromeDownload(sock, jid, url));
    }

    // El botón de cada resultado responde con .xvdownload + URL.
    case cmd === "xvdownload": {
      const url = args.split(/\s+/)[0];
      if (!/^https?:\/\/\S+$/i.test(url) || !hostMatches(url, "xvideos.com")) {
        return sock.sendMessage(jid, { text: "❌ Enlace de XVideos no válido." });
      }
      return heavy(sock, jid, () => downloadAndSend(sock, jid, url, "video", "xvideos"));
    }

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
    case ["tagall", "hidetag", "admins", "infogrupo", "warn", "kick", "promote", "demote", "encuesta"].includes(cmd):
      return handleGroupUtility(sock, msg, jid, cmd, args);
    case cmd === "sorteo":
      return handleRaffle(sock, msg, jid, args);
    case Object.prototype.hasOwnProperty.call(ANTI_LABELS, cmd):
      return handleAntiToggle(sock, msg, jid, cmd, args);

    // Juegos y utilidades locales sin API
    case ["dados", "moneda", "8ball", "ppt", "ship", "trivia", "respuesta", "mayus", "upper", "minus", "lower", "reverse", "contar", "base64", "random"].includes(cmd):
      return handleLocalFun(sock, jid, cmd, args);
    case ["status", "ram", "disk", "version", "changelog"].includes(cmd):
      return handleSystemInfo(sock, jid, cmd);

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

module.exports = { handleMessage, getMenu, normPhone };
