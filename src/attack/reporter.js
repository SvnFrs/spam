/**
 * Attack reporting module
 */
import fs from "fs/promises";

/**
 * Generate attack report
 * @param {Object} stats - Attack statistics
 * @returns {Promise<void>}
 */
export async function generateReport(stats) {
  console.log("\n\n📊 Attack Results:");
  console.log(`Target: ${stats.target}`);
  console.log(`Duration: ${stats.duration.toFixed(2)} seconds`);
  console.log(`Paths Attacked: ${stats.paths}`);
  console.log(`Total Requests: ${stats.totalRequests} (${stats.requestsPerSecond} req/sec)`);
  console.log(`HTTP Requests: Successful: ${stats.successCount}, Failed: ${stats.failCount}`);
  console.log(`WebSocket Connections: Successful: ${stats.wsSuccessCount}, Failed: ${stats.wsFailCount}`);
  console.log(`Data Transmitted: ${(stats.bytesSent / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Data Received: ${(stats.bytesReceived / (1024 * 1024)).toFixed(2)} MB`);

  // Status code distribution
  console.log("\n📈 Status Code Distribution:");

  // Sort status codes for nicer display
  const sortedStatusCodes = Object.entries(stats.statusCodes).sort((a, b) =>
    parseInt(a[0]) - parseInt(b[0]));

  const statusGroups = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0
  };

  for (const [status, count] of sortedStatusCodes) {
    const statusNum = parseInt(status);
    if (statusNum >= 200 && statusNum < 300) statusGroups['2xx'] += count;
    else if (statusNum >= 300 && statusNum < 400) statusGroups['3xx'] += count;
    else if (statusNum >= 400 && statusNum < 500) statusGroups['4xx'] += count;
    else if (statusNum >= 500) statusGroups['5xx'] += count;

    console.log(`  ${status}: ${count} (${(count / stats.totalRequests * 100).toFixed(1)}%)`);
  }

  console.log("\nStatus Groups:");
  for (const [group, count] of Object.entries(statusGroups)) {
    if (count > 0) {
      console.log(`  ${group}: ${count} (${(count / stats.totalRequests * 100).toFixed(1)}%)`);
    }
  }

  // HTTP method effectiveness
  console.log("\n📊 HTTP Method Effectiveness:");
  for (const [method, methodStats] of Object.entries(stats.methodStats)) {
    const total = methodStats.success + methodStats.failed;
    if (total > 0) {
      const successRate = (methodStats.success / total * 100).toFixed(1);
      console.log(`  ${method}: ${methodStats.success}/${total} (${successRate}% success)`);
    }
  }

  // Sort proxies by effectiveness
  const proxyEffectiveness = stats.proxyStats
    .map(([proxy, stats]) => ({
      proxy,
      requests: stats.requests,
      success: stats.success,
      failed: stats.failed,
      successRate: stats.requests > 0 ? stats.success / stats.requests : 0
    }))
    .sort((a, b) => b.successRate - a.successRate)
    .filter(p => p.requests > 10); // Only show proxies with more than 10 requests

  console.log("\n⭐ Most effective proxies:");
  proxyEffectiveness.slice(0, 10).forEach((result, index) => {
    console.log(
      `${index + 1}. ${result.proxy} - ${result.success}/${result.requests} successful (${(result.successRate * 100).toFixed(1)}%)`,
    );
  });

  // Sort paths by success rate
  const pathEffectiveness = stats.pathStats
    .map(([path, pathStat]) => ({
      path,
      success: pathStat.success,
      failed: pathStat.failed,
      total: pathStat.success + pathStat.failed,
      successRate: (pathStat.success + pathStat.failed) > 0 ?
        pathStat.success / (pathStat.success + pathStat.failed) : 0,
      avgResponseSize: pathStat.avgResponseSize
    }))
    .filter(p => p.total > 5) // Only show paths with more than 5 requests
    .sort((a, b) => b.successRate - a.successRate);

  console.log("\n⭐ Most effective paths:");
  pathEffectiveness.slice(0, 10).forEach((pathInfo, index) => {
    console.log(
      `${index + 1}. ${pathInfo.path} - ${pathInfo.success}/${pathInfo.total} successful (${(pathInfo.successRate * 100).toFixed(1)}%) - Avg size: ${Math.floor(pathInfo.avgResponseSize)} bytes`,
    );
  });

  // List largest response paths (potential data leak points)
  const largestResponsePaths = [...pathEffectiveness]
    .sort((a, b) => b.avgResponseSize - a.avgResponseSize);

  console.log("\n📦 Paths with largest responses (potential data sources):");
  largestResponsePaths.slice(0, 5).forEach((pathInfo, index) => {
    console.log(
      `${index + 1}. ${pathInfo.path} - ${Math.floor(pathInfo.avgResponseSize)} bytes avg response`,
    );
  });

  // Save results to file
  const reportContent = `
    Attack Report
    ============
    Target: ${stats.target}
    Time: ${new Date().toISOString()}
    Duration: ${stats.duration.toFixed(2)} seconds
    Paths Attacked: ${stats.paths}
    Total Requests: ${stats.totalRequests}
    Successful: ${stats.successCount}
    Failed: ${stats.failCount}
    Requests Per Second: ${stats.requestsPerSecond}
    Data Transmitted: ${(stats.bytesSent / (1024 * 1024)).toFixed(2)} MB
    Data Received: ${(stats.bytesReceived / (1024 * 1024)).toFixed(2)} MB

    Status Code Distribution:
    ${sortedStatusCodes.map(([status, count]) =>
    `${status}: ${count} (${(count / stats.totalRequests * 100).toFixed(1)}%)`).join('\n')}

    Method Effectiveness:
    ${Object.entries(stats.methodStats).map(([method, methodStats]) => {
      const total = methodStats.success + methodStats.failed;
      const successRate = total > 0 ? (methodStats.success / total * 100).toFixed(1) : '0.0';
      return `${method}: ${methodStats.success}/${total} (${successRate}% success)`;
    }).join('\n')}

    Most Effective Proxies:
    ${proxyEffectiveness.slice(0, 20).map((p, i) =>
      `${i + 1}. ${p.proxy}: ${p.success}/${p.requests} successful (${(p.successRate * 100).toFixed(1)}%)`
    ).join('\n')}

    Most Effective Paths:
    ${pathEffectiveness.slice(0, 20).map((p, i) =>
      `${i + 1}. ${p.path}: ${p.success}/${p.total} successful (${(p.successRate * 100).toFixed(1)}%) - Avg size: ${Math.floor(p.avgResponseSize)} bytes`
    ).join('\n')}

    Largest Response Paths:
    ${largestResponsePaths.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.path}: ${Math.floor(p.avgResponseSize)} bytes avg response`
    ).join('\n')}
  `;

  await fs.writeFile("attack_report.txt", reportContent);

  // Save raw JSON data for potential further analysis
  const jsonReport = {
    target: stats.target,
    timestamp: new Date().toISOString(),
    duration: stats.duration,
    stats: {
      paths: stats.paths,
      requests: stats.totalRequests,
      successful: stats.successCount,
      failed: stats.failCount,
      rps: stats.requestsPerSecond,
      bytesSent: stats.bytesSent,
      bytesReceived: stats.bytesReceived
    },
    statusCodes: stats.statusCodes,
    methodStats: stats.methodStats,
    proxyStats: proxyEffectiveness.slice(0, 50),
    pathStats: pathEffectiveness.slice(0, 100)
  };

  await fs.writeFile("attack_report.json", JSON.stringify(jsonReport, null, 2));

  console.log("\n📄 Reports saved to attack_report.txt and attack_report.json");
}