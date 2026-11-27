'use strict';

// Luno Supremacy: sticker animado con sonido para Baileys.
// El audio va incrustado en StickerMessage (campo protobuf 26), no se envía aparte.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const AUDIO_FIELD = 26;
const AUDIO_TAG = (AUDIO_FIELD << 3) | 2;
const pendingAudio = new Map();
const PATCHED = Symbol.for('luno-sound-sticker.encode-patched');
const MAX_WEBP = 500 * 1024;

function hashKey(value) {
  return Buffer.from(value).toString('base64');
}

function installStickerAudioPatch() {
  const StickerMessage = proto?.Message?.StickerMessage;
  if (!StickerMessage?.encode) throw new Error('Baileys no expone StickerMessage.encode; revisa su versión.');
  if (StickerMessage.encode[PATCHED]) return;
  const original = StickerMessage.encode;
  const patched = function (message, writer) {
    const result = original.call(this, message, writer);
    try {
      if (message?.fileSha256) {
        const audioBytes = pendingAudio.get(hashKey(message.fileSha256));
        if (audioBytes) result.uint32(AUDIO_TAG).bytes(audioBytes);
      }
    } catch (error) {
      console.error('[SOUND STICKER] No se pudo adjuntar el audio:', error.message);
    }
    return result;
  };
  patched[PATCHED] = true;
  StickerMessage.encode = patched;
}

function run(command, args, timeout = 180000, binary = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0;
    const timer = timeout > 0 ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;
    child.stdout.on('data', chunk => { out.push(chunk); size += chunk.length; });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8').slice(-12000);
      if (code !== 0) return reject(new Error(stderr || `${command} terminó con código ${code}`));
      resolve(binary ? stdout : { stdout: stdout.toString('utf8'), stderr });
    });
  });
}

async function probe(input, ffprobe) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input
  ], 30000);
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration || 0);
  const streams = data.streams || [];
  return { duration, hasVideo: streams.some(x => x.codec_type === 'video'), hasAudio: streams.some(x => x.codec_type === 'audio') };
}

