import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateInputTokens,
  isTokenCountFallbackStatus,
  shouldTranslateWebSearchError,
  webSearchUnsupportedMessage,
  preprocessClaudeCodeMessagesBody,
} from './claudeCodeCompat.js';

describe('estimateInputTokens', () => {
  it('estimates ceil(JSON length / 4) tokens for a messages body', () => {
    const body = { messages: [{ role: 'user', content: 'hello world' }] };
    const expected = Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
    assert.equal(estimateInputTokens(body), expected);
  });

  it('returns at least 1 token for a tiny body', () => {
    assert.ok(estimateInputTokens({}) >= 1);
  });

  it('grows with larger bodies', () => {
    const small = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const large = estimateInputTokens({
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
    });
    assert.ok(large > small);
  });
});

describe('isTokenCountFallbackStatus', () => {
  it('returns true for 404', () => assert.equal(isTokenCountFallbackStatus(404), true));
  it('returns true for 405', () => assert.equal(isTokenCountFallbackStatus(405), true));
  it('returns true for 501', () => assert.equal(isTokenCountFallbackStatus(501), true));
  it('returns false for 400', () => assert.equal(isTokenCountFallbackStatus(400), false));
  it('returns false for 200', () => assert.equal(isTokenCountFallbackStatus(200), false));
});

describe('shouldTranslateWebSearchError', () => {
  const webSearchBody = { tools: [{ type: 'web_search', name: 'web_search' }] };

  it('returns true for a web-search request with a matching upstream error', () => {
    assert.equal(
      shouldTranslateWebSearchError(400, 'web_search is not supported', webSearchBody),
      true,
    );
  });

  it('returns true for a web_search_* tool with an unsupported_value error at 404', () => {
    const body = { tools: [{ type: 'web_search_20250305', name: 'web_search' }] };
    assert.equal(shouldTranslateWebSearchError(404, 'unsupported_value', body), true);
  });

  it('returns false when the request has no web-search tool', () => {
    const body = { tools: [{ type: 'custom', name: 'foo' }] };
    assert.equal(shouldTranslateWebSearchError(400, 'web_search not supported', body), false);
  });

  it('returns false when requestBody is undefined', () => {
    assert.equal(shouldTranslateWebSearchError(400, 'web_search not supported', undefined), false);
  });

  it('returns false when the status is not 400/404', () => {
    assert.equal(shouldTranslateWebSearchError(500, 'web_search not supported', webSearchBody), false);
  });

  it('returns false when the body text does not mention web search', () => {
    assert.equal(shouldTranslateWebSearchError(400, 'some other error', webSearchBody), false);
  });
});

describe('webSearchUnsupportedMessage', () => {
  it('is a non-empty string', () => {
    const message = webSearchUnsupportedMessage({ tools: [{ type: 'web_search' }] });
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0);
  });

  it('mentions the offending tool type', () => {
    const message = webSearchUnsupportedMessage({ tools: [{ type: 'web_search_20250305' }] });
    assert.ok(message.includes('web_search_20250305'));
  });

  it('falls back to web_search when no tool is present', () => {
    const message = webSearchUnsupportedMessage(undefined);
    assert.ok(message.includes('web_search'));
  });
});

describe('preprocessClaudeCodeMessagesBody: cache_control.scope removal', () => {
  it('removes cache_control.scope from message content blocks', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', scope: 'all' } },
          ],
        },
      ],
    };
    const result = preprocessClaudeCodeMessagesBody(body) as {
      messages: Array<{ content: Array<{ cache_control?: Record<string, unknown> }> }>;
    };
    const cacheControl = result.messages[0].content[0].cache_control;
    assert.ok(cacheControl);
    assert.equal('scope' in cacheControl, false);
    assert.equal(cacheControl.type, 'ephemeral');
  });

  it('does not mutate the original body', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { scope: 'all' } }] },
      ],
    };
    preprocessClaudeCodeMessagesBody(body);
    const original = body.messages[0].content[0] as { cache_control: { scope?: string } };
    assert.equal(original.cache_control.scope, 'all');
  });
});

describe('preprocessClaudeCodeMessagesBody: currentDate block removal', () => {
  it('removes the injected # currentDate block from system text', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      system: [
        { type: 'text', text: "Intro line.\n# currentDate\nToday's date is 2025-01-02.\n\nRest." },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = preprocessClaudeCodeMessagesBody(body) as {
      system: Array<{ text: string }>;
    };
    const text = result.system[0].text;
    assert.equal(text.includes('# currentDate'), false);
    assert.equal(text.includes("Today's date is"), false);
    assert.ok(text.includes('Intro line.'));
    assert.ok(text.includes('Rest.'));
  });
});

describe('preprocessClaudeCodeMessagesBody: "Tool loaded." boundary removal', () => {
  it('removes text blocks that are exactly the Tool loaded. marker', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Tool loaded.' }] },
        { role: 'user', content: [{ type: 'text', text: 'real question' }] },
      ],
    };
    const result = preprocessClaudeCodeMessagesBody(body) as {
      messages: Array<{ role: string; content: Array<{ text?: string }> }>;
    };
    const allText = result.messages.flatMap((m) => m.content.map((b) => b.text));
    assert.equal(allText.includes('Tool loaded.'), false);
    assert.ok(allText.includes('real question'));
  });
});

describe('preprocessClaudeCodeMessagesBody: trailing assistant message', () => {
  it('appends a "Please continue." user message after a trailing assistant message', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      ],
    };
    const result = preprocessClaudeCodeMessagesBody(body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content, [{ type: 'text', text: 'Please continue.' }]);
  });

  it('does not append when the last message is already from the user', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'question' }],
    };
    const result = preprocessClaudeCodeMessagesBody(body) as {
      messages: Array<{ role: string }>;
    };
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[result.messages.length - 1].role, 'user');
  });
});
