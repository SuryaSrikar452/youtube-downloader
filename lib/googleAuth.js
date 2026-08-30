/**
 * Google OAuth2 Web Flow Handler
 * Standard "Sign in with Google" — user enters Gmail + password on Google's own page.
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKENS_FILE = path.join(os.tmpdir(), '.yt_cache', 'google_tokens.json');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || 'https://streamvault-szxq.onrender.com/api/auth/google/callback';
}

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Generate the Google sign-in URL to redirect the user to */
function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',  // Always prompt so we always get refresh_token
  });
}

/** Exchange authorization code from callback for tokens, then persist them */
async function exchangeCode(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('Google OAuth not configured.');
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  return tokens;
}

function saveTokens(tokens) {
  try {
    const dir = path.dirname(TOKENS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
  } catch (err) {
    console.error('[googleAuth] Failed to save tokens:', err.message);
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

/**
 * Returns a valid access_token, refreshing via refresh_token if needed.
 * Returns null if user is not authenticated.
 */
async function getFreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) return null;

  // If token expired (or close to it), refresh
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
    if (!tokens.refresh_token) {
      console.warn('[googleAuth] Token expired and no refresh_token — user must re-login.');
      return null;
    }
    try {
      const client = getOAuth2Client();
      if (!client) return null;
      client.setCredentials(tokens);
      const { credentials } = await client.refreshAccessToken();
      saveTokens({ ...tokens, ...credentials });
      console.log('[googleAuth] Access token refreshed successfully.');
      return credentials.access_token;
    } catch (err) {
      console.error('[googleAuth] Token refresh failed:', err.message);
      return null;
    }
  }

  return tokens.access_token;
}

function isAuthenticated() {
  const tokens = loadTokens();
  return !!(tokens && tokens.access_token);
}

function logout() {
  try {
    if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
    console.log('[googleAuth] User logged out, tokens cleared.');
  } catch (err) {
    console.error('[googleAuth] Logout error:', err.message);
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  getFreshAccessToken,
  isAuthenticated,
  logout,
  loadTokens,
};
