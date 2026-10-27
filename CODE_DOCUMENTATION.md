# Code Documentation

## Project Structure

- `index.html`: The main entry point for the application. It bundles the UI structure, declares the Content-Security-Policy and loads the vendored Markdown libraries.
- `css/`: Contains the styling for the application.
  - `styles.css`: The primary stylesheet containing CSS variables, dark mode themes, component styles, and responsiveness logic.
- `js/`: Contains the application logic.
  - `app.js`: The monolithic JavaScript file handling state, IndexedDB interactions, UI rendering, event listeners, and API calls to Ollama.
  - `utils.js`: Dependency-free shared helpers (HTML escaping, storage parsing, NDJSON parsing, URL normalisation). Loaded before `app.js` and also consumable by the Node test suite.
- `vendor/`: Locally hosted third-party libraries and their license texts (see `THIRD_PARTY_NOTICES.md`).
- `tests/`: Node-based unit tests (`node:test`) and headless-browser tests (Playwright Core against the installed Chrome channel), including a mock Ollama server.
- `sw.js`: The Service Worker file responsible for caching assets (HTML, CSS, JS, Images) to enable PWAs to work offline.
- `manifest.json`: Metadata for the Progressive Web App (PWA) installation.
- `run_app.bat` / `run_app.sh`: Scripts to launch a local development server for the application.

## High-Level Architecture

The Ollama Web App follows a **client-side only** architecture (Single Page Application). It connects directly to a locally running Ollama instance or a configured cloud endpoint.

1.  **UI Layer**: HTML5 + Vanilla CSS. No frameworks.
2.  **Logic Layer**: Vanilla JavaScript (ES6+).
3.  **Data Layer**: IndexedDB (`OllamaWebApp`) for persistent storage of chats and messages.
4.  **Network Layer**: `fetch` API to communicate with Ollama (`/api/tags`, `/api/chat`).

### Cloud endpoints and CORS

The app runs entirely in the browser, so every API call is subject to CORS.
Ollama's public endpoint (`https://ollama.com/api`) does not return
`Access-Control-Allow-Origin`, which means direct browser requests are blocked.
Use a same-origin proxy or a local Ollama daemon with cloud models enabled; the
UI reports this explicitly when a remote request fails.

Endpoint URLs are validated as `http(s)` and trailing slashes are removed. API
keys are attached only to cloud requests, and only over HTTPS or a loopback
address. Insecure remote endpoints are refused rather than leaking the key.

### Model selection

