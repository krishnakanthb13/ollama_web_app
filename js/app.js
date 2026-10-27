// --- DB Logic (Inlined for compatibility) ---
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
    canonicalizeFreeCloudModels,
    splitCloudModelsByPlan,
    normalizeEndpointUrl,
    isLoopbackEndpoint,
    canSendApiKey,
    describeFetchFailure
} = window.AppUtils;
const requestRegistry = createRequestRegistry();
const REQUEST_IDLE_TIMEOUT_MS = 60000;
const DB_NAME = 'OllamaWebApp';
const DB_VERSION = 1;

class DB {
    constructor() {
        this.db = null;
    }

    async open() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (e) => reject(e.target.error);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('chats')) {
                    const store = db.createObjectStore('chats', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('updated_at', 'updated_at', { unique: false });
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('chat_id', 'chat_id', { unique: false });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
        });
    }

    async getAllChats() {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('chats', 'readonly');
            const store = tx.objectStore('chats');
            const index = store.index('updated_at');
            const request = index.getAll();
            request.onsuccess = () => resolve(request.result.reverse());
            request.onerror = () => reject(request.error);
        });
    }

    async createChat(title, model) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('chats', 'readwrite');
            const store = tx.objectStore('chats');
            const chat = {
                title,
                model,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            const request = store.add(chat);
            request.onsuccess = () => {
                chat.id = request.result;
                resolve(chat);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getChat(id) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('chats', 'readonly');
            const store = tx.objectStore('chats');
            const request = store.get(Number(id));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteChat(id) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['chats', 'messages'], 'readwrite');
            const chatStore = tx.objectStore('chats');
            const msgStore = tx.objectStore('messages');

            chatStore.delete(Number(id));

            const index = msgStore.index('chat_id');
            const range = IDBKeyRange.only(Number(id));
            index.openCursor(range).onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async addMessage(chatId, role, content, thinking = '', status = 'complete') {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['chats', 'messages'], 'readwrite');
            const msgStore = tx.objectStore('messages');
            const chatStore = tx.objectStore('chats');

            const msg = {
                chat_id: Number(chatId),
                role,
                content,
                thinking,
                status,
                created_at: new Date().toISOString()
            };

            const addRequest = msgStore.add(msg);
            addRequest.onsuccess = () => {
                msg.id = addRequest.result;
            };

            const chatReq = chatStore.get(Number(chatId));
            chatReq.onsuccess = () => {
                const chat = chatReq.result;
                if (chat) {
                    chat.updated_at = new Date().toISOString();
                    chatStore.put(chat);
                }
            };

            tx.oncomplete = () => resolve(msg);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    async getMessages(chatId) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const index = store.index('chat_id');
            const range = IDBKeyRange.only(Number(chatId));
            const request = index.getAll(range);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async exportDatabase() {
        await this.open();
        const chats = await this.getAllChats();
        const exportData = { chats: [], version: 1, exported_at: new Date().toISOString() };

        for (const chat of chats) {
            const messages = await this.getMessages(chat.id);
            exportData.chats.push({ ...chat, messages });
        }
        return exportData;
    }
}

const dbApp = new DB();

// --- Default Configuration ---
const DEFAULT_LOCAL_URL = 'http://localhost:11434';
const DEFAULT_CLOUD_URL = 'https://ollama.com/api';
// Free-tier models as listed in https://ollama.com/settings (usage breakdown).
// Matching also accepts the CLI-style `-cloud`/`:cloud` aliases.
const FREE_CLOUD_MODELS = [
    "beam",
    "gemma4:31b",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "nemotron-3-nano:30b",
    "nemotron-3-super",
    "nemotron-3-ultra"
];

const DEFAULT_CLOUD_MODELS = [
    // Free-tier cloud models
    "beam", "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b",
    "nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra",
    // Paid cloud models
    "glm-4.7:cloud", "minimax-m2.1:cloud", "gemini-3-flash-preview:latest",
    "gemini-3-flash-preview:cloud",
    "gemini-3-pro-preview:latest", "rnj-1:8b-cloud", "devstral-small-2:24b-cloud",
    "devstral-2:123b-cloud", "qwen3-next:80b-cloud", "gemma3:27b-cloud",
    "gemma3:12b-cloud", "gemma3:4b-cloud", "deepseek-v3.2:cloud",
    "mistral-large-3:675b-cloud", "ministral-3:14b-cloud",
    "ministral-3:8b-cloud", "ministral-3:3b-cloud", "cogito-2.1:671b-cloud",
    "qwen3-vl:235b-instruct-cloud", "deepseek-v3.1:671b-cloud",
    "glm-4.6:cloud", "kimi-k2-thinking:cloud",
    "minimax-m2:cloud", "qwen3-coder:480b-cloud", "kimi-k2:1t-cloud",
    "qwen3-vl:235b-cloud"
];

// Bump when the default cloud catalogue changes so existing installs merge
// newly introduced free models once instead of silently keeping stale storage.
const CLOUD_CATALOG_VERSION = '1';
const DRAFTS_KEY = 'drafts';
const THEMES = ['midnight', 'tide', 'paper'];
const THEME_LABELS = { midnight: 'Midnight', tide: 'Tide', paper: 'Paper' };
const THEME_COLORS = { midnight: '#0b0d10', tide: '#07171b', paper: '#f4f2ec' };
const THEME_STORAGE_KEY = 'theme';

function loadStoredCloudModels() {
    const stored = uniqueStrings(
        parseStoredArray(safeStorageGet('cloudModels'), DEFAULT_CLOUD_MODELS)
    );

    // Legacy default catalogues stored free models under `-cloud` aliases, which
    // collide with the local daemon's mirror of cloud models and drop out of the
    // free section. Rewrite them to the canonical API name first.
    const canonical = canonicalizeFreeCloudModels(stored, FREE_CLOUD_MODELS);

    const migrated = safeStorageGet('cloudCatalogVersion') === CLOUD_CATALOG_VERSION
        ? canonical
        // Keep an explicitly emptied list empty, but backfill free-tier models
        // for existing catalogues. `mergeCloudModels` avoids duplicate aliases.
        : (canonical.length > 0 ? mergeCloudModels(canonical, FREE_CLOUD_MODELS) : canonical);

    const changed = JSON.stringify(migrated) !== JSON.stringify(stored);
    if (changed || safeStorageGet('cloudCatalogVersion') !== CLOUD_CATALOG_VERSION) {
        try {
            if (changed) localStorage.setItem('cloudModels', JSON.stringify(migrated));
            localStorage.setItem('cloudCatalogVersion', CLOUD_CATALOG_VERSION);
        } catch (error) {
            // Storage is best-effort; the in-memory list still works for this session.
        }
    }

    return migrated;
}

// --- State ---
const state = {
    currentChatId: null,
    currentModel: safeStorageGet('lastModel', ''),
    chats: [],
    messages: [],
    isSidebarOpen: false,
    isSending: false,

    // Configuration
    localUrl: normalizeEndpointUrl(safeStorageGet('localUrl'), DEFAULT_LOCAL_URL),
    cloudUrl: normalizeEndpointUrl(safeStorageGet('cloudUrl'), DEFAULT_CLOUD_URL),
    cloudApiKey: safeStorageGet('cloudApiKey', ''),

    // Models
    localModels: [],
    // Cloud relays surfaced by the local daemon (`remote_model` entries and
    // `-cloud`/`:cloud` names): display name -> real model name. They stay in
    // `localModels` for routing but are grouped under the cloud sections.
    cloudMirrors: new Map(),
    hiddenModels: uniqueStrings(parseStoredArray(safeStorageGet('hiddenModels'), [])),
    cloudModels: loadStoredCloudModels(),
    modelSearchQuery: '',

    // Settings / Toggles
    showThinking: safeStorageGet('showThinking') === 'true',
    qualityPreset: normalizeChoice(safeStorageGet('qualityPreset'), ['none', 'low', 'medium', 'high'], 'none'),
    sortOrder: normalizeChoice(safeStorageGet('sortOrder'), ['default', 'az'], 'default'),
    fontSize: normalizeChoice(safeStorageGet('fontSize'), ['small', 'medium', 'large'], 'medium'),
    theme: normalizeChoice(safeStorageGet(THEME_STORAGE_KEY), THEMES, 'midnight'),
    sidebarWidth: normalizeSidebarWidth(safeStorageGet('sidebarWidth'), '280px')
};

