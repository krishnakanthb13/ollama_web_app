'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml } = require('../js/utils.js');

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
