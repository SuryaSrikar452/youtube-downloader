// State Management
let currentVideoData = null;
let activeAbortController = null;
let queuePollTimeout = null;
let currentQueueId = null;

// DOM Elements
const urlInput = document.getElementById('url-input');
const clearBtn = document.getElementById('clear-btn');
const inputError = document.getElementById('input-error');
const errorCard = document.getElementById('error-card');
const errorMessage = document.getElementById('error-message');
const skeletonLoader = document.getElementById('skeleton-loader');
const resultCard = document.getElementById('result-card');
const videoThumbnail = document.getElementById('video-thumbnail');
const videoDuration = document.getElementById('video-duration');
const videoTitle = document.getElementById('video-title');
const uploaderName = document.getElementById('uploader-name');
const videoFormats = document.getElementById('video-formats');
const audioFormats = document.getElementById('audio-formats');

const progressCard = document.getElementById('progress-card');
const progressStatusText = document.getElementById('progress-status-text');
const progressFormatLabel = document.getElementById('progress-format-label');
const progressBar = document.getElementById('progress-bar');
const progressBytes = document.getElementById('progress-bytes');
const progressPercent = document.getElementById('progress-percent');
const cancelBtn = document.getElementById('cancel-btn');

const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');

// YouTube URL Validation helper
function extractVideoId(urlStr) {
  if (!urlStr) return null;
  try {
    const trimmed = urlStr.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return trimmed;
    }

    let formatUrl = trimmed;
    if (!/^https?:\/\//i.test(formatUrl)) {
      formatUrl = 'https://' + formatUrl;
    }

    const parsed = new URL(formatUrl);
    const host = parsed.hostname.replace('www.', '').replace('m.', '').replace('music.', '');

    if (host === 'youtube.com') {
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v');
      } else if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/')[2];
      }
    } else if (host === 'youtu.be') {
      return parsed.pathname.slice(1);
    }
  } catch (err) {}
  return null;
}

// Format duration helper (seconds -> HH:MM:SS or MM:SS)
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const formattedSecs = secs < 10 ? `0${secs}` : secs;

  if (hrs > 0) {
    const formattedMins = mins < 10 ? `0${mins}` : mins;
    return `${hrs}:${formattedMins}:${formattedSecs}`;
  }
  return `${mins}:${formattedSecs}`;
}

// Format bytes helper (bytes -> MB or GB)
function formatBytes(bytes) {
  if (bytes === 0) return '0.00 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

// Show/Hide UI elements helper
function showElement(el, visible = true) {
  if (!el) return;
  if (visible) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// Set up UI States
function resetUI() {
  showElement(inputError, false);
  showElement(errorCard, false);
  showElement(skeletonLoader, false);
  showElement(resultCard, false);
}

// Parse filename from Content-Disposition header
function getFilenameFromHeader(header, defaultName) {
  if (!header) return defaultName;
  const match = header.match(/filename="?([^"]+)"?/);
  return match ? decodeURIComponent(match[1]) : defaultName;
}

// Handle Auto-Fetch when URL changes
let fetchDebounceTimeout = null;

urlInput.addEventListener('input', () => {
  const value = urlInput.value.trim();
  showElement(clearBtn, value.length > 0);

  if (fetchDebounceTimeout) clearTimeout(fetchDebounceTimeout);
  resetUI();

  if (!value) return;

  const videoId = extractVideoId(value);
  if (!videoId) {
    inputError.innerText = 'Please enter a valid YouTube video or Shorts link.';
    showElement(inputError, true);
    return;
  }

  // Valid ID detected, trigger skeleton immediately
  showElement(skeletonLoader, true);

  // Debounce API fetch for 600ms to allow typing
  fetchDebounceTimeout = setTimeout(() => {
    fetchVideoInfo(value);
  }, 600);
});

// Clear Input
clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  showElement(clearBtn, false);
  resetUI();
  urlInput.focus();
});

