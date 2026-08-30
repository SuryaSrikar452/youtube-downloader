class InfoCache {
  constructor(defaultTtlMs = 10 * 60 * 1000) { // 10 minutes default
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(videoId) {
    if (!videoId) return null;
    const entry = this.cache.get(videoId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(videoId);
      return null;
    }

    return entry.data;
  }

  set(videoId, data, ttlMs = this.defaultTtlMs) {
    if (!videoId) return;
    this.cache.set(videoId, {
      data,
      expiresAt: Date.now() + ttlMs
    });
  }

  delete(videoId) {
    if (!videoId) return;
    this.cache.delete(videoId);
  }

  clear() {
    this.cache.clear();
  }
}

// Export a singleton instance
module.exports = new InfoCache();
