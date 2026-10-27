'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    escapeHtml,
    scrollElementToBottom,
    buildChatTitle,
    createRequestRegistry,
    createNdjsonParser,
    safeStorageGet,
    parseStoredArray,
    normalizeChoice,
    normalizeSidebarWidth,
    uniqueStrings,
    parseStoredObject,
    buildConversationContext,
    normalizeCloudModelName,
    isFreeCloudModel,
    mergeCloudModels,
    splitCloudModelsByPlan,
    normalizeEndpointUrl,
    isLoopbackEndpoint,
    canSendApiKey,
    describeFetchFailure
} = require('../js/utils.js');

test('escapeHtml escapes HTML metacharacters', () => {
    assert.equal(
        escapeHtml(`<img src=x onerror="alert('xss')"> & more`),
        '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; more'
    );
});

test('escapeHtml neutralises a script tag payload', () => {
    const escaped = escapeHtml('<script>window.pwned = true</script>');
    assert.equal(escaped.includes('<script>'), false);
    assert.equal(escaped, '&lt;script&gt;window.pwned = true&lt;/script&gt;');
});

test('escapeHtml handles null, undefined and numbers', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml leaves benign text untouched', () => {
    assert.equal(escapeHtml('llama3.1:8b • 2026-10-27'), 'llama3.1:8b • 2026-10-27');
});

test('scrollElementToBottom moves the supplied scroll container', () => {
    const element = { scrollTop: 0, scrollHeight: 4321 };
    scrollElementToBottom(element);
    assert.equal(element.scrollTop, 4321);
});

test('scrollElementToBottom tolerates a missing container', () => {
    assert.doesNotThrow(() => scrollElementToBottom(null));
    assert.doesNotThrow(() => scrollElementToBottom(undefined));
});

test('buildChatTitle trims, truncates and appends an ellipsis', () => {
    assert.equal(buildChatTitle('  Short prompt  '), 'Short prompt');
    assert.equal(buildChatTitle('abcdefghij', 4), 'abcd...');
    assert.equal(buildChatTitle('   '), 'New chat');
    assert.equal(buildChatTitle(null), 'New chat');
});

test('buildChatTitle never splits surrogate pairs', () => {
    assert.equal(buildChatTitle('😀😀😀', 2), '😀😀...');
    assert.equal(Array.from(buildChatTitle('😀😀😀', 2)).filter((char) => char === '😀').length, 2);
});

test('request registry tracks a single current request', () => {
    const registry = createRequestRegistry();
    const first = registry.start({ chatId: 1 });

    assert.equal(registry.current, first);
    assert.equal(registry.isCurrent(first), true);

    const second = registry.start({ chatId: 2 });
    assert.equal(registry.isCurrent(first), false);
    assert.equal(registry.isCurrent(second), true);
    assert.equal(registry.current, second);

    registry.finish(second);
    assert.equal(registry.current, null);
    assert.equal(registry.isCurrent(second), false);
});

test('request registry aborts on cancel and keeps the first stop reason', async () => {
    const registry = createRequestRegistry();
    const request = registry.start();

    let resolved = false;
    request.done.then(() => { resolved = true; });

    registry.cancel(request, 'user');
    assert.equal(request.cancelled, true);
    assert.equal(request.stopReason, 'user');
    assert.equal(request.controller.signal.aborted, true);
    assert.equal(registry.current, null);

    registry.cancel(request, 'navigation');
    assert.equal(request.stopReason, 'user');

    registry.finish(request);
    await request.done;
    assert.equal(resolved, true);
});

test('NDJSON parser buffers lines split across chunks', () => {
    const parser = createNdjsonParser();

    assert.deepEqual(parser.push('{"message":{"content":"Hel'), []);
    const events = parser.push('lo"}}\n{"message":{"content":" world"},"done":false}\n');

    assert.deepEqual(events.map((event) => event.content), ['Hello', ' world']);
    assert.equal(parser.sawDone, false);
});

