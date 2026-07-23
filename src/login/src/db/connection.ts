/**
 * PostgreSQL connection module for login (replaces SQLite connection).
 */
export { getGeneralPool, getCoordinationPool, getLoginJobEncryptionKey, initPool, closePool } from './pool.js';
