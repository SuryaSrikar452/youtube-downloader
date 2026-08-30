const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const fs = require('fs');
const path = require('path');
const os = require('os');

let yt = null;

async function getInnertube() {
  if (!yt) {
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
  }
  return yt;
}

// 1. Get video metadata and available formats
async function getVideoDetails(videoId) {
  const innertube = await getInnertube();
  const info = await innertube.getInfo(videoId);

  const title = info.basic_info.title || 'YouTube Video';
  const uploader = info.basic_info.author || 'YouTube Creator';
  const duration = info.basic_info.duration || 0;
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  // Determine available resolutions
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

// 2. Download and stream video/audio format
async function downloadStream(videoId, format, res) {
  const innertube = await getInnertube();
  const ffmpegPath = binaries.getFfmpegPath();

  if (format === 'mp3') {
    // Download audio stream and pipe through ffmpeg to MP3
    const stream = await innertube.download(videoId, {
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
    // Video download: download video + audio and merge into MP4
    const targetHeight = format === '1080p' ? 1080 : format === '480p' ? 480 : format === '360p' ? 360 : 720;
    
    // Download progressive or video-only format
    const tempDir = os.tmpdir();
    const tempVideoPath = path.join(tempDir, `v_${videoId}_${Date.now()}.mp4`);

    const stream = await innertube.download(videoId, {
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
