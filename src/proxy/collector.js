/**
 * Proxy collector module - fetches proxies from various sources
 */
import axios from "axios";
import * as cheerio from 'cheerio';
import fs from "fs/promises";
import { CONFIG } from "../config/index.js";
import { getRandomUserAgent } from "../utils/http.js";

/**
 * Scrape proxies from HTML sources
 * @param {string} url - Source URL
 * @returns {Promise<string[]>} Array of proxy URLs
 */
export async function scrapeHtmlProxyList(url) {
  try {
    console.log(`Scraping proxies from ${url}`);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
    const $ = cheerio.load(response.data);
    const proxies = [];

    // For free-proxy-list.net structure
    $("table tbody tr").each((i, element) => {
      const ip = $(element).find("td:nth-child(1)").text().trim();
      const port = $(element).find("td:nth-child(2)").text().trim();
      if (ip && port) {
        proxies.push(`http://${ip}:${port}`);
      }
    });

    console.log(`Found ${proxies.length} proxies from HTML source`);
    return proxies;
  } catch (error) {
    console.error(`Failed to scrape HTML proxies from ${url}:`, error.message);
    return [];
  }
}

/**
 * Parse JSON API responses for proxies
 * @param {string} url - API URL
 * @returns {Promise<string[]>} Array of proxy URLs
 */
export async function scrapeJsonProxyList(url) {
  try {
    console.log(`Scraping proxies from API: ${url}`);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json'
      }
    });

    const proxies = [];

    // Handle different API formats
    if (url.includes('proxylist.geonode.com')) {
      // Format: { data: [{ip, port, protocols}, ...] }
      if (response.data && response.data.data) {
        response.data.data.forEach(item => {
          if (item.ip && item.port) {
            // Check each protocol
            if (item.protocols) {
              item.protocols.forEach(protocol => {
                proxies.push(`${protocol}://${item.ip}:${item.port}`);
              });
            } else {
              // Default to http if no protocol specified
              proxies.push(`http://${item.ip}:${item.port}`);
            }
          }
        });
      }
    } else if (url.includes('proxyscrape.com')) {
      // Format: { proxies: [{protocol, ip, port}, ...] }
      if (response.data && response.data.proxies) {
        response.data.proxies.forEach(item => {
          if (item.ip && item.port) {
            proxies.push(`${item.protocol || 'http'}://${item.ip}:${item.port}`);
          }
        });
      }
    } else {
      // Generic JSON handling - look for common property names
      const data = response.data;
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.ip && item.port) {
            proxies.push(`${item.protocol || 'http'}://${item.ip}:${item.port}`);
          }
        });
      } else if (typeof data === 'object') {
        // Try to find arrays in the response
        Object.values(data).forEach(value => {
          if (Array.isArray(value)) {
            value.forEach(item => {
              if (item.ip && item.port) {
                proxies.push(`${item.protocol || 'http'}://${item.ip}:${item.port}`);
              }
            });
          }
        });
      }
    }

    console.log(`Found ${proxies.length} proxies from JSON API`);
    return proxies;
  } catch (error) {
    console.error(`Failed to scrape JSON proxies from ${url}:`, error.message);
    return [];
  }
}

/**
 * Get proxies from text-based lists
 * @param {string} url - Text list URL
 * @returns {Promise<string[]>} Array of proxy URLs
 */
export async function getTextProxyList(url) {
  try {
    console.log(`Fetching proxies from ${url}`);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': getRandomUserAgent()
      }
    });

    // Try to determine if the response is JSON first
    try {
      if (typeof response.data === 'string' &&
        (response.data.startsWith('{') || response.data.startsWith('['))) {
        const jsonData = JSON.parse(response.data);
        return []; // If it's JSON, let the JSON handler deal with it
      }
    } catch (e) {
      // Not JSON, continue with text processing
    }

    const proxies = [];
    if (typeof response.data === 'string') {
      const lines = response.data
        .split("\n")
        .filter((line) => line.trim() !== "");

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Check for IP:PORT format
        const ipPortRegex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/;
        const match = trimmedLine.match(ipPortRegex);

        if (match) {
          const ip = match[1];
          const port = match[2];

          // Detect protocol or default to http
          let protocol = 'http';
          if (trimmedLine.includes('socks4://')) {
            protocol = 'socks4';
          } else if (trimmedLine.includes('socks5://')) {
            protocol = 'socks5';
          } else if (trimmedLine.includes('https://')) {
            protocol = 'https';
          }

          proxies.push(`${protocol}://${ip}:${port}`);
        } else if (trimmedLine.includes('://')) {
          // Already has protocol specified
          proxies.push(trimmedLine);
        }
      }
    }

    console.log(`Found ${proxies.length} proxies from text source`);
    return proxies;
  } catch (error) {
    console.error(`Failed to fetch text proxies from ${url}:`, error.message);
    return [];
  }
}

/**
 * Fetch proxies from all configured sources
 * @returns {Promise<string[]>} Array of unique proxies
 */
export async function getAllProxies() {
  console.log("📡 Fetching proxies from multiple sources...");
  const allProxies = [];

  for (const url of CONFIG.PROXY_SOURCES) {
    try {
      let proxies = [];

      if (url.includes("free-proxy-list.net")) {
        proxies = await scrapeHtmlProxyList(url);
      } else if (url.includes("json") || url.includes("api")) {
        proxies = await scrapeJsonProxyList(url);
      } else {
        proxies = await getTextProxyList(url);
      }

      allProxies.push(...proxies);
    } catch (error) {
      console.error(`Error processing ${url}:`, error.message);
    }
  }

  // Remove duplicates and normalize formats
  const uniqueProxies = [...new Set(allProxies)].map(proxy => {
    // Ensure all proxies have a protocol prefix
    if (!proxy.includes('://')) {
      return `http://${proxy}`;
    }
    return proxy;
  });

  console.log(`\nTotal unique proxies found: ${uniqueProxies.length}`);

  // Save to file for reference
  await fs.writeFile("all_proxies.txt", uniqueProxies.join("\n"));
  return uniqueProxies;
}