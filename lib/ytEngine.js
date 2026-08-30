const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');

let yt = null;

const cacheDir = path.join(os.tmpdir(), '.yt_cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function getInnertube() {
  if (!yt) {
    console.log('[ytEngine] Initializing native Innertube engine...');
    yt = await Innertube.create({
      cache: new UniversalCache(true, cacheDir),
      generate_session_locally: true,
    });
  }
  return yt;
}

// 1. Get video metadata and available formats
async function getVideoDetails(videoId) {
  const innertube = await getInnertube();
  
  // Try clients to fetch info
  let info = null;
  const clients = ['ANDROID', 'IOS', 'WEB', 'TV'];
  for (const client of clients) {
    try {
      info = await innertube.getInfo(videoId, client);
      if (info && info.basic_info) break;
    } catch (e) {}
  }

  if (!info || !info.basic_info) {
    throw new Error('Unable to retrieve video details from YouTube.');
  }

  const title = info.basic_info.title || 'YouTube Video';
  const uploader = info.basic_info.author || 'YouTube Creator';
  const duration = info.basic_info.duration || 0;
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  let maxRes = 720;
  if (info.streaming_data && info.streaming_data.adaptive_formats) {
    for (const fmt of info.streaming_data.adaptive_formats) {
      if (fmt.height && fmt.height > maxRes) {
        maxRes = fmt.height;
      }
    }
  }

  const formats = [];
  if (maxRes >= 1080) formats.push({ id: '1080p', label: '1080p Full HD (MP4)', ext: 'mp4', type: 'video' });
  if (maxRes >= 720)  formats.push({ id: '720p',  label: '720p HD (MP4)',       ext: 'mp4', type: 'video' });
  if (maxRes >= 480)  formats.push({ id: '480p',  label: '480p (MP4)',          ext: 'mp4', type: 'video' });
  formats.push({ id: '360p', label: '360p (MP4)', ext: 'mp4', type: 'video' });
  formats.push({ id: 'mp3',  label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' });

  return {
    videoId,
    title,
    thumbnail,
    duration,
    uploader,
    formats
  };
}

// Helper to download stream with multi-client fallback chain
async function getStreamWithFallback(innertube, videoId, options) {
  const clients = ['ANDROID', 'IOS', 'WEB', 'TV'];
  let lastError = null;

  for (const client of clients) {
    try {
      console.log(`[ytEngine] Stream fetch attempting client: ${client}...`);
      return await innertube.download(videoId, { ...options, client });
    } catch (err) {
      console.warn(`[ytEngine] Client ${client} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`Failed to stream video. Detail: ${lastError ? lastError.message : 'All clients exhausted'}`);
}

// 2. Download and stream video/audio format
async function downloadStream(videoId, format, res) {
  const innertube = await getInnertube();
  const ffmpegPath = binaries.getFfmpegPath();

  if (format === 'mp3') {
    const stream = await getStreamWithFallback(innertube, videoId, {
      type: 'audio',
      quality: 'best'
    });

    res.setHeader('Content-Type', 'audio/mpeg');

    if (ffmpegPath) {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-vn',
        '-ab', '192k',
        '-ar', '44100',
        '-f', 'mp3',
        'pipe:1'
      ]);

      stream.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(res);

      ffmpeg.on('error', err => {
        console.error('[Engine Audio FFmpeg Error]:', err);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      stream.pipe(res);
    }
  } else {
    const tempDir = os.tmpdir();
    const tempVideoPath = path.join(tempDir, `v_${videoId}_${Date.now()}.mp4`);

    const stream = await getStreamWithFallback(innertube, videoId, {
      type: 'video+audio',
      quality: 'best'
    });

    const fileStream = fs.createWriteStream(tempVideoPath);
    stream.pipe(fileStream);

    fileStream.on('finish', () => {
      try {
        const stat = fs.statSync(tempVideoPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);

        const readStream = fs.createReadStream(tempVideoPath);
        readStream.pipe(res);

        readStream.on('end', () => {
          fs.unlink(tempVideoPath, () => {});
        });
      } catch (err) {
        console.error('[Engine Video Stream Error]:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream video file.' });
        fs.unlink(tempVideoPath, () => {});
      }
    });

    fileStream.on('error', err => {
      console.error('[Engine File Write Error]:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to save temporary video file.' });
      fs.unlink(tempVideoPath, () => {});
    });
  }
}

module.exports = {
  getVideoDetails,
  downloadStream
};