The model selector keeps local models separate from cloud models. Cloud models
are further split into `FREE CLOUD MODELS` and `PAID CLOUD MODELS` using the
`FREE_CLOUD_MODELS` list, which mirrors the seven free-tier models shown under
usage settings on [ollama.com/settings](https://ollama.com/settings). Each
section shows how many models it contains. Plan matching accepts both API names
(`gemma4:31b`) and CLI aliases (`gemma4:31b-cloud`). Sorting (Default or A-Z)
applies inside each section so the local/free/paid boundary stays visible.

Grouping is based on the source lists (`localModels` vs `cloudModels`), never on
the name suffix alone, so a locally pulled model that happens to share a free
cloud name stays in the local section. When an empty chat is open, the
placeholder repeats the selected cloud model's plan: free-tier models are marked
as using free usage credits, while all other cloud models point to the paid plan
or usage credits and link to the usage settings.

The cloud list is also the catalogue cache. Existing installs are backfilled
once with any newly introduced free models (`cloudCatalogVersion` records that
migration), without duplicating CLI aliases such as `gpt-oss:20b-cloud`. At
startup the app also tries `GET {cloudUrl}/tags` in the background when the
cloud endpoint is not loopback, merging any returned model names into the cached
list. Direct requests to `ollama.com` remain CORS-blocked, so this refresh is
useful behind a proxy or a reachable Ollama gateway; failures silently keep the
stored list.

The grouping is presentation-only: it does not change which endpoint or model
name is sent in a request. Free-tier usage still draws from the account's free
credits, and any other cloud model requires credits or a paid plan.

### Conversation context

Only the newest messages are sent as context, capped at 40 messages or roughly
24,000 characters, whichever limit is reached first. The latest message is
always included even if it alone exceeds the character budget. This keeps long
conversations from producing oversized requests while preserving the most
relevant recent turns.

### Draft autosave

Unsent composer text is saved as you type and restored when you return to the
same conversation. Drafts live in one `localStorage` map keyed by scope: `new`
for a conversation that has not been sent yet, and `chat:<id>` once it exists.
The first send moves any text typed during chat creation from `new` to the new
chat's scope, and sending clears only the active draft. Chats that still have an
unsent draft show a `Draft` badge in the sidebar. Storage failures are ignored
so private browsing or a full quota cannot break chat.

## Core Modules & Functions (`js/app.js`)

| Module / Class | Function | Description |
| :--- | :--- | :--- |
| **DB** | `constructor()` | Initializes the IndexedDB connection. |
| | `getChat(id)` | Retrieves a specific chat thread. |
| | `addMessage()` | Saves a user or assistant message to the database. |
| **State** | `state` object | Holds global app state (`currentChatId`, `models`, `settings`). |
| | `validateCurrentModel()` | Falls back to the first available model when the stored selection no longer exists. |
| | `updateHeaderControlsUI()` | Shows only the controls the selected model supports and keeps the quality label in sync. |
| **Capabilities** | `getModelCapabilities()` | Detects thinking, tools and size support from the model name. |
| **Initialization** | `init()` | Bootstraps the app: binds DOM, loads models, restores settings. |
| | `loadStoredCloudModels()` / `refreshCloudModels()` | Backfills the free-tier catalogue once and refreshes the cached cloud list from a reachable `/tags` endpoint. |
| **Chat Logic** | `sendMessage()` | Handles user input, updates UI, calls Ollama API, streams the response, and persists a partial answer when a request is stopped or interrupted. |
| | `stopGeneration()` | Cancels the active request; the partial answer is saved with an `interrupted` status. |
| **Drafts** | `saveDraft()` / `restoreDraft()` | Persists the composer per conversation scope and restores it on chat load, new chat and startup. |
| | `clearDraft()` / `adoptDraftScope()` | Clears only the active draft after sending and moves a `new` draft to the chat id created by the first send. |
| | `syncDraftBadges()` | Updates the sidebar `Draft` badge without re-rendering the whole list. |
| **Rendering** | `renderChatList()` | Renders the sidebar list of conversation history. |
| | `renderMessages()` | Renders the transcript, including the empty-state hint and the selected cloud model's plan note. |
| | `renderModelList()` | Renders local, free cloud and paid cloud model sections with counts, applying the search filter and sort order within each section. |
| | `appendMessageToUI()` | Adds a new message bubble to the chat window (supports Markdown). |
| **Utilities** | `escapeHtml()` | Escapes all untrusted values before HTML interpolation. |
| | `buildConversationContext()` | Keeps the newest chat turns within the 40-message / 24,000-character context budget. |
| | `createNdjsonParser()` | Buffers split stream lines, flushes the final line, and reports `done`/`error` payloads. |
| | `parseStoredArray()` / `normalizeChoice()` | Validate persisted arrays and enum-like settings before they reach app state. |
| | `safeStorageGet()` / `parseStoredObject()` | Read localStorage without throwing and validate persisted JSON objects. |
| | `splitCloudModelsByPlan()` / `normalizeCloudModelName()` / `isFreeCloudModel()` | Split cloud models into free and paid lists, matching API names and `-cloud`/`:cloud` aliases. |
| | `mergeCloudModels()` | Merges catalogue additions without duplicating the same model under an API name and CLI alias. |
| | `normalizeEndpointUrl()` / `canSendApiKey()` | Validates endpoint URLs and blocks API keys on insecure remote connections. |
| | `describeFetchFailure()` | Adds local Ollama or cloud CORS guidance to network failures. |
| **Settings** | `openSettings()` | Toggles the settings panel. |
| | `toggleCloudList()` | Expands/collapses the cloud model configuration section. |

## Data Flow

1.  **Initialization**: `init()` -> Load Settings (`localStorage`) -> Open DB -> Load Models (API) -> Render UI.
2.  **User Message**: Input -> `sendMessage()` -> **Update UI** (Optimistic) -> **Save to DB**.
3.  **API Call**: `sendMessage()` -> `fetch(Ollama API)` -> **Stream Response**.
4.  **Bot Response**: Chunk Received -> **Update UI** (Token by Token) -> **Save Final Message to DB**. If the request is stopped, times out, or the user switches chats, the received tokens are still saved with an `interrupted` status.

## Dependencies

- **Runtime**:
  - A modern web browser (Chrome, Edge, Firefox).
  - [Ollama](https://ollama.com/) running locally (default: `http://localhost:11434`) or cloud access.
- **Libraries (vendored)**:
  - `vendor/marked.umd.js` (18.1.2): For parsing Markdown in chat messages.
  - `vendor/purify.min.js` (3.4.17): For sanitizing rendered HTML to prevent XSS.
  - No CDN is used at runtime, so the app loads offline and under its CSP. See
    `THIRD_PARTY_NOTICES.md` and the license files in `vendor/`.

## Content-Security-Policy

`index.html` sets a CSP in a `<meta http-equiv>` tag. Scripts and styles are
restricted to the app's own origin; `'unsafe-inline'` remains for the existing
inline event handlers and `style` attributes. Connections may target any
`http:`/`https:` origin because the Ollama endpoint is user-configured, while
images allow `data:`, `blob:` and remote URLs used in Markdown. Objects and base
URL overrides are blocked. Because the policy is declared in HTML rather than an
HTTP header, it also protects the app when served by any static file server.
- **Development**:
  - `http-server`: Simple static server for local testing.

## Execution Flow

1.  User opens `index.html` (via `run_app.bat`).
2.  `sw.js` installs and caches core assets.
3.  `app.js` initializes `DB` and restores the last active chat/model.
4.  User types a prompt.
5.  App sends JSON payload to Ollama `/api/chat`.
6.  Ollama returns a stream of JSON objects.
7.  App parses chunks and updates the DOM in real-time.

## Testing

```bash
npm test          # unit + browser tests
npm run test:unit # node:test helpers only
npm run test:e2e  # headless Chrome against tests/mock-server.js
```

The browser tests use `playwright-core` with the locally installed Chrome
(`channel: "chrome"`), so no browser download is required. Set
`CHROME_CHANNEL=msedge` to run them with Edge instead.