test('NDJSON parser flushes a final line without a trailing newline', () => {
    const parser = createNdjsonParser();

    assert.deepEqual(parser.push('{"message":{"content":"tail"},"done":true}'), []);
    const events = parser.flush();

    assert.deepEqual(events.map((event) => event.content), ['tail']);
    assert.equal(events[0].done, true);
    assert.equal(parser.sawDone, true);
    assert.deepEqual(parser.flush(), []);
});

test('NDJSON parser reports server errors as fatal events', () => {
    const parser = createNdjsonParser();

    const events = parser.push(
        '{"message":{"content":"partial"},"done":false}\n{"error":"model overloaded"}\n'
    );

    assert.equal(events[0].content, 'partial');
    assert.equal(events[1].error, 'model overloaded');
    assert.equal(events[1].fatal, true);
    assert.equal(parser.sawDone, true);
});

test('NDJSON parser skips blank lines and treats malformed lines as non-fatal', () => {
    const parser = createNdjsonParser();

    const events = parser.push('\n  \nnot-json\n{"message":{"thinking":"hmm"}}\r\n');

    assert.equal(events.length, 2);
    assert.equal(events[0].fatal, false);
    assert.match(events[0].error, /Malformed JSON/);
    assert.equal(events[1].thinking, 'hmm');
    assert.equal(parser.sawDone, false);
});

test('parseStoredArray keeps string entries and trims them', () => {
    assert.deepEqual(
        parseStoredArray('["alpha", " beta ", 3, null, {}, ""]', []),
        ['alpha', 'beta']
    );
});

test('parseStoredArray falls back for malformed or non-array values', () => {
    assert.deepEqual(parseStoredArray('{not json', ['fallback']), ['fallback']);
    assert.deepEqual(parseStoredArray('{"a":1}', ['fallback']), ['fallback']);
    assert.deepEqual(parseStoredArray(null, ['fallback']), ['fallback']);
    assert.deepEqual(parseStoredArray('', ['fallback']), ['fallback']);
    assert.deepEqual(parseStoredArray('[]', ['fallback']), [], 'an explicit empty list is preserved');
});

test('parseStoredArray does not mutate the fallback array', () => {
    const fallback = ['alpha'];
    const result = parseStoredArray('broken', fallback);

    result.push('beta');
    assert.deepEqual(fallback, ['alpha']);
});

test('normalizeChoice accepts allowed values and rejects the rest', () => {
    assert.equal(normalizeChoice('medium', ['small', 'medium'], 'small'), 'medium');
    assert.equal(normalizeChoice('huge', ['small', 'medium'], 'small'), 'small');
    assert.equal(normalizeChoice(null, ['small'], 'small'), 'small');
});

test('normalizeSidebarWidth accepts sane pixel values only', () => {
    assert.equal(normalizeSidebarWidth('320px'), '320px');
    assert.equal(normalizeSidebarWidth('  440px '), '440px');
    assert.equal(normalizeSidebarWidth('10px'), '280px');
    assert.equal(normalizeSidebarWidth('9000px'), '280px');
    assert.equal(normalizeSidebarWidth('calc(100vw)'), '280px');
    assert.equal(normalizeSidebarWidth(null), '280px');
});

test('uniqueStrings trims, filters and deduplicates while preserving order', () => {
    assert.deepEqual(
        uniqueStrings(['llama3.1:8b', ' llama3.1:8b ', '', null, 42, 'qwen3:8b']),
        ['llama3.1:8b', 'qwen3:8b']
    );
    assert.deepEqual(uniqueStrings('not-an-array'), []);
    assert.deepEqual(uniqueStrings(null), []);
});

test('normalizeCloudModelName folds API names and cloud aliases', () => {
    assert.equal(normalizeCloudModelName('gemma4:31b'), 'gemma4:31b');
    assert.equal(normalizeCloudModelName('  gemma4:31b-cloud '), 'gemma4:31b');
    assert.equal(normalizeCloudModelName('gpt-oss:20b:cloud'), 'gpt-oss:20b');
    assert.equal(normalizeCloudModelName('GPT-OSS:20B-CLOUD'), 'gpt-oss:20b');
    assert.equal(normalizeCloudModelName(null), '');
    assert.equal(normalizeCloudModelName(42), '');
});

