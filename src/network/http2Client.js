import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger.js';

/**
 * Http2Client
 * High-performance, persistent HTTP/2 client with pre-warmed connection,
 * zero-handshake request dispatching, automatic reconnection, and background PING.
 */
export class Http2Client extends EventEmitter {
  /**
   * @param {string} baseUrl - e.g. "https://edge.madmarket.io"
   * @param {Object} [options]
   * @param {number} [options.pingIntervalMs=15000] - Interval between HTTP/2 PING frames
   * @param {number} [options.requestTimeoutMs=10000] - Request timeout in ms
   */
  constructor(baseUrl, options = {}) {
    super();
    this.baseUrl = baseUrl;
    this.parsedUrl = new URL(baseUrl);
    this.pingIntervalMs = options.pingIntervalMs || 15000;
    this.requestTimeoutMs = options.requestTimeoutMs || 10000;

    /** @type {http2.ClientHttp2Session | null} */
    this.session = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDestroyed = false;
    this.lastPingRttMs = 0;
    this.connectPromise = null;

    /** @type {NodeJS.Timeout | null} */
    this.pingTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.reconnectTimer = null;
  }

  /**
   * Connects to the HTTP/2 server and sets up event listeners.
   * @returns {Promise<http2.ClientHttp2Session>}
   */
  async connect() {
    if (this.isDestroyed) {
      throw new Error('Http2Client is destroyed');
    }

    if (this.isConnected && this.session && !this.session.destroyed && !this.session.closed) {
      return this.session;
    }

    if (this.isConnecting && this.connectPromise) {
      return this.connectPromise;
    }

    this.isConnecting = true;
    logger.info('Http2Client', `Initiating pre-warmed HTTP/2 connection to ${this.baseUrl}...`);

    this.connectPromise = new Promise((resolve, reject) => {
      let resolved = false;

      try {
        const session = http2.connect(this.baseUrl, {
          rejectUnauthorized: true,
          peerMaxConcurrentStreams: 100
        });

        const onConnect = () => {
          this.session = session;
          this.isConnected = true;
          this.isConnecting = false;
          this.startPingLoop();
          logger.success('Http2Client', `HTTP/2 session established with ${this.baseUrl}`);
          this.emit('connect', { baseUrl: this.baseUrl });

          if (!resolved) {
            resolved = true;
            resolve(session);
          }
        };

        session.once('connect', onConnect);

        session.on('error', (err) => {
          logger.error('Http2Client', `HTTP/2 session error: ${err.message}`, err);
          this.emit('error', err);
          this.handleDisconnect('error', err);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        session.on('goaway', (errorCode, lastStreamId, opaqueData) => {
          logger.warn('Http2Client', `Received GOAWAY frame (code: ${errorCode}, lastStreamId: ${lastStreamId})`);
          this.emit('goaway', { errorCode, lastStreamId, opaqueData });
          this.handleDisconnect('goaway');
        });

        session.on('close', () => {
          logger.warn('Http2Client', 'HTTP/2 session closed');
          this.emit('close');
          this.handleDisconnect('close');
        });

        session.on('frameError', (type, code, id) => {
          logger.error('Http2Client', `HTTP/2 frameError: type=${type}, code=${code}, id=${id}`);
          this.emit('frameError', { type, code, id });
        });

      } catch (err) {
        this.isConnecting = false;
        this.connectPromise = null;
        logger.error('Http2Client', `HTTP/2 connect call failed: ${err.message}`, err);
        reject(err);
      }
    });

    return this.connectPromise;
  }

  /**
   * Ensures an active HTTP/2 session is ready before dispatching.
   * @returns {Promise<http2.ClientHttp2Session>}
   */
  async ensureConnected() {
    if (this.isConnected && this.session && !this.session.destroyed && !this.session.closed) {
      return this.session;
    }
    return this.connect();
  }

  /**
   * Internal disconnect handler and auto-reconnector.
   * @param {string} reason
   * @param {Error} [err]
   */
  handleDisconnect(reason, err) {
    this.isConnected = false;
    this.isConnecting = false;
    this.connectPromise = null;
    this.stopPingLoop();

    if (this.session && !this.session.destroyed) {
      try {
        this.session.destroy();
      } catch {
        // Safe ignore
      }
    }
    this.session = null;

    if (!this.isDestroyed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch((connectErr) => {
          this.emit('reconnect_failed', connectErr);
        });
      }, 500);
    }
  }

