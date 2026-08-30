function extractVideoId(urlStr) {
  if (!urlStr) return null;
  try {
    // If the input is just the 11-char ID itself
    if (/^[a-zA-Z0-9_-]{11}$/.test(urlStr.trim())) {
      return urlStr.trim();
    }

    // Parse URL (prepend protocol if missing)
    let formatUrl = urlStr.trim();
    if (!/^https?:\/\//i.test(formatUrl)) {
      formatUrl = 'https://' + formatUrl;
    }

    const parsed = new URL(formatUrl);
    const host = parsed.hostname.replace('www.', '').replace('m.', '').replace('music.', '');

    if (host === 'youtube.com') {
      if (parsed.pathname === '/watch') {
        const v = parsed.searchParams.get('v');
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
          return v;
        }
      } else if (parsed.pathname.startsWith('/shorts/')) {
        const parts = parsed.pathname.split('/');
        const id = parts[2];
        if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
          return id;
        }
      }
    } else if (host === 'youtu.be') {
      // youtu.be/videoId
      const id = parsed.pathname.slice(1);
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return id;
      }
    }
  } catch (err) {
    // Return null if invalid URL format
  }
  return null;
}

function sanitizeFilename(title) {
  if (!title) return { ascii: 'video', utf8: 'video' };
  
  // Clean special characters
  const cleanTitle = title
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // Create ASCII fallback (remove non-ASCII characters)
  let ascii = cleanTitle.replace(/[^\x20-\x7E]/g, '');
  ascii = ascii.trim() || 'video';

  return {
    ascii,
    utf8: cleanTitle
  };
}

module.exports = {
  extractVideoId,
  sanitizeFilename
};
