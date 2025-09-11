/**
 * Web crawler module for discovering paths on target sites
 */
import axios from "axios";
import * as cheerio from 'cheerio';
import cliProgress from "cli-progress";
import fs from "fs/promises";
import { CONFIG } from "../config/index.js";
import { getRandomProxy } from "../proxy/validator.js";
import { extractLinks } from "./pathFinder.js";
import { extractPathsFromRobotsTxt, checkCommonPaths } from "./pathFinder.js";
import { normalizeUrl, isSameHost } from "../utils/url.js";
import { getRandomUserAgent, createProxyAgent } from "../utils/http.js";

/**
 * Discover paths on a target website
 * @param {string} baseUrl - Base URL to crawl
 * @param {string[]} workingProxies - Array of working proxies
 * @returns {Promise<string[]>} Discovered paths
 */
export async function discoverPaths(baseUrl, workingProxies) {
  console.log(`\n🕸️ Starting path discovery on ${baseUrl}...`);

  const visited = new Set();
  const queue = [baseUrl];
  const baseUrlObj = new URL(baseUrl);
  const foundPaths = new Set();
  const failedPaths = new Set();

  // Create a map to track depth of each URL
  const urlDepth = new Map();
  urlDepth.set(baseUrl, 0);

  // Always check robots.txt first (using a random proxy for privacy)
  const proxy = getRandomProxy(workingProxies);
  const robotsPaths = await extractPathsFromRobotsTxt(baseUrl, proxy);

  // Add all paths from robots.txt
  robotsPaths.forEach((robotsPath) => {
    const fullUrl = `${baseUrlObj.origin}${robotsPath}`;
    foundPaths.add(fullUrl);
    if (!visited.has(fullUrl)) {
      queue.push(fullUrl);
      visited.add(fullUrl);
      urlDepth.set(fullUrl, 1); // Consider robots.txt paths as depth 1
    }
  });

  // Check common paths
  const commonFoundPaths = await checkCommonPaths(baseUrl, proxy, workingProxies);

  // Add common paths to our queues
  commonFoundPaths.forEach((path) => {
    foundPaths.add(path);
    if (!visited.has(path)) {
      queue.push(path);
      visited.add(path);
      urlDepth.set(path, 1); // Consider common paths as depth 1
    }
  });

  // Create progress bar
  const progressBar = new cliProgress.SingleBar({
    format: 'Crawling [{bar}] URLs Checked: {checked}/{total} | Found: {found}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(queue.length, 0, {
    found: foundPaths.size,
    checked: 0
  });

  // Process URLs with proper concurrency control
  while (queue.length > 0 && foundPaths.size < CONFIG.MAX_PATHS_TO_DISCOVER) {
    const batchSize = Math.min(CONFIG.MAX_CONCURRENT_CRAWLS, queue.length);
    const batch = queue.splice(0, batchSize);
    const batchPromises = [];

    for (const currentUrl of batch) {
      // Skip if we exceed the maximum depth
      const depth = urlDepth.get(currentUrl) || 0;
      if (depth >= CONFIG.CRAWL_DEPTH) continue;

      batchPromises.push((async () => {
        try {
          // Pick a random proxy for each request
          const crawlProxy = getRandomProxy(workingProxies);

          const response = await axios.get(currentUrl, {
            timeout: 12000,
            maxRedirects: 5,
            headers: {
              "User-Agent": getRandomUserAgent(Math.random() > 0.8), // 20% chance of mobile
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Cache-Control": "no-cache",
            },
            ...(crawlProxy ? {
              httpAgent: crawlProxy.startsWith('socks') ?
                createProxyAgent(crawlProxy) : createProxyAgent(crawlProxy),
              httpsAgent: crawlProxy.startsWith('socks') ?
                createProxyAgent(crawlProxy) : createProxyAgent(crawlProxy)
            } : {}),
          });

          foundPaths.add(currentUrl);

          // Extract links from the page
          if (
            response.headers["content-type"] &&
            response.headers["content-type"].includes("text/html")
          ) {
            const links = extractLinks(response.data, currentUrl);
            const newDepth = depth + 1;

            for (const link of links) {
              // Only process links from the same host
              if (isSameHost(link, baseUrl) && !visited.has(link)) {
                visited.add(link);

                // Only add to queue if we haven't reached max depth
                if (newDepth < CONFIG.CRAWL_DEPTH) {
                  queue.push(link);
                  urlDepth.set(link, newDepth);
                }

                // Always add to foundPaths even if we don't crawl further
                foundPaths.add(link);

                // Check if we've found enough paths
                if (foundPaths.size >= CONFIG.MAX_PATHS_TO_DISCOVER) {
                  break;
                }
              }
            }
          }
        } catch (error) {
          failedPaths.add(currentUrl);
        }
      })());
    }

    // Wait for the batch to complete
    await Promise.all(batchPromises);

    // Update progress bar
    progressBar.update(visited.size, {
      found: foundPaths.size,
      checked: visited.size,
      total: visited.size + queue.length
    });

    // Add small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  progressBar.stop();

  console.log(
    `\n✅ Path discovery complete! Found ${foundPaths.size} valid paths (${failedPaths.size} failed)`,
  );

  // Filter out API endpoints and interesting paths for separate tracking
  const apiEndpoints = [...foundPaths].filter(p =>
    p.includes('/api/') || p.includes('/graphql') || p.includes('/wp-json')
  );

  if (apiEndpoints.length > 0) {
    console.log(`🔍 Discovered ${apiEndpoints.length} API endpoints`);
    await fs.writeFile("discovered_apis.txt", apiEndpoints.join("\n"));
  }

  // Save paths to file
  await fs.writeFile("discovered_paths.txt", [...foundPaths].join("\n"));
  return [...foundPaths];
}