  /**
   * Starts background HTTP/2 PING frames every 15s to keep the TLS/TCP pipe warm.
   */
  startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.isConnected || !this.session || this.session.destroyed) {
        return;
      }

      const pingStart = performance.now();
      try {
        this.session.ping((err, duration) => {
          if (err) {
            logger.warn('Http2Client', `HTTP/2 ping failed: ${err.message}`);
            this.emit('ping_error', err);
            return;
          }
          const rtt = typeof duration === 'number' ? duration : (performance.now() - pingStart);
          this.lastPingRttMs = Number(rtt.toFixed(2));
          this.emit('ping', this.lastPingRttMs);
        });
      } catch (pingErr) {
        logger.error('Http2Client', `HTTP/2 ping exception: ${pingErr.message}`);
        this.emit('ping_error', pingErr);
      }
    }, this.pingIntervalMs);
  }

  /**
   * Stops background ping timer.
   */
  stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * High-speed request dispatcher directly pushing HTTP/2 frame onto the pre-warmed socket.
   *
   * @param {string} method - 'GET', 'POST', etc.
   * @param {string} path - Request path (e.g. '/v1/orders/')
   * @param {Record<string, string>} headers - Additional HTTP/2 headers
   * @param {string | Buffer | Uint8Array} [body] - Request payload
   * @returns {Promise<{ status: number, headers: http2.IncomingHttpHeaders, body: string, rttMs: number }>}
   */
  async request(method, path, headers = {}, body = null) {
    const session = await this.ensureConnected();

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const startTime = performance.now();

      const reqHeaders = {
        [http2.constants.HTTP2_HEADER_SCHEME]: this.parsedUrl.protocol.replace(':', ''),
        [http2.constants.HTTP2_HEADER_AUTHORITY]: this.parsedUrl.host,
        [http2.constants.HTTP2_HEADER_METHOD]: method.toUpperCase(),
        [http2.constants.HTTP2_HEADER_PATH]: path,
        ...headers
      };

      let req;
      try {
        req = session.request(reqHeaders);
      } catch (reqError) {
        logger.error('Http2Client', `Failed to open HTTP/2 stream for ${method} ${path}: ${reqError.message}`);
        return reject(reqError);
      }

      // Timeout guard
      req.setTimeout(this.requestTimeoutMs, () => {
        if (!isSettled) {
          isSettled = true;
          req.close(http2.constants.NGHTTP2_CANCEL);
          const timeoutErr = new Error(`HTTP/2 Request timeout after ${this.requestTimeoutMs}ms`);
          logger.error('Http2Client', timeoutErr.message);
          reject(timeoutErr);
        }
      });

      let status = 0;
      let respHeaders = {};
      const chunks = [];

      req.on('response', (responseHeaders) => {
        respHeaders = responseHeaders;
        status = Number(responseHeaders[http2.constants.HTTP2_HEADER_STATUS]) || 0;
      });

      req.on('data', (chunk) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (isSettled) return;
        isSettled = true;

        const rttMs = Number((performance.now() - startTime).toFixed(2));
        const respBody = Buffer.concat(chunks).toString('utf8');

        resolve({
          status,
          headers: respHeaders,
          body: respBody,
          rttMs
        });
      });

      req.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        logger.error('Http2Client', `HTTP/2 stream error on ${method} ${path}: ${err.message}`);
        reject(err);
      });

      // Write body if provided
      if (body !== null && body !== undefined) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          req.end(body);
        } else {
          req.end(JSON.stringify(body));
        }
      } else {
        req.end();
      }
    });
  }

  /**
   * Graceful shutdown of client and connections.
   */
  async destroy() {
    this.isDestroyed = true;
    this.stopPingLoop();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.session && !this.session.destroyed) {
      return new Promise((resolve) => {
        const s = this.session;
        this.session = null;
        this.isConnected = false;

        try {
          s.close(() => {
            try {
              s.destroy();
            } catch {}
            resolve();
          });
        } catch {
          resolve();
        }
      });
    }
  }
}
