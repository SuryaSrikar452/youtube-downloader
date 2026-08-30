const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const binaries = require('./lib/binaries');
const validate = require('./lib/validate');
const infoCache = require('./lib/infoCache');
const downloadQueue = require('./lib/downloadQueue');
const ytEngine = require('./lib/ytEngine');

const app = express();
const PORT = process.env.PORT || 3000;

// Write YouTube cookies to a temp file if the env variable is set.
// Supports both raw Netscape cookie text and Base64-encoded string for clean env variable storage.
let COOKIES_FILE_PATH = null;
if (process.env.YOUTUBE_COOKIES) {
  try {
    let cookieContent = process.env.YOUTUBE_COOKIES.trim();

    // Auto-detect base64 string
    if (!cookieContent.includes('\n') && !cookieContent.includes('\t') && cookieContent.length > 50 && /^[A-Za-z0-9+/=]+$/.test(cookieContent)) {
      cookieContent = Buffer.from(cookieContent, 'base64').toString('utf8');
    }

    // Ensure Netscape cookie header exists
    if (!cookieContent.startsWith('# Netscape HTTP Cookie File')) {
      cookieContent = '# Netscape HTTP Cookie File\n' + cookieContent;
    }

    COOKIES_FILE_PATH = path.join(os.tmpdir(), 'yt_cookies.txt');
    fs.writeFileSync(COOKIES_FILE_PATH, cookieContent, 'utf8');
    console.log('[Auth] YouTube cookies loaded and formatted successfully.');
  } catch (err) {
    console.error('[Auth] Failed to write cookies file:', err);
  }
}

// Security Setup: Dynamic startup secrets
const SERVER_SECRET = crypto.randomBytes(32).toString('hex');
const VALID_TOKEN = crypto.createHmac('sha256', SERVER_SECRET).update('jahnavireddy').digest('hex');

app.use(express.json());

// Helper to parse request cookies manually (saves installing dependency)
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [key, ...val] = cookie.split('=');
    acc[key.trim()] = decodeURIComponent(val.join('='));
    return acc;
  }, {});
  return cookies[name] || null;
}

// Authentication Middleware to protect API routes
function requireAuth(req, res, next) {
  const token = getCookie(req, 'auth_token');

  // Timing-safe check to prevent validation timing attacks
  if (token && token.length === VALID_TOKEN.length) {
    const bufferA = Buffer.from(token);
    const bufferB = Buffer.from(VALID_TOKEN);
    if (crypto.timingSafeEqual(bufferA, bufferB)) {
      return next();
    }
  }

  res.status(401).json({ error: 'Unauthorized access. Please log in.' });
}

// 1. Password Verification Endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Hash target safely for timing-safe check
  const inputHash = crypto.createHmac('sha256', SERVER_SECRET).update(password).digest('hex');
  const targetHash = crypto.createHmac('sha256', SERVER_SECRET).update('jahnavireddy').digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(targetHash))) {
    // Set a highly secure HTTPOnly cookie
    res.setHeader('Set-Cookie', `auth_token=${VALID_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`);
    return res.json({ success: true });
  }

  res.status(401).json({ error: 'Incorrect password.' });
});

// 2. Auth status check endpoint
app.get('/api/auth-check', (req, res) => {
  const token = getCookie(req, 'auth_token');
  if (token && token.length === VALID_TOKEN.length) {
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(VALID_TOKEN))) {
      return res.json({ authenticated: true });
    }
  }
  res.json({ authenticated: false });
});

// Serve frontend static files AFTER auth verification check (except index.html, JS/CSS assets)
// We let express serve static files, but we shield the operational endpoints.
app.use(express.static(path.join(__dirname, 'public')));

