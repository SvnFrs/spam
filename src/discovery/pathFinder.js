/**
 * Path finding utilities
 */
import axios from "axios";
import * as cheerio from 'cheerio';
import cliProgress from "cli-progress";
import { CONFIG } from "../config/index.js";
import { getRandomUserAgent, createProxyAgent } from "../utils/http.js";
import { normalizeUrl } from "../utils/url.js";
import { getRandomProxy } from "../proxy/validator.js";

/**
 * Extract paths from robots.txt
 * @param {string} baseUrl - Base URL
 * @param {string|null} proxy - Proxy URL
 * @returns {Promise<string[]>} Array of paths
 */
export async function extractPathsFromRobotsTxt(baseUrl, proxy = null) {
  try {
    const robotsUrl = `${new URL(baseUrl).origin}/robots.txt`;
    console.log(`Checking robots.txt at: ${robotsUrl}`);

    const config = {
      timeout: 8000,
      headers: {
        "User-Agent": getRandomUserAgent(),
        "Accept": "text/plain,*/*"
      }
    };

    if (proxy) {
      const agent = createProxyAgent(proxy);
      config.httpAgent = agent;
      config.httpsAgent = agent;
    }

    const response = await axios.get(robotsUrl, config);
    const text = response.data;

    // Enhanced regex to extract more information
    const pathRegex = /(?:Disallow|Allow|Sitemap):\s*(\S+)/gi;
    const paths = new Set();
    const sitemaps = new Set();

    let match;
    while ((match = pathRegex.exec(text)) !== null) {
      const entry = match[0].toLowerCase();
      const path = match[1];

      if (path && path !== "/") {
        if (entry.startsWith("sitemap:")) {
          // Add sitemap URL for later processing
          sitemaps.add(path);
        } else {
          // Add disallow/allow paths
          paths.add(path);
        }
      }
    }

    // Process sitemaps to extract more URLs
    for (const sitemapUrl of sitemaps) {
      try {
        console.log(`Processing sitemap: ${sitemapUrl}`);
        const sitemapResponse = await axios.get(sitemapUrl, config);
        const $ = cheerio.load(sitemapResponse.data, { xmlMode: true });

        // Extract URLs from sitemap
        $('url > loc').each((_, element) => {
          const url = $(element).text();
          const urlObj = new URL(url);
          paths.add(urlObj.pathname);
        });
      } catch (error) {
        // Ignore sitemap processing errors
        console.log(`Error processing sitemap: ${error.message}`);
      }
    }

    console.log(`Found ${paths.size} paths in robots.txt and sitemaps`);
    return [...paths];
  } catch (error) {
    console.log(`No robots.txt found or couldn't access it: ${error.message}`);
    return [];
  }
}

/**
 * Check common paths on target URL
 * @param {string} baseUrl - Base URL
 * @param {string|null} proxy - Proxy URL
 * @param {string[]} workingProxies - Array of working proxies
 * @returns {Promise<string[]>} Array of valid paths
 */
export async function checkCommonPaths(baseUrl, proxy = null, workingProxies = []) {
  const commonPaths = CONFIG.COMMON_PATHS;
  const foundPaths = new Set();
  const baseUrlObj = new URL(baseUrl);

  console.log(`\n🔍 Testing ${commonPaths.length} common paths on ${baseUrl}`);

  // Create progress bar
  const progressBar = new cliProgress.SingleBar({
    format: 'Testing Paths [{bar}] {percentage}% | {value}/{total} | Found: {found}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(commonPaths.length, 0, {
    found: 0
  });

  // Create batches to avoid overwhelming the server
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < commonPaths.length; i += batchSize) {
    batches.push(commonPaths.slice(i, i + batchSize));
  }

  let processed = 0;

  // Process each batch
  for (const batch of batches) {
    await Promise.all(
      batch.map(async (pathToCheck) => {
        try {
          const fullUrl = `${baseUrlObj.origin}${pathToCheck}`;

          // Get a random proxy if none provided but we have working proxies
          const useProxy = proxy || (workingProxies.length > 0 ?
            getRandomProxy(workingProxies) : null);

          // Try different request methods for more thorough discovery
          for (const method of ['GET', 'HEAD']) {
            const config = {
              method,
              url: fullUrl,
              timeout: 5000,
              validateStatus: (status) => status < 400 || status === 403, // 403 Forbidden can be a good sign
              headers: {
                "User-Agent": getRandomUserAgent(),
                "Accept": "text/html,application/xhtml+xml,application/xml,application/json,*/*",
                "Cache-Control": "no-cache"
              }
            };

            if (useProxy) {
              const agent = createProxyAgent(useProxy);
              config.httpAgent = agent;
              config.httpsAgent = agent;
            }

            const response = await axios(config);

            // If we got a response that's not 404, consider it a valid path
            foundPaths.add(fullUrl);
            progressBar.update(processed + 1, { found: foundPaths.size });

            // No need to try other methods if this one worked
            break;
          }
        } catch (error) {
          // Ignore errors
        } finally {
          processed++;
          progressBar.update(processed, { found: foundPaths.size });
        }
      }),
    );

    // Slight delay between batches
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  progressBar.stop();
  console.log(`Found ${foundPaths.size} valid common paths`);
  return [...foundPaths];
}

/**
 * Extract links from HTML content
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL
 * @returns {string[]} Array of extracted URLs
 */
export function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  // Extract from various HTML elements
  const selectors = [
    'a[href]',
    'form[action]',
    'link[href]',
    'script[src]',
    'img[src]',
    'iframe[src]',
    'area[href]',
    'frame[src]',
    'embed[src]',
    'object[data]',
    'source[src]'
  ];

  selectors.forEach(selector => {
    const attrName = selector.includes('[href]') ? 'href' :
      selector.includes('[action]') ? 'action' :
        selector.includes('[data]') ? 'data' : 'src';

    $(selector).each((_, element) => {
      const urlValue = $(element).attr(attrName);
      if (urlValue) {
        const normalizedUrl = normalizeUrl(urlValue, baseUrl);
        if (normalizedUrl) links.add(normalizedUrl);
      }
    });
  });

  // Extract URLs from inline JavaScript
  $('script:not([src])').each((_, element) => {
    const scriptContent = $(element).html() || '';
    // Look for URLs in the script content
    const urlRegex = /(https?:\/\/[^\s'"]+)/g;
    let match;
    while ((match = urlRegex.exec(scriptContent)) !== null) {
      const normalizedUrl = normalizeUrl(match[1], baseUrl);
      if (normalizedUrl) links.add(normalizedUrl);
    }

    // Look for paths in the script content
    const pathRegex = /["'](\/([\w\d\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-F]{2})+)["']/gi;
    while ((match = pathRegex.exec(scriptContent)) !== null) {
      const normalizedUrl = normalizeUrl(match[1], baseUrl);
      if (normalizedUrl) links.add(normalizedUrl);
    }
  });

  // Extract API endpoints from JavaScript
  $('script').each((_, element) => {
    const scriptContent = $(element).html() || '';
    // Look for API endpoints patterns
    const apiRegex = /["'](\/api\/[\w\d\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-F]{2})+["']/gi;
    let match;
    while ((match = apiRegex.exec(scriptContent)) !== null) {
      const normalizedUrl = normalizeUrl(match[1], baseUrl);
      if (normalizedUrl) links.add(normalizedUrl);
    }
  });

  return [...links];
}