// Fetch Video Info API Call
async function fetchVideoInfo(url) {
  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch video information.');
    }

    displayVideoResult(data);
    saveToRecentLookups(data);
  } catch (error) {
    resetUI();
    handleApiError(error);
    if (!error.message.includes('Unauthorized')) {
      errorMessage.innerText = error.message;
      showElement(errorCard, true);
    }
  } finally {
    showElement(skeletonLoader, false);
  }
}

// Populate Result Card
function displayVideoResult(data) {
  currentVideoData = data;
  videoTitle.innerText = data.title;
  uploaderName.innerText = data.uploader;
  videoThumbnail.src = data.thumbnail;
  videoDuration.innerText = formatDuration(data.duration);

  // Clear format grids
  videoFormats.innerHTML = '';
  audioFormats.innerHTML = '';

  data.formats.forEach(f => {
    const btn = document.createElement('button');
    btn.className = `dl-btn ${f.type === 'video' ? 'btn-video' : 'btn-audio'}`;
    
    const iconClass = f.type === 'video' ? 'fa-solid fa-video' : 'fa-solid fa-music';
    btn.innerHTML = `<i class="${iconClass}"></i> ${f.label}`;
    
    btn.addEventListener('click', () => triggerDownload(f.id, f.label, f.ext));

    if (f.type === 'video') {
      videoFormats.appendChild(btn);
    } else {
      audioFormats.appendChild(btn);
    }
  });

  showElement(resultCard, true);
}

// Start Streamed Download
async function triggerDownload(formatId, formatLabel, ext) {
  // If there's an active download, don't start a new one
  if (activeAbortController) {
    alert('A download is already in progress. Please cancel it or wait for it to complete.');
    return;
  }

  // Set up progress card UI
  progressStatusText.innerText = 'Preparing download...';
  progressFormatLabel.innerText = formatLabel;
  progressBar.style.width = '0%';
  progressBytes.innerText = '0.00 MB downloaded';
  progressPercent.innerText = '0%';
  showElement(progressCard, true);
  
  // Scroll to progress card on mobile
  progressCard.scrollIntoView({ behavior: 'smooth' });

  activeAbortController = new AbortController();
  currentQueueId = null;

  pollDownloadQueue(formatId, formatLabel, ext);
}

