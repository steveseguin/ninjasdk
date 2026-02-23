'use strict';

function loadVDONinjaSDK() {
  const candidates = [
    '@vdoninja/sdk/node',
    '@vdoninja/sdk',
    '../../../vdoninja-sdk-node.js'
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const resolved = require(candidate);
      if (resolved) return resolved;
    } catch (error) {
      const isMissingModule = error &&
        error.code === 'MODULE_NOT_FOUND' &&
        typeof error.message === 'string' &&
        error.message.includes(`Cannot find module '${candidate}'`);
      if (!isMissingModule) {
        throw error;
      }
      lastError = error;
    }
  }

  const hint = lastError && lastError.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(
    `Unable to load VDO.Ninja SDK. Tried: ${candidates.join(', ')}.${hint}`
  );
}

module.exports = {
  loadVDONinjaSDK
};
