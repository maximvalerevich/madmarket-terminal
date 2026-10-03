import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Http2Client } from './src/network/http2Client.js';
import { WsFeed } from './src/network/wsFeed.js';
import { MollybetAdapter } from './src/adapters/mollybetAdapter.js';
import { StateManager } from './src/core/stateManager.js';
import { ExecutionEngine } from './src/core/executionEngine.js';
import { TerminalUI } from './src/ui/terminalUI.js';
import { logger } from './src/utils/logger.js';

// Resolve directory paths in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads configuration file synchronously during bootstrap.
 * Supports both namespaced (adapters + global) and flat legacy config formats.
 * @returns {Object}
 */
function loadConfig() {
  const configPath = path.resolve(__dirname, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Handle new namespaced format
    if (raw.global && raw.adapters) {
      const adapterName = Object.keys(raw.adapters).find(k => raw.adapters[k].enabled !== false) || 'mollybet';
      const adapterConf = raw.adapters[adapterName] || {};
      const merged = {
        ...raw.global,
        ...adapterConf,
        _adapterName: adapterName,
        _rawConfig: raw
      };
      // Allow overriding secrets via environment variables
      if (process.env.SESSION_TOKEN) merged.sessionToken = process.env.SESSION_TOKEN;
      if (process.env.INSTANCE_ID) merged.instanceId = process.env.INSTANCE_ID;
      return merged;
    }

    // Legacy flat format
    if (process.env.SESSION_TOKEN) raw.sessionToken = process.env.SESSION_TOKEN;
    if (process.env.INSTANCE_ID) raw.instanceId = process.env.INSTANCE_ID;
    return raw;
  } catch (err) {
    logger.error('Bootstrap', `Failed to read config.json: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Application Bootstrap
 */
async function main() {
  logger.info('Bootstrap', 'Starting MadMarket Low-Latency Trading Terminal...');
  const config = loadConfig();

  // 1. Initialize persistent HTTP/2 client
  const http2Client = new Http2Client(config.baseUrl, {
    pingIntervalMs: 15000,
    requestTimeoutMs: 10000
  });

  // 2. Initialize Mollybet broker adapter
  const adapter = new MollybetAdapter(config, http2Client);

  // 3. Initialize WebSocket Price & Event Feed
  const wsFeed = new WsFeed(config);

  // 4. Initialize in-memory StateManager and bind adapter + wsFeed
  const stateManager = new StateManager(config);
  stateManager.setAdapter(adapter);
  stateManager.setWsFeed(wsFeed);

  // Wire WebSocket events to StateManager
  wsFeed.on('event_update', (eventData) => {
    stateManager.updateEventMetadata(eventData);
  });

  wsFeed.on('odds_update', (oddsData) => {
    stateManager.updateOdds(oddsData);
  });

  // 5. Initialize Low-latency Execution Engine
  const executionEngine = new ExecutionEngine(adapter, stateManager, config);
  executionEngine.setWsFeed(wsFeed);

  // 6. Initialize Terminal UI (rawMode / tmux optimized)
  const ui = new TerminalUI({
    stateManager,
    executionEngine,
    http2Client,
    wsFeed,
    config
  });

  // Global uncaught error traps to prevent rawMode terminal lockup
  process.on('uncaughtException', (err) => {
    logger.error('Process', `Uncaught exception: ${err.message}`, err);
    ui.setLog('error', `[UNCAUGHT] ${err.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('Process', `Unhandled promise rejection: ${msg}`, reason);
    ui.setLog('error', `[PROMISE REJECTION] ${msg}`);
  });

  // Handle graceful exit
  const shutdown = async () => {
    logger.info('Process', 'Graceful shutdown initiated...');
    ui.destroy();
    stateManager.destroy();
    await wsFeed.destroy().catch(() => {});
    await adapter.destroy().catch(() => {});
    logger.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start UI
  ui.start();
  ui.setLog('info', 'Инициализация терминала и сетевых коннекторов...');

  // Start HTTP/2 pre-warm connection in background
  http2Client.connect()
    .then(() => {
      ui.setLog('success', `HTTP/2 соединение установлено с ${config.baseUrl}`);
    })
    .catch((err) => {
      ui.setLog('error', `Ошибка подключения HTTP/2: ${err.message}`);
    });

  // Start WebSocket feed connection
  wsFeed.connect();
  wsFeed.on('connected', () => {
    ui.setLog('success', 'WebSocket фид цен и событий подключен');
  });

  wsFeed.on('synced', ({ totalEvents }) => {
    ui.setLog('success', `Фид синхронизирован: загружено ${totalEvents} событий. Нажмите 'M' для выбора матча.`);
  });

  wsFeed.on('disconnected', ({ reason }) => {
    ui.setLog('warn', `WebSocket фид отключен: ${reason || 'соединение закрыто'}. Переподключение...`);
  });
}

main().catch((fatalErr) => {
  logger.error('Bootstrap', `Fatal startup error: ${fatalErr.message}`, fatalErr);
  console.error('[FATAL STARTUP ERROR]', fatalErr);
  process.exit(1);
});
