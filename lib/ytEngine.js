const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const googleAuth = require('./googleAuth');
const fs = require('fs');
const path = require('path');
const os = require('os');

let yt = null;

const cacheDir = path.join(os.tmpdir(), '.yt_cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

/** Reset the singleton so next call rebuilds with fresh credentials */
function resetInstance() {
  yt = null;
  console.log('[ytEngine] Instance reset — will rebuild on next request.');
}

/**
 * Build (or return cached) Innertube instance.
 * If user is authenticated via Google OAuth, we inject the Bearer token
 * into every YouTube InnerTube request via a custom fetch adapter.
 */
async function getInnertube() {
  if (yt) return yt;

  const accessToken = await googleAuth.getFreshAccessToken();
  const isLoggedIn = !!accessToken;

  console.log(`[ytEngine] Creating Innertube instance (authenticated=${isLoggedIn})`);

  const opts = {
    cache: new UniversalCache(true, cacheDir),
    generate_session_locally: true,
  };

  if (isLoggedIn) {
    // Inject Google OAuth2 Bearer token into all InnerTube HTTP requests.
    // This authenticates us as the signed-in user so age-restricted videos work.
    opts.fetch = async (input, init) => {
      const freshToken = await googleAuth.getFreshAccessToken();
      const headers = new Headers(init?.headers || {});
      if (freshToken) {
        headers.set('Authorization', `Bearer ${freshToken}`);
      }
      return globalThis.fetch(input, { ...init, headers });
    };
  }

  yt = await Innertube.create(opts);
  return yt;
}

/** Status endpoint: is the Google account connected? */
async function getGoogleStatus() {
  return { isLoggedIn: googleAuth.isAuthenticated() };
}

// 2. Get video metadata and available formats
async function getVideoDetails(videoId) {
  const innertube = await getInnertube();
  const info = await innertube.getInfo(videoId);

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

  return { videoId, title, thumbnail, duration, uploader, formats };
}

/**
 * Download stream with client fallback.
 * - Logged in  → WEB client (Bearer token injected in opts.fetch authenticates it)
 * - Anonymous  → ANDROID client (best for public videos without bot checks)
 */
async function getStreamWithFallback(innertube, videoId, options) {
  const isLoggedIn = googleAuth.isAuthenticated();

  if (isLoggedIn) {
    // WEB client + our custom Bearer-token fetch = authenticated InnerTube requests
    try {
      console.log(`[ytEngine] Downloading with WEB client (Google authenticated)...`);
      return await innertube.download(videoId, { ...options, client: 'WEB' });
    } catch (err) {
      console.warn(`[ytEngine] WEB client failed (${err.message}), trying ANDROID...`);
      return await innertube.download(videoId, { ...options, client: 'ANDROID' });
    }
  } else {
    // No auth — ANDROID is best for anonymous public videos
    try {
      console.log(`[ytEngine] Downloading with ANDROID client (anonymous)...`);
      return await innertube.download(videoId, { ...options, client: 'ANDROID' });
    } catch (err) {
      if (err.message && err.message.includes('LOGIN_REQUIRED')) {
        throw new Error('This video requires a Google account sign-in. Please click "Sign in with Google" at the top of the page.');
      }
      throw err;
    }
  }
}

// 3. Download and stream video/audio format
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
        '-vn', '-ab', '192k', '-ar', '44100', '-f', 'mp3', 'pipe:1'
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
        readStream.on('end', () => fs.unlink(tempVideoPath, () => {}));
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
  downloadStream,
  getGoogleStatus,
  resetInstance,
};
