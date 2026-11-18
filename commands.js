// ======================================================
// DEXTER MODZ - COMANDOS PARA CADA CUENTA VINCULADA
// (extraído de bot.js; sin comandos de administración)
// ======================================================

const { spawn } = require("child_process");
const {
  downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const os = require("os");
const path = require("path");

let QRCode = null;
try { QRCode = require("qrcode"); } catch (_) {}

const COOKIE_FILE = path.join(__dirname, "cookies.txt");
const TEMP_DIR = path.join(os.tmpdir(), "dexter-modz-temp");
const MAX_MEDIA_DOWNLOAD = 50 * 1024 * 1024;
const MAX_STICKER_SIZE = 1024 * 1024;
const DOWNLOAD_TIMEOUT = 12 * 60 * 1000;
const MAX_GLOBAL_DOWNLOADS = Number(process.env.MAX_DOWNLOADS || 2);

// Limpia temporales que hayan quedado de un reinicio anterior.
try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeDownloads = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = Date.now();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Cola global: limita cuántas descargas/conversiones pesadas corren a la vez.
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
    if (runningJobs < MAX_GLOBAL_DOWNLOADS) run();
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

function getYtDlpCommand() {
  const candidates = [
    process.env.YTDLP_PATH,
    process.env.PREFIX ? path.join(process.env.PREFIX, "bin", "yt-dlp") : null,
    "/data/data/com.termux/files/usr/bin/yt-dlp",
    "yt-dlp"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "yt-dlp" || (fs.existsSync(candidate) && fs.statSync(candidate).isFile())) return candidate;
  }
  return "yt-dlp";
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
  if (command === "tiktok" || hostMatches(url, "tiktok.com")) return "TIKTOK";
  if (command === "instagram" || hostMatches(url, "instagram.com")) return "INSTAGRAM";
  return String(command || "WEB").toUpperCase();
}

