/**
 * HTTP utilities for making requests and handling responses
 */
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { CONFIG } from "../config/index.js";
import { getRateLimiter } from "./rateLimit.js";

/**
 * Get a random user agent with optional mobile preference
 * @param {boolean} preferMobile - Whether to prefer mobile user agents
 * @returns {string} A random user agent string
 */
export function getRandomUserAgent(preferMobile = false) {
  const agents = CONFIG.USER_AGENTS;
  if (preferMobile) {
    const mobileAgents = agents.filter(ua =>
      ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone") || ua.includes("iPad")
    );
    if (mobileAgents.length > 0) {
      return mobileAgents[Math.floor(Math.random() * mobileAgents.length)];
    }
  }
  return agents[Math.floor(Math.random() * agents.length)];
}

/**
 * Create the appropriate proxy agent based on proxy type
 * @param {string} proxy - Proxy URL
 * @returns {Object|null} Proxy agent or null
 */
export function createProxyAgent(proxy) {
  if (!proxy) return null;

  if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
    return new SocksProxyAgent(proxy);
  } else {
    return new HttpsProxyAgent(proxy);
  }
}

/**
 * Generate random headers for requests
 * @param {string} url - Target URL
 * @param {string|null} referer - Optional referer
 * @returns {Object} Headers object
 */
export function getRandomHeaders(url, referer = null) {
  const headers = {
    "User-Agent": getRandomUserAgent(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };

  // Add referer header if provided
  if (referer) {
    headers["Referer"] = referer;
  } else if (Math.random() > 0.5) {
    // Add a search engine referer 50% of the time
    const searchEngines = [
      "https://www.google.com/search?q=site:",
      "https://www.bing.com/search?q=site:",
      "https://search.yahoo.com/search?p=site:"
    ];
    headers["Referer"] = searchEngines[Math.floor(Math.random() * searchEngines.length)] + new URL(url).hostname;
  }

  // Add WAF bypass headers if enabled
  if (CONFIG.BYPASS_TECHNIQUES.WAF) {
    const bypassHeaders = CONFIG.BYPASS_HEADERS;
    const randomIp = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    // Choose random keys from bypass headers
    const bypassKeys = Object.keys(bypassHeaders);
    const numHeaders = Math.floor(Math.random() * 3) + 1; // Add 1-3 random headers

    for (let i = 0; i < numHeaders; i++) {
      const key = bypassKeys[Math.floor(Math.random() * bypassKeys.length)];
      headers[key] = bypassHeaders[key].replace('127.0.0.1', randomIp);
    }
  }

  return headers;
}

/**
 * Send a request to the target with retry support
 * @param {string} target - Target URL
 * @param {string|null} proxy - Proxy URL
 * @param {string} method - HTTP method
 * @param {Object|null} data - Request data
 * @param {number} retries - Number of retries
 * @returns {Promise<Object>} Response data
 */
export async function sendRequest(target, proxy, method = "GET", data = null, retries = CONFIG.RETRY_FAILED_REQUESTS) {
  return new Promise(async (resolve) => {
    const url = new URL(target);

    // Rate limiting to prevent self-DoS
    await getRateLimiter(url.hostname).throttle();

    const sendWithRetry = async (attemptsLeft) => {
      try {
        const proxyAgent = proxy ? createProxyAgent(proxy) : null;

        const options = {
          method: method,
          timeout: CONFIG.REQUEST_TIMEOUT,
          headers: getRandomHeaders(target),
          validateStatus: function (status) {
            return status >= 200 && status < 600; // Accept all responses
          }
        };

        if (proxyAgent) {
          options.httpAgent = proxyAgent;
          options.httpsAgent = proxyAgent;
        }

        // Add data for POST/PUT requests
        if ((method === "POST" || method === "PUT") && data) {
          options.data = data;

          // Set appropriate content type
          if (typeof data === 'object') {
            options.headers["Content-Type"] = "application/json";
          }
        }

        // Send the request
        const response = await axios(target, options);

        resolve({
          status: response.status,
          responseSize: response.data ?
            (typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data).length) : 0,
          data: response.data,
          headers: response.headers,
          success: true
        });
      } catch (error) {
        if (attemptsLeft > 0) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
          return sendWithRetry(attemptsLeft - 1);
        } else {
          resolve({
            status: 0,
            responseSize: 0,
            success: false,
            error: error.message
          });
        }
      }
    };

    await sendWithRetry(retries);
  });
}

/**
 * Detect protections on a target site
 * @param {string} target - Target URL
 * @returns {Promise<Object|null>} Detected protections
 */
export async function detectProtections(target) {
  console.log(`\n🔍 Detecting protections on ${target}...`);

  try {
    const response = await axios.get(target, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent": getRandomUserAgent(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
      }
    });

    const protections = {
      cloudflare: false,
      captcha: false,
      waf: false,
      rateLimit: false,
      ddosProtection: false
    };

    // Check response headers and body for signs of protection
    const headers = response.headers;
    const body = typeof response.data === 'string' ? response.data : '';

    // Cloudflare detection
    if (
      headers['server']?.includes('cloudflare') ||
      headers['cf-ray'] ||
      body.includes('Cloudflare') && body.includes('security')
    ) {
      protections.cloudflare = true;
    }

    // CAPTCHA detection
    if (
      body.includes('captcha') ||
      body.includes('CAPTCHA') ||
      body.includes('recaptcha') ||
      body.includes('hcaptcha')
    ) {
      protections.captcha = true;
    }

    // WAF detection
    if (
      headers['x-firewall-blocked'] ||
      headers['x-sucuri-id'] ||
      headers['x-mod-security'] ||
      body.includes('firewall') && body.includes('blocked') ||
      body.includes('security') && body.includes('violation') ||
      body.includes('WAF')
    ) {
      protections.waf = true;
    }

    // Rate limiting detection
    if (
      headers['retry-after'] ||
      response.status === 429 ||
      body.includes('rate limit') ||
      body.includes('too many requests')
    ) {
      protections.rateLimit = true;
    }

    // DDoS protection detection
    if (
      headers['x-ddos-protection'] ||
      body.includes('DDoS') && body.includes('protection') ||
      body.includes('attack') && body.includes('detected')
    ) {
      protections.ddosProtection = true;
    }

    console.log("\nDetected protections:");
    for (const [protection, detected] of Object.entries(protections)) {
      console.log(`  ${protection}: ${detected ? '✅ Detected' : '❌ Not detected'}`);
    }

    return protections;
  } catch (error) {
    console.log(`Error detecting protections: ${error.message}`);
    return null;
  }
}