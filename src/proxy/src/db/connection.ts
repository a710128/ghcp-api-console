/**
 * PostgreSQL connection module for proxy.
 * Replaces the SQLite connection module.
 * Pool is initialized at startup via initPool().
 */
export { getGeneralPool, getCoordinationPool, getDataEncryptionKey, initPool, closePool } from './pool.js';