async function encodeWebp(input, output, start, duration, ffmpeg) {
  const fpsOptions = [15, 12, 10, 8, 6];
  const qualityOptions = [65, 45, 25, 12];
  let lastSize = 0;
  for (const fps of fpsOptions) {
    const frames = Math.max(1, Math.floor(duration * fps));
    const exactDuration = frames / fps;
    for (const quality of qualityOptions) {
      await run(ffmpeg, [
        '-y', '-v', 'error', '-ss', start.toFixed(3), '-t', exactDuration.toFixed(3), '-i', input,
        '-an', '-vf', `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality), '-compression_level', '4',
        '-loop', '0', output
      ], 90000);
      lastSize = fs.statSync(output).size;
      if (lastSize <= MAX_WEBP) return { duration: exactDuration, fps, quality, bytes: lastSize };
    }
  }
  throw new Error(`El sticker todavía pesa ${Math.round(lastSize / 1024)} KB. Prueba un fragmento más corto.`);
}

async function extractOgg(input, output, start, duration, ffmpeg) {
  await run(ffmpeg, [
    '-y', '-v', 'error', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    '-vn', '-map', '0:a:0', '-af', `aresample=48000:first_pts=0,apad=whole_dur=${duration.toFixed(3)}`,
    '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
    '-map_metadata', '-1', output
  ], 180000);
}

async function waveform(ogg, ffmpeg) {
  const pcm = await run(ffmpeg, ['-v', 'error', '-i', ogg, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], 60000, true);
  const samples = Math.floor(pcm.length / 2);
  const bars = new Array(64).fill(0);
  if (!samples) return Uint8Array.from(bars);
  const perBar = Math.max(1, Math.floor(samples / 64));
  for (let b = 0; b < 64; b++) {
    let sum = 0, count = 0;
    for (let i = b * perBar; i < Math.min(samples, (b + 1) * perBar); i++) {
      sum += Math.abs(pcm.readInt16LE(i * 2)); count++;
    }
    bars[b] = count ? sum / count : 0;
  }
  const peak = Math.max(...bars) || 1;
  return Uint8Array.from(bars.map(v => Math.round(v * 100 / peak)));
}


function makeStickerExif() {
  // WhatsApp sticker pack metadata is read from the WebP EXIF chunk,
  // not from arbitrary packName/packPublisher protobuf properties.
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  const metadata = Buffer.from(JSON.stringify({
    'sticker-pack-id': process.env.STICKER_PACK_ID || 'luno-supremacy-sound',
    'sticker-pack-name': process.env.STICKER_PACK_NAME || '𝙻𝚞𝚗𝚘 𝚂𝚞𝚙𝚛𝚎𝚖𝚊𝚌𝚢',
    'sticker-pack-publisher': process.env.STICKER_PACK_PUBLISHER || '𝙳𝚡𝚡 𝙼𝚘𝚍𝚣',
    emojis: ['🎵', '🔥']
  }), 'utf8');
  return Buffer.concat([exifHeader, metadata]);
}

async function addStickerExif(inputPath, outputPath) {
  const exifPath = `${outputPath}.exif`;
  try {
    fs.writeFileSync(exifPath, makeStickerExif());
    await run('webpmux', ['-set', 'exif', exifPath, inputPath, '-o', outputPath], 30000);
    return outputPath;
  } finally {
    try { fs.unlinkSync(exifPath); } catch {}
  }
}

async function sendSoundSticker(sock, jid, webpPath, oggPath, seconds, quoted, ffmpeg) {
  installStickerAudioPatch();
  if (typeof sock.waUploadToServer !== 'function') throw new Error('Baileys no ofrece waUploadToServer en esta conexión.');
  const upload = { upload: sock.waUploadToServer };
  const taggedWebpPath = `${webpPath}.metadata.webp`;
  await addStickerExif(webpPath, taggedWebpPath);
  const [uploadedAudio, uploadedSticker, wave] = await Promise.all([
    prepareWAMessageMedia({ audio: fs.readFileSync(oggPath), mimetype: 'audio/ogg; codecs=opus', seconds }, upload),
    prepareWAMessageMedia({ sticker: fs.readFileSync(taggedWebpPath), isAnimated: true }, upload),
    waveform(oggPath, ffmpeg)
  ]);
  const a = uploadedAudio.audioMessage;
  const audioBytes = proto.Message.AudioMessage.encode(proto.Message.AudioMessage.create({
    url: a.url,
    mimetype: 'audio/ogg; codecs=opus',
    fileSha256: a.fileSha256,
    fileLength: a.fileLength,
    seconds,
    ptt: true,
    mediaKey: a.mediaKey,
    fileEncSha256: a.fileEncSha256,
    directPath: a.directPath,
    mediaKeyTimestamp: a.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
    waveform: wave
  })).finish();
  const sticker = uploadedSticker.stickerMessage;
  sticker.isAnimated = true;
  sticker.width = 512;
  sticker.height = 512;

  pendingAudio.set(hashKey(sticker.fileSha256), audioBytes);
  try {
    const message = generateWAMessageFromContent(jid, { stickerMessage: sticker }, {
      quoted,
      userJid: sock.user?.id
    });
    await sock.relayMessage(jid, message.message, { messageId: message.key.id });
  } finally {
    pendingAudio.delete(hashKey(sticker.fileSha256));
    try { fs.unlinkSync(taggedWebpPath); } catch {}
  }
}

async function createSoundSticker({ sock, jid, inputPath, workDir, ffmpeg, ffprobe, start = 0, duration = 10, quoted }) {
  const info = await probe(inputPath, ffprobe);
  if (!info.hasVideo) throw new Error('El archivo no contiene video.');
  if (!info.hasAudio) throw new Error('El video no tiene audio; no puede convertirse en sticker con sonido.');
  const available = Math.max(0, info.duration - start);
  const wanted = Math.min(Number(duration) || 10, 30, available);
  if (wanted < 0.5) throw new Error('El fragmento es demasiado corto o el inicio está fuera del video.');
  const webp = `${workDir}/sticker.webp`;
  const ogg = `${workDir}/audio.ogg`;
  const encoded = await encodeWebp(inputPath, webp, start, wanted, ffmpeg);
  await extractOgg(inputPath, ogg, start, encoded.duration, ffmpeg);
  await sendSoundSticker(sock, jid, webp, ogg, Math.max(1, Math.round(encoded.duration)), quoted, ffmpeg);
  return { ...encoded, audioBytes: fs.statSync(ogg).size };
}

module.exports = { createSoundSticker, installStickerAudioPatch };
