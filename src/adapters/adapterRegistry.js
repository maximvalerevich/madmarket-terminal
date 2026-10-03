import { MollybetAdapter } from './mollybetAdapter.js';
import { WsFeed } from '../network/wsFeed.js';

/**
 * AdapterRegistry
 * A factory/registry that manages adapter+feed pairs by name.
 */
class AdapterRegistry {
  constructor() {
    /** @type {Map<string, { AdapterClass: Function, FeedClass: Function }>} */
    this.registry = new Map();
    /** @type {Map<string, import('./baseAdapter.js').BaseAdapter>} */
    this.adapters = new Map();
    /** @type {Map<string, import('./baseFeed.js').BaseFeed>} */
    this.feeds = new Map();

    // Register built-in adapters
    this.register('mollybet', MollybetAdapter, WsFeed);
  }

  /**
   * Registers a new adapter and feed pair by name.
   * @param {string} name - Name of the adapter (e.g. 'mollybet')
   * @param {Function} AdapterClass - Adapter class extending BaseAdapter
   * @param {Function} FeedClass - Feed class extending BaseFeed
   */
  register(name, AdapterClass, FeedClass) {
    this.registry.set(name.toLowerCase(), { AdapterClass, FeedClass });
  }

  /**
   * Instantiates or returns an existing adapter instance from config.
   * @param {string} name - Name of the adapter
   * @param {Object} fullConfig - The full application config containing global and adapters sections
   * @param {import('../network/http2Client.js').Http2Client} [http2Client] - Optional http2client
   * @returns {import('./baseAdapter.js').BaseAdapter}
   */
  getAdapter(name, fullConfig = null, http2Client = null) {
    const key = name.toLowerCase();
    if (!this.adapters.has(key)) {
      const entry = this.registry.get(key);
      if (!entry) {
        throw new Error(`Adapter '${name}' is not registered.`);
      }
      if (!fullConfig) {
        throw new Error(`Cannot instantiate adapter '${name}' without config.`);
      }
      
      const adapterConfig = fullConfig.adapters?.[key] || {};
      const mergedConfig = { ...fullConfig.global, ...adapterConfig };
      
      const adapter = new entry.AdapterClass(mergedConfig, http2Client);
      this.adapters.set(key, adapter);
    }
    return this.adapters.get(key);
  }

  /**
   * Instantiates or returns an existing feed instance from config.
   * @param {string} name - Name of the adapter
   * @param {Object} fullConfig - The full application config
   * @returns {import('./baseFeed.js').BaseFeed}
   */
  getFeed(name, fullConfig = null) {
    const key = name.toLowerCase();
    if (!this.feeds.has(key)) {
      const entry = this.registry.get(key);
      if (!entry) {
        throw new Error(`Feed for '${name}' is not registered.`);
      }
      if (!fullConfig) {
        throw new Error(`Cannot instantiate feed '${name}' without config.`);
      }

      const adapterConfig = fullConfig.adapters?.[key] || {};
      const mergedConfig = { ...fullConfig.global, ...adapterConfig };

      const feed = new entry.FeedClass(mergedConfig);
      this.feeds.set(key, feed);
    }
    return this.feeds.get(key);
  }

  /**
   * Lists all registered adapter names.
   * @returns {string[]}
   */
  listAdapters() {
    return Array.from(this.registry.keys());
  }
}

// Export singleton instance
export default new AdapterRegistry();