// --- DOM Elements ---
const dom = {}; // Populated in init to ensure DOM is ready

// --- Initialization ---
async function init() {
    console.log('App initializing...');
    try {
        bindDomElements();
        applyTheme(state.theme, { persist: false, announce: false });
        setupEventListeners();

        await loadModels();
        setSortOrder(state.sortOrder);
        await loadChatList();
        renderMessages();
        restoreDraft();

        // Restore UI state
        applyFontSize(state.fontSize);
        if (dom.sidebar) dom.sidebar.style.width = state.sidebarWidth;
        document.documentElement.style.setProperty('--sidebar-width', state.sidebarWidth);
        updateHeaderControlsUI();

        // Expose for usage in HTML onclick
        window.setQualityPreset = setQualityPreset;
        console.log('App initialized successfully.');
    } catch (e) {
        console.error('App initialization failed:', e);
        alert('Failed to initialize app. Check console for details.');
    }
}

function bindDomElements() {
    // App Structure
    dom.app = document.getElementById('app');
    dom.sidebar = document.getElementById('sidebar');
    dom.overlay = document.getElementById('overlay');
    dom.chatContainer = document.getElementById('chat-container');
    dom.messagesArea = document.getElementById('messages-area');
    dom.textInput = document.getElementById('user-input');
    dom.sendBtn = document.getElementById('send-btn');
    dom.stopBtn = document.getElementById('stop-btn');
    dom.toast = document.getElementById('toast');
    dom.chatCount = document.getElementById('chat-count');
    dom.composerModel = document.getElementById('composer-model');

    // Sidebar Buttons
    dom.menuBtn = document.getElementById('menu-btn');
    dom.closeSidebarBtn = document.getElementById('close-sidebar-btn');
    dom.newChatBtn = document.getElementById('new-chat-btn');
    dom.headerNewChatBtn = document.getElementById('header-new-chat-btn');

    // Header controls
    dom.thinkingBtn = document.getElementById('thinking-btn');
    dom.themeBtn = document.getElementById('theme-btn');
    dom.themeLabel = document.getElementById('theme-label');

    // NEW Dropdowns
    dom.modelSelectorBtn = document.getElementById('model-selector-btn');
    dom.sidebarResizer = document.getElementById('sidebar-resizer');
    dom.modelDropdown = document.getElementById('model-dropdown');
    dom.currentModelName = document.getElementById('current-model-name');
    dom.modelList = document.getElementById('model-list');

    // NEW Search Elements
    dom.modelSearchContainer = document.querySelector('.model-search-container');
    dom.modelSearchInput = document.getElementById('model-search-input');
    dom.modelSearchClear = document.getElementById('model-search-clear');

    dom.qualityBtn = document.getElementById('quality-selector-btn');
    dom.qualityDropdown = document.getElementById('quality-dropdown');
    dom.currentQualityName = document.getElementById('current-quality-name');

    // Settings
    dom.settingsBtn = document.getElementById('settings-btn-sidebar');
    dom.settingsPanel = document.getElementById('settings-panel');
    dom.closeSettingsBtn = document.getElementById('close-settings-modal');
    dom.saveSettingsBtn = document.getElementById('save-settings-btn');
    dom.exportDbBtn = document.getElementById('export-db-btn');

    // Inputs in Settings
    dom.inputLocalUrl = document.getElementById('setting-local-url');
    dom.inputCloudUrl = document.getElementById('setting-cloud-url');
    dom.inputCloudKey = document.getElementById('setting-cloud-key');
    dom.cloudModelListContainer = document.getElementById('cloud-model-list-container');
    dom.cloudModelList = document.getElementById('cloud-model-list');
    dom.cloudModelInput = document.getElementById('setting-new-model');
    dom.addModelBtn = document.getElementById('add-model-btn');
    dom.toggleCloudBtn = document.getElementById('toggle-cloud-list-btn');

    dom.toggleLocalBtn = document.getElementById('toggle-local-list-btn');
    dom.localModelListContainer = document.getElementById('local-model-list-container');
    dom.localModelList = document.getElementById('local-model-list');

    dom.togglePasswordBtn = document.getElementById('toggle-password-btn');

    // Sorting (inside Model Dropdown now)
    dom.sortDefault = document.getElementById('sort-default');
    dom.sortAz = document.getElementById('sort-az');
}

function setupEventListeners() {
    // Sidebar
    dom.menuBtn?.addEventListener('click', () => toggleSidebar(true));
    dom.closeSidebarBtn?.addEventListener('click', () => toggleSidebar(false));
    dom.overlay?.addEventListener('click', () => toggleSidebar(false));
    dom.newChatBtn?.addEventListener('click', createNewChat);
    dom.headerNewChatBtn?.addEventListener('click', createNewChat);

    document.getElementById('chat-list')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const content = event.target.closest('.chat-item-content');
        if (!content || event.target !== content) return;
        event.preventDefault();
        content.click();
    });

    // Header Controls
    dom.thinkingBtn?.addEventListener('click', toggleThinking);
    dom.themeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleTheme();
    });

    // Role="button" elements need explicit keyboard activation.
    [dom.modelSelectorBtn, dom.qualityBtn].forEach((element) => {
        element?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            element.click();
        });
    });

    // Dropdown Toggles
    // Dropdown Toggles
    dom.modelSelectorBtn?.addEventListener('click', (e) => {
        e.stopPropagation(); // prevent window click
        renderModelList();
        toggleDropdownNS('model');
    });

    dom.qualityBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdownNS('quality');
    });

    // NEW Search Events
    dom.modelSearchInput?.addEventListener('input', (e) => {
        state.modelSearchQuery = e.target.value.toLowerCase();
        if (dom.modelSearchClear) {
            dom.modelSearchClear.style.display = state.modelSearchQuery ? 'block' : 'none';
        }
        renderModelList();
    });

    dom.modelSearchClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        state.modelSearchQuery = '';
        if (dom.modelSearchInput) {
            dom.modelSearchInput.value = '';
            dom.modelSearchInput.focus();
        }
        if (dom.modelSearchClear) dom.modelSearchClear.style.display = 'none';
        renderModelList();
    });

    // Prevent propagation on search input click
    dom.modelSearchInput?.addEventListener('click', (e) => e.stopPropagation());

    // NEW Propagate Stop for Search Container
    dom.modelSearchContainer?.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent closing when clicking background of search area
    });

    // Sorting
    dom.sortDefault?.addEventListener('click', (e) => { e.stopPropagation(); setSortOrder('default'); });
    dom.sortAz?.addEventListener('click', (e) => { e.stopPropagation(); setSortOrder('az'); });

    // Settings
    dom.settingsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dom.settingsPanel?.classList.contains('active')) {
            closeSettings();
        } else {
            openSettings();
        }
    });
    dom.closeSettingsBtn?.addEventListener('click', closeSettings);
    dom.saveSettingsBtn?.addEventListener('click', saveSettings);
    dom.addModelBtn?.addEventListener('click', addCloudModel);
    dom.exportDbBtn?.addEventListener('click', downloadDbExport);
    dom.toggleCloudBtn?.addEventListener('click', toggleCloudList);
    dom.toggleLocalBtn?.addEventListener('click', toggleLocalList);
    dom.togglePasswordBtn?.addEventListener('click', (e) => togglePasswordVisibility(e));

    // Chat
    if (dom.sendBtn) dom.sendBtn.addEventListener('click', sendMessage);
    if (dom.stopBtn) dom.stopBtn.addEventListener('click', stopGeneration);
    if (dom.textInput) {
        dom.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!state.isSending) sendMessage();
            }
        });
        dom.textInput.addEventListener('input', () => {
            autoResizeInput.call(dom.textInput);
            if (dom.sendBtn) dom.sendBtn.disabled = state.isSending || !dom.textInput.value.trim();
            saveDraft();
        });
    }

    // Global click to close dropdowns
    document.addEventListener('click', (e) => {
        closeAllDropdowns();
        // Also close settings sidebar if click outside or inside and type-selection etc.
        // Actually, sidebar usually stays until close btn. 
        // But for better UX let's close if clicking main content.
        if (dom.settingsPanel?.classList.contains('active') &&
            !dom.settingsPanel.contains(e.target) &&
            e.target !== dom.settingsBtn) {
            closeSettings();
        }
    });

    // Keyboard dismissal for transient overlays
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeAllDropdowns();
        if (dom.settingsPanel?.classList.contains('active')) closeSettings();
        if (dom.sidebar?.classList.contains('open')) toggleSidebar(false);
    });

    // Font
    document.querySelectorAll('.font-btn').forEach(btn => {
        btn.addEventListener('click', () => applyFontSize(btn.dataset.size));
    });

    // Sidebar Resizing
    if (dom.sidebarResizer) {
        let isResizing = false;

        dom.sidebarResizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.classList.add('resizing');
            dom.sidebarResizer.classList.add('resizing');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = Math.min(Math.max(200, e.clientX), window.innerWidth * 0.5);
            const widthStr = `${newWidth}px`;
            state.sidebarWidth = widthStr;
            dom.sidebar.style.width = widthStr;
            document.documentElement.style.setProperty('--sidebar-width', widthStr);
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('resizing');
                dom.sidebarResizer.classList.remove('resizing');
                localStorage.setItem('sidebarWidth', state.sidebarWidth);
            }
        });
    }
}