// Simple In-Memory Rate Limiter Middleware
function rateLimit(limitCount, windowMs) {
  const ipRequests = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();

    if (!ipRequests.has(ip)) {
      ipRequests.set(ip, []);
    }

    let timestamps = ipRequests.get(ip);
    timestamps = timestamps.filter(time => now - time < windowMs);

    if (timestamps.length >= limitCount) {
      return res.status(429).json({
        error: 'Too many requests from this IP. Please wait a moment and try again.'
      });
    }

    timestamps.push(now);
    ipRequests.set(ip, timestamps);
    next();
  };
}

// Protected Operational Endpoints
app.get('/api/info', requireAuth, rateLimit(20, 60 * 1000), async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required.' });
  }

  const videoId = validate.extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube or Shorts URL.' });
  }

  // Check cache first
  const cachedData = infoCache.get(videoId);
  if (cachedData) {
    console.log(`[Cache Hit] Returning cached info for videoId: ${videoId}`);
    return res.json(cachedData);
  }

  // 1. Fast Path: Use YouTube's official oEmbed API (100ms response, zero bot checks/timeouts)
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
    if (oembedRes.ok) {
      const oembedData = await oembedRes.json();
      const responseData = {
        videoId,
        title: oembedData.title || 'YouTube Video',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: 0,
        uploader: oembedData.author_name || 'YouTube Creator',
        formats: [
          { id: '1080p', label: '1080p Full HD (MP4)', ext: 'mp4', type: 'video' },
          { id: '720p', label: '720p HD (MP4)', ext: 'mp4', type: 'video' },
          { id: '480p', label: '480p (MP4)', ext: 'mp4', type: 'video' },
          { id: '360p', label: '360p (MP4)', ext: 'mp4', type: 'video' },
          { id: 'mp3', label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' }
        ]
      };

      infoCache.set(videoId, responseData);
      console.log(`[oEmbed Success] Instant metadata returned for videoId: ${videoId}`);
      return res.json(responseData);
    }
  } catch (oembedErr) {
    console.log(`[oEmbed Fallback] oEmbed failed, falling back to yt-dlp...`, oembedErr.message);
  }

  // 2. Slow Fallback: yt-dlp spawn
  const ytDlpPath = binaries.getYtDlpPath();
  console.log(`[Fetch Info] Spawning yt-dlp to resolve metadata for: ${videoId}`);
  const infoArgs = [
    '-j',
    '--no-playlist',
    '--geo-bypass',
    '--no-check-certificates',
    '--js-runtimes', 'node',
  ];
  if (COOKIES_FILE_PATH) infoArgs.push('--cookies', COOKIES_FILE_PATH);
  infoArgs.push(videoUrl);
  const child = spawn(ytDlpPath, infoArgs);

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    stdout += data;
  });

  child.stderr.on('data', (data) => {
    stderr += data;
  });

  const timeoutId = setTimeout(() => {
    child.kill();
    res.status(504).json({ error: 'Request timed out while retrieving video information.' });
  }, 25000);

  child.on('close', (code) => {
    clearTimeout(timeoutId);
    if (res.headersSent) return;

    if (code !== 0) {
      console.error(`[Fetch Info] yt-dlp error code ${code} for video ${videoId}`);
      console.error(`[Fetch Info] stderr: ${stderr}`);
      const friendlyMessage = getFriendlyError(stderr);
      return res.status(500).json({ error: friendlyMessage });
    }

    try {
      const info = JSON.parse(stdout);

      const maxResolution = info.height || 720;
      const title = info.title || 'YouTube Video';
      const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : '');
      const duration = info.duration || 0; // seconds
      const uploader = info.uploader || 'Unknown Channel';

      // Define standard format options available to the client based on maxResolution
      const formats = [];

      if (maxResolution >= 1080) {
        formats.push({ id: '1080p', label: '1080p Full HD (MP4)', ext: 'mp4', type: 'video' });
      }
      if (maxResolution >= 720) {
        formats.push({ id: '720p', label: '720p HD (MP4)', ext: 'mp4', type: 'video' });
      }
      if (maxResolution >= 480) {
        formats.push({ id: '480p', label: '480p (MP4)', ext: 'mp4', type: 'video' });
      }
      formats.push({ id: '360p', label: '360p (MP4)', ext: 'mp4', type: 'video' });
      formats.push({ id: 'mp3', label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' });

      const responseData = {
        videoId,
        title,
        thumbnail,
        duration,
        uploader,
        formats
      };

      // Cache details for 10 minutes
      infoCache.set(videoId, responseData);
      res.json(responseData);
    } catch (parseError) {
      console.error('[Fetch Info] JSON Parse Error:', parseError);
      res.status(500).json({ error: 'Failed to process video metadata.' });
    }
  });
});

