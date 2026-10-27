/*
 * Shared, dependency-free helpers.
 *
 * Loaded as a classic script in the browser (exposes `window.AppUtils`) and
 * consumed through CommonJS by the Node test suite. Keeping this file free of
 * DOM/network access makes every helper directly unit-testable.
 */
(function (root, factory) {
    'use strict';

    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.AppUtils = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HTML_ENTITIES = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    /**
     * Escape a value for safe interpolation into an HTML template string.
     * Always use this for user-, server-, or storage-provided text.
     *
     * @param {unknown} value
     * @returns {string}
     */
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
    }

    return { escapeHtml };
});
