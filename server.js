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

const app = express();
const PORT = process.env.PORT || 3000;

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

  const ytDlpPath = binaries.getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`[Fetch Info] Spawning yt-dlp to resolve metadata for: ${videoId}`);
  const child = spawn(ytDlpPath, ['-j', '--no-playlist', videoUrl]);

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

    if (code !== 0) {
      console.error(`[Fetch Info] yt-dlp error code ${code} for video ${videoId}`);
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
  return 'Could not retrieve video information. Please make sure the URL is correct.';
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

  // Start Download
  const ytDlpPath = binaries.getYtDlpPath();
  const ffmpegPath = binaries.getFfmpegPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cachedInfo = infoCache.get(videoId);
  const title = cachedInfo ? cachedInfo.title : 'video';
  const { ascii, utf8 } = validate.sanitizeFilename(title);

  let args = [];
  let contentType = 'video/mp4';
  let ext = 'mp4';

  // Create a unique temp file path for this download
  const tempDir = os.tmpdir();
  const tempId = `sv_${slotStatus.queueId}_${Date.now()}`;

  if (format === 'mp3') {
    contentType = 'audio/mpeg';
    ext = 'mp3';
    // Audio can still be piped directly to stdout
    const tempPath = path.join(tempDir, `${tempId}.mp3`);
    args = [
      '-f', 'bestaudio',
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-playlist',
      '-o', '-',
      videoUrl
    ];

    // Inject ffmpeg-static if available
    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    console.log(`[Download] Starting audio stream for job ${slotStatus.queueId}. format: ${format}`);
    res.setHeader('Content-Type', contentType);
    const asciiFilename = `${ascii}.${ext}`;
    const utf8Filename = encodeURIComponent(`${utf8}.${ext}`);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`);

    const child = spawn(ytDlpPath, args);
    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      const log = data.toString().trim();
      if (log && !log.includes('[download]') && !log.includes('%')) {
        console.log(`[Download stderr - ${slotStatus.queueId}]: ${log}`);
      }
    });

    let finished = false;
    const cleanupProcess = () => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      downloadQueue.releaseSlot(slotStatus.queueId);
      console.log(`[Download] Job ${slotStatus.queueId} process killed and slot released.`);
    };

    req.on('close', () => {
      console.log(`[Download] Client connection closed prematurely for job ${slotStatus.queueId}.`);
      cleanupProcess();
    });

    child.on('close', (code) => {
      if (code !== 0 && !finished) {
        console.error(`[Download] yt-dlp child process exited with code ${code} for job ${slotStatus.queueId}`);
      }
      cleanupProcess();
    });

    child.on('error', (err) => {
      console.error(`[Download] Child process error for job ${slotStatus.queueId}:`, err);
      cleanupProcess();
    });
  } else {
    // VIDEO downloads: write to temp file as MP4 (requires seekable output), then stream to client.
    // MP4 needs the moov atom written at the end, so it cannot be piped to stdout directly.
    const tempPath = path.join(tempDir, `${tempId}.mp4`);

    // Prefer H.264 (avc1) over AV1 for maximum device compatibility (especially mobile).
    let formatSelector = 'bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
    if (format === '1080p') {
      formatSelector = 'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]';
    } else if (format === '480p') {
      formatSelector = 'bestvideo[vcodec^=avc1][height<=480]+bestaudio[ext=m4a]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
    } else if (format === '360p') {
      formatSelector = 'bestvideo[vcodec^=avc1][height<=360]+bestaudio[ext=m4a]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
    }

    args = [
      '-f', formatSelector,
      '--no-playlist',
      '--no-part',
      '--merge-output-format', 'mp4',
      '-o', tempPath,
      videoUrl
    ];

    // Inject ffmpeg-static if available
    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    console.log(`[Download] Starting video download to temp file for job ${slotStatus.queueId}. format: ${format}`);

    const child = spawn(ytDlpPath, args);
    let finished = false;

    // Cleanup helper: kill child process, delete temp file, release queue slot
    const cleanupProcess = (deleteTemp = true) => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      downloadQueue.releaseSlot(slotStatus.queueId);
      if (deleteTemp) {
        fs.unlink(tempPath, () => {}); // best-effort delete
      }
      console.log(`[Download] Job ${slotStatus.queueId} cleaned up.`);
    };

    child.stderr.on('data', (data) => {
      const log = data.toString().trim();
      if (log && !log.includes('[download]') && !log.includes('%')) {
        console.log(`[Download stderr - ${slotStatus.queueId}]: ${log}`);
      }
    });

    // If the client disconnects before yt-dlp finishes, abort
    req.on('close', () => {
      if (!finished) {
        console.log(`[Download] Client disconnected during download for job ${slotStatus.queueId}.`);
        cleanupProcess(true);
      }
    });

    child.on('error', (err) => {
      console.error(`[Download] Child process error for job ${slotStatus.queueId}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download process failed to start.' });
      }
      cleanupProcess(true);
    });

    child.on('close', (code) => {
      if (finished) return;

      if (code !== 0) {
        console.error(`[Download] yt-dlp exited with code ${code} for job ${slotStatus.queueId}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Video download failed. Please try again.' });
        }
        cleanupProcess(true);
        return;
      }

      // yt-dlp finished successfully — stream the temp MP4 file to the client
      try {
        const stat = fs.statSync(tempPath);
        const asciiFilename = `${ascii}.${ext}`;
        const utf8Filename = encodeURIComponent(`${utf8}.${ext}`);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`);

        const fileStream = fs.createReadStream(tempPath);
        fileStream.pipe(res);

        fileStream.on('end', () => {
          finished = true;
          downloadQueue.releaseSlot(slotStatus.queueId);
          // Delete the temp file after streaming
          fs.unlink(tempPath, () => {});
          console.log(`[Download] Job ${slotStatus.queueId} completed and temp file cleaned.`);
        });

        fileStream.on('error', (err) => {
          console.error(`[Download] File stream error for job ${slotStatus.queueId}:`, err);
          cleanupProcess(true);
        });
      } catch (err) {
        console.error(`[Download] Failed to read temp file for job ${slotStatus.queueId}:`, err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to prepare the downloaded file.' });
        }
        cleanupProcess(true);
      }
    });
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
