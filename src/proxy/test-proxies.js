// test-proxies.js
/**
 * Bun-optimized high-performance proxy testing utility (validation only)
 * - Early & hard timeouts with AbortController (true cancellation)
 * - Keep-alive proxy agents to cut handshake overhead
 * - High, bounded concurrency with light adaptive backoff
 * - Batch processing to keep memory stable
 * - Optional write-through so crashes don't lose progress
 *
 * Usage:
 *   bun test-proxies.js [-i file] [-o file] [-t ms] [-c n] [-b n] [-f] [--append] [--meta] [--max N]
 */

import fs from "fs/promises";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import cliProgress from "cli-progress";
import { CONFIG } from "../config/index.js";
import { getAllProxies } from "./collector.js";

// ---- Defaults (tuned for Bun on a mid/high core box) ----
const DEFAULT_CONCURRENCY = 650;
const DEFAULT_TIMEOUT = 4000;          // hard timeout per request
const DEFAULT_BATCH_SIZE = 1000;
const EARLY_TERMINATION_MS = 1500;     // early abort to avoid long stalls

// ---- CLI ----
function printHelp() {
  console.log(`
    ╔═════════════════════════════════════════════════════════════════════╗
    ║                Bun-Optimized Proxy Testing Utility                  ║
    ╠═════════════════════════════════════════════════════════════════════╣
    ║ Usage:                                                              ║
    ║   bun test-proxies.js [options]                                     ║
    ║                                                                     ║
    ║ Options:                                                            ║
    ║   -h, --help              Show this help message                    ║
    ║   -i, --input <file>      Input file with proxy list                ║
    ║   -o, --output <file>     Output file for verified proxies          ║
    ║                           (default: working_proxies.txt)            ║
    ║   -t, --timeout <ms>      Timeout per check (default: ${DEFAULT_TIMEOUT})  ║
    ║   -c, --concurrency <n>   Concurrent checks (default: ${DEFAULT_CONCURRENCY})║
    ║   -b, --batch <n>         Batch size (default: ${DEFAULT_BATCH_SIZE})       ║
    ║   -f, --fast              Ultra-fast mode (lower timeouts)          ║
    ║       --append            Append survivors as they're found         ║
    ║       --meta              Also write JSON with latency & endpoint   ║
    ║       --max <N>           Cap number of candidates tested           ║
    ║                                                                     ║
    ║ Examples:                                                           ║
    ║   bun test-proxies.js -i proxies.txt -o verified.txt -c 800         ║
    ║   bun test-proxies.js -t 3000 -c 1000 -f --append --meta            ║
    ╚═════════════════════════════════════════════════════════════════════╝
  `);
}

function parseArguments() {
  const args = process.argv.slice(2);
  const options = {
    inputFile: null,
    outputFile: "working_proxies.txt",
    timeout: DEFAULT_TIMEOUT,
    concurrency: DEFAULT_CONCURRENCY,
    batchSize: DEFAULT_BATCH_SIZE,
    fastMode: false,
    earlyTerminationMs: EARLY_TERMINATION_MS,
    append: false,
    writeMeta: false,
    max: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if ((a === "-i" || a === "--input") && i + 1 < args.length) {
      options.inputFile = args[++i];
    } else if ((a === "-o" || a === "--output") && i + 1 < args.length) {
      options.outputFile = args[++i];
    } else if ((a === "-t" || a === "--timeout") && i + 1 < args.length) {
      options.timeout = parseInt(args[++i], 10);
    } else if ((a === "-c" || a === "--concurrency") && i + 1 < args.length) {
      options.concurrency = parseInt(args[++i], 10);
    } else if ((a === "-b" || a === "--batch") && i + 1 < args.length) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (a === "-f" || a === "--fast") {
      options.fastMode = true;
      options.timeout = Math.min(options.timeout, 2500);
      options.earlyTerminationMs = Math.min(options.earlyTerminationMs, 1000);
    } else if (a === "--append") {
      options.append = true;
    } else if (a === "--meta") {
      options.writeMeta = true;
    } else if (a === "--max" && i + 1 < args.length) {
      options.max = parseInt(args[++i], 10);
    }
  }
  return options;
}

