const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Single shared Innertube instance — NEVER null it out after auth,
// doing so loses the in-memory OAuth session tokens.
let yt = null;
let isDeviceAuthenticated = false;
let currentDeviceCodeData = null;

const cacheDir = path.join(os.tmpdir(), '.yt_cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function getInnertube() {
  if (yt) return yt;

  console.log('[ytEngine] Creating Innertube instance...');
  yt = await Innertube.create({
    cache: new UniversalCache(true, cacheDir),
    generate_session_locally: true,
  });

  // Restore session state from disk cache if available
  if (yt.session.logged_in) {
    isDeviceAuthenticated = true;
    console.log('[ytEngine] Session restored from cache — user is authenticated.');
  }

  // Listen for device OAuth events on this instance (persists across logins)
  yt.session.on('auth', () => {
    console.log('[ytEngine] Google TV device sign-in successful!');
    isDeviceAuthenticated = true;
    currentDeviceCodeData = null;
  });

  yt.session.on('auth-error', (err) => {
    console.error('[ytEngine] Auth error:', err.message || err);
    isDeviceAuthenticated = false;
  });

  return yt;
}

/** Reset to force re-creation (call after logout only) */
function resetInstance() {
  yt = null;
  isDeviceAuthenticated = false;
  currentDeviceCodeData = null;
  console.log('[ytEngine] Instance reset.');
}

// ── Google TV Device OAuth ────────────────────────────────────────────────────

async function startGoogleLogin() {
  const innertube = await getInnertube();

  if (innertube.session.logged_in || isDeviceAuthenticated) {
    return { status: 'already_authenticated' };
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Google device auth timed out (2 min).'));
    }, 120000);

    innertube.session.once('auth-pending', (data) => {
      clearTimeout(timeout);
      console.log('[ytEngine] Device code ready:', data.user_code);
      currentDeviceCodeData = {
        verification_url: data.verification_url,
        user_code: data.user_code,
      };
      resolve(currentDeviceCodeData);
    });

    innertube.session.signIn().catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function getGoogleStatus() {
  const innertube = await getInnertube();
  return {
    isLoggedIn: isDeviceAuthenticated || innertube.session.logged_in,
  };
}

// ── Video Metadata ────────────────────────────────────────────────────────────

async function getVideoDetails(videoId) {
  const innertube = await getInnertube();
  const info = await innertube.getInfo(videoId);

  const title    = info.basic_info.title    || 'YouTube Video';
  const uploader = info.basic_info.author   || 'YouTube Creator';
  const duration = info.basic_info.duration || 0;
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  let maxRes = 720;
  if (info.streaming_data?.adaptive_formats) {
    for (const fmt of info.streaming_data.adaptive_formats) {
      if (fmt.height && fmt.height > maxRes) maxRes = fmt.height;
    }
  }

  const formats = [];
  if (maxRes >= 1080) formats.push({ id: '1080p', label: '1080p Full HD (MP4)', ext: 'mp4', type: 'video' });
  if (maxRes >= 720)  formats.push({ id: '720p',  label: '720p HD (MP4)',       ext: 'mp4', type: 'video' });
  if (maxRes >= 480)  formats.push({ id: '480p',  label: '480p (MP4)',          ext: 'mp4', type: 'video' });
  formats.push({ id: '360p', label: '360p (MP4)',                ext: 'mp4', type: 'video' });
  formats.push({ id: 'mp3',  label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' });

  return { videoId, title, thumbnail, duration, uploader, formats };
}

// ── Stream Download with Client Fallback ──────────────────────────────────────

async function getStreamWithFallback(innertube, videoId, options) {
  const authenticated = isDeviceAuthenticated || innertube.session.logged_in;

  if (authenticated) {
    // TVJS is the native client for TV device OAuth tokens — use it first
    const clients = ['TVJS', 'TV_EMBEDDED', 'WEB'];
    for (const client of clients) {
      try {
        console.log(`[ytEngine] Trying ${client} client (authenticated)...`);
        return await innertube.download(videoId, { ...options, client });
      } catch (err) {
        console.warn(`[ytEngine] ${client} failed: ${err.message}`);
      }
    }
    throw new Error('All authenticated clients failed for this video.');
  }

  // Anonymous — ANDROID bypasses most bot checks for public videos
  try {
    console.log('[ytEngine] Trying ANDROID client (anonymous)...');
    return await innertube.download(videoId, { ...options, client: 'ANDROID' });
  } catch (err) {
    if (err.message?.includes('LOGIN_REQUIRED')) {
      throw new Error('This video requires sign-in. Please click "Connect Google Account" above.');
    }
    throw err;
  }
}

// ── Download and Stream ───────────────────────────────────────────────────────

async function downloadStream(videoId, format, res) {
  const innertube  = await getInnertube();
  const ffmpegPath = binaries.getFfmpegPath();

  if (format === 'mp3') {
    const stream = await getStreamWithFallback(innertube, videoId, { type: 'audio', quality: 'best' });

    res.setHeader('Content-Type', 'audio/mpeg');

    if (ffmpegPath) {
      const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:0', '-vn', '-ab', '192k', '-ar', '44100', '-f', 'mp3', 'pipe:1']);
      stream.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(res);
      ffmpeg.on('error', (err) => {
        console.error('[Engine Audio FFmpeg Error]:', err);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      stream.pipe(res);
    }
  } else {
    const tempDir       = os.tmpdir();
    const tempVideoPath = path.join(tempDir, `v_${videoId}_${Date.now()}.mp4`);

    const stream     = await getStreamWithFallback(innertube, videoId, { type: 'video+audio', quality: 'best' });
    const fileStream = fs.createWriteStream(tempVideoPath);
    stream.pipe(fileStream);

    fileStream.on('finish', () => {
      try {
        const stat = fs.statSync(tempVideoPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);
        const readStream = fs.createReadStream(tempVideoPath);
        readStream.pipe(res);
        readStream.on('end', () => fs.unlink(tempVideoPath, () => {}));
      } catch (err) {
        console.error('[Engine Video Stream Error]:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream video file.' });
        fs.unlink(tempVideoPath, () => {});
      }
    });

    fileStream.on('error', (err) => {
      console.error('[Engine File Write Error]:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to save temporary video file.' });
      fs.unlink(tempVideoPath, () => {});
    });
  }
}

module.exports = { getVideoDetails, downloadStream, startGoogleLogin, getGoogleStatus, resetInstance };
