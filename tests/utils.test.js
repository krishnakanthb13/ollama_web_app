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
    normalizeSidebarWidth
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
