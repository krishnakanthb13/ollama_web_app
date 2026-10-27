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

    /**
     * Scroll a container to its latest content. Kept as a helper so the
     * browser code and tests share the same behaviour.
     *
     * @param {{ scrollTop: number, scrollHeight: number } | null | undefined} element
     */
    function scrollElementToBottom(element) {
        if (!element) return;
        element.scrollTop = element.scrollHeight;
    }

    /**
     * Build a stable chat title without splitting surrogate pairs (emoji).
     *
     * @param {unknown} text
     * @param {number} [maxLength]
     * @returns {string}
     */
    function buildChatTitle(text, maxLength = 30) {
        const characters = Array.from(String(text ?? '').trim());
        if (characters.length === 0) return 'New chat';

        const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 30;
        return characters.length > limit
            ? `${characters.slice(0, limit).join('')}...`
            : characters.join('');
    }

    /**
     * Tracks exactly one in-flight generation. The registry makes the
     * "is this still the active request?" checks explicit and testable, which
     * prevents late stream chunks from touching a newly opened chat.
     */
    function createRequestRegistry() {
        let current = null;
        let sequence = 0;

        return {
            start(meta = {}) {
                const request = Object.assign({
                    id: ++sequence,
                    cancelled: false,
                    stopReason: null,
                    controller: new AbortController()
                }, meta);

                request.done = new Promise((resolve) => {
                    request._resolveDone = resolve;
                });

                current = request;
                return request;
            },

            isCurrent(request) {
                return Boolean(request) && current === request && !request.cancelled;
            },

            cancel(request, reason = 'navigation') {
                if (!request) return;
                if (!request.stopReason) request.stopReason = reason;
                request.cancelled = true;
                request.controller?.abort();
                if (current === request) current = null;
            },

            finish(request) {
                if (request) request._resolveDone?.();
                if (current === request) current = null;
            },

            get current() {
                return current;
            }
        };
    }

    /**
     * Stateful parser for Ollama's newline-delimited JSON stream. Buffers
     * partial lines across chunks and exposes the `done` flag so the caller can
     * distinguish a completed answer from a truncated stream.
     *
     * Events have the shape `{ content, thinking, done }` for data lines and
     * `{ error, fatal }` for `{ "error": ... }` payloads (fatal) or malformed
     * lines (non-fatal).
     */
    function createNdjsonParser() {
        let buffer = '';
        let sawDone = false;

        function parseLine(line, events) {
            const trimmed = line.trim();
            if (!trimmed) return;

            let json;
            try {
                json = JSON.parse(trimmed);
            } catch (error) {
                events.push({
                    error: `Malformed JSON from server: ${trimmed.slice(0, 120)}`,
                    fatal: false
                });
                return;
            }

            if (json && json.error) {
                sawDone = true;
                events.push({ error: String(json.error), fatal: true });
                return;
            }

            const event = {
                content: typeof json.message?.content === 'string' ? json.message.content : '',
                thinking: typeof json.message?.thinking === 'string' ? json.message.thinking : '',
                done: json.done === true
            };
            if (event.done) sawDone = true;
            events.push(event);
        }

        return {
            push(chunk) {
                buffer += String(chunk ?? '');
                const events = [];
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) parseLine(line, events);
                return events;
            },

            flush() {
                const events = [];
                if (buffer.trim()) parseLine(buffer, events);
                buffer = '';
                return events;
            },

            get sawDone() {
                return sawDone;
            }
        };
    }

    return {
        escapeHtml,
        scrollElementToBottom,
        buildChatTitle,
        createRequestRegistry,
        createNdjsonParser
    };
});
