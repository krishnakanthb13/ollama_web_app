'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    escapeHtml,
    scrollElementToBottom,
    buildChatTitle,
    createRequestRegistry
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
