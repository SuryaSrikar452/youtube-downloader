const crypto = require('crypto');

class DownloadQueue {
  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
    this.activeJobs = new Set(); // queueIds currently downloading
    this.readyJobs = new Map();  // queueId -> { timestamp, videoId, format } (promoted, waiting for fetch)
    this.queue = [];             // array of { queueId, videoId, format, timestamp } (waiting)
    
    // Periodically clean up stale jobs (e.g., if client closed browser tab)
    this.cleanupInterval = setInterval(() => this.cleanup(), 5000);
  }

  // Check queue status or request a new slot.
  // Returns { status: 'ready'|'queued', queueId, position }
  requestSlot(videoId, format, queueId = null) {
    const now = Date.now();

    if (queueId) {
      // 1. Check if it's already active (downloading)
      if (this.activeJobs.has(queueId)) {
        return { status: 'ready', queueId };
      }
      
      // 2. Check if it's ready (promoted but client has not yet initiated the download stream)
      if (this.readyJobs.has(queueId)) {
        const job = this.readyJobs.get(queueId);
        job.timestamp = now; // keep-alive
        return { status: 'ready', queueId };
      }

      // 3. Check if still in queue
      const index = this.queue.findIndex(item => item.queueId === queueId);
      if (index !== -1) {
        this.queue[index].timestamp = now; // keep-alive
        return { status: 'queued', queueId, position: index + 1 };
      }
      
      // If queueId was lost or expired, fall through to create a new one
    }

    // Assign new queue ID
    const newQueueId = crypto.randomUUID();

    // If there is immediate space and no one is waiting in line
    if (this.activeJobs.size + this.readyJobs.size < this.maxConcurrent && this.queue.length === 0) {
      this.readyJobs.set(newQueueId, { videoId, format, timestamp: now });
      return { status: 'ready', queueId: newQueueId };
    }

    // Otherwise, push to waiting list
    this.queue.push({ queueId: newQueueId, videoId, format, timestamp: now });
    return { status: 'queued', queueId: newQueueId, position: this.queue.length };
  }

  // Call when client initiates the streaming response
  startDownload(queueId) {
    if (this.readyJobs.has(queueId)) {
      this.readyJobs.delete(queueId);
      this.activeJobs.add(queueId);
      console.log(`[Queue] Job ${queueId} started. Active downloads: ${this.activeJobs.size}`);
      return true;
    }
    
    // If not in ready map, allow if under concurrency limit
    if (this.activeJobs.size < this.maxConcurrent) {
      this.activeJobs.add(queueId);
      console.log(`[Queue] Job ${queueId} started directly. Active downloads: ${this.activeJobs.size}`);
      return true;
    }

    return false;
  }

  // Release a slot when download completes, fails or cancels
  releaseSlot(queueId) {
    if (!queueId) return;
    let released = false;

    if (this.activeJobs.delete(queueId)) released = true;
    if (this.readyJobs.delete(queueId)) released = true;
    
    const initialLen = this.queue.length;
    this.queue = this.queue.filter(item => item.queueId !== queueId);
    if (this.queue.length !== initialLen) released = true;

    if (released) {
      console.log(`[Queue] Released slot for ${queueId}. Active: ${this.activeJobs.size}, Queue: ${this.queue.length}`);
      this.processQueue();
    }
  }

  // Move queued items to ready state if slots are available
  processQueue() {
    while (this.activeJobs.size + this.readyJobs.size < this.maxConcurrent && this.queue.length > 0) {
      const nextJob = this.queue.shift();
      nextJob.timestamp = Date.now(); // reset timer for ready grace period
      this.readyJobs.set(nextJob.queueId, nextJob);
      console.log(`[Queue] Promoted job ${nextJob.queueId} to READY. Ready jobs: ${this.readyJobs.size}, Queued remaining: ${this.queue.length}`);
    }
  }

  // Cleanup jobs that haven't polled recently (dead clients)
  cleanup() {
    const now = Date.now();
    const STALE_TIMEOUT = 12000; // 12 seconds stale window (clients poll every 2s)

    // Stale ready jobs (promoted but never fetched)
    for (const [queueId, job] of this.readyJobs.entries()) {
      if (now - job.timestamp > STALE_TIMEOUT) {
        console.log(`[Queue] Ready job ${queueId} expired waiting for download initiation.`);
        this.readyJobs.delete(queueId);
      }
    }

    // Stale queued jobs (stopped polling)
    const initialQueueLength = this.queue.length;
    this.queue = this.queue.filter(job => {
      const isAlive = now - job.timestamp < STALE_TIMEOUT;
      if (!isAlive) {
        console.log(`[Queue] Queued job ${job.queueId} expired (client stopped polling).`);
      }
      return isAlive;
    });

    if (this.readyJobs.size === 0 || this.queue.length !== initialQueueLength) {
      this.processQueue();
    }
  }
}

module.exports = new DownloadQueue();
