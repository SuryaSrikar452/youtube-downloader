const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');

let yt = null;
let currentAuthData = null;
let isAuthenticating = false;

const cacheDir = path.join(os.tmpdir(), '.yt_cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function getInnertube() {
  if (!yt) {
    console.log('[ytEngine] Creating new Innertube instance...');
    yt = await Innertube.create({
      cache: new UniversalCache(true, cacheDir),
      generate_session_locally: true
    });

    yt.session.on('auth', (data) => {
      console.log('[ytEngine Auth] Google Sign-In Successful! Refreshing Innertube instance on next use.');
      currentAuthData = { status: 'authenticated' };
      isAuthenticating = false;
      // Null out yt so the next call recreates with fresh credentials from cache
      yt = null;
    });

    yt.session.on('auth-error', (err) => {
      console.error('[ytEngine Auth Error]:', err);
      currentAuthData = { status: 'error', error: err.message };
      isAuthenticating = false;
    });

    if (yt.session.logged_in) {
      console.log('[ytEngine] Session restored from cache. User is logged in.');
      currentAuthData = { status: 'authenticated' };
    }
  }
  return yt;
}

// 1. Google Device Login Flow
async function startGoogleLogin() {
  const innertube = await getInnertube();

  if (innertube.session.logged_in) {
    currentAuthData = { status: 'authenticated' };
    return { status: 'already_authenticated' };
  }

  return new Promise((resolve, reject) => {
    isAuthenticating = true;

    const timeout = setTimeout(() => {
      if (isAuthenticating) {
        isAuthenticating = false;
        reject(new Error('Google authentication timed out.'));
      }
    }, 120000);

    innertube.session.once('auth-pending', (data) => {
      console.log('[ytEngine] Google Auth Pending:', data.user_code);
      currentAuthData = {
        status: 'pending',
        verification_url: data.verification_url,
        user_code: data.user_code
      };
      clearTimeout(timeout);
      resolve(currentAuthData);
    });

    innertube.session.signIn().catch(err => {
      clearTimeout(timeout);
      isAuthenticating = false;
      reject(err);
    });
  });
}

async function getGoogleStatus() {
  try {
    const innertube = await getInnertube();
    const loggedIn = innertube.session.logged_in;
    if (loggedIn && currentAuthData?.status !== 'authenticated') {
      currentAuthData = { status: 'authenticated' };
    }
    return {
      isLoggedIn: loggedIn,
      currentAuthData
    };
  } catch (err) {
    return { isLoggedIn: false, currentAuthData };
  }
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
  if (maxRes >= 720)  formats.push({ id: '720p', label: '720p HD (MP4)', ext: 'mp4', type: 'video' });
  if (maxRes >= 480)  formats.push({ id: '480p', label: '480p (MP4)', ext: 'mp4', type: 'video' });
  formats.push({ id: '360p', label: '360p (MP4)', ext: 'mp4', type: 'video' });
  formats.push({ id: 'mp3', label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' });

  return {
    videoId,
    title,
    thumbnail,
    duration,
    uploader,
    formats
  };
}

// Helper to download stream with client fallback
// Priority: TV_EMBEDDED (best for age-restricted+logged-in) -> ANDROID (best for public) -> WEB
async function getStreamWithFallback(innertube, videoId, options) {
  const isLoggedIn = innertube.session.logged_in;

  if (isLoggedIn) {
    // For authenticated sessions, use TV_EMBEDDED which supports age-restricted content
    try {
      console.log(`[ytEngine] Trying TV_EMBEDDED client (logged in)...`);
      return await innertube.download(videoId, { ...options, client: 'TV_EMBEDDED' });
    } catch (err) {
      console.warn(`[ytEngine] TV_EMBEDDED failed: ${err.message}. Trying WEB_EMBEDDED...`);
    }
    try {
      return await innertube.download(videoId, { ...options, client: 'WEB_EMBEDDED' });
    } catch (err) {
      console.warn(`[ytEngine] WEB_EMBEDDED failed: ${err.message}. Trying WEB...`);
    }
    return await innertube.download(videoId, { ...options, client: 'WEB' });
  } else {
    // For anonymous sessions use ANDROID which bypasses most bot checks
    try {
      console.log(`[ytEngine] Trying ANDROID client (anonymous)...`);
      return await innertube.download(videoId, { ...options, client: 'ANDROID' });
    } catch (err) {
      if (err.message && err.message.includes('LOGIN_REQUIRED')) {
        console.log(`[ytEngine] ANDROID requires login, falling back to WEB...`);
        return await innertube.download(videoId, { ...options, client: 'WEB' });
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
  downloadStream,
  startGoogleLogin,
  getGoogleStatus
};