// Manage Queue Polling and File Streaming
async function pollDownloadQueue(formatId, formatLabel, ext) {
  if (!activeAbortController) return;

  const url = `/api/download?videoId=${currentVideoData.videoId}&format=${formatId}` +
    (currentQueueId ? `&queueId=${currentQueueId}` : '');

  try {
    const res = await fetch(url, { signal: activeAbortController.signal });

    // Handle Queue (202 Accepted)
    if (res.status === 202) {
      const data = await res.json();
      currentQueueId = data.queueId;
      progressStatusText.innerText = `Queued — ${data.position} client(s) ahead...`;
      progressBar.style.width = '0%';
      
      // Poll again in 2 seconds
      queuePollTimeout = setTimeout(() => {
        pollDownloadQueue(formatId, formatLabel, ext);
      }, 2000);
      return;
    }

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed with HTTP status ${res.status}`);
    }

    // 200 OK — Streaming has started
    progressStatusText.innerText = 'Downloading file...';
    
    const contentDisposition = res.headers.get('Content-Disposition');
    const contentType = res.headers.get('Content-Type');
    const defaultFilename = `${currentVideoData.title || 'video'}.${ext}`;
    const filename = getFilenameFromHeader(contentDisposition, defaultFilename);
    const contentLength = +res.headers.get('Content-Length'); // might be NaN or 0

    const reader = res.body.getReader();
    let receivedLength = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      chunks.push(value);
      receivedLength += value.length;

      // Update Progress
      progressBytes.innerText = `${formatBytes(receivedLength)} downloaded`;
      
      if (contentLength && !isNaN(contentLength)) {
        const percent = Math.round((receivedLength / contentLength) * 100);
        progressBar.style.width = `${percent}%`;
        progressPercent.innerText = `${percent}%`;
      } else {
        // Indeterminate/fallback progress representation
        progressBar.style.width = '100%';
        progressBar.classList.add('animate-pulse');
        progressPercent.innerText = '-- %';
      }
    }

    // Streaming finished, assemble and save the file
    progressStatusText.innerText = 'Finishing download...';
    const blob = new Blob(chunks, { type: contentType });
    const downloadUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);

    // Complete UI State
    progressStatusText.innerText = 'Download complete!';
    setTimeout(() => {
      showElement(progressCard, false);
      resetActiveDownloadState();
    }, 3000);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Download cancelled by user.');
    } else {
      console.error(error);
      handleApiError(error);
      if (!error.message.includes('Unauthorized')) {
        alert(error.message || 'An error occurred during the download.');
      }
      showElement(progressCard, false);
    }
    resetActiveDownloadState();
  }
}

// Reset variables
function resetActiveDownloadState() {
  activeAbortController = null;
  currentQueueId = null;
  if (queuePollTimeout) {
    clearTimeout(queuePollTimeout);
    queuePollTimeout = null;
  }
  progressBar.classList.remove('animate-pulse');
}

// Cancel Active Download Button handler
cancelBtn.addEventListener('click', () => {
  if (activeAbortController) {
    activeAbortController.abort();
  }
  showElement(progressCard, false);
  resetActiveDownloadState();
});

// Recent Lookups Logic (LocalStorage)
function saveToRecentLookups(video) {
  let recents = JSON.parse(localStorage.getItem('streamvault_recents') || '[]');
  
  // Filter out duplicates
  recents = recents.filter(item => item.videoId !== video.videoId);
  
  // Add to top of list
  recents.unshift({
    videoId: video.videoId,
    title: video.title,
    thumbnail: video.thumbnail,
    uploader: video.uploader,
    duration: video.duration
  });

  // Limit to 5 entries
  recents = recents.slice(0, 5);
  
  localStorage.setItem('streamvault_recents', JSON.stringify(recents));
  renderRecentLookups();
}

function renderRecentLookups() {
  const recents = JSON.parse(localStorage.getItem('streamvault_recents') || '[]');
  
  if (recents.length === 0) {
    showElement(recentSection, false);
    return;
  }

  recentList.innerHTML = '';
  recents.forEach(item => {
    const card = document.createElement('div');
    card.className = 'recent-item';
    card.innerHTML = `
      <div class="recent-thumb-wrapper">
        <img class="recent-thumb" src="${item.thumbnail}" alt="Thumbnail">
        <span class="video-badge">${formatDuration(item.duration)}</span>
      </div>
      <div class="recent-info">
        <h4 class="recent-title">${item.title}</h4>
        <p class="recent-author">${item.uploader}</p>
      </div>
    `;
    
    card.addEventListener('click', () => {
      urlInput.value = `https://www.youtube.com/watch?v=${item.videoId}`;
      showElement(clearBtn, true);
      resetUI();
      // Directly render cached video details (saving API roundtrip)
      // but fetch in background to make sure formats list is completely up to date
      displayVideoResult({
        videoId: item.videoId,
        title: item.title,
        thumbnail: item.thumbnail,
        duration: item.duration,
        uploader: item.uploader,
        // Provide standard formats list as default, it will be refined on fetch completion
        formats: [
          { id: '720p', label: '720p HD (MP4)', ext: 'mp4', type: 'video' },
          { id: '360p', label: '360p (MP4)', ext: 'mp4', type: 'video' },
          { id: 'mp3', label: 'MP3 Audio (Highest Quality)', ext: 'mp3', type: 'audio' }
        ]
      });
      
      // Refresh formats list from server
      fetchVideoInfo(urlInput.value);
    });

    recentList.appendChild(card);
  });

  showElement(recentSection, true);
}

// Authentication Handlers
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginErrorMsg = document.getElementById('login-error-msg');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = passwordInput.value;
  loginErrorMsg.classList.add('hidden');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Invalid password');
    }

    // Success: Animate unlock and focus input
    loginOverlay.classList.add('fade-out');
    renderRecentLookups();
    setTimeout(() => {
      urlInput.focus();
    }, 500);

  } catch (err) {
    loginErrorMsg.innerText = err.message;
    loginErrorMsg.classList.remove('hidden');
    passwordInput.value = '';
    passwordInput.focus();
  }
});

