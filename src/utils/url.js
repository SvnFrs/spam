/**
 * URL handling utilities
 */

/**
 * Normalize a URL, handling relative URLs properly
 * @param {string} url - URL to normalize
 * @param {string} baseUrl - Base URL for relative URLs
 * @returns {string|null} Normalized URL or null if invalid
 */
export function normalizeUrl(url, baseUrl) {
  try {
    // Skip empty URLs and special protocols
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith("mailto:") || url.startsWith("tel:") ||
      url.startsWith("javascript:") || url.startsWith("#")) {
      return null;
    }

    // Handle relative URLs
    if (url.startsWith("/")) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${url}`;
    }
    // Handle full URLs
    else if (url.startsWith("http")) {
      return url;
    }
    // Handle protocol-relative URLs
    else if (url.startsWith("//")) {
      const base = new URL(baseUrl);
      return `${base.protocol}${url}`;
    }
    // Handle relative URLs without leading slash
    else {
      const base = new URL(baseUrl);
      // Handle base paths properly
      let basePath = base.pathname;
      if (!basePath.endsWith('/')) {
        // Remove the file part of the path
        basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1);
      }
      return `${base.protocol}//${base.host}${basePath}${url}`;
    }
  } catch (err) {
    return null;
  }
}

/**
 * Check if URL is from the same host as baseUrl
 * @param {string} url - URL to check
 * @param {string} baseUrl - Base URL to compare against
 * @returns {boolean} True if same host
 */
export function isSameHost(url, baseUrl) {
  try {
    const urlObj = new URL(url);
    const baseObj = new URL(baseUrl);

    // Consider subdomains of the same domain as same host
    const urlDomain = urlObj.hostname;
    const baseDomain = baseObj.hostname;

    // Extract base domain (e.g., example.com from sub.example.com)
    const getBaseDomain = (hostname) => {
      const parts = hostname.split('.');
      if (parts.length <= 2) return hostname;
      // Handle special cases like co.uk, com.au
      if (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com') {
        if (parts.length > 3) {
          return parts.slice(-3).join('.');
        }
      }
      return parts.slice(-2).join('.');
    };

    const urlBaseDomain = getBaseDomain(urlDomain);
    const baseBaseDomain = getBaseDomain(baseDomain);

    return urlBaseDomain === baseBaseDomain;
  } catch (err) {
    return false;
  }
}
