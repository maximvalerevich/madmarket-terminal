import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * File & UI Logger
 * High-speed asynchronous stream logger with zero-blocking stdout and disk persistence.
 */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.logFilePath = path.resolve(process.cwd(), 'terminal.log');
    this.fileStream = null;

    try {
      this.fileStream = fs.createWriteStream(this.logFilePath, { flags: 'a', encoding: 'utf8' });
    } catch (err) {
      console.error(`[LOGGER INIT ERROR] Failed to create write stream to ${this.logFilePath}:`, err.message);
    }
  }

  /**
   * Writes a structured log line.
   * @param {'DEBUG' | 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR'} level
   * @param {string} component
   * @param {string} message
   * @param {any} [details]
   */
  log(level, component, message, details = null) {
    const timestamp = new Date().toISOString();
    let detailStr = '';
    if (details !== null && details !== undefined) {
      if (details instanceof Error) {
        detailStr = ` | ${details.stack || details.message}`;
      } else if (typeof details === 'object') {
        try {
          detailStr = ` | ${JSON.stringify(details)}`;
        } catch {
          detailStr = ' | [Circular/Unserializable]';
        }
      } else {
        detailStr = ` | ${String(details)}`;
      }
    }

    const line = `[${timestamp}] [${level}] [${component}] ${message}${detailStr}\n`;

    if (this.fileStream && !this.fileStream.destroyed) {
      this.fileStream.write(line);
    }

    // Emit for UI consumption
    this.emit('entry', {
      timestamp,
      level: level.toLowerCase(),
      component,
      message: `${message}${detailStr}`,
      raw: line
    });
  }

  debug(comp, msg, det) { this.log('DEBUG', comp, msg, det); }
  info(comp, msg, det) { this.log('INFO', comp, msg, det); }
  success(comp, msg, det) { this.log('SUCCESS', comp, msg, det); }
  warn(comp, msg, det) { this.log('WARN', comp, msg, det); }
  error(comp, msg, det) { this.log('ERROR', comp, msg, det); }

  destroy() {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

export const logger = new Logger();
