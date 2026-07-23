import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_AUTH_HEADER } from '@ghcp/shared';

// config.ts reads INTERNAL_API_TOKEN at module-eval time. Under ESM, static
// `import` statements are hoisted and run before any top-level code, so we must
// set the env var and then dynamically import the middleware (and its config
// dependency) so config picks up the value.
const TOKEN = 'test-internal-token-123';
let requireInternalToken: typeof import('./internalAuth.js').requireInternalToken;

before(async () => {
  process.env['INTERNAL_API_TOKEN'] = TOKEN;
  ({ requireInternalToken } = await import('./internalAuth.js'));
});

function makeReq(headers: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => headers[name] ?? lower[name.toLowerCase()],
  } as any;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('requireInternalToken', () => {
  it('rejects with 401 when the token header is missing', () => {
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    requireInternalToken(req, res as any, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.deepEqual((res.body as any).error.code, 'internal_auth_failed');
  });

  it('rejects with 401 when the token value is incorrect', () => {
    const req = makeReq({ [INTERNAL_AUTH_HEADER]: 'wrong-token' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalToken(req, res as any, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it('calls next() when the token is correct and does not set 401', () => {
    const req = makeReq({ [INTERNAL_AUTH_HEADER]: TOKEN });
    const res = makeRes();
    let nextCalled = false;
    requireInternalToken(req, res as any, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, undefined);
  });
});
