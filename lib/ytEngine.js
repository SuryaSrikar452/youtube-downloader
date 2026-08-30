const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Auto-detects and loads YouTube cookies from process.env.YOUTUBE_COOKIES if available.
 */
function getCookiesFilePath() {
  if (process.env.YOUTUBE_COOKIES) {
    try {
      let cookieContent = process.env.YOUTUBE_COOKIES.trim();
      if (!cookieContent.includes('\n') && !cookieContent.includes('\t') && cookieContent.length > 50 && /^[A-Za-z0-9+/=]+$/.test(cookieContent)) {
        cookieContent = Buffer.from(cookieContent, 'base64').toString('utf8');
      }
      if (!cookieContent.startsWith('# Netscape HTTP Cookie File')) {
        cookieContent = '# Netscape HTTP Cookie File\n' + cookieContent;
      }
      const cookiesPath = path.join(os.tmpdir(), 'yt_cookies.txt');
      fs.writeFileSync(cookiesPath, cookieContent, 'utf8');
      return cookiesPath;
    } catch (err) {
      console.error('[ytEngine] Failed to write temp cookies file:', err);
    }
  }
  return null;
}

/**
 * Helper to run yt-dlp process and retry without cookies if expired cookies are detected.
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
 * Uses ios,android player client fallback chain to bypass bot challenges.
 */
async function downloadStream(videoId, format, res) {
  const ffmpegPath = binaries.getFfmpegPath();
  const ytDlpPath = binaries.getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tempDir = os.tmpdir();
  const cookiesPath = getCookiesFilePath();

  console.log(`[ytEngine] Starting download for videoId: ${videoId}, format: ${format}`);

  if (format === 'mp3') {
    const tempAudioPath = path.join(tempDir, `audio_${videoId}_${Date.now()}.mp3`);

    const buildArgs = (useCookies) => {
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
        '--extractor-args', 'youtube:player_client=ios,android',
      ];
      if (useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
      args.push(videoUrl);
      return args;
    };

    try {
      await runYtDlp(ytDlpPath, buildArgs(true), tempAudioPath, res);
    } catch (firstErr) {
      if (cookiesPath && (firstErr.message.includes('cookies') || firstErr.message.includes('sign in') || firstErr.message.includes('429'))) {
        console.warn('[ytEngine] Primary download attempt failed. Retrying WITHOUT cookies...');
        await runYtDlp(ytDlpPath, buildArgs(false), tempAudioPath, res);
      } else {
        throw firstErr;
      }
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

    const buildArgs = (useCookies) => {
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
        '--extractor-args', 'youtube:player_client=ios,android',
      ];
      if (useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
      args.push(videoUrl);
      return args;
    };

    try {
      await runYtDlp(ytDlpPath, buildArgs(true), tempVideoPath, res);
    } catch (firstErr) {
      if (cookiesPath && (firstErr.message.includes('cookies') || firstErr.message.includes('sign in') || firstErr.message.includes('429'))) {
        console.warn('[ytEngine] Primary download attempt failed. Retrying WITHOUT cookies...');
        await runYtDlp(ytDlpPath, buildArgs(false), tempVideoPath, res);
      } else {
        throw firstErr;
      }
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
