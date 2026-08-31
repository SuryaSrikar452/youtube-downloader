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

const cookies = require('./lib/cookies');

// Initialize cookies on startup
cookies.initCookies();


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

  // 2. Slow Fallback: yt-dlp spawn with 2-attempt client chain
  const ytDlpPath = binaries.getYtDlpPath();
  console.log(`[Fetch Info] Spawning yt-dlp to resolve metadata for: ${videoId}`);

  const runInfoYtDlp = (useCookies, playerClient) => {
    return new Promise((resolve, reject) => {
      const infoArgs = [
        '-j',
        '--no-playlist',
        '--geo-bypass',
        '--no-check-certificates',
        '--js-runtimes', 'node',
        '--extractor-args', `youtube:player_client=${playerClient}`,
      ];
      const cookiesPath = cookies.getCookiesPath();
      if (useCookies && cookiesPath) infoArgs.push('--cookies', cookiesPath);
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
        reject(new Error('Request timed out while retrieving video information.'));
      }, 25000);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0) {
          reject(new Error(stderr || `Process exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });

      child.on('error', (err) => reject(err));
    });
  };

  let stdout = '';
  let success = false;
  let activeClient = 'android';
  let cookiesUsed = false;
  let finalError = null;

  try {
    console.log(`[Fetch Info] Attempting metadata fetch for videoId: ${videoId} using client: android, no cookies`);
    stdout = await runInfoYtDlp(false, 'android');
    success = true;
    activeClient = 'android';
    cookiesUsed = false;
  } catch (err1) {
    console.warn(`[Fetch Info] Android client metadata fetch failed for videoId: ${videoId}. Error: ${err1.message}`);
    finalError = err1;

    console.log(`[Fetch Info] Waiting 1.5s before retry...`);
    await new Promise(resolve => setTimeout(resolve, 1500));

    let tempCookiesPath = null;
    try {
      const freshCookiesPath = cookies.getCookiesPath();
      if (freshCookiesPath) {
        tempCookiesPath = path.join(os.tmpdir(), `cookies_info_${videoId}_${Date.now()}.txt`);
        fs.copyFileSync(freshCookiesPath, tempCookiesPath);
      }
      
      console.log(`[Fetch Info] Preparing Attempt 2 (web,tv with cookies) diagnostics:`);
      cookies.logCookieDiagnostics(tempCookiesPath || freshCookiesPath);
      
      const attempt2Args = [
        '-j',
        '--no-playlist',
        '--geo-bypass',
        '--no-check-certificates',
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=web,tv',
      ];
      if (tempCookiesPath) attempt2Args.push('--cookies', tempCookiesPath);
      attempt2Args.push(videoUrl);

      console.log(`[Fetch Info] Spawning yt-dlp with exact command array:`, [ytDlpPath, ...attempt2Args]);
      console.log(`[Fetch Info] Retrying metadata fetch for videoId: ${videoId} using client: web,tv, cookies: ${!!tempCookiesPath}`);
      
      stdout = await new Promise((resolve, reject) => {
        const child = spawn(ytDlpPath, attempt2Args);
        let out = '';
        let err = '';
        child.stdout.on('data', d => out += d.toString());
        child.stderr.on('data', d => err += d.toString());
        const timeoutId = setTimeout(() => {
          child.kill();
          reject(new Error('Request timed out while retrieving video information.'));
        }, 25000);
        child.on('close', code => {
          clearTimeout(timeoutId);
          if (code !== 0) reject(new Error(err || `Process exited with code ${code}`));
          else resolve(out);
        });
        child.on('error', e => reject(e));
      });
      
      success = true;
      activeClient = 'web,tv';
      cookiesUsed = !!tempCookiesPath;
    } catch (err2) {
      console.error(`[Fetch Info] Web/TV client metadata fetch failed for videoId: ${videoId}. Error: ${err2.message}`);
      finalError = err2;
    } finally {
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        try {
          fs.unlinkSync(tempCookiesPath);
          console.log(`[Fetch Info] Cleaned up temporary request-scoped cookie file: ${tempCookiesPath}`);
        } catch (e) {
          console.error(`[Fetch Info] Failed to delete temp cookie file ${tempCookiesPath}:`, e);
        }
      }
    }
  }

  if (res.headersSent) return;

  if (!success) {
    const friendlyMessage = getFriendlyError(finalError ? finalError.message : '');
    console.error(`[Fetch Info] All metadata fetch attempts failed for videoId: ${videoId}. Error: ${friendlyMessage}`);
    return res.status(500).json({ error: friendlyMessage });
  }

  const cookieStr = cookiesUsed ? 'with cookies' : 'no cookies';
  console.log(`[Fetch Info] Succeeded via ${activeClient} client, ${cookieStr}`);

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

// Helper for error translation
function getFriendlyError(stderr) {
  const err = stderr.toLowerCase();
  if (err.includes('sign in to confirm') || err.includes('confirm your age') || err.includes('bot')) {
    return 'YouTube session expired or cookies invalid — re-export cookies and update the Render Secret File at /etc/secrets/cookies.txt';
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

async function runCookieSelfTest() {
  const cookiesPath = cookies.getCookiesPath();
  if (!cookiesPath) {
    console.log('[Cookie Self-Test] Skipped: No cookies configured (neither /etc/secrets/cookies.txt exists nor YOUTUBE_COOKIES env var is set).');
    return;
  }
  
  console.log(`[Cookie Self-Test] Testing cookies at: ${cookiesPath}`);
  const ytDlpPath = binaries.getYtDlpPath();
  const testVideoUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  
  const args = [
    '--cookies', cookiesPath,
    '--skip-download',
    '--simulate',
    testVideoUrl
  ];
  
  const child = spawn(ytDlpPath, args);
  let stderr = '';
  child.stderr.on('data', d => stderr += d.toString());
  
  const success = await new Promise((resolve) => {
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
  
  if (success) {
    console.log('[Cookie Self-Test] SUCCESS: Cookie file successfully parsed and validated by yt-dlp.');
  } else {
    console.error(`[Cookie Self-Test] FAILURE: Cookie file is non-functional (corrupted, expired, or invalid format) for yt-dlp. Stderr: ${stderr.trim()}`);
  }
}

// Initialize binaries on startup
binaries.ensureBinaries().then(async () => {
  // Run startup self-test
  await runCookieSelfTest();

  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`YouTube Downloader server running at http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}).catch(err => {
  console.error('CRITICAL: Failed to download yt-dlp on startup. Server cannot start.', err);
  process.exit(1);
});
