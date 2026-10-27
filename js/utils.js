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

    /**
     * Read a localStorage value without throwing when storage is unavailable.
     *
     * @param {string} key
     * @param {string | null} [fallback]
     * @returns {string | null}
     */
    function safeStorageGet(key, fallback = null) {
        try {
            const storage = globalThis.localStorage;
            if (!storage) return fallback;
            const value = storage.getItem(key);
            return value === null || value === undefined ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    /**
     * Parse a JSON array of strings from storage. Malformed JSON, non-arrays and
     * non-string entries fall back safely instead of crashing app startup.
     *
     * @param {unknown} raw
     * @param {string[]} [fallback]
     * @returns {string[]}
     */
    function parseStoredArray(raw, fallback = []) {
        const fallbackCopy = Array.isArray(fallback) ? fallback.slice() : [];
        if (typeof raw !== 'string' || raw.trim() === '') return fallbackCopy;

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            return fallbackCopy;
        }

        if (!Array.isArray(parsed)) return fallbackCopy;

        return parsed
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    /**
     * Return `value` when it is one of the allowed options, otherwise `fallback`.
     *
     * @param {unknown} value
     * @param {string[]} allowed
     * @param {string} fallback
     * @returns {string}
     */
    function normalizeChoice(value, allowed, fallback) {
        return Array.isArray(allowed) && allowed.includes(value) ? value : fallback;
    }

    /**
     * Keep a persisted sidebar width inside a sane pixel range.
     *
     * @param {unknown} value
     * @param {string} [fallback]
     * @returns {string}
     */
    function normalizeSidebarWidth(value, fallback = '280px') {
        const match = /^(\d{3,4})px$/.exec(String(value ?? '').trim());
        if (!match) return fallback;

        const width = Number(match[1]);
        return width >= 200 && width <= 2000 ? `${width}px` : fallback;
    }

    /**
     * Return the unique, trimmed, non-empty strings from a list while keeping
     * the original order.
     *
     * @param {unknown} values
     * @returns {string[]}
     */
    function uniqueStrings(values) {
        if (!Array.isArray(values)) return [];

        const seen = new Set();
        const result = [];

        for (const value of values) {
            if (typeof value !== 'string') continue;
            const trimmed = value.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            result.push(trimmed);
        }

        return result;
    }

    /**
     * Trim and validate an HTTP(S) endpoint, dropping trailing slashes.
     * Returns `fallback` when the value is not a usable URL.
     *
     * @param {unknown} value
     * @param {string} [fallback]
     * @returns {string}
     */
    function normalizeEndpointUrl(value, fallback = '') {
        if (typeof value !== 'string') return fallback;

        const trimmed = value.trim();
        if (!trimmed) return fallback;

        let url;
        try {
            url = new URL(trimmed);
        } catch (error) {
            return fallback;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;

        const path = url.pathname.replace(/\/+$/, '');
        return `${url.origin}${path}`;
    }

    /**
     * Whether an endpoint points at the local machine.
     *
     * @param {unknown} value
     * @returns {boolean}
     */
    function isLoopbackEndpoint(value) {
        try {
            const hostname = new URL(String(value)).hostname.toLowerCase();
            return hostname === 'localhost'
                || hostname === '127.0.0.1'
                || hostname === '::1'
                || hostname === '[::1]';
        } catch (error) {
            return false;
        }
    }

    /**
     * API keys are only safe to send over HTTPS or to a loopback address.
     *
     * @param {unknown} endpoint
     * @returns {boolean}
     */
    function canSendApiKey(endpoint) {
        try {
            const protocol = new URL(String(endpoint)).protocol;
            return protocol === 'https:' || isLoopbackEndpoint(endpoint);
        } catch (error) {
            return false;
        }
    }

    /**
     * Turn a network failure into an actionable message. Non-network errors
     * (HTTP status failures, parser errors) are returned unchanged.
     *
     * @param {unknown} endpoint
     * @param {unknown} error
     * @returns {string}
     */
    function describeFetchFailure(endpoint, error) {
        const message = error?.message ? String(error.message) : 'Request failed';
        const isNetworkFailure = error instanceof TypeError
            || /failed to fetch|load failed|networkerror|network error/i.test(message);

        if (!isNetworkFailure) return message;

        let origin = String(endpoint ?? '');
        try {
            origin = new URL(String(endpoint)).origin;
        } catch (urlError) {
            // Keep the raw endpoint when it cannot be parsed.
        }

        if (isLoopbackEndpoint(endpoint)) {
            return `${message}. Could not reach Ollama at ${origin}. Make sure it is running and allow this origin with OLLAMA_ORIGINS="*".`;
        }

        return `${message}. Could not reach ${origin}. Browser requests to a remote Ollama endpoint need CORS support; ollama.com does not send CORS headers. Use a same-origin proxy or a local Ollama daemon with cloud models enabled.`;
    }

    return {
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
        normalizeEndpointUrl,
        isLoopbackEndpoint,
        canSendApiKey,
        describeFetchFailure
    };
});
