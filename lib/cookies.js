const fs = require('fs');
const path = require('path');

const SECRET_COOKIES_PATH = '/etc/secrets/cookies.txt';
const COOKIES_FILE_PATH = path.join(__dirname, '..', 'bin', 'cookies.txt');

function validateCookiesContent(content) {
  if (!content) {
    return { valid: false, reason: 'Cookie file is empty.' };
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith('# Netscape HTTP Cookie File')) {
    return { valid: false, reason: 'Does not start with "# Netscape HTTP Cookie File".' };
  }
  
  const lines = trimmed.split(/\r?\n/);
  let youtubeDomainsCount = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith('#')) {
      continue;
    }
    const parts = l.split('\t');
    if (parts.length >= 5) {
      const domain = parts[0];
      if (domain.toLowerCase().includes('youtube.com')) {
        youtubeDomainsCount++;
      }
    }
  }
  
  if (youtubeDomainsCount < 2) {
    return { valid: false, reason: `Requires multiple tab-separated lines with youtube.com domains, but only found ${youtubeDomainsCount}.` };
  }
  
  return { valid: true };
}

function initCookies() {
  if (fs.existsSync(SECRET_COOKIES_PATH)) {
    try {
      const content = fs.readFileSync(SECRET_COOKIES_PATH, 'utf8');
      const validation = validateCookiesContent(content);
      if (validation.valid) {
        console.log(`[Auth] Using primary cookies from secret file: ${SECRET_COOKIES_PATH}`);
        return;
      } else {
        console.error(`[Auth] Error validating cookies at ${SECRET_COOKIES_PATH}: ${validation.reason}`);
      }
    } catch (err) {
      console.error(`[Auth] Error reading cookies file at ${SECRET_COOKIES_PATH}:`, err);
    }
  } else {
    console.warn(`[Auth] Primary cookie file ${SECRET_COOKIES_PATH} not found.`);
  }

  // Fallback to environment variable
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

      // Ensure directory exists
      const binDir = path.dirname(COOKIES_FILE_PATH);
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      fs.writeFileSync(COOKIES_FILE_PATH, cookieContent, 'utf8');
      console.log(`[Auth] Fallback active: YouTube cookies written from YOUTUBE_COOKIES environment variable to ${COOKIES_FILE_PATH} successfully.`);
    } catch (err) {
      console.error('[Auth] Failed to write fallback cookies file:', err);
    }
  } else {
    console.warn('[Auth] YOUTUBE_COOKIES environment variable is not set. Falling back to cookie-less requests.');
  }
}

function getCookiesPath() {
  if (fs.existsSync(SECRET_COOKIES_PATH)) {
    try {
      const content = fs.readFileSync(SECRET_COOKIES_PATH, 'utf8');
      const validation = validateCookiesContent(content);
      if (validation.valid) {
        return SECRET_COOKIES_PATH;
      }
    } catch (e) {}
  }
  if (fs.existsSync(COOKIES_FILE_PATH)) {
    return COOKIES_FILE_PATH;
  }
  return null;
}

function logCookieDiagnostics(cookiesPath) {
  try {
    if (!cookiesPath) {
      console.log('[Diagnostics] Cookies Path is null');
      return;
    }
    const exists = fs.existsSync(cookiesPath);
    console.log(`[Diagnostics] Cookies Path: ${cookiesPath} (Exists on disk: ${exists})`);
    if (exists) {
      const content = fs.readFileSync(cookiesPath, 'utf8');
      const lines = content.split(/\r?\n/);
      const firstLines = [];
      let charCount = 0;
      for (const line of lines) {
        if (line.trim() && !line.trim().startsWith('#')) {
          const parts = line.split('\t');
          if (parts.length >= 7) {
            parts[6] = '[REDACTED]';
            firstLines.push(parts.join('\t'));
          } else {
            firstLines.push('[NON-STANDARD-LINE-REDACTED]');
          }
        } else {
          firstLines.push(line);
        }
        charCount += line.length + 1;
        if (charCount > 300) break;
      }
      const preview = firstLines.join('\n').substring(0, 500);
      console.log(`[Diagnostics] Cookie file preview (redacted):\n${preview}...\n[Diagnostics] Total line count: ${lines.length}`);
    }
  } catch (err) {
    console.error('[Diagnostics] Failed to read cookie file for diagnostics:', err);
  }
}

module.exports = {
  initCookies,
  getCookiesPath,
  logCookieDiagnostics
};
