import { EventEmitter } from 'node:events';

/**
 * BaseAdapter
 * Abstract base class for bookmaker and broker API adapters (Adapter Pattern).
 * Encapsulates broker-specific protocols, payload formatting, and session management.
 */
export class BaseAdapter extends EventEmitter {
  /**
   * @param {Object} config - Configuration object
   */
  constructor(config) {
    super();
    if (new.target === BaseAdapter) {
      throw new TypeError('Cannot construct BaseAdapter instances directly (abstract class)');
    }
    this.config = config;
  }

  /**
   * Initializes session, establishes pre-warmed connections, or verifies credentials.
   * @returns {Promise<void>}
   */
  async initSession() {
    throw new Error('BaseAdapter.initSession() must be implemented by subclass');
  }

  /**
   * Pre-arms a betslip for low-latency firing.
   * @param {'OVER' | 'HOME' | 'AWAY'} targetKey - The trade target
   * @param {Object} matchInfo - Current match metadata, score, and market context
   * @returns {Promise<{ betslipId: string, expiryTs: number, price?: number, betType?: string }>}
   */
  async preArmBetslip(targetKey, matchInfo) {
    throw new Error('BaseAdapter.preArmBetslip() must be implemented by subclass');
  }

  /**
   * Submits an immediate combat order against a pre-armed betslip.
   * @param {Object} armedData - Object containing betslipId and armed metadata
   * @param {number} livePrice - Limit / execution price with slippage applied
   * @param {number} [stake] - Stake amount in base currency
   * @returns {Promise<{ success: boolean, orderId?: string, status: number, rttMs: number, data?: any, error?: string }>}
   */
  async placeOrder(armedData, livePrice, stake) {
    throw new Error('BaseAdapter.placeOrder() must be implemented by subclass');
  }

  /**
   * Sends keep-alive / heartbeat frame or token refresh.
   * @returns {Promise<void>}
   */
  async keepAlive() {
    throw new Error('BaseAdapter.keepAlive() must be implemented by subclass');
  }

  /**
   * Deletes / closes an open betslip to free up broker quota.
   * @param {string} betslipId
   * @returns {Promise<boolean>}
   */
  async deleteBetslip(betslipId) {
    throw new Error('BaseAdapter.deleteBetslip() must be implemented by subclass');
  }

  /**
   * Retrieves current status and settlement of an order from broker.
   * @param {string} orderId
   * @returns {Promise<{ orderId: string, status: string, closed: boolean, closeReason?: string, gotPrice?: number, placed?: any[], unplaced?: any[], bookie?: string }>}
   */
  async getOrderStatus(orderId) {
    throw new Error('BaseAdapter.getOrderStatus() must be implemented by subclass');
  }

  /**
   * Gracefully tears down network sockets and timers.
   * @returns {Promise<void>}
   */
  async destroy() {
    // Optional teardown hook
  }
}
