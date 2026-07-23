import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@ghcp/database/test-support';
import { JsonHttpClient } from './httpClient.js';
import { HttpApiError, INTERNAL_AUTH_HEADER } from './api.js';

describe('JsonHttpClient', () => {
  it('builds URL, sets internal auth header, sends JSON body, and parses 2xx JSON', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, jsonBody: { ok: true, value: 42 } }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;

    let result: { ok: boolean; value: number };
    try {
      const client = new JsonHttpClient({ baseUrl: 'https://example.test/', internalToken: 'tok-123' });
      result = await client.request('/api/thing', { body: { name: 'x' } });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(result, { ok: true, value: 42 });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://example.test/api/thing');

    const headers = call.options?.headers as Record<string, string>;
    assert.equal(headers[INTERNAL_AUTH_HEADER], 'tok-123');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers.Accept, 'application/json');

    assert.equal(call.options?.method, 'POST');
    assert.equal(call.options?.body, JSON.stringify({ name: 'x' }));
  });

  it('throws HttpApiError with correct status on 4xx', async () => {
    const { fetch } = mockFetch([
      { status: 403, jsonBody: { error: { code: 'forbidden', message: 'Forbidden' } } },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;

    try {
      const client = new JsonHttpClient({ baseUrl: 'https://example.test' });
      await assert.rejects(
        () => client.request('/api/thing'),
        (err: unknown) => {
          assert.ok(err instanceof HttpApiError);
          assert.equal(err.status, 403);
          assert.equal(err.code, 'forbidden');
          assert.equal(err.message, 'Forbidden');
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
