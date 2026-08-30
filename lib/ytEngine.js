const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

/**
 * Resolves direct stream URLs using yt-dlp with player_client=android extractor args.
 * Bypasses datacenter IP blocks (HTTP 429 / Sign-in required) completely.
 */
async function resolveStreamUrls(videoId, format) {
  const ytDlpPath = binaries.getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let formatSelector = 'b[ext=mp4]/best[ext=mp4]/best';
  if (format === '1080p') {
    formatSelector = 'bv*[height<=1080][ext=mp4]+ba*[ext=m4a]/b[height<=1080][ext=mp4]/best';
  } else if (format === '720p') {
    formatSelector = 'bv*[height<=720][ext=mp4]+ba*[ext=m4a]/b[height<=720][ext=mp4]/best';
  } else if (format === '480p') {
    formatSelector = 'bv*[height<=480][ext=mp4]+ba*[ext=m4a]/b[height<=480][ext=mp4]/best';
  } else if (format === '360p') {
    formatSelector = 'bv*[height<=360][ext=mp4]+ba*[ext=m4a]/b[height<=360][ext=mp4]/best';
  } else if (format === 'mp3') {
    formatSelector = 'ba*[ext=m4a]/ba/bestaudio';
  }

  const args = [
    '-g',
    '-f', formatSelector,
    '--no-playlist',
    '--geo-bypass',
    '--no-check-certificates',
    '--extractor-args', 'youtube:player_client=android,mweb',
    videoUrl
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out resolving video stream.'));
    }, 20000);

    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim().length > 0) {
        const urls = stdout.trim().split('\n').filter(u => u.startsWith('http'));
        if (urls.length > 0) {
          return resolve(urls);
        }
      }
      console.error('[ytEngine Resolve Error]:', stderr);
      reject(new Error(`Failed to extract video stream. ${stderr.split('\n')[0] || ''}`));
    });
  });
}

/**
 * Downloads and pipes video/audio stream directly toExpress response.
 */
async function downloadStream(videoId, format, res) {
  const ffmpegPath = binaries.getFfmpegPath();
  const ytDlpPath = binaries.getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`[ytEngine] Resolving stream for videoId: ${videoId}, format: ${format}`);

  if (format === 'mp3') {
    const urls = await resolveStreamUrls(videoId, 'mp3');
    const audioUrl = urls[0];

    res.setHeader('Content-Type', 'audio/mpeg');

    if (ffmpegPath) {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', audioUrl,
        '-vn',
        '-ab', '192k',
        '-ar', '44100',
        '-f', 'mp3',
        'pipe:1'
      ]);

      ffmpeg.stdout.pipe(res);
      ffmpeg.on('error', err => {
        console.error('[ytEngine Audio FFmpeg Error]:', err);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      // Direct stream pipe fallback
      const req = https.get(audioUrl, {
        headers: { 'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 11; en_US) gzip' }
      }, streamRes => {
        streamRes.pipe(res);
      });
      req.on('error', err => {
        console.error('[ytEngine Direct Stream Error]:', err);
        if (!res.headersSent) res.status(500).end();
      });
    }
  } else {
    // Video streaming via yt-dlp direct output pipe with FFmpeg merging
    let formatFilter = 'bv*[ext=mp4]+ba*[ext=m4a]/b[ext=mp4]/best';
    if (format === '1080p') formatFilter = 'bv*[height<=1080][ext=mp4]+ba*[ext=m4a]/b[height<=1080][ext=mp4]/best';
    if (format === '720p')  formatFilter = 'bv*[height<=720][ext=mp4]+ba*[ext=m4a]/b[height<=720][ext=mp4]/best';
    if (format === '480p')  formatFilter = 'bv*[height<=480][ext=mp4]+ba*[ext=m4a]/b[height<=480][ext=mp4]/best';
    if (format === '360p')  formatFilter = 'bv*[height<=360][ext=mp4]+ba*[ext=m4a]/b[height<=360][ext=mp4]/best';

    const args = [
      '-o', '-',
      '-f', formatFilter,
      '--no-playlist',
      '--geo-bypass',
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=android,mweb',
    ];

    if (ffmpegPath) {
      args.push('--ffmpeg-location', path.dirname(ffmpegPath));
    }

    args.push(videoUrl);

    console.log(`[ytEngine] Spawning yt-dlp pipe for video download...`);
    const child = spawn(ytDlpPath, args);

    res.setHeader('Content-Type', 'video/mp4');
    child.stdout.pipe(res);

    child.stderr.on('data', d => {
      const msg = d.toString();
      if (msg.includes('ERROR:')) {
        console.error('[ytEngine Download Stderr]:', msg.trim());
      }
    });

    child.on('error', err => {
      console.error('[ytEngine Spawn Error]:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream video.' });
    });
  }
}

module.exports = {
  downloadStream
};
