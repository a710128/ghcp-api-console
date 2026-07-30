import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildApp } from '../server.js';
import { config } from '../config.js';

const TEST_API_KEY = 'test-api-key-unused';
const TEST_IDENTITY = 'test-identity';

function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        // Drain response body so the connection closes cleanly.
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /v1/responses/compact route existence', () => {
  let server: http.Server;
  let baseUrl: string;
  let originalApiKey: string;

  // requireApiKey + requireIdentityHeader run BEFORE the 404 fallthrough, so an
  // unauthenticated request returns 401 regardless of route registration. Only
  // under valid auth does an unregistered path reach the 404 handler.
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'X-User-Identity': TEST_IDENTITY,
  };

  before(async () => {
    originalApiKey = config.apiKey;
    config.apiKey = TEST_API_KEY;
    server = buildApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    config.apiKey = originalApiKey;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('POST /v1/responses/compact is registered (not 404) when authenticated', async () => {
    const status = await postJson(baseUrl, '/v1/responses/compact', { model: 'gpt-5', input: 'hi' }, authHeaders);
    assert.notEqual(status, 404, `expected a registered route (not 404), got ${status}`);
  });

  it('control: POST /v1/responses is registered (not 404) when authenticated', async () => {
    const status = await postJson(baseUrl, '/v1/responses', { model: 'gpt-5', input: 'hi' }, authHeaders);
    assert.notEqual(status, 404, `expected a registered route (not 404), got ${status}`);
  });

  it('control: POST /v1/nonexistent responds 404 (unregistered route)', async () => {
    const status = await postJson(baseUrl, '/v1/nonexistent', { model: 'gpt-5' }, authHeaders);
    assert.equal(status, 404, `expected 404 for an unregistered path, got ${status}`);
  });
});