test('isFreeCloudModel matches API names and cloud aliases', () => {
    const freeModels = ['gemma4:31b', 'gpt-oss:20b', 'nemotron-3-super'];

    assert.equal(isFreeCloudModel('gemma4:31b', freeModels), true);
    assert.equal(isFreeCloudModel('gemma4:31b-cloud', freeModels), true);
    assert.equal(isFreeCloudModel('GPT-OSS:20B:cloud', freeModels), true);
    assert.equal(isFreeCloudModel('glm-4.7:cloud', freeModels), false);
    assert.equal(isFreeCloudModel('', freeModels), false);
    assert.equal(isFreeCloudModel(null, freeModels), false);
});

test('mergeCloudModels adds new models without duplicating aliases', () => {
    assert.deepEqual(
        mergeCloudModels(
            ['gpt-oss:20b-cloud', 'glm-4.7:cloud'],
            ['gpt-oss:20b', 'gemma4:31b', 'gemma4:31b-cloud', 'beam']
        ),
        ['gpt-oss:20b-cloud', 'glm-4.7:cloud', 'gemma4:31b', 'beam']
    );
});

test('mergeCloudModels tolerates bad input and does not mutate its inputs', () => {
    const existing = ['glm-4.7:cloud'];
    const additions = ['beam', null, 42];

    assert.deepEqual(mergeCloudModels(existing, additions), ['glm-4.7:cloud', 'beam']);
    assert.deepEqual(existing, ['glm-4.7:cloud']);
    assert.deepEqual(mergeCloudModels(null, null), []);
});

test('splitCloudModelsByPlan separates free models and accepts alias suffixes', () => {
    const { free, paid } = splitCloudModelsByPlan(
        [
            'gpt-oss:20b-cloud',
            'glm-4.7:cloud',
            'gemma4:31b',
            'nemotron-3-nano:30b',
            'beam',
            'gemma4:31b',
            '   '
        ],
        ['beam', 'gemma4:31b', 'gpt-oss:20b', 'nemotron-3-nano:30b']
    );

    assert.deepEqual(free, [
        'gpt-oss:20b-cloud',
        'gemma4:31b',
        'nemotron-3-nano:30b',
        'beam'
    ]);
    assert.deepEqual(paid, ['glm-4.7:cloud']);
});

test('splitCloudModelsByPlan treats everything as paid without a free list', () => {
    const { free, paid } = splitCloudModelsByPlan(['gemma4:31b', 'glm-4.7:cloud'], null);

    assert.deepEqual(free, []);
    assert.deepEqual(paid, ['gemma4:31b', 'glm-4.7:cloud']);
});

test('parseStoredObject accepts objects and rejects malformed or array values', () => {
    assert.deepEqual(parseStoredObject('{"new":"hello","chat:1":"draft"}'), {
        new: 'hello',
        'chat:1': 'draft'
    });
    assert.deepEqual(parseStoredObject('[]'), {});
    assert.deepEqual(parseStoredObject('null'), {});
    assert.deepEqual(parseStoredObject('{broken'), {});
    assert.deepEqual(parseStoredObject(''), {});
    assert.deepEqual(parseStoredObject(null), {});
});