// --- Logic ---

function toggleDropdown(type) {
    // Close all first, then toggle target
    const target = type === 'model' ? dom.modelDropdown : dom.qualityDropdown;
    const isVisible = target.classList.contains('show');
    closeAllDropdowns();
    if (!isVisible) {
        target.classList.add('show');
        (type === 'model' ? dom.modelSelectorBtn : dom.qualityBtn)?.setAttribute('aria-expanded', 'true');
        if (type === 'model') {
            // Always start at the free cloud section, even after the last visit
            // scrolled down to paid models.
            if (dom.modelDropdown) dom.modelDropdown.scrollTop = 0;
            if (dom.modelList) dom.modelList.scrollTop = 0;
            if (dom.modelSearchInput) setTimeout(() => dom.modelSearchInput.focus(), 100);
        }
    }
}

function closeAllDropdowns() {
    if (dom.modelDropdown) {
        dom.modelDropdown.classList.remove('show');
        dom.modelSelectorBtn?.setAttribute('aria-expanded', 'false');
    }
    if (dom.qualityDropdown) {
        dom.qualityDropdown.classList.remove('show');
        dom.qualityBtn?.setAttribute('aria-expanded', 'false');
    }
}

function applyTheme(theme, { persist = true, announce = true } = {}) {
    const next = THEMES.includes(theme) ? theme : 'midnight';
    state.theme = next;

    document.documentElement.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[next]);

    if (persist) {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch (error) {
            // The theme still applies for this session when storage is blocked.
        }
    }

    const label = THEME_LABELS[next];
    if (dom.themeLabel) dom.themeLabel.textContent = label;
    if (dom.themeBtn) {
        dom.themeBtn.setAttribute('aria-label', `Theme: ${label}. Change theme`);
        dom.themeBtn.title = `Theme: ${label}`;
    }

    if (announce) showToast(`${label} theme`);
}

function cycleTheme() {
    const index = THEMES.indexOf(state.theme);
    const next = THEMES[(index + 1) % THEMES.length];
    applyTheme(next);
}

let toastTimer = null;
function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast?.classList.remove('show'), 1800);
}

function setQualityPreset(value) {
    state.qualityPreset = value;
    localStorage.setItem('qualityPreset', value);
    closeAllDropdowns();
    updateHeaderControlsUI();
}

function setSortOrder(order) {
    state.sortOrder = order;
    localStorage.setItem('sortOrder', order);

    dom.sortDefault?.classList.toggle('active', order === 'default');
    dom.sortDefault?.setAttribute('aria-pressed', String(order === 'default'));
    dom.sortAz?.classList.toggle('active', order === 'az');
    dom.sortAz?.setAttribute('aria-pressed', String(order === 'az'));

    renderModelList();
}

