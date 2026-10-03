/**
 * Shared utility functions for configuration handling.
 */

/**
 * Returns a Set of allowed bookmakers (e.g. pin88) configured for the session.
 * @param {Object} config - The configuration object (either legacy root config or merged adapter config)
 * @returns {Set<string>}
 */
export function getAllowedBookies(config) {
  const set = new Set();
  
  if (config && Array.isArray(config.adaptiveBookies)) {
    for (const b of config.adaptiveBookies) {
      if (typeof b === 'string' && b.trim()) set.add(b.trim().toLowerCase());
    }
  }
  
  if (config && Array.isArray(config.accounts)) {
    for (const acc of config.accounts) {
      if (Array.isArray(acc) && acc[0]) {
        set.add(String(acc[0]).trim().toLowerCase());
      } else if (typeof acc === 'string' && acc.trim()) {
        set.add(acc.trim().toLowerCase());
      }
    }
  }
  
  if (set.size === 0) {
    set.add('pin88');
  }
  
  return set;
}

/**
 * Validates the basic required fields of the config.
 * @param {Object} config - The full application config
 * @throws {Error} If validation fails
 */
export function validateConfig(config) {
  if (!config) throw new Error('Config is empty or null');
  
  if (!config.global) {
    throw new Error('Config missing "global" section');
  }
  
  if (!config.adapters || Object.keys(config.adapters).length === 0) {
    throw new Error('Config missing "adapters" section or no adapters defined');
  }
  
  // Example validation for mollybet adapter if present
  if (config.adapters.mollybet) {
    const mb = config.adapters.mollybet;
    if (mb.enabled && (!mb.sessionToken || typeof mb.sessionToken !== 'string')) {
      throw new Error('Mollybet adapter requires a valid sessionToken');
    }
  }
}

/**
 * Merges user config with sane defaults.
 * @param {Object} config - The user provided config
 * @returns {Object} Merged configuration object
 */
export function mergeWithDefaults(config) {
  const defaultConfig = {
    global: {
      defaultStake: 5.0,
      stakeStep: 10.0,
      defaultCurrency: "EUR",
      slippagePct: 0.03,
      defaultDuration: 15,
      debounceMs: 2000,
      dryRun: false
    },
    adapters: {}
  };

  const merged = {
    ...defaultConfig,
    ...config,
    global: {
      ...defaultConfig.global,
      ...(config?.global || {})
    },
    adapters: {
      ...(config?.adapters || {})
    }
  };

  return merged;
}
