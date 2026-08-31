# YouTube Downloader

A robust, high-performance Node.js YouTube video and audio downloader designed for server deployment (e.g., Render). Features standard MP4/MP3 downloads and streams via `yt-dlp` with automated fallback client chains, rate-limit avoidance, and session error recovery.

## Features

- **High-Quality Audio & Video**: Download video resolutions up to 1080p MP4 and high-quality MP3 audio.
- **Smart Metadata Retrieval**: Fast path via YouTube oEmbed API fallback to `yt-dlp` for speed and reliability.
- **Bot/429 Protection**: Features an automated two-step fallback chain for all request operations:
  1. **Android Client (No Cookies)**: Fast, free path that works for non-restricted videos.
  2. **Web/TV Clients (With Cookies)**: Secondary path utilizing active session cookies for restricted videos.
- **Authentication**: Dynamic password verification with secure HTTPOnly cookies.

## Cookie Authentication Setup

Due to YouTube rate-limiting and bot checks on datacenter IP ranges (such as Render's), cookie authentication is essential for maximum download success.

### Option 1: Render Secret Files (Recommended for Production)

Upload your cookies file directly onto Render as a Secret File:

1. Export your cookies from an active, logged-in YouTube session (using browser extensions like "Get cookies.txt LOCALLY").
2. In your Render dashboard, navigate to **Environment** under your service settings.
3. Under **Secret Files**, create a file named `cookies.txt` with the destination path:
   ```
   /etc/secrets/cookies.txt
   ```
4. Paste the content of your exported cookies file. It must start with `# Netscape HTTP Cookie File`.

The application will validate the file format on startup and prioritize it automatically.

### Option 2: Environment Variable (Recommended for Local Dev)

For local development or when Secret Files are not available, set the environment variable:

- `YOUTUBE_COOKIES`: Raw content or Base64-encoded string of your `cookies.txt` file.

On startup, this will write to the local `bin/cookies.txt` and act as the fallback cookie path.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the application:
   ```bash
   npm start
   ```
3. Open your browser and navigate to `http://localhost:3000`.
