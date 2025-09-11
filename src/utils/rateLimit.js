/**
 * Rate limiter implementation to prevent overwhelming servers
 */

// Domain-specific rate limiters
const domainRateLimiters = new Map();

/**
 * Rate limiter class to prevent overwhelming targets
 */
export class RateLimiter {
  /**
   * Create a rate limiter
   * @param {number} maxRPS - Maximum requests per second
   * @param {number} timeWindow - Time window in ms
   */
  constructor(maxRPS = 100, timeWindow = 1000) {
    this.maxRPS = maxRPS;
    this.timeWindow = timeWindow;
    this.timestamps = [];
  }

  /**
   * Throttle requests if needed
   * @returns {Promise<void>}
   */
  async throttle() {
    const now = Date.now();
    // Remove timestamps outside the current time window
    this.timestamps = this.timestamps.filter(time => now - time < this.timeWindow);

    if (this.timestamps.length >= this.maxRPS) {
      // Calculate needed delay
      const delay = this.timeWindow - (now - this.timestamps[0]);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this.timestamps.push(Date.now());
  }
}

/**
 * Get a rate limiter for a specific domain
 * @param {string} domain - Target domain
 * @returns {RateLimiter} Rate limiter instance
 */
export function getRateLimiter(domain) {
  if (!domainRateLimiters.has(domain)) {
    // Create a new rate limiter for this domain
    domainRateLimiters.set(domain, new RateLimiter(50, 1000)); // 50 RPS per domain
  }
  return domainRateLimiters.get(domain);
}