test('buildConversationContext keeps the newest messages within the limit', () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`
    }));

    const context = buildConversationContext(messages);

    assert.equal(context.length, 40);
    assert.equal(context[0].content, 'message-10');
    assert.equal(context.at(-1).content, 'message-49');
    assert.deepEqual(Object.keys(context[0]), ['role', 'content']);
});

test('buildConversationContext stops when the character budget is reached', () => {
    const context = buildConversationContext([
        { role: 'user', content: '12345' },
        { role: 'assistant', content: 'abcdef' },
        { role: 'user', content: 'xy' }
    ], { maxChars: 10 });

    assert.deepEqual(context, [
        { role: 'assistant', content: 'abcdef' },
        { role: 'user', content: 'xy' }
    ]);
});

test('buildConversationContext always keeps the latest oversized message', () => {
    const context = buildConversationContext([
        { role: 'user', content: 'short' },
        { role: 'user', content: 'a much longer final question' }
    ], { maxChars: 5 });

    assert.deepEqual(context, [
        { role: 'user', content: 'a much longer final question' }
    ]);
});

test('buildConversationContext ignores empty and malformed messages', () => {
    const context = buildConversationContext([
        { role: 'assistant', content: '   ' },
        { role: 'tool', content: 'ignored' },
        { role: 'user', content: '' },
        null,
        { role: 'user', content: 'kept' }
    ], { maxMessages: 5 });

    assert.deepEqual(context, [{ role: 'user', content: 'kept' }]);
    assert.deepEqual(buildConversationContext('not-an-array'), []);
});

test('safeStorageGet reads values and survives unavailable storage', () => {
    const original = globalThis.localStorage;

    globalThis.localStorage = {
        getItem(key) {
            if (key === 'throws') throw new Error('storage blocked');
            return key === 'present' ? 'value' : null;
        }
    };

    try {
        assert.equal(safeStorageGet('present', 'fallback'), 'value');
        assert.equal(safeStorageGet('missing', 'fallback'), 'fallback');
        assert.equal(safeStorageGet('throws', 'fallback'), 'fallback');
    } finally {
        globalThis.localStorage = original;
    }
});

test('normalizeEndpointUrl accepts HTTP(S) URLs and strips trailing slashes', () => {
    assert.equal(normalizeEndpointUrl('  http://localhost:11434/  '), 'http://localhost:11434');
    assert.equal(normalizeEndpointUrl('https://ollama.com/api///'), 'https://ollama.com/api');
    assert.equal(normalizeEndpointUrl('https://ollama.com/api?x=1#hash'), 'https://ollama.com/api');
});

test('normalizeEndpointUrl rejects unsupported or malformed URLs', () => {
    assert.equal(normalizeEndpointUrl('ftp://example.com'), '');
    assert.equal(normalizeEndpointUrl('not a url'), '');
    assert.equal(normalizeEndpointUrl(''), '');
    assert.equal(normalizeEndpointUrl(null), '');
    assert.equal(normalizeEndpointUrl('nonsense', 'http://fallback.test'), 'http://fallback.test');
});

test('isLoopbackEndpoint recognises loopback hosts only', () => {
    assert.equal(isLoopbackEndpoint('http://localhost:11434'), true);
    assert.equal(isLoopbackEndpoint('http://127.0.0.1:11434/api'), true);
    assert.equal(isLoopbackEndpoint('http://[::1]:11434'), true);
    assert.equal(isLoopbackEndpoint('https://ollama.com/api'), false);
    assert.equal(isLoopbackEndpoint('http://192.168.1.10:11434'), false);
    assert.equal(isLoopbackEndpoint('not a url'), false);
});

test('canSendApiKey only allows HTTPS or loopback endpoints', () => {
    assert.equal(canSendApiKey('https://ollama.com/api/chat'), true);
    assert.equal(canSendApiKey('http://localhost:11434/api/chat'), true);
    assert.equal(canSendApiKey('http://127.0.0.1:11434/api/chat'), true);
    assert.equal(canSendApiKey('http://example.invalid/api/chat'), false);
    assert.equal(canSendApiKey('ftp://example.com'), false);
    assert.equal(canSendApiKey('not a url'), false);
});

test('describeFetchFailure gives local Ollama guidance for network failures', () => {
    const message = describeFetchFailure('http://localhost:11434/api/chat', new TypeError('Failed to fetch'));

    assert.match(message, /Could not reach Ollama at http:\/\/localhost:11434/);
    assert.match(message, /OLLAMA_ORIGINS/);
});

test('describeFetchFailure explains cloud CORS for remote network failures', () => {
    const message = describeFetchFailure('https://ollama.com/api/chat', new TypeError('Failed to fetch'));

    assert.match(message, /https:\/\/ollama\.com/);
    assert.match(message, /CORS/);
    assert.match(message, /same-origin proxy/);
});

test('describeFetchFailure leaves non-network errors unchanged', () => {
    assert.equal(
        describeFetchFailure('https://ollama.com/api/chat', new Error('API Error: 500')),
        'API Error: 500'
    );
});
