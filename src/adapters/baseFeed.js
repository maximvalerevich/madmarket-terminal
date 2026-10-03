import { EventEmitter } from 'node:events';

/**
 * BaseFeed
 * Abstract base class for WebSocket price/event streams (Adapter Pattern).
 * Emits unified events for live odds, match metadata, and account balance.
 *
 * @fires BaseFeed#connected
 * @fires BaseFeed#disconnected
 * @fires BaseFeed#synced
 * @fires BaseFeed#event_update
 * @fires BaseFeed#odds_update
 * @fires BaseFeed#balance
 * @fires BaseFeed#betslip_update
 * @fires BaseFeed#pmm_update
 * @fires BaseFeed#betslip_closed
 * @fires BaseFeed#order_update
 * @fires BaseFeed#heartbeat
 * @fires BaseFeed#error
 */
export class BaseFeed extends EventEmitter {
  /**
   * @param {Object} config - Configuration object
   */
  constructor(config) {
    super();
    if (new.target === BaseFeed) {
      throw new TypeError('Cannot construct BaseFeed instances directly (abstract class)');
    }
    this.config = config;
    this.isConnected = false;
    this.isDestroyed = false;
    this.lastWsRttMs = 0;
  }

  /**
   * Connects to the WebSocket feed.
   */
  connect() {
    throw new Error('BaseFeed.connect() must be implemented by subclass');
  }

  /**
   * Subscribes to live price updates and handicap lines for a specific match.
   * @param {number|string} competitionId
   * @param {string} sport
   * @param {string} eventId
   */
  subscribeToEvent(competitionId, sport, eventId) {
    throw new Error('BaseFeed.subscribeToEvent() must be implemented by subclass');
  }

  /**
   * Unsubscribes from an event.
   * @param {number|string} competitionId
   * @param {string} sport
   * @param {string} eventId
   */
  unsubscribeEvent(competitionId, sport, eventId) {
    throw new Error('BaseFeed.unsubscribeEvent() must be implemented by subclass');
  }

  /**
   * Graceful disconnect and resource disposal.
   * @returns {Promise<void>}
   */
  async destroy() {
    this.isDestroyed = true;
    this.isConnected = false;
  }
}
