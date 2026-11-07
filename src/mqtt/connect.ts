/**
 * mqtt.js is CommonJS, and a dynamic import of CommonJS in the esbuild bundle only
 * has `default`, so callers load this file rather than importing 'mqtt' themselves.
 */
export { connectAsync } from 'mqtt'