async function loadModels() {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000); // 2s timeout
        const res = await fetch(`${state.localUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(id);
        if (res.ok) {
            const data = await res.json();
            // `/api/tags` lists locally reachable models; keep every valid name.
            const models = (data.models || []).filter((model) => model?.name);
            state.localModels = uniqueStrings(models.map((model) => model.name));

            // Entries carrying `remote_model` (or a cloud suffix) are cloud
            // relays of the Ollama app, not downloads; remember their target so
            // the selector groups them under free/paid cloud instead of local.
            state.cloudMirrors = new Map();
            for (const model of models) {
                const name = String(model.name);
                const remote = typeof model.remote_model === 'string'
                    ? model.remote_model.trim()
                    : '';
                const suffixed = /[-:]cloud$/i.test(name);
                if (remote) {
                    state.cloudMirrors.set(name, remote);
                } else if (suffixed) {
                    state.cloudMirrors.set(name, name.replace(/[-:]cloud$/i, ''));
                }
            }
        }
    } catch (e) { /* ignore */ }

    validateCurrentModel();
    renderModelList();

    // Refresh the cloud catalogue in the background when it can be reached.
    // Direct ollama.com requests are CORS-blocked, so this is useful with a
    // proxy or a remote Ollama gateway; failure keeps the cached list.
    refreshCloudModels();
}

async function refreshCloudModels() {
    if (!state.cloudUrl || isLoopbackEndpoint(state.cloudUrl)) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
        const headers = {};
        if (state.cloudApiKey && canSendApiKey(state.cloudUrl)) {
            headers.Authorization = `Bearer ${state.cloudApiKey}`;
        }

        const response = await fetch(`${state.cloudUrl}/tags`, {
            headers,
            signal: controller.signal
        });
        if (!response.ok) return;

        const data = await response.json();
        const names = uniqueStrings((data.models || []).map((model) => model?.name));
        if (names.length === 0) return;

        const merged = mergeCloudModels(state.cloudModels, names);
        if (merged.length === state.cloudModels.length) return;

        state.cloudModels = merged;
        localStorage.setItem('cloudModels', JSON.stringify(state.cloudModels));
        validateCurrentModel();
        renderModelList();
    } catch (error) {
        // Unreachable or CORS-blocked: the persisted list is the cache.
    } finally {
        clearTimeout(timer);
    }
}

function validateCurrentModel() {
    const available = uniqueStrings([...state.localModels, ...state.cloudModels]);

    if (available.length === 0) {
        state.currentModel = '';
        if (dom.currentModelName) dom.currentModelName.textContent = 'Select model…';
        updateHeaderControlsUI();
        return;
    }

    if (!available.includes(state.currentModel)) {
        state.currentModel = available[0];
        localStorage.setItem('lastModel', state.currentModel);
    }

    if (dom.currentModelName) dom.currentModelName.textContent = state.currentModel;
    updateHeaderControlsUI();
}

function renderModelList() {
    const container = dom.modelList;
    if (!container) return;
    container.innerHTML = '';

    const createItem = (name, type) => {
        const div = document.createElement('div');
        div.className = `model-option ${name === state.currentModel ? 'selected' : ''}`;
        div.dataset.source = type.toLowerCase();
        div.setAttribute('role', 'option');
        div.setAttribute('aria-selected', String(name === state.currentModel));
        div.tabIndex = 0;

        const caps = getModelCapabilities(name);
        const icons = caps.length > 0 ? caps.map(c => c.icon).join(' ') : (type === 'Local' ? '💻' : '☁️');
        const safeName = escapeHtml(name);

        div.innerHTML = `
            <div class="model-info">
                <span class="model-name">${safeName}</span>
                <span class="model-icon" aria-hidden="true">${icons}</span>
            </div>
            ${name === state.currentModel ? '<span class="check-icon" aria-hidden="true">✓</span>' : ''}
        `;
        div.onclick = (e) => {
            e.stopPropagation();
            setModel(name);
            closeAllDropdowns();
        };
        div.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            div.click();
        });
        return div;
    };

    // Genuine downloads only. The local daemon also mirrors cloud models
    // (`remote_model` entries / `-cloud` names); those group with cloud below.
    let allLocal = uniqueStrings(state.localModels)
        .filter((name) => !state.cloudMirrors.has(name))
        .map(m => ({ name: m, type: 'Local' }));
    const localNames = new Set(allLocal.map((model) => model.name));

    // A locally pulled model keeps priority over the same cloud entry, and a
    // relay is skipped when the stored cloud list already carries its model
    // (e.g. `gemma4:cloud` next to `gemma4:31b`), so nothing is listed twice.
    const cloudBase = uniqueStrings(state.cloudModels)
        .filter((name) => !localNames.has(name));
    const coveredMirror = (name) => {
        const target = state.cloudMirrors.get(name) || '';
        return Boolean(target) && cloudBase.some(
            (entry) => normalizeCloudModelName(entry) === normalizeCloudModelName(target)
        );
    };
    const mirrorNames = [...state.cloudMirrors.keys()]
        .filter((name) => !state.hiddenModels.includes(name))
        .filter((name) => !localNames.has(name))
        .filter((name) => !coveredMirror(name));

    let allCloud = mergeCloudModels(cloudBase, mirrorNames)
        .map((name) => ({ name, type: 'Cloud' }));

    // FILTERING logic
    if (state.modelSearchQuery) {
        allLocal = allLocal.filter(m => m.name.toLowerCase().includes(state.modelSearchQuery));
        allCloud = allCloud.filter(m => m.name.toLowerCase().includes(state.modelSearchQuery));
    }

    // Exclude hidden models
    allLocal = allLocal.filter(m => !state.hiddenModels.includes(m.name));

    // Paid and free cloud models are shown in separate sections so the plan
    // boundary is visible. Matching accepts API names and `-cloud` aliases, and
    // relays classify with the model they point at.
    const cloudPlans = splitCloudModelsByPlan(
        allCloud.map(m => m.name),
        FREE_CLOUD_MODELS,
        state.cloudMirrors
    );
    const freeCloud = cloudPlans.free.map(name => ({ name, type: 'Cloud' }));
    const paidCloud = cloudPlans.paid.map(name => ({ name, type: 'Cloud' }));

    const addSection = (title, models, marginTop = false) => {
        if (models.length === 0) return;

        const header = document.createElement('div');
        header.className = `model-group-header${marginTop ? ' spaced' : ''}`;

        const label = document.createElement('span');
        label.className = 'model-group-title';
        label.textContent = title;
        header.appendChild(label);

        const count = document.createElement('span');
        count.className = 'model-group-count';
        count.textContent = String(models.length);
        header.appendChild(count);

        container.appendChild(header);

        models.forEach(m => container.appendChild(createItem(m.name, m.type)));
    };

    // Sorting applies inside each section so the local/free/paid grouping stays
    // intact in both display modes.
    const sortSection = (models) => state.sortOrder === 'az'
        ? models.slice().sort((a, b) => a.name.localeCompare(b.name))
        : models;

    // Free cloud models come first because they are the ones most users can
    // try immediately; paid cloud models stay last.
    const sections = [
        { title: 'FREE CLOUD MODELS', models: sortSection(freeCloud) },
        { title: 'LOCAL MODELS', models: sortSection(allLocal) },
        { title: 'PAID CLOUD MODELS', models: sortSection(paidCloud) }
    ].filter((section) => section.models.length > 0);

    sections.forEach((section, index) => addSection(section.title, section.models, index > 0));

    if (sections.length === 0) {
        const noRes = document.createElement('div');
        noRes.className = 'model-empty';
        noRes.textContent = state.modelSearchQuery ? 'No models match that search' : 'No models found';
        container.appendChild(noRes);
    }
}

function setModel(name) {
    if (typeof name !== 'string') return;
    const modelName = name.trim();
    if (!modelName) return;

    state.currentModel = modelName;
    localStorage.setItem('lastModel', modelName);
    // Update UI headers
    if (dom.currentModelName) dom.currentModelName.textContent = modelName;
    updateHeaderControlsUI();

    // Re-render list to show selection
    renderModelList();
    // Keep the empty-state plan note in sync when no conversation is open.
    if (state.messages.length === 0) renderMessages();
}

async function loadChatList() {
    state.chats = await dbApp.getAllChats();
    renderChatList();
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    const drafts = readDrafts();
    if (dom.chatCount) dom.chatCount.textContent = String(state.chats.length);

    list.innerHTML = state.chats.map(chat => {
        const hasDraft = Boolean(drafts[`chat:${chat.id}`]);
        return `
        <div class="chat-item ${chat.id === state.currentChatId ? 'active' : ''}" data-chat-id="${chat.id}"
            role="listitem" onclick="loadChat(${chat.id})">
            <div class="chat-item-content" role="button" tabindex="0"
                aria-label="Open chat: ${escapeHtml(chat.title || 'Untitled chat')}">
                <div class="chat-item-title">${escapeHtml(chat.title || 'Untitled chat')}</div>
                <div class="chat-item-date">
                    ${chat.model ? `<span class="chat-model">${escapeHtml(chat.model)}</span>` : ''}
                    <span class="chat-date">${new Date(chat.updated_at).toLocaleDateString()}</span>
                    ${hasDraft ? '<span class="chat-draft">Draft</span>' : ''}
                </div>
            </div>
            <div class="chat-actions">
                <button class="download-chat-btn" type="button" onclick="exportChatToMarkdown(event, ${chat.id})"
                    title="Download as Markdown" aria-label="Download chat as Markdown">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor" aria-hidden="true"><path d="M480-320 280-520l56-56 104 104v-328h80v328l104-104 56 56-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/></svg>
                </button>
                <button class="delete-chat-btn" type="button" onclick="deleteChat(event, ${chat.id})"
                    title="Delete chat" aria-label="Delete chat">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor" aria-hidden="true"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T720-120H280Zm440-600H240v520q0 8 6 14t14 6h440q8 0 14-6t6-14v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM240-720v520-520Z"/></svg>
                </button>
            </div>
        </div>
    `;
    }).join('');
}

// --- Drafts ---------------------------------------------------------------
// Unsent text is stored per scope: `new` for an unsent conversation and
// `chat:<id>` afterwards, so switching conversations never moves a draft.
function readDrafts() {
    const parsed = parseStoredObject(safeStorageGet(DRAFTS_KEY));
    const drafts = {};
    for (const [scope, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.trim()) drafts[scope] = value;
    }
    return drafts;
}

function writeDrafts(drafts) {
    try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch (error) {
        // Drafts are best-effort; private mode or a full quota must not break chat.
    }
}

function draftScope() {
    return state.currentChatId ? `chat:${state.currentChatId}` : 'new';
}

function saveDraft() {
    if (!dom.textInput) return;
    const scope = draftScope();
    const drafts = readDrafts();
    const had = Boolean(drafts[scope]);
    const has = Boolean(dom.textInput.value.trim());

    if (has) drafts[scope] = dom.textInput.value;
    else delete drafts[scope];

    writeDrafts(drafts);
    if (had !== has) syncDraftBadges();
}

function restoreDraft() {
    if (!dom.textInput) return;
    dom.textInput.value = readDrafts()[draftScope()] || '';
    autoResizeInput.call(dom.textInput);
    if (dom.sendBtn) dom.sendBtn.disabled = state.isSending || !dom.textInput.value.trim();
}

function clearDraft(scope = draftScope()) {
    const drafts = readDrafts();
    if (!(scope in drafts)) return;
    delete drafts[scope];
    writeDrafts(drafts);
    syncDraftBadges();
}

// The first send promotes the unsaved `new` scope to the real chat id. Text
// typed while the reply starts has to follow that id.
function adoptDraftScope(id) {
    const drafts = readDrafts();
    delete drafts.new;
    const text = dom.textInput?.value || '';
    if (text.trim()) drafts[`chat:${id}`] = text;
    else delete drafts[`chat:${id}`];
    writeDrafts(drafts);
    syncDraftBadges();
}

function syncDraftBadges() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    const drafts = readDrafts();

    list.querySelectorAll('.chat-item').forEach((item) => {
        const id = Number(item.dataset.chatId);
        const hasDraft = Boolean(id && drafts[`chat:${id}`]);
        const badge = item.querySelector('.chat-draft');

        if (hasDraft && !badge) {
            const label = document.createElement('span');
            label.className = 'chat-draft';
            label.textContent = 'Draft';
            (item.querySelector('.chat-item-date') || item).appendChild(label);
        } else if (!hasDraft && badge) {
            badge.remove();
        }
    });
}

window.deleteChat = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this chat?')) return;

    if (state.currentChatId === id) {
        await cancelActiveRequest('navigation');
        setSendingUi(false);
    }

    await dbApp.deleteChat(id);
    clearDraft(`chat:${id}`);
    if (state.currentChatId === id) {
        state.currentChatId = null;
        state.messages = [];
        renderMessages();
        restoreDraft();
    }
    await loadChatList();
};

window.exportChatToMarkdown = async (e, id) => {
    e.stopPropagation();
    const chat = await dbApp.getChat(id);
    const messages = await dbApp.getMessages(id);
    if (!chat || !messages) return;

    let md = `# ${chat.title}\n\n`;
    md += `- **Date**: ${new Date(chat.updated_at).toLocaleString()}\n`;
    md += `- **Model**: ${chat.model || 'N/A'}\n\n`;
    md += `---\n\n`;

    messages.forEach(msg => {
        const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
        md += `### ${role}\n`;
        if (msg.thinking) {
            md += `> **Thinking**:\n> ${msg.thinking.replace(/\n/g, '\n> ')}\n\n`;
        }
        md += `${msg.content}\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${chat.title.replace(/[^a-z0-9]/gi, '_')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

window.loadChat = async (id) => {
    if (state.currentChatId === id) {
        toggleSidebar(false);
        return;
    }

    // Wait for any in-flight answer to be persisted before swapping chats.
    saveDraft();
    await cancelActiveRequest('navigation');
    setSendingUi(false);

    state.currentChatId = id;
    state.messages = await dbApp.getMessages(id);
    // Removed setModel override to keep model selection persistent globally
    renderMessages();
    restoreDraft();
    toggleSidebar(false);
    renderChatList();
};

async function createNewChat() {
    saveDraft();
    await cancelActiveRequest('navigation');
    setSendingUi(false);

    state.currentChatId = null;
    state.messages = [];
    renderMessages();
    restoreDraft();
    toggleSidebar(false);
    renderChatList();
    if (dom.textInput) dom.textInput.focus();
}

function renderMessages() {
    if (!dom.messagesArea) return;
    dom.messagesArea.innerHTML = '';

    if (state.messages.length === 0) {
        const model = state.currentModel;
        const isGenuineLocal = Boolean(model)
            && state.localModels.includes(model)
            && !state.cloudMirrors.has(model);
        const isCloud = Boolean(model) && !isGenuineLocal && (
            state.cloudModels.includes(model) || state.localModels.includes(model)
        );
        const isFree = isCloud && (
            isFreeCloudModel(model, FREE_CLOUD_MODELS)
            || isFreeCloudModel(state.cloudMirrors.get(model) || '', FREE_CLOUD_MODELS)
        );
        const planNote = !isCloud ? '' : (isFree
            ? '<div class="model-plan-note free">☁️ Free cloud model · uses free usage credits · <a href="https://ollama.com/settings" target="_blank" rel="noopener noreferrer">Usage</a></div>'
            : '<div class="model-plan-note paid">☁️ Paid cloud model · requires a paid plan or usage credits · <a href="https://ollama.com/settings" target="_blank" rel="noopener noreferrer">Manage</a> · <a href="https://docs.ollama.com/cloud" target="_blank" rel="noopener noreferrer">Docs</a></div>');

        dom.messagesArea.innerHTML = `
            <div class="empty-state">
                <p class="empty-eyebrow">Channel open</p>
                <h2 class="empty-title">What should we <em>think through?</em></h2>
                <p class="empty-sub">You're talking to <strong>${escapeHtml(state.currentModel || 'Ollama')}</strong>. Ask a question, paste an error, or sketch an idea — your history stays on this device.</p>
                ${planNote}
                <ul class="empty-hints">
                    <li><kbd>Enter</kbd><span>send</span></li>
                    <li><kbd>Shift</kbd><span>+</span><kbd>Enter</kbd><span>new line</span></li>
                    <li><kbd>Esc</kbd><span>close menus</span></li>
                </ul>
            </div>`;
        return;
    }
    state.messages.forEach(msg => appendMessageToUI(msg));
    scrollToBottom();
}

function appendMessageToUI(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.role === 'user' ? 'user-msg' : 'assistant-msg'}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content markdown-body';

    try {
        contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(msg.content));
    } catch (e) {
        console.warn('Markdown parsing failed', e);
        contentDiv.textContent = msg.content;
    }

    // Thinking
    if (msg.thinking) {
        const thinkDiv = document.createElement('div');
        thinkDiv.className = `thinking-block ${state.showThinking ? 'active' : ''}`;
        thinkDiv.textContent = msg.thinking;
        div.appendChild(thinkDiv);
    }

    div.appendChild(contentDiv);

    // Meta / Actions Row
    div.appendChild(createMessageMetaRow(msg));

    // The first real message replaces the empty-state hero.
    dom.messagesArea?.querySelector('.empty-state')?.remove();

    if (dom.messagesArea) dom.messagesArea.appendChild(div);
    scrollToBottom();
}

function formatMessageTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    return `${date.toLocaleDateString()} ${time}`;
}

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor">
       <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z"/>
    </svg>`;
const COPIED_ICON = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="var(--success)"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';

/**
 * Copy text to the clipboard, reporting a rejected promise instead of throwing
 * when the API is unavailable (for example in an insecure context).
 */
function copyTextToClipboard(text) {
    if (!navigator.clipboard?.writeText) {
        return Promise.reject(new Error('Clipboard API is unavailable'));
    }
    return navigator.clipboard.writeText(text);
}

/**
 * Build the timestamp/status/copy row shared by streamed and re-rendered
 * messages.
 *
 * @param {{ content?: string, created_at?: string, status?: string }} msg
 * @returns {HTMLDivElement}
 */
function createMessageMetaRow(msg) {
    const metaRow = document.createElement('div');
    metaRow.className = 'message-meta-row';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-timestamp';
    timeSpan.textContent = formatMessageTime(msg.created_at || new Date().toISOString());
    metaRow.appendChild(timeSpan);

    if (msg.status && msg.status !== 'complete') {
        const statusSpan = document.createElement('span');
        statusSpan.className = `msg-status ${msg.status}`;
        statusSpan.textContent = msg.status === 'interrupted' ? 'Interrupted' : 'Incomplete';
        metaRow.appendChild(statusSpan);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-msg-btn-clean';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.onclick = () => {
        copyTextToClipboard(msg.content || '')
            .then(() => {
                copyBtn.innerHTML = COPIED_ICON;
                setTimeout(() => { copyBtn.innerHTML = COPY_ICON; }, 1500);
            })
            .catch((error) => console.warn('Copy failed', error));
    };
    metaRow.appendChild(copyBtn);

    return metaRow;
}

function showChatError(message, { focus = 'cloud' } = {}) {
    const errorBlock = document.createElement('div');
    errorBlock.className = 'chat-error';

    const title = document.createElement('p');
    title.className = 'chat-error-title';
    title.textContent = 'Request failed';

    const body = document.createElement('p');
    body.className = 'chat-error-body';
    body.textContent = message;

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'chat-error-action';
    action.textContent = 'Open connection settings';
    action.addEventListener('click', (event) => {
        event.stopPropagation();
        openSettings();
        window.setTimeout(() => {
            const field = focus === 'local' ? dom.inputLocalUrl : dom.inputCloudUrl;
            field?.focus();
            field?.select();
        }, 340);
    });

    errorBlock.append(title, body, action);
    return errorBlock;
}

function setSendingUi(sending) {
    state.isSending = sending;

    if (dom.sendBtn) {
        dom.sendBtn.style.display = sending ? 'none' : '';
        dom.sendBtn.disabled = sending || !dom.textInput?.value.trim();
    }

    if (dom.stopBtn) {
        dom.stopBtn.style.display = sending ? 'flex' : 'none';
        dom.stopBtn.disabled = !sending;
    }
}

function stopGeneration() {
    const request = requestRegistry.current;
    if (!request) return;
    requestRegistry.cancel(request, 'user');
}

/**
 * Cancel the in-flight generation (if any) and wait until it has persisted its
 * partial answer. Navigation handlers await this before swapping chats so late
 * stream chunks can never land in the wrong conversation.
 */
function cancelActiveRequest(reason = 'navigation') {
    const request = requestRegistry.current;
    if (!request) return Promise.resolve();
    requestRegistry.cancel(request, reason);
    return request.done;
}

function isRequestVisible(request) {
    return Boolean(request) && state.currentChatId === request.chatId;
}

/**
 * Read one stream chunk, rejecting when the server stalls for too long. The
 * underlying request is aborted by the caller.
 */
function readWithIdleTimeout(reader, timeoutMs) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`The response timed out after ${Math.round(timeoutMs / 1000)} seconds of inactivity.`));
        }, timeoutMs);
    });

    return Promise.race([reader.read(), timeout])
        .finally(() => clearTimeout(timer));
}

