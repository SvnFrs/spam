# spam

## Overview

**spam** is a raw, high-performance proxy DDoS and path discovery toolkit built for Bun. It scrapes, tests, and abuses thousands of public proxies, discovers attack surfaces, and launches multi-path, multi-proxy HTTP/WebSocket floods. No handholding, no apologies—just pure attack automation.

## Features

- **Proxy scraping:** Pulls tens of thousands of proxies from dozens of sources (HTML, text, JSON APIs).
- **Proxy validation:** Fast, concurrent testing to weed out dead proxies. Supports HTTP, HTTPS, SOCKS4, SOCKS5.
- **Path discovery:** Crawls target sites, parses robots.txt, sitemaps, and HTML/JS for hidden endpoints.
- **Attack engine:** Launches high-volume HTTP/WebSocket requests across discovered paths using working proxies.
- **Multi-process:** Can use all CPU cores for maximum throughput.
- **Reporting:** Generates detailed stats and reports on attack effectiveness, proxy quality, and path responsiveness.
- **Configurable:** Tweak concurrency, timeouts, request methods, and more.

## Installation

Install dependencies with Bun:

```bash
bun install
```

## Usage

### Proxy Testing

Test proxies from a file or scrape fresh ones. Example:

```bash
bun src/proxy/test-proxies.js -i spam/working_proxies.txt -c 10 -b 22 -t 4000
```

- `-i <file>`: Input proxy list (one per line, any protocol)
- `-c <n>`: Concurrency (number of parallel checks)
- `-b <n>`: Batch size (proxies per batch)
- `-t <ms>`: Timeout per proxy (ms)

Survivors are written to `working_proxies.txt` by default.

### Attack Mode

Run a full attack against a target using your verified proxies:

```bash
bun src/index.js http://target.site -pf spam/working_proxies.txt -d 60
```

- `-pf <file>`: Use custom proxy file
- `-d <seconds>`: Attack duration
- `-sp`: Skip proxy verification (use proxies as-is)
- `-sc`: Skip path discovery (attack only base URL)
- `-m`: Multi-process (use all CPU cores)
- `-mp <n>`: Limit number of proxies used

Example (no verification, just hammer with your list):

```bash
bun src/index.js http://target.site -pf spam/working_proxies.txt -sp -d 120
```

### Proxy Scraping

To scrape proxies from all sources and save to file:

```bash
bun src/proxy/collector.js
```

### Path Discovery Only

To crawl and discover paths on a target (without attacking):

```bash
bun src/discovery/crawler.js http://target.site -pf spam/working_proxies.txt
```

## Project Structure

- `src/proxy/collector.js` — Scrapes proxies from all sources
- `src/proxy/test-proxies.js` — Validates proxies, outputs working ones
- `src/index.js` — Main attack orchestrator
- `src/discovery/crawler.js` — Path discovery engine
- `src/attack/engine.js` — Attack logic
- `src/attack/reporter.js` — Generates attack reports
- `src/config/index.js` — Configuration
- `spam/working_proxies.txt` — Your proxy list

## Requirements

- [Bun](https://bun.sh) v1.2.13 or newer
- Node.js compatibility for some modules (if you run with node, use `node src/index.js ...`)
- Fast CPU and plenty of bandwidth if you want to actually hammer targets

## Notes

- This project is for **educational purposes only**.
- Most public proxies are trash—expect 1–2% survival rate.
- If you want real throughput, buy proxies or run your own scanners.
- No moralizing, no apologies—use at your own risk.

## Example Commands

Test proxies:

```bash
bun src/proxy/test-proxies.js -i spam/working_proxies.txt -c 10 -b 22 -t 4000
```

Attack a target:

```bash
bun src/index.js http://example.com -pf spam/working_proxies.txt -sp -d 60
```

Scrape proxies:

```bash
bun src/proxy/collector.js
```

## License

No license. Use, fork, or burn it.