// ---- IO helpers ----
async function readFileIfExists(filename) {
  try {
    const content = await fs.readFile(filename, "utf8");
    return content.split("\n").map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function saveToFile(filename, content) {
  try {
    // backup existing
    try {
      const st = await fs.stat(filename);
      if (st.isFile()) {
        const backup = `${filename}.backup-${Date.now()}`;
        await fs.copyFile(filename, backup);
        console.log(`✅ Backup created: ${backup}`);
      }
    } catch { }
    await fs.writeFile(filename, content);
    console.log(`✅ Saved to ${filename}`);
  } catch (e) {
    console.error(`❌ Error saving to ${filename}: ${e.message}`);
  }
}

// ---- Proxy check core ----
const DEFAULT_TEST_URLS = [
  "http://httpbin.org/ip",
  "https://api.ipify.org?format=json",
  "https://api.myip.com",
];

function getTestUrls() {
  const urls = Array.isArray(CONFIG?.PROXY_TEST_URLS) && CONFIG.PROXY_TEST_URLS.length
    ? CONFIG.PROXY_TEST_URLS
    : DEFAULT_TEST_URLS;
  return urls.slice(); // shallow copy
}

function makeAgent(proxyUrl) {
  // Keep-alive reduces cost of TLS handshakes
  const agentOpts = { keepAlive: true };
  if (/^socks[45]:\/\//i.test(proxyUrl)) return new SocksProxyAgent(proxyUrl, agentOpts);
  return new HttpsProxyAgent(proxyUrl, agentOpts);
}

/**
 * Validate a single proxy (true cancellation via AbortController)
 * @returns {Promise<{ok:boolean, ms?:number, endpoint?:string, proto?:string, aborted?:boolean}>}
 */
async function testProxy(proxy, testUrls, options) {
  const controller = new AbortController();
  const earlyTimer = setTimeout(() => controller.abort(), options.earlyTerminationMs);
  const hardTimer = setTimeout(() => controller.abort(), options.timeout);

  const clearTimers = () => {
    clearTimeout(earlyTimer);
    clearTimeout(hardTimer);
  };

  try {
    const agent = makeAgent(proxy);
    const t0 = Date.now();

    for (const url of testUrls) {
      try {
        const res = await axios.get(url, {
          httpAgent: agent,
          httpsAgent: agent,
          signal: controller.signal,
          timeout: options.timeout, // extra guard; AbortController is primary
          headers: {
            "User-Agent": "ProxyValidator/1.0 (+legit scraping; contact admin)",
            "Accept": "application/json,text/plain,*/*",
          },
          validateStatus: s => s >= 200 && s < 400,
        });
        clearTimers();
        return {
          ok: true,
          ms: Date.now() - t0,
          endpoint: url,
          proto: proxy.split("://")[0].toLowerCase(),
        };
      } catch (e) {
        if (controller.signal.aborted) {
          clearTimers();
          return { ok: false, aborted: true };
        }
        // try next url
      }
    }
    clearTimers();
    return { ok: false };
  } catch {
    clearTimers();
    return { ok: false };
  }
}

/**
 * Process a batch with bounded concurrency and light adaptive backoff.
 * - Lowers concurrency by 10% if recent success rate < 10% over last window.
 */
async function testProxyBatch(proxies, options) {
  const results = [];
  const meta = [];
  const testUrls = getTestUrls();

  const bar = new cliProgress.SingleBar({
    format: 'Testing Proxies [{bar}] {percentage}% | {value}/{total} | Working: {ok} | {speed} p/s | Concurrency: {cc}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
  });
  bar.start(proxies.length, 0, { ok: 0, speed: 0, cc: options.concurrency });

  // queue with manual concurrency
  let cc = Math.max(1, options.concurrency);
  const queue = proxies.slice();
  const active = new Set();

  let processed = 0;
  let okCount = 0;
  let windowProcessed = 0;
  let windowOk = 0;
  const tStart = Date.now();

  async function kick() {
    while (active.size < cc && queue.length > 0) {
      const proxy = queue.shift();
      const task = (async () => {
        const res = await testProxy(proxy, testUrls, options);
        processed++;
        windowProcessed++;
        if (res.ok) {
          okCount++;
          windowOk++;
          meta.push({ proxy, ms: res.ms, endpoint: res.endpoint, proto: res.proto });
          results.push(proxy);
          if (options.append) {
            // write-through: append survivor immediately
            try { await fs.appendFile(options.outputFile, proxy + "\n"); } catch { }
          }
        }
        if (processed % 100 === 0 || processed === proxies.length) {
          const elapsed = Math.max(1, (Date.now() - tStart) / 1000);
          const speed = Math.round(processed / elapsed);
          bar.update(processed, { ok: okCount, speed, cc });
        }
      })();

      active.add(task);
      task.finally(() => {
        active.delete(task);
        // Try to keep the pipeline full
        kick();
      });
    }
  }

  // Start initial workers
  kick();

  // Periodic adaptive backoff
  const adjustTimer = setInterval(() => {
    // every second, check last window
    const successRate = windowProcessed ? (windowOk / windowProcessed) : 1;
    // If success is extremely low, reduce pressure a bit
    if (windowProcessed >= 500 && successRate < 0.1 && cc > 50) {
      cc = Math.max(50, Math.floor(cc * 0.9));
    } else if (windowProcessed >= 500 && successRate > 0.4) {
      // cautiously ramp up if doing fine
      cc = Math.min(cc + 20, options.concurrency);
    }
    // reset window
    windowProcessed = 0;
    windowOk = 0;
    bar.update(processed, { ok: okCount, cc });
    // keep workers topped up if idle
    kick();
  }, 1000);

  // Wait for completion
  while (active.size > 0 || queue.length > 0) {
    // Avoid tight loop
    await Promise.race(active).catch(() => { });
  }
  clearInterval(adjustTimer);

  const elapsed = Math.max(1, (Date.now() - tStart) / 1000);
  const speed = Math.round(processed / elapsed);
  bar.update(proxies.length, { ok: okCount, speed, cc });
  bar.stop();

  // sort survivors by latency asc
  meta.sort((a, b) => a.ms - b.ms);
  results.sort((a, b) => {
    const am = meta.find(x => x.proxy === a)?.ms ?? Infinity;
    const bm = meta.find(x => x.proxy === b)?.ms ?? Infinity;
    return am - bm;
  });

  return { survivors: results, meta };
}

// ---- Main ----
async function main() {
  const options = parseArguments();

  console.log(`
    🚀 Bun-Optimized Proxy Testing (validation only)
    ⚙️ Timeout: ${options.timeout}ms
    ⚙️ Concurrency (max): ${options.concurrency}
    ⚙️ Batch size: ${options.batchSize}
    ⚙️ Fast mode: ${options.fastMode ? "Enabled" : "Disabled"}
    ⚙️ Append survivors: ${options.append ? "Yes" : "No"}
    ⚙️ Write meta JSON: ${options.writeMeta ? "Yes" : "No"}
  `);

  // Prepare output if append mode (ensure file exists/cleared)
  if (!options.append) {
    try { await fs.rm(options.outputFile, { force: true }); } catch { }
  }

  let candidates = [];
  if (options.inputFile) {
    console.log(`📡 Loading proxies from ${options.inputFile}...`);
    candidates = await readFileIfExists(options.inputFile);
  } else {
    console.log("📡 Fetching proxies from multiple sources...");
    candidates = await getAllProxies(); // must return ["proto://ip:port", ...]
  }

  // De-dup & optional cap
  const seen = new Set();
  const normalized = [];
  for (const p of candidates) {
    const s = (p || "").trim();
    if (!s) continue;
    const key = s.replace(/\/+$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }
  const all = options.max > 0 ? normalized.slice(0, options.max) : normalized;

  if (all.length === 0) {
    console.error("❌ No proxies found. Cannot proceed.");
    return;
  }

  console.log(`\n🔍 Testing ${all.length} proxies...`);

  // Split into batches for stability
  const batches = [];
  for (let i = 0; i < all.length; i += options.batchSize) {
    batches.push(all.slice(i, i + options.batchSize));
  }

  const globalMeta = [];
  const survivorsAll = [];

  const t0 = Date.now();
  for (let bi = 0; bi < batches.length; bi++) {
    const chunk = batches[bi];
    console.log(`\n📦 Batch ${bi + 1}/${batches.length} (${chunk.length} proxies)`);
    const { survivors, meta } = await testProxyBatch(chunk, options);
    survivorsAll.push(...survivors);
    globalMeta.push(...meta);
  }

  // Sort final survivors by latency
  globalMeta.sort((a, b) => a.ms - b.ms);
  const survivorsSorted = globalMeta.map(x => x.proxy);

  // Save outputs
  await saveToFile(options.outputFile, survivorsSorted.join("\n"));

  if (options.writeMeta) {
    const metaFile = options.outputFile.replace(/(\.txt)?$/, ".meta.json");
    await saveToFile(metaFile, JSON.stringify(globalMeta, null, 2));
  }

  const elapsed = (Date.now() - t0) / 1000;
  const http = survivorsSorted.filter(p => p.startsWith("http://")).length;
  const https = survivorsSorted.filter(p => p.startsWith("https://")).length;
  const socks4 = survivorsSorted.filter(p => p.startsWith("socks4://")).length;
  const socks5 = survivorsSorted.filter(p => p.startsWith("socks5://")).length;

  console.log(`
✅ Done!
   Working proxies: ${survivorsSorted.length} / ${all.length}
   Success rate   : ${((survivorsSorted.length / all.length) * 100).toFixed(2)}%
   Total time     : ${elapsed.toFixed(2)}s
   Throughput     : ${Math.round(all.length / Math.max(1, elapsed))} proxies/sec

📊 Types:
   HTTP   : ${http}
   HTTPS  : ${https}
   SOCKS4 : ${socks4}
   SOCKS5 : ${socks5}
`);
}

main().catch((err) => {
  console.error("Fatal error:", err?.stack || err?.message || String(err));
});