/**
 * Resolve a selected model to the name the local daemon serves it under.
 * A canonical cloud name (`beam`) maps to the daemon's relay (`beam:cloud`);
 * returns '' when the daemon does not serve the model, so callers fall back
 * to the configured cloud endpoint.
 *
 * @param {string} name
 * @returns {string}
 */
function resolveLocalModelName(name) {
    if (!name) return '';
    if (state.localModels.includes(name)) return name;

    const normalized = normalizeCloudModelName(name);
    if (!normalized) return '';

    for (const [daemonName, target] of state.cloudMirrors) {
        if (normalizeCloudModelName(target) === normalized) return daemonName;
    }
    return '';
}

async function sendMessage() {
    const text = dom.textInput.value.trim();
    if (!text || state.isSending) return;

    if (!state.currentModel) {
        alert('Please select a model first.');
        return;
    }

    const model = state.currentModel;
    // Cloud models stay cloud, but when the local daemon relays one (`beam` is
    // served as `beam:cloud`) the request goes through the daemon: direct
    // browser calls to ollama.com fail because it sends no CORS headers.
    const localModel = resolveLocalModelName(model);
    const isLocal = Boolean(localModel);
    const history = buildConversationContext(state.messages);
    const request = requestRegistry.start({ model, chatId: state.currentChatId });

    // The prompt is now owned by the message list, so consume its draft and
    // clear the composer. Anything typed while the reply starts is a new draft.
    clearDraft(draftScope());
    if (dom.textInput) {
        dom.textInput.value = '';
        autoResizeInput.call(dom.textInput);
    }
    setSendingUi(true);

    let chatId = state.currentChatId;
    let url = '';
    let reader = null;
    let msgDiv = null;
    let contentBlock = null;
    let thinkingBlock = null;
    let metaRow = null;
    let completed = false;
    let hadError = false;

    let assistantMsg = {
        role: 'assistant',
        content: '',
        thinking: '',
        created_at: new Date().toISOString(),
        status: 'interrupted'
    };

    try {
        if (!chatId) {
            const chat = await dbApp.createChat(buildChatTitle(text), model);
            chatId = chat.id;
            state.currentChatId = chat.id;
            request.chatId = chat.id;
            adoptDraftScope(chat.id);
            await loadChatList();
        } else {
            request.chatId = chatId;
        }

        const userMessage = await dbApp.addMessage(chatId, 'user', text);

        if (isRequestVisible(request)) {
            const userEntry = {
                role: 'user',
                content: text,
                created_at: userMessage?.created_at || new Date().toISOString()
            };
            state.messages.push(userEntry);
            appendMessageToUI(userEntry);
        }

        msgDiv = document.createElement('div');
        msgDiv.className = 'message assistant-msg';

        contentBlock = document.createElement('div');
        contentBlock.className = 'message-content markdown-body';
        msgDiv.appendChild(contentBlock);

        if (dom.messagesArea && isRequestVisible(request)) dom.messagesArea.appendChild(msgDiv);
        scrollToBottom();

        let headers = { 'Content-Type': 'application/json' };
        if (isLocal) {
            url = `${state.localUrl}/api/chat`;
        } else {
            url = `${state.cloudUrl}/chat`;
            if (state.cloudApiKey) {
                if (!canSendApiKey(url)) {
                    throw new Error('Refusing to send the API key over an insecure connection. Use an https:// cloud URL or a loopback address.');
                }
                headers['Authorization'] = `Bearer ${state.cloudApiKey}`;
            }
        }

        const supportsThinking = getModelCapabilities(model).some((cap) => cap.type === 'thinking');
        const payload = {
            model: localModel || model,
            messages: history.concat({ role: 'user', content: text }),
            stream: true,
            think: supportsThinking && state.qualityPreset !== 'none' ? state.qualityPreset : undefined
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: request.controller.signal
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createNdjsonParser();

        const applyStreamEvent = (event) => {
            if (event.error) {
                if (event.fatal) throw new Error(event.error);
                console.warn(event.error);
                return;
            }

            if (event.thinking) {
                if (!thinkingBlock) {
                    thinkingBlock = document.createElement('div');
                    thinkingBlock.className = `thinking-block ${state.showThinking ? 'active' : ''}`;
                    msgDiv.insertBefore(thinkingBlock, contentBlock);
                }
                assistantMsg.thinking += event.thinking;
                thinkingBlock.textContent = assistantMsg.thinking;
            }

            if (event.content) {
                assistantMsg.content += event.content;
                try {
                    contentBlock.innerHTML = DOMPurify.sanitize(marked.parse(assistantMsg.content));
                } catch (e) {
                    contentBlock.textContent = assistantMsg.content;
                }
            }
        };

        while (true) {
            const { done, value } = await readWithIdleTimeout(reader, REQUEST_IDLE_TIMEOUT_MS);

            if (done) {
                // A final line may arrive without a trailing newline.
                for (const event of parser.flush()) applyStreamEvent(event);
                break;
            }

            for (const event of parser.push(decoder.decode(value, { stream: true }))) {
                applyStreamEvent(event);
            }
            scrollToBottom();

            if (parser.sawDone) break;
        }

        completed = !request.cancelled && parser.sawDone;
        if (completed && contentBlock) {
            try {
                contentBlock.innerHTML = DOMPurify.sanitize(marked.parse(assistantMsg.content));
            } catch (e) {
                contentBlock.textContent = assistantMsg.content;
            }
        }
    } catch (e) {
        if (!request.cancelled && e.name !== 'AbortError') {
            hadError = true;
            console.error('Chat request failed', e);
            if (contentBlock) {
                contentBlock.appendChild(showChatError(
                    `Error: ${describeFetchFailure(url, e)}`,
                    { focus: isLocal ? 'local' : 'cloud' }
                ));
            }
        }
    } finally {
        if (reader) {
            try { reader.cancel().catch(() => {}); } catch (e) { /* stream already closed */ }
        }
        if (!completed) {
            try { request.controller.abort(); } catch (e) { /* already aborted */ }
        }

        const hasContent = assistantMsg.content.length > 0 || assistantMsg.thinking.length > 0;

        if (hasContent) {
            assistantMsg.status = completed ? 'complete' : 'interrupted';

            if (chatId) {
                try {
                    assistantMsg = await dbApp.addMessage(
                        chatId,
                        'assistant',
                        assistantMsg.content,
                        assistantMsg.thinking,
                        assistantMsg.status
                    );
                } catch (e) {
                    console.error('Failed to save assistant message', e);
                }
            }

            if (msgDiv && !metaRow) {
                metaRow = createMessageMetaRow(assistantMsg);
                msgDiv.appendChild(metaRow);
            }

            if (isRequestVisible(request)) {
                state.messages.push(assistantMsg);
            }
        } else if (msgDiv?.parentNode && !hadError) {
            // A stopped request with no tokens should not leave an empty bubble.
            msgDiv.remove();
        }

        requestRegistry.finish(request);
        setSendingUi(false);
        scrollToBottom();
        if (dom.textInput) dom.textInput.focus();
    }
}

// --- Settings Logic ---
function openSettings() {
    dom.inputLocalUrl.value = state.localUrl;
    dom.inputCloudUrl.value = state.cloudUrl;
    dom.inputCloudKey.value = state.cloudApiKey;
    renderCloudModelEditor();
    renderLocalModelEditor();
    dom.settingsPanel.classList.add('active');
}

function closeSettings() {
    dom.settingsPanel.classList.remove('active');
}

function saveSettings() {
    const localUrl = normalizeEndpointUrl(dom.inputLocalUrl.value);
    const cloudUrl = normalizeEndpointUrl(dom.inputCloudUrl.value);

    if (!localUrl || !cloudUrl) {
        alert('Please enter valid http:// or https:// URLs for the local and cloud endpoints.');
        return;
    }

    if (state.cloudApiKey && !canSendApiKey(cloudUrl)) {
        alert('The API key is only sent over HTTPS or to a loopback address. Use an https:// cloud URL.');
        return;
    }

    state.localUrl = localUrl;
    state.cloudUrl = cloudUrl;
    state.cloudApiKey = dom.inputCloudKey.value;

    dom.inputLocalUrl.value = localUrl;
    dom.inputCloudUrl.value = cloudUrl;

    localStorage.setItem('localUrl', state.localUrl);
    localStorage.setItem('cloudUrl', state.cloudUrl);
    localStorage.setItem('cloudApiKey', state.cloudApiKey);
    localStorage.setItem('cloudModels', JSON.stringify(state.cloudModels));

    closeSettings();
    loadModels();
    showToast('Connection settings saved');
}

function toggleCloudList() {
    const isShowing = dom.cloudModelListContainer.classList.toggle('show');
    dom.toggleCloudBtn.textContent = isShowing ? 'Hide list' : 'Show all';
    dom.toggleCloudBtn.setAttribute('aria-expanded', String(isShowing));
}

function toggleLocalList() {
    const isShowing = dom.localModelListContainer.classList.toggle('show');
    dom.toggleLocalBtn.textContent = isShowing ? 'Hide' : 'Show';
    dom.toggleLocalBtn.setAttribute('aria-expanded', String(isShowing));
}

function renderLocalModelEditor() {
    if (!dom.localModelList) return;
    dom.localModelList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    if (state.localModels.length === 0) {
        dom.localModelList.innerHTML = '<div class="settings-empty">No local models found. Check the connection in the field above.</div>';
        return;
    }

    state.localModels.forEach(modelName => {
        const isHidden = state.hiddenModels.includes(modelName);
        const div = document.createElement('div');
        div.className = 'model-list-item';
        div.style.justifyContent = 'space-between';

        div.innerHTML = `
            <span style="opacity: ${isHidden ? 0.5 : 1}; text-decoration: ${isHidden ? 'line-through' : 'none'}">${escapeHtml(modelName)}</span>
            <button class="text-link-btn" style="color: ${isHidden ? 'var(--text-secondary)' : 'var(--success)'}; font-size:0.8rem;">
                ${isHidden ? 'Enable' : 'Disable'}
            </button>
        `;

        div.querySelector('button').onclick = (e) => {
            e.stopPropagation();
            if (isHidden) {
                state.hiddenModels = state.hiddenModels.filter(m => m !== modelName);
            } else {
                state.hiddenModels.push(modelName);
            }
            localStorage.setItem('hiddenModels', JSON.stringify(state.hiddenModels));
            renderLocalModelEditor();
            renderModelList(); // Update main dropdown immediately
        };
        fragment.appendChild(div);
    });

    dom.localModelList.appendChild(fragment);
}

function togglePasswordVisibility(e) {
    if (e) e.stopPropagation();
    const input = dom.inputCloudKey;
    const isPassword = input.getAttribute('type') === 'password';
    input.setAttribute('type', isPassword ? 'text' : 'password');
    dom.togglePasswordBtn.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');

    // Toggle icon (simple swap or Rotate)
    dom.togglePasswordBtn.innerHTML = isPassword ?
        `<svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="var(--accent)"><path d="m644-428-58-58q9-47-27-83t-83-27l-58-58q9-2 18-2 75 0 127.5 52.5T616-480q0 9-2 18Zm118 118-57-57q33-31 61-68t46-77q-62-132-186-220t-272-88q-36 0-70 5t-67 15l-57-57q46-18 94-28t100-10q148 0 272 88t186 220q-18 41-47 80t-63 77ZM880-40l-80-80q-50 42-108 71t-122 41v-80q48-10 93-30t83-50l-80-80q-21 10-43 16t-45 6q-75 0-127.5-52.5T344-480q0-23 6-45t16-43l-80-80q-30 38-50 83t-30 93l-80 2q12-64 41-122t71-108l-80-80 56-56 840 840-56 56ZM480-400Zm-66-178Z"/></svg>` :
        `<svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-80q-42 0-71-29t-29-71q0-42 29-71t71-29q42 0 71 29t29 71q0 42-29 71t-71 29Zm0 160q-154 0-278-88T22-500q62-132 186-220t272-88q148 0 272 88t186 220q-62 132-186 220t-272 88Zm0-80q113 0 207.5-59.5T832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-400Z"/></svg>`;
}


function renderCloudModelEditor() {
    if (!dom.cloudModelList) return;
    dom.cloudModelList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    state.cloudModels.forEach((modelName, index) => {
        const div = document.createElement('div');
        div.className = 'model-list-item';
        div.innerHTML = `
            <span>${escapeHtml(modelName)}</span>
            <button class="remove-model-btn" title="Remove model">✕</button>
        `;
        div.querySelector('button').onclick = (e) => {
            e.stopPropagation(); // Prevent closing settings
            state.cloudModels.splice(index, 1);
            renderCloudModelEditor();
            // Also update localStorage immediately after removal
            localStorage.setItem('cloudModels', JSON.stringify(state.cloudModels));
        };
        fragment.appendChild(div);
    });

    dom.cloudModelList.appendChild(fragment);
}

function addCloudModel() {
    const val = dom.cloudModelInput.value.trim();
    if (val && !state.cloudModels.includes(val)) {
        state.cloudModels.push(val);
        dom.cloudModelInput.value = '';

        // Auto-expand list and update button
        dom.cloudModelListContainer?.classList.add('show');
        if (dom.toggleCloudBtn) dom.toggleCloudBtn.textContent = 'Hide List';

        renderCloudModelEditor();
    }
}

async function downloadDbExport() {
    try {
        const data = await dbApp.exportDatabase();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ollama_chat_history_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('Export Failed: ' + e.message);
    }
}

// --- Helpers ---
function toggleSidebar(open) {
    state.isSidebarOpen = open;
    dom.sidebar?.classList.toggle('open', open);
    dom.overlay?.classList.toggle('active', open);
}

function openModelSelector() {
    // Legacy support or direct redirect
    toggleDropdownNS('model');
}

function autoResizeInput() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
}

