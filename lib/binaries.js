const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

const isWindows = process.platform === 'win32';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_NAME = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const YT_DLP_PATH = path.join(BIN_DIR, BIN_NAME);

// ffmpeg-static exports the path to the static ffmpeg binary based on target OS platform
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (err) {
  console.error('Error loading ffmpeg-static:', err);
}

function getYtDlpPath() {
  return YT_DLP_PATH;
}

function getFfmpegPath() {
  return ffmpegPath;
}

function logYtDlpVersion() {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP_PATH, ['--version']);
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('close', (code) => {
      console.log(`[Binary] Current yt-dlp version: ${stdout.trim() || 'unknown (exit code ' + code + ')'}`);
      resolve();
    });
    child.on('error', (err) => {
      console.error('[Binary] Failed to run yt-dlp to check version:', err);
      resolve();
    });
  });
}

function runBackgroundUpdater() {
  console.log(`[Binary] Triggering background update check...`);
  const updater = spawn(YT_DLP_PATH, ['-U']);
  let updateOut = '';
  let updateErr = '';
  updater.stdout.on('data', d => updateOut += d.toString());
  updater.stderr.on('data', d => updateErr += d.toString());
  updater.on('close', (code) => {
    console.log(`[Binary] yt-dlp update process finished with code ${code}.`);
    if (updateOut.trim()) console.log(`[Binary] yt-dlp update output:\n${updateOut.trim()}`);
    if (updateErr.trim()) console.error(`[Binary] yt-dlp update error:\n${updateErr.trim()}`);
  });
  updater.on('error', (err) => {
    console.error('[Binary] Failed to update yt-dlp:', err);
  });
}

async function ensureBinaries() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  if (fs.existsSync(YT_DLP_PATH)) {
    await logYtDlpVersion();
    runBackgroundUpdater();
    return;
  }

  console.log(`${BIN_NAME} is missing. Downloading latest release...`);
  const url = isWindows
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download: HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('Response body is empty');
    }

    const fileStream = fs.createWriteStream(YT_DLP_PATH);
    await finished(Readable.fromWeb(response.body).pipe(fileStream));
    
    // Set execution permissions on Linux/macOS
    if (!isWindows) {
      fs.chmodSync(YT_DLP_PATH, 0o755);
    }
    
    console.log(`${BIN_NAME} downloaded successfully.`);
    await logYtDlpVersion();
  } catch (error) {
    console.error(`Error downloading ${BIN_NAME}:`, error);
    // Cleanup partial file if it exists
    if (fs.existsSync(YT_DLP_PATH)) {
      try {
        fs.unlinkSync(YT_DLP_PATH);
      } catch (e) {}
    }
    throw error;
  }
}

module.exports = {
  ensureBinaries,
  getYtDlpPath,
  getFfmpegPath
};