async function downloadAndSend(sock, jid, url, mode, sourceCommand) {
  if (activeDownloads.has(jid)) {
    await sock.sendMessage(jid, {
      text: "⏳ Ya hay una descarga en proceso en este chat."
    });
    return;
  }

  const playIsUrl = sourceCommand === "play" && !!getUrlHost(url);
  if (sourceCommand === "play") {
    if (playIsUrl && !isYoutubeUrl(url)) {
      await sock.sendMessage(jid, { text: "❌ !play acepta enlaces de YouTube o el nombre de una canción." });
      return;
    }
    mode = "audio";
  } else if (!isAllowedMediaUrl(url)) {
    await sock.sendMessage(jid, { text: "❌ Sitio no compatible o URL no válida." });
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

    if (fs.existsSync(COOKIE_FILE)) {
      args.push("--cookies", COOKIE_FILE);
      log("[YTDLP] Cookies activadas.");
    }

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
      throw new Error("No se encontró el archivo descargado.");
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
        "Puedes probar con cookies.txt dentro de ~/BOT.";
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


async function handleGoogleSearch(sock, jid, query, mode = "web") {
  query = String(query || "").trim();
  const labels = {
    web: { title: "BÚSQUEDA WEB", emoji: "🌐", engine: "DuckDuckGo" },
    video: { title: "BÚSQUEDA DE VIDEOS", emoji: "🎬", engine: "YouTube" },
    image: { title: "BÚSQUEDA DE IMÁGENES", emoji: "🖼️", engine: "Bing Imágenes" }
  };
  const config = labels[mode] || labels.web;

  if (!query) {
    const command = mode === "video" ? "!google-v" : mode === "image" ? "!google-i" : "!google-busqueda";
    await sock.sendMessage(jid, { text: `🔎 Uso: ${command} término de búsqueda` });
    return;
  }

  await sock.sendMessage(jid, {
    text: `🔥 DEXTER MODZ\n${config.emoji} ${config.title}: ${query}\n⏳ Buscando hasta 10 resultados...`
  });

  const decodeHtml = value => String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  const cleanHtml = value => decodeHtml(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/json",
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.7"
  };
  const safeUrl = value => {
    try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.href : ""; }
    catch (_) { return ""; }
  };

  try {
    const results = [];

    if (mode === "web") {
      const searchUrl = "https://html.duckduckgo.com/html/?kl=mx-es&q=" + encodeURIComponent(query);
      const response = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
      const html = await response.text();
      const blocks = html.match(/<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bresult\b|<\/body>)/gi) || [];
      for (const block of blocks) {
        if (results.length >= 10) break;
        const a = block.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        const href = a && a[0].match(/\bhref=["']([^"']+)["']/i);
        if (!a || !href) continue;
        let link = safeUrl(decodeHtml(href[1]));
        try { const u = new URL(link); if (u.hostname.includes("duckduckgo.com")) link = safeUrl(u.searchParams.get("uddg") || ""); } catch (_) {}
        const title = cleanHtml(a[1]);
        const sn = block.match(/<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
        if (link && title && !results.some(x => x.link === link)) results.push({ title, link, snippet: sn ? cleanHtml(sn[1]) : "Abre el enlace para consultar la información." });
      }
      // Obtiene imagen Open Graph de la página, si está disponible.
      await Promise.all(results.map(async item => {
        try {
          const r = await fetch(item.link, { headers, signal: AbortSignal.timeout(5500), redirect: "follow" });
          if (!r.ok) return;
          const page = (await r.text()).slice(0, 500000);
          const m = page.match(/<meta[^>]+(?:property=["']og:image["'][^>]+content=["']([^"']+)|content=["']([^"']+)["'][^>]+property=["']og:image["'])/i)
            || page.match(/<meta[^>]+(?:name=["']twitter:image["'][^>]+content=["']([^"']+)|content=["']([^"']+)["'][^>]+name=["']twitter:image["'])/i);
          item.image = m ? safeUrl(decodeHtml(m[1] || m[2])) : "";
        } catch (_) { item.image = ""; }
      }));
    } else if (mode === "video") {
      const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000), redirect: "follow" });
      if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
      const page = await response.text();
      const match = page.match(/(?:var ytInitialData\s*=|ytInitialData\s*=)\s*(\{[\s\S]*?\})\s*;?<\/script>/);
      if (match) {
        let data;
        try { data = JSON.parse(match[1]); } catch (_) {}
        const walk = value => {
          if (!value || typeof value !== "object" || results.length >= 10) return;
          if (value.videoRenderer) {
            const v = value.videoRenderer;
            const id = v.videoId;
            const title = (v.title?.runs || []).map(x => x.text || "").join("") || v.title?.simpleText || "Video de YouTube";
            const duration = v.lengthText?.simpleText || v.lengthText?.accessibility?.accessibilityData?.label || "Duración no disponible";
            const channel = v.ownerText?.runs?.map(x => x.text).join("") || "Canal de YouTube";
            if (id && !results.some(x => x.id === id)) results.push({ id, title, duration, channel, link: `https://www.youtube.com/watch?v=${id}`, image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
          }
          for (const child of Object.values(value)) walk(child);
        };
        walk(data);
      }
      // Respaldo por si YouTube cambia el formato del HTML.
      if (!results.length) {
        const ids = [...page.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]);
        for (const id of [...new Set(ids)].slice(0, 10)) results.push({ id, title: "Video de YouTube", duration: "Duración no disponible", channel: "YouTube", link: `https://www.youtube.com/watch?v=${id}`, image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
      }
    } else {
      const url = "https://www.bing.com/images/search?q=" + encodeURIComponent(query);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000), redirect: "follow" });
      if (!response.ok) throw new Error(`Bing Imágenes HTTP ${response.status}`);
      const page = decodeHtml(await response.text());
      const seen = new Set();
      for (const m of page.matchAll(/\bmurl\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+)["']/gi)) {
        let image = m[1].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
        image = safeUrl(image);
        if (!image || seen.has(image)) continue;
        seen.add(image);
        results.push({ title: `Imagen ${results.length + 1}`, image, link: image, snippet: "Imagen encontrada en Bing Imágenes." });
        if (results.length >= 10) break;
      }
      // Formato JSON embebido alternativo usado por Bing.
      if (!results.length) {
        for (const m of page.matchAll(/"murl"\s*:\s*"(https?:[^"\\]+)"/gi)) {
          const image = safeUrl(m[1].replace(/\\u0026/g, "&"));
          if (!image || seen.has(image)) continue;
          seen.add(image);
          results.push({ title: `Imagen ${results.length + 1}`, image, link: image, snippet: "Imagen encontrada en Bing Imágenes." });
          if (results.length >= 10) break;
        }
      }
    }

    if (!results.length) throw new Error("El buscador no devolvió resultados. Prueba con otras palabras o inténtalo más tarde.");
    await sock.sendMessage(jid, { text: `🔥 DEXTER MODZ\n${config.emoji} ${config.title}\n🔎 ${query}\n📊 ${results.length} resultados\n🌐 Motor: ${config.engine}` });

    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      let caption;
      if (mode === "video") {
        caption = `*${i + 1}. ${item.title}*\n\n⏱️ ${item.duration}\n📺 ${item.channel}\n🔗 ${item.link}\n\n👤 by Dxx Modz Sk`;
      } else if (mode === "image") {
        caption = `*${i + 1}. ${item.title}*\n🖼️ Imagen encontrada\n🔗 ${item.link}\n\n👤 by Dxx Modz Sk`;
      } else {
        let host = "Web";
        try { host = new URL(item.link).hostname.replace(/^www\./, ""); } catch (_) {}
        caption = `*${i + 1}. ${item.title}*\n\n📝 ${item.snippet}\n\n🌐 ${host}\n🔗 ${item.link}\n\n👤 by Dxx Modz Sk`;
      }
      const image = item.image || (mode === "web" ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(item.link).hostname)}&sz=128` : "");
      try {
        if (image) await sock.sendMessage(jid, { image: { url: image }, caption });
        else await sock.sendMessage(jid, { text: caption });
      } catch (_) {
        await sock.sendMessage(jid, { text: caption });
      }
      await sleep(350);
    }
  } catch (error) {
    log(`[SEARCH ${mode.toUpperCase()}]`, error.message);
    await sock.sendMessage(jid, { text: `❌ Error en DEXTER Search (${config.title}):\n${error.message}` });
  }
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

    await runProcess("ffmpeg", args, 180000);

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

    await runProcess("ffmpeg", [
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

    await runProcess("ffmpeg", [
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


// ======================================================
// MENU
// ======================================================

function getMenu() {
  return (
    "╔══════════════════════════╗\n" +
    "       🔥 DEXTER MODZ 🔥\n" +
    "╚══════════════════════════╝\n\n" +

    "🔎 BÚSQUEDA\n" +
    "• !google texto - Web (10 resultados)\n" +
    "• !google-v texto - Videos\n" +
    "• !google-i texto - Imágenes\n\n" +

    "🎵 MÚSICA\n" +
    "• !play canción o enlace - Enviar MP3\n\n" +

    "📥 DESCARGAS DIRECTAS A WHATSAPP\n" +
    "• !dl URL - Sitio compatible\n" +
    "• !tiktok URL - TikTok\n" +
    "• !instagram URL - Instagram\n" +
    "• !facebook URL - Facebook\n\n" +

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

// ======================================================
// MANEJADOR DE MENSAJES (uno por cuenta vinculada)
// ======================================================

const seenBySocket = new WeakMap();
const lastCommandAt = new Map();   // jid -> timestamp
const pendingJobs = new Set();     // jid con trabajo pesado en curso/cola
const COOLDOWN_MS = 1500;

async function heavy(sock, jid, task) {
  if (pendingJobs.has(jid)) {
    await sock.sendMessage(jid, {
      text: "⏳ Ya tienes una tarea en proceso. Espera a que termine."
    });
    return;
  }
  pendingJobs.add(jid);
  try {
    if (runningJobs >= MAX_GLOBAL_DOWNLOADS) {
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

  // Evita procesar dos veces el mismo mensaje.
  let seen = seenBySocket.get(sock);
  if (!seen) { seen = new Set(); seenBySocket.set(sock, seen); }
  const id = msg.key.id;
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  const trimmed = extractText(msg.message).trim();
  if (!trimmed || !/^[!.\/]/.test(trimmed) && trimmed.toLowerCase() !== "hola") return;

  // Anti-spam sencillo por chat.
  const now = Date.now();
  if (now - (lastCommandAt.get(jid) || 0) < COOLDOWN_MS) return;
  lastCommandAt.set(jid, now);
  if (lastCommandAt.size > 2000) lastCommandAt.delete(lastCommandAt.keys().next().value);

  // ---- Descargas ----
  const playMatch = trimmed.match(/^[!.\/]play(?:\s+audio)?\s+(.+)$/i);
  const dlMatch = trimmed.match(/^[!.\/](dl|tiktok|instagram|facebook)\s+(https?:\/\/\S+)$/i);

  if (playMatch) {
    return heavy(sock, jid, () =>
      downloadAndSend(sock, jid, playMatch[1].trim().slice(0, 300), "audio", "play"));
  }
  if (dlMatch) {
    return heavy(sock, jid, () =>
      downloadAndSend(sock, jid, dlMatch[2], "video", dlMatch[1].toLowerCase()));
  }
  if (/^[!.\/](play|dl|tiktok|instagram|facebook)(?:\s|$)/i.test(trimmed)) {
    await sock.sendMessage(jid, {
      text:
        "🎵 MÚSICA:\n!play nombre de canción\n!play enlace de YouTube\n\n" +
        "📥 DESCARGAS DIRECTAS A WHATSAPP:\n" +
        "!instagram URL\n!tiktok URL\n!facebook URL\n!dl URL"
    });
    return;
  }

  // ---- Búsquedas ----
  const searchCommands = [
    { regex: /^[!.\/]google-busqueda\s+(.+)$/i, mode: "web" },
    { regex: /^[!.\/]google-v\s+(.+)$/i, mode: "video" },
    { regex: /^[!.\/]google-i\s+(.+)$/i, mode: "image" },
    { regex: /^[!.\/]google\s+(.+)$/i, mode: "web" }
  ];
  for (const c of searchCommands) {
    const m = trimmed.match(c.regex);
    if (m) {
      return heavy(sock, jid, () =>
        handleGoogleSearch(sock, jid, m[1].slice(0, 200), c.mode));
    }
  }
  if (/^[!.\/](google-busqueda|google-v|google-i|google)(?:\s|$)/i.test(trimmed)) {
    await sock.sendMessage(jid, {
      text:
        "🔎 DEXTER SEARCH\n\n🌐 !google-busqueda término\n🎬 !google-v término\n" +
        "🖼️ !google-i término\n\nEjemplo: !google-v Free Fire"
    });
    return;
  }

  // ---- Multimedia ----
  if (/^[!.\/]sticker$/i.test(trimmed))
    return heavy(sock, jid, () => handleSticker(sock, jid, msg.message));
  if (/^[!.\/]toimg$/i.test(trimmed))
    return heavy(sock, jid, () => handleToImage(sock, jid, msg.message));
  if (/^[!.\/]toaudio$/i.test(trimmed))
    return heavy(sock, jid, () => handleToAudio(sock, jid, msg.message));
  if (/^[!.\/]qr(?:\s|$)/i.test(trimmed))
    return handleQR(sock, jid, trimmed.replace(/^[!.\/]qr/i, "").trim().slice(0, 1000));

  // ---- Generales ----
  const command = trimmed.toLowerCase().replace(/^[!.\/]/, "").trim();

  if (command === "hola") {
    await sock.sendMessage(jid, { text: "🔥 DEXTER MODZ BOT ACTIVO\n\nBienvenido." });
  } else if (command === "menu" || command === "help") {
    await sock.sendMessage(jid, { text: getMenu() });
  } else if (command === "ping") {
    await sock.sendMessage(jid, { text: "🏓 PONG!\n🔥 DEXTER MODZ ACTIVO" });
  } else if (command === "info") {
    await sock.sendMessage(jid, {
      text:
        "🔥 DEXTER MODZ\nMotor: Baileys\nDescargas: yt-dlp\n" +
        "Procesamiento: FFmpeg\nMultimedia: Activo\nSistema: Activo"
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