function scrollToBottom() {
    scrollElementToBottom(dom.chatContainer);
}

function applyFontSize(size) {
    const sizes = { 'small': '13px', 'medium': '15px', 'large': '17px' };
    document.documentElement.style.fontSize = sizes[size];
    state.fontSize = size;
    localStorage.setItem('fontSize', size);

    document.querySelectorAll('.font-btn').forEach(btn => {
        const active = btn.dataset.size === size;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
}

// --- Helper Toggles ---
function toggleThinking() {
    state.showThinking = !state.showThinking;
    localStorage.setItem('showThinking', state.showThinking);

    // Toggle visibility of existing thinking blocks
    document.querySelectorAll('.thinking-block').forEach(el => {
        el.classList.toggle('active', state.showThinking);
    });

    updateHeaderControlsUI();
}

function toggleDropdownNS(name, force) {
    const dropdown = name === 'model' ? dom.modelDropdown : dom.qualityDropdown;
    if (!dropdown) return;

    // Close others
    if (name !== 'model' && dom.modelDropdown) dom.modelDropdown.classList.remove('show');
    if (name !== 'quality' && dom.qualityDropdown) dom.qualityDropdown.classList.remove('show');

    const isShow = typeof force === 'boolean' ? force : !dropdown.classList.contains('show');
    const trigger = name === 'model' ? dom.modelSelectorBtn : dom.qualityBtn;
    if (isShow) {
        dropdown.classList.add('show');
        trigger?.setAttribute('aria-expanded', 'true');
        // Auto focus search if model dropdown
        if (name === 'model' && dom.modelSearchInput) {
            setTimeout(() => dom.modelSearchInput.focus(), 50);
        }
    } else {
        dropdown.classList.remove('show');
        trigger?.setAttribute('aria-expanded', 'false');
    }
}

// --- Capability Logic ---
function getModelCapabilities(name) {
    const caps = [];
    if (!name) return caps;
    const lower = name.toLowerCase();

    // 1. Thinking / Reasoning Support (🧠)
    // Precise list based on user manual check
    const reasoningKeywords = ['gpt', 'deepseek-r1', 'deepseek 3.1', 'o1', 'reasoning'];
    if (reasoningKeywords.some(kw => lower.includes(kw))) {
        // Exception: Explicit "none" models from user list
        const isNone = ['ministral', 'nemotron', 'kimi', 'gemma', 'gemini 3', 'glm', 'cogito', 'rnj', 'minimax', 'devstral'].some(kw => lower.includes(kw));
        if (!isNone) {
            caps.push({ type: 'thinking', icon: '🧠', label: 'Thinking' });
        }
    }

    // 2. Tools Support (🛠️) - Modern generic models (Filtered by user 'none' list)
    const toolKeywords = ['llama3', 'mistral'];
    const toolNone = ['ministral', 'mistral large'].some(kw => lower.includes(kw));
    if (toolKeywords.some(kw => lower.includes(kw)) && !toolNone) {
        caps.push({ type: 'tools', icon: '🛠️', label: 'Tools' });
    }

    // 3. Size / Power (🏋️ vs ⚡)
    if (lower.includes(':70b') || lower.includes(':large') || lower.includes('671b') || lower.includes('675b') || lower.includes('480b') || lower.includes('235b') || lower.includes('120b')) {
        caps.push({ type: 'size', icon: '🏋️', label: 'High Power' });
    } else if (lower.includes(':7b') || lower.includes(':8b') || lower.includes('24b') || lower.includes('3b') || lower.includes('4b')) {
        caps.push({ type: 'size', icon: '⚡', label: 'Fast' });
    }

    return caps;
}

function updateHeaderControlsUI() {
    const caps = getModelCapabilities(state.currentModel);
    const hasThinking = caps.some(c => c.type === 'thinking');

    // Show only the controls the selected model can actually use.
    if (dom.thinkingBtn) {
        dom.thinkingBtn.style.display = hasThinking ? 'flex' : 'none';
        dom.thinkingBtn.classList.toggle('active', state.showThinking);
        dom.thinkingBtn.setAttribute('aria-pressed', String(state.showThinking));
    }
    if (dom.qualityBtn) dom.qualityBtn.style.display = hasThinking ? 'flex' : 'none';

    if (dom.currentQualityName) {
        const labels = { 'none': 'Std', 'low': 'Low', 'medium': 'Med', 'high': 'High' };
        dom.currentQualityName.textContent = labels[state.qualityPreset] || 'Std';
    }

    updateModelIndicator();
}

/**
 * Mirror the selected model's source (local, free cloud, paid cloud) onto the
 * header chip and the composer footer. The dot is the quickest way to see
 * whether a prompt will stay on the machine or leave it.
 */
function updateModelIndicator() {
    const model = state.currentModel;
    // Local daemon relays of cloud models count as cloud for the indicator even
    // though requests for them still go through the daemon.
    const isMirror = Boolean(model) && state.cloudMirrors.has(model);
    const isLocal = Boolean(model) && state.localModels.includes(model) && !isMirror;
    const isCloud = Boolean(model) && !isLocal
        && (state.cloudModels.includes(model) || state.localModels.includes(model));
    const isFree = isCloud && (
        isFreeCloudModel(model, FREE_CLOUD_MODELS)
        || isFreeCloudModel(state.cloudMirrors.get(model) || '', FREE_CLOUD_MODELS)
    );
    const source = !model ? 'none'
        : isLocal ? 'local'
            : isFree ? 'free'
                : isCloud ? 'paid' : 'none';

    if (dom.modelSelectorBtn) {
        dom.modelSelectorBtn.dataset.source = source;
        dom.modelSelectorBtn.title = model || 'Select a model';
    }
    if (dom.composerModel) {
        const kind = source === 'local' ? 'Local' : source === 'free' ? 'Free cloud' : source === 'paid' ? 'Cloud' : '';
        dom.composerModel.textContent = model
            ? (kind ? `${kind} · ${model}` : model)
            : 'No model selected';
    }
}
document.addEventListener('DOMContentLoaded', init);
