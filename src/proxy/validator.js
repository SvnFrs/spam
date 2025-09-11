/**
 * Proxy validator module - checks which proxies are working
 */
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import cliProgress from "cli-progress";
import fs from "fs/promises";
import { CONFIG } from "../config/index.js";
import { getRandomUserAgent } from "../utils/http.js";

/**
 * Verify a single proxy
 * @param {string} proxy - Proxy URL
 * @returns {Promise<{proxy: string, working: boolean}>} Verification result
 */
export async function verifyProxy(proxy) {
  return new Promise(async (resolve) => {
    const timeoutTimer = setTimeout(() => {
      resolve({ proxy, working: false });
    }, CONFIG.PROXY_TIMEOUT);

    try {
      // Determine proxy type and create appropriate agent
      let agent;
      if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        agent = new SocksProxyAgent(proxy);
      } else {
        agent = new HttpsProxyAgent(proxy);
      }

      // Try multiple test URLs for better verification
      for (const testUrl of CONFIG.PROXY_TEST_URLS) {
        try {
          const response = await axios.get(testUrl, {
            httpsAgent: agent,
            httpAgent: agent,
            timeout: CONFIG.PROXY_TIMEOUT,
            headers: {
              "User-Agent": getRandomUserAgent(),
              "Accept": "application/json, text/plain, */*",
              "Cache-Control": "no-cache",
            },
          });

          if (response.status === 200) {
            clearTimeout(timeoutTimer);
            resolve({ proxy, working: true });
            return;
          }
        } catch (innerError) {
          // Try next test URL
          continue;
        }
      }

      // If we got here, all test URLs failed
      clearTimeout(timeoutTimer);
      resolve({ proxy, working: false });
    } catch (error) {
      clearTimeout(timeoutTimer);
      resolve({ proxy, working: false });
    }
  });
}

/**
 * Verify all proxies with progress bar
 * @param {string[]} allProxies - Array of proxy URLs to verify
 * @returns {Promise<string[]>} Array of working proxies
 */
export async function verifyProxies(allProxies) {
  console.log("\n🔍 Verifying proxies...");
  const batchSize = CONFIG.PROXY_VERIFICATION_CONCURRENCY;
  const workingProxies = [];

  const progressBar = new cliProgress.SingleBar({
    format: 'Verifying Proxies [{bar}] {percentage}% | {value}/{total} | Working: {working}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(allProxies.length, 0, {
    working: 0
  });

  for (let i = 0; i < allProxies.length; i += batchSize) {
    const batch = allProxies.slice(i, i + batchSize);

    try {
      const results = await Promise.all(
        batch.map(async (proxy) => {
          const result = await verifyProxy(proxy);
          if (result.working) workingProxies.push(proxy);
          return result;
        }),
      );

      // Update progress bar
      progressBar.update(Math.min(i + batchSize, allProxies.length), {
        working: workingProxies.length
      });
    } catch (error) {
      console.error(`Error verifying proxy batch: ${error.message}`);
    }
  }

  progressBar.stop();

  // Sort proxies by type for easier reference
  workingProxies.sort((a, b) => {
    // Put HTTP proxies first, then HTTPS, then SOCKS
    if (a.startsWith('http://') && !b.startsWith('http://')) return -1;
    if (b.startsWith('http://') && !a.startsWith('http://')) return 1;
    if (a.startsWith('https://') && !b.startsWith('https://')) return -1;
    if (b.startsWith('https://') && !a.startsWith('https://')) return 1;
    return 0;
  });

  // Save working proxies to file
  await fs.writeFile("working_proxies.txt", workingProxies.join("\n"));
  console.log(
    `\n✅ Verification complete! ${workingProxies.length}/${allProxies.length} proxies are working`,
  );

  return workingProxies;
}

/**
 * Get a random working proxy with type filtering
 * @param {string[]} workingProxies - Array of working proxies
 * @param {string|null} preferredType - Preferred proxy type
 * @returns {string|null} Random proxy or null if none available
 */
export function getRandomProxy(workingProxies, preferredType = null) {
  if (workingProxies.length === 0) return null;

  if (preferredType) {
    // Filter by type if specified
    const typeProxies = workingProxies.filter(p => p.startsWith(preferredType));
    if (typeProxies.length > 0) {
      return typeProxies[Math.floor(Math.random() * typeProxies.length)];
    }
  }

  return workingProxies[Math.floor(Math.random() * workingProxies.length)];
}