// Helper for error translation
function getFriendlyError(stderr) {
  const err = stderr.toLowerCase();
  if (err.includes('sign in to confirm') || err.includes('confirm your age') || err.includes('bot')) {
    return 'This video requires authentication or age verification. YouTube restricts automated access for this video.';
  }
  if (err.includes('private video')) {
    return 'This video is private and cannot be accessed.';
  }
  if (err.includes('members-only')) {
    return 'This video is members-only. You must be a member of this channel to access it.';
  }
  if (err.includes('video unavailable') || err.includes('not found') || err.includes('does not exist')) {
    return 'This video is unavailable or has been removed.';
  }
  if (err.includes('country') || err.includes('region')) {
    return 'This video is region-locked or unavailable in this country.';
  }

  // Extract key error lines for diagnosis
  const cleanStderr = stderr.split('\n').filter(line => line.trim().length > 0).join(' | ');
  return `Could not retrieve video information. Error detail: ${cleanStderr || 'Unknown error'}`;
}

// 2. Queue Status / Download Request Endpoint
app.get('/api/download', requireAuth, rateLimit(10, 60 * 1000), async (req, res) => {
  const { videoId, format, queueId } = req.query;

  if (!videoId || !format) {
    return res.status(400).json({ error: 'videoId and format query parameters are required.' });
  }

  // Verify format validity
  const validFormats = ['1080p', '720p', '480p', '360p', 'mp3'];
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: 'Invalid format selection.' });
  }

  // Request a queue slot (polled by front-end)
  const slotStatus = downloadQueue.requestSlot(videoId, format, queueId);

  if (slotStatus.status === 'queued') {
    return res.status(202).json({
      status: 'queued',
      queueId: slotStatus.queueId,
      position: slotStatus.position
    });
  }

  // Check if we can proceed to start download
  const isStarted = downloadQueue.startDownload(slotStatus.queueId);
  if (!isStarted) {
    // Fallback to queue if something changed asynchronously
    const reSlot = downloadQueue.requestSlot(videoId, format, slotStatus.queueId);
    return res.status(202).json({
      status: 'queued',
      queueId: reSlot.queueId,
      position: reSlot.position
    });
  }

  // Start Download via Native youtubei.js Engine
  const cachedInfo = infoCache.get(videoId);
  const title = cachedInfo ? cachedInfo.title : 'video';
  const { ascii, utf8 } = validate.sanitizeFilename(title);

  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const contentType = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  const asciiFilename = `${ascii}.${ext}`;
  const utf8Filename = encodeURIComponent(`${utf8}.${ext}`);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`);

  console.log(`[Download] Starting native youtubei.js stream for job ${slotStatus.queueId}. format: ${format}`);

  try {
    await ytEngine.downloadStream(videoId, format, res);
  } catch (err) {
    console.error(`[Download Error - ${slotStatus.queueId}]:`, err);
  } finally {
    downloadQueue.releaseSlot(slotStatus.queueId);
    console.log(`[Download] Job ${slotStatus.queueId} completed and slot released.`);
  }
});

// Initialize binaries on startup
binaries.ensureBinaries().then(() => {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`YouTube Downloader server running at http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}).catch(err => {
  console.error('CRITICAL: Failed to download yt-dlp on startup. Server cannot start.', err);
  process.exit(1);
});