// Check if any response is unauthorized (401) and show login screen
function handleApiError(error) {
  if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized')) {
    loginOverlay.classList.remove('fade-out');
    passwordInput.value = '';
    passwordInput.focus();
  }
}

// Google Auth Integration
const googleLoginBtn = document.getElementById('google-login-btn');
const googleStatusBadge = document.getElementById('google-status-badge');
const googleModal = document.getElementById('google-modal');
const closeGoogleModal = document.getElementById('close-google-modal');
const startGoogleLoginBtn = document.getElementById('start-google-login-btn');
const googleAuthSteps = document.getElementById('google-auth-steps');
const googleUserCode = document.getElementById('google-user-code');
const googleAuthLink = document.getElementById('google-auth-link');
const googleModalMsg = document.getElementById('google-modal-msg');

let googlePollInterval = null;

async function checkGoogleAuthStatus() {
  try {
    const res = await fetch('/api/auth/google-status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.isLoggedIn) {
      googleLoginBtn.classList.add('hidden');
      googleStatusBadge.classList.remove('hidden');
      if (googlePollInterval) clearInterval(googlePollInterval);
    } else {
      googleLoginBtn.classList.remove('hidden');
      googleStatusBadge.classList.add('hidden');
    }
  } catch (err) {
    console.error('Google status check failed:', err);
  }
}

if (googleLoginBtn) {
  googleLoginBtn.addEventListener('click', () => {
    googleModal.classList.remove('hidden');
  });
}

if (closeGoogleModal) {
  closeGoogleModal.addEventListener('click', () => {
    googleModal.classList.add('hidden');
  });
}

if (startGoogleLoginBtn) {
  startGoogleLoginBtn.addEventListener('click', async () => {
    startGoogleLoginBtn.disabled = true;
    startGoogleLoginBtn.innerText = 'Connecting to Google...';
    googleModalMsg.innerText = '';

    try {
      const res = await fetch('/api/auth/google-start', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to start Google login.');

      if (data.status === 'already_authenticated') {
        googleModalMsg.innerText = 'Your Google Account is already connected!';
        checkGoogleAuthStatus();
        setTimeout(() => googleModal.classList.add('hidden'), 1500);
        return;
      }

      if (data.user_code && data.verification_url) {
        googleUserCode.innerText = data.user_code;
        googleAuthLink.href = data.verification_url;
        googleAuthSteps.classList.remove('hidden');
        startGoogleLoginBtn.classList.add('hidden');
        googleModalMsg.innerText = 'Waiting for you to complete sign-in on Google...';

        // Poll for completion
        if (googlePollInterval) clearInterval(googlePollInterval);
        googlePollInterval = setInterval(async () => {
          const statusRes = await fetch('/api/auth/google-status');
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.isLoggedIn) {
              clearInterval(googlePollInterval);
              googleModalMsg.innerText = '🎉 Google Account Connected Successfully!';
              checkGoogleAuthStatus();
              setTimeout(() => googleModal.classList.add('hidden'), 2000);
            }
          }
        }, 3000);
      }
    } catch (err) {
      googleModalMsg.innerText = err.message;
      startGoogleLoginBtn.disabled = false;
      startGoogleLoginBtn.innerText = 'Generate Device Login Code';
    }
  });
}

// Initial rendering on page load
window.addEventListener('DOMContentLoaded', async () => {
  // Check session authorization status
  try {
    const res = await fetch('/api/auth-check');
    const data = await res.json();

    if (data.authenticated) {
      loginOverlay.classList.add('fade-out');
      renderRecentLookups();
      checkGoogleAuthStatus();
      urlInput.focus();
    } else {
      loginOverlay.classList.remove('fade-out');
      passwordInput.focus();
    }
  } catch (err) {
    console.error('Session verification failed:', err);
    loginOverlay.classList.remove('fade-out');
    passwordInput.focus();
  }
});
