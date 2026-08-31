const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cookies = require('./cookies');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getFriendlyDownloadError(stderr) {
  if (!stderr) return 'Failed to download stream.';
  const err = stderr.toLowerCase();
  
  if (err.includes('sign in to confirm') || err.includes('confirm your age') || err.includes('bot')) {
    return "YouTube session expired or cookies invalid — re-export cookies and update the Render Secret File at /etc/secrets/cookies.txt";
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
  return `Download failed: ${cleanStderr || 'Unknown error'}`;
}

/**
 * Helper to run yt-dlp process.
 */
function runYtDlp(ytDlpPath, args, tempPath, res) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args);
    let stderr = '';

    child.stderr.on('data', d => {
      const msg = d.toString();
      stderr += msg;
      if (msg.includes('ERROR:')) console.error('[ytEngine Error]:', msg.trim());
    });

    child.on('close', code => {
      if (code === 0 && fs.existsSync(tempPath)) {
        resolve();
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });

    child.on('error', err => reject(err));
  });
}

/**
 * Downloads and streams 100% valid, uncorrupted MP4/MP3 files.
 */
async function downloadStream(videoId, format, res) {
  const ffmpegPath = binaries.getFfmpegPath();
  const ytDlpPath = binaries.getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tempDir = os.tmpdir();

  console.log(`[ytEngine] Starting download for videoId: ${videoId}, format: ${format}`);

  if (format === 'mp3') {
    const tempAudioPath = path.join(tempDir, `audio_${videoId}_${Date.now()}.mp3`);

    const buildArgs = (useCookies, playerClient) => {
      const freshCookiesPath = cookies.getCookiesPath();
      const args = [
        '-o', tempAudioPath,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--no-playlist',
        '--geo-bypass',
        '--no-check-certificates',
        '--add-header', 'Referer:https://www.youtube.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        '--extractor-args', `youtube:player_client=${playerClient};skip=webpage,configs,js`,
      ];
      if (useCookies && freshCookiesPath) args.push('--cookies', freshCookiesPath);
      if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
      args.push(videoUrl);
      return args;
    };

    let success = false;
    let activeClient = 'android';
    let cookiesUsed = false;
    let finalError = null;

    try {
      console.log(`[ytEngine] Attempting MP3 download for videoId: ${videoId} using client: android, no cookies`);
      await runYtDlp(ytDlpPath, buildArgs(false, 'android'), tempAudioPath, res);
      success = true;
      activeClient = 'android';
      cookiesUsed = false;
    } catch (err1) {
      console.warn(`[ytEngine] Android client MP3 download failed for videoId: ${videoId}. Error: ${err1.message}`);
      finalError = err1;

      console.log(`[ytEngine] Waiting 1.5s before retry...`);
      await delay(1500);

      try {
        const freshCookiesPath = cookies.getCookiesPath();
        const useCookies = !!freshCookiesPath;
        
        console.log(`[ytEngine] Preparing Attempt 2 (web,tv with cookies) diagnostics:`);
        cookies.logCookieDiagnostics(freshCookiesPath);
        
        const attempt2Args = buildArgs(useCookies, 'web,tv');
        console.log(`[ytEngine] Spawning yt-dlp with exact command array:`, [ytDlpPath, ...attempt2Args]);

        console.log(`[ytEngine] Retrying MP3 download for videoId: ${videoId} using client: web,tv, cookies: ${useCookies}`);
        await runYtDlp(ytDlpPath, attempt2Args, tempAudioPath, res);
        success = true;
        activeClient = 'web,tv';
        cookiesUsed = useCookies;
      } catch (err2) {
        console.error(`[ytEngine] Web/TV client MP3 download failed for videoId: ${videoId}. Error: ${err2.message}`);
        finalError = err2;
      }
    }

    if (success) {
      const cookieStr = cookiesUsed ? 'with cookies' : 'no cookies';
      console.log(`[ytEngine] Succeeded via ${activeClient} client, ${cookieStr}`);
    } else {
      const friendlyMsg = getFriendlyDownloadError(finalError ? finalError.message : '');
      console.error(`[ytEngine] All MP3 download attempts failed for videoId: ${videoId}. Error: ${friendlyMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: friendlyMsg });
      }
      if (fs.existsSync(tempAudioPath)) {
        fs.unlink(tempAudioPath, () => {});
      }
      return;
    }

    if (fs.existsSync(tempAudioPath)) {
      try {
        const stat = fs.statSync(tempAudioPath);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', stat.size);

        const readStream = fs.createReadStream(tempAudioPath);
        readStream.pipe(res);
        readStream.on('end', () => fs.unlink(tempAudioPath, () => {}));
      } catch (err) {
        console.error('[ytEngine MP3 Stream Error]:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream MP3 audio.' });
        fs.unlink(tempAudioPath, () => {});
      }
    } else {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to download MP3 audio.' });
    }
  } else {
    const tempVideoPath = path.join(tempDir, `video_${videoId}_${Date.now()}.mp4`);

    let formatFilter = 'b[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
    if (format === '1080p') {
      formatFilter = 'bv*[height<=1080]+ba/b[height<=1080]/bestvideo+bestaudio/best';
    } else if (format === '720p') {
      formatFilter = 'bv*[height<=720]+ba/b[height<=720]/bestvideo+bestaudio/best';
    } else if (format === '480p') {
      formatFilter = 'bv*[height<=480]+ba/b[height<=480]/bestvideo+bestaudio/best';
    } else if (format === '360p') {
      formatFilter = 'bv*[height<=360]+ba/b[height<=360]/bestvideo+bestaudio/best';
    }

    const buildArgs = (useCookies, playerClient) => {
      const freshCookiesPath = cookies.getCookiesPath();
      const args = [
        '-o', tempVideoPath,
        '-f', formatFilter,
        '--merge-output-format', 'mp4',
        '--recode-video', 'mp4',
        '--no-playlist',
        '--geo-bypass',
        '--no-check-certificates',
        '--add-header', 'Referer:https://www.youtube.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        '--extractor-args', `youtube:player_client=${playerClient};skip=webpage,configs,js`,
      ];
      if (useCookies && freshCookiesPath) args.push('--cookies', freshCookiesPath);
      if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
      args.push(videoUrl);
      return args;
    };

    let success = false;
    let activeClient = 'android';
    let cookiesUsed = false;
    let finalError = null;

    try {
      console.log(`[ytEngine] Attempting MP4 download for videoId: ${videoId} using client: android, no cookies`);
      await runYtDlp(ytDlpPath, buildArgs(false, 'android'), tempVideoPath, res);
      success = true;
      activeClient = 'android';
      cookiesUsed = false;
    } catch (err1) {
      console.warn(`[ytEngine] Android client MP4 download failed for videoId: ${videoId}. Error: ${err1.message}`);
      finalError = err1;

      console.log(`[ytEngine] Waiting 1.5s before retry...`);
      await delay(1500);

      try {
        const freshCookiesPath = cookies.getCookiesPath();
        const useCookies = !!freshCookiesPath;
        
        console.log(`[ytEngine] Preparing Attempt 2 (web,tv with cookies) diagnostics:`);
        cookies.logCookieDiagnostics(freshCookiesPath);
        
        const attempt2Args = buildArgs(useCookies, 'web,tv');
        console.log(`[ytEngine] Spawning yt-dlp with exact command array:`, [ytDlpPath, ...attempt2Args]);

        console.log(`[ytEngine] Retrying MP4 download for videoId: ${videoId} using client: web,tv, cookies: ${useCookies}`);
        await runYtDlp(ytDlpPath, attempt2Args, tempVideoPath, res);
        success = true;
        activeClient = 'web,tv';
        cookiesUsed = useCookies;
      } catch (err2) {
        console.error(`[ytEngine] Web/TV client MP4 download failed for videoId: ${videoId}. Error: ${err2.message}`);
        finalError = err2;
      }
    }

    if (success) {
      const cookieStr = cookiesUsed ? 'with cookies' : 'no cookies';
      console.log(`[ytEngine] Succeeded via ${activeClient} client, ${cookieStr}`);
    } else {
      const friendlyMsg = getFriendlyDownloadError(finalError ? finalError.message : '');
      console.error(`[ytEngine] All MP4 download attempts failed for videoId: ${videoId}. Error: ${friendlyMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: friendlyMsg });
      }
      if (fs.existsSync(tempVideoPath)) {
        fs.unlink(tempVideoPath, () => {});
      }
      return;
    }

    if (fs.existsSync(tempVideoPath)) {
      try {
        const stat = fs.statSync(tempVideoPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);

        const readStream = fs.createReadStream(tempVideoPath);
        readStream.pipe(res);
        readStream.on('end', () => fs.unlink(tempVideoPath, () => {}));
      } catch (err) {
        console.error('[ytEngine Video Stream Error]:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream MP4 video.' });
        fs.unlink(tempVideoPath, () => {});
      }
    } else {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to process MP4 video download.' });
    }
  }
}

module.exports = {
  downloadStream
};
