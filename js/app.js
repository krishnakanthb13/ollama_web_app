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
    isFreeCloudModel,
    mergeCloudModels,
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

function loadStoredCloudModels() {
    const stored = uniqueStrings(
        parseStoredArray(safeStorageGet('cloudModels'), DEFAULT_CLOUD_MODELS)
    );

    if (safeStorageGet('cloudCatalogVersion') === CLOUD_CATALOG_VERSION) {
        return stored;
    }

    // Keep an explicitly emptied list empty, but backfill free-tier models for
    // existing catalogues. `mergeCloudModels` avoids duplicate `-cloud` aliases.
    const migrated = stored.length > 0
        ? mergeCloudModels(stored, FREE_CLOUD_MODELS)
        : stored;

    try {
        localStorage.setItem('cloudModels', JSON.stringify(migrated));
        localStorage.setItem('cloudCatalogVersion', CLOUD_CATALOG_VERSION);
    } catch (error) {
        // Storage is best-effort; the in-memory list still works for this session.
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
    hiddenModels: uniqueStrings(parseStoredArray(safeStorageGet('hiddenModels'), [])),
    cloudModels: loadStoredCloudModels(),
    modelSearchQuery: '',

    // Settings / Toggles
    showThinking: safeStorageGet('showThinking') === 'true',
    qualityPreset: normalizeChoice(safeStorageGet('qualityPreset'), ['none', 'low', 'medium', 'high'], 'none'),
    sortOrder: normalizeChoice(safeStorageGet('sortOrder'), ['default', 'az'], 'default'),
    fontSize: normalizeChoice(safeStorageGet('fontSize'), ['small', 'medium', 'large'], 'medium'),
    sidebarWidth: normalizeSidebarWidth(safeStorageGet('sidebarWidth'), '280px')
};

// --- DOM Elements ---
const dom = {}; // Populated in init to ensure DOM is ready

// --- Initialization ---
async function init() {
    console.log('App initializing...');
    try {
        bindDomElements();
        setupEventListeners();

        await loadModels();
        setSortOrder(state.sortOrder);
        await loadChatList();
        renderMessages();

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

    // Sidebar Buttons
    dom.menuBtn = document.getElementById('menu-btn');
    dom.closeSidebarBtn = document.getElementById('close-sidebar-btn');
    dom.newChatBtn = document.getElementById('new-chat-btn');
    dom.headerNewChatBtn = document.getElementById('header-new-chat-btn');

    // Header controls
    dom.thinkingBtn = document.getElementById('thinking-btn');

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

    // Header Controls
    dom.thinkingBtn?.addEventListener('click', toggleThinking);

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
        if (type === 'model' && dom.modelSearchInput) {
            setTimeout(() => dom.modelSearchInput.focus(), 100);
        }
    }
}

function closeAllDropdowns() {
    if (dom.modelDropdown) dom.modelDropdown.classList.remove('show');
    if (dom.qualityDropdown) dom.qualityDropdown.classList.remove('show');
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
    dom.sortDefault.style.background = order === 'default' ? 'var(--accent)' : 'var(--bg-tertiary)';
    dom.sortDefault.style.color = order === 'default' ? 'white' : 'var(--text-secondary)';
    dom.sortAz.style.background = order === 'az' ? 'var(--accent)' : 'var(--bg-tertiary)';
    dom.sortAz.style.color = order === 'az' ? 'white' : 'var(--text-secondary)';
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
            state.localModels = uniqueStrings((data.models || []).map((model) => model?.name));
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
        if (dom.currentModelName) dom.currentModelName.textContent = 'Select Model...';
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

        // Slight theme difference for local vs cloud
        if (type === 'Local') {
            div.style.backgroundColor = 'rgba(99, 102, 241, 0.03)'; // Subtle tint of accent
        } else {
            div.style.backgroundColor = 'rgba(255, 255, 255, 0.02)'; // Subtle neutral
        }

        const caps = getModelCapabilities(name);
        const icons = caps.length > 0 ? caps.map(c => c.icon).join(' ') : (type === 'Local' ? '💻' : '☁️');
        const safeName = escapeHtml(name);

        div.innerHTML = `
            <div class="model-info" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; width: 100%; gap: 12px;">
                <span class="model-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeName}</span>
                <span class="model-icon" style="font-size: 0.9rem; opacity: 0.8; flex-shrink: 0;">${icons}</span>
            </div>
            ${name === state.currentModel ? '<span class="check-icon" style="color:var(--accent); margin-left: 8px;">✓</span>' : ''}
        `;
        div.onclick = (e) => {
            e.stopPropagation();
            setModel(name);
            closeAllDropdowns();
        };
        return div;
    };

    let allLocal = uniqueStrings(state.localModels).map(m => ({ name: m, type: 'Local' }));
    const localNames = new Set(allLocal.map((model) => model.name));
    let allCloud = uniqueStrings(state.cloudModels)
        .filter((name) => !localNames.has(name))
        .map(m => ({ name: m, type: 'Cloud' }));

    // FILTERING logic
    if (state.modelSearchQuery) {
        allLocal = allLocal.filter(m => m.name.toLowerCase().includes(state.modelSearchQuery));
        allCloud = allCloud.filter(m => m.name.toLowerCase().includes(state.modelSearchQuery));
    }

    // Exclude hidden models
    allLocal = allLocal.filter(m => !state.hiddenModels.includes(m.name));

    // Paid and free cloud models are shown in separate sections so the plan
    // boundary is visible. Matching accepts API names and `-cloud` aliases.
    const cloudPlans = splitCloudModelsByPlan(allCloud.map(m => m.name), FREE_CLOUD_MODELS);
    const freeCloud = cloudPlans.free.map(name => ({ name, type: 'Cloud' }));
    const paidCloud = cloudPlans.paid.map(name => ({ name, type: 'Cloud' }));

    const addSection = (title, models, marginTop = false) => {
        if (models.length === 0) return;

        const header = document.createElement('div');
        header.className = 'model-group-header';
        header.style.padding = '8px 12px';
        if (marginTop) header.style.marginTop = '8px';
        header.style.fontWeight = 'bold';
        header.style.fontSize = '0.8rem';
        header.style.color = 'var(--text-secondary)';
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.gap = '8px';

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

    addSection('LOCAL MODELS', sortSection(allLocal));
    addSection('FREE CLOUD MODELS', sortSection(freeCloud), true);
    addSection('PAID CLOUD MODELS', sortSection(paidCloud), true);

    if (allLocal.length === 0 && freeCloud.length === 0 && paidCloud.length === 0) {
        const noRes = document.createElement('div');
        noRes.style.padding = '1rem';
        noRes.style.textAlign = 'center';
        noRes.style.color = 'var(--text-secondary)';
        noRes.textContent = 'No models found';
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
    list.innerHTML = state.chats.map(chat => `
        <div class="chat-item ${chat.id === state.currentChatId ? 'active' : ''}" onclick="loadChat(${chat.id})">
            <div class="chat-item-content">
                <div class="chat-item-title">${escapeHtml(chat.title || 'Untitled chat')}</div>
                <div class="chat-item-date">${chat.model ? escapeHtml(chat.model) + ' • ' : ''}${new Date(chat.updated_at).toLocaleDateString()}</div>
            </div>
            <div style="display:flex; opacity:0; transition: opacity 0.2s;" class="chat-actions">
                <button class="download-chat-btn" onclick="exportChatToMarkdown(event, ${chat.id})" title="Download as Markdown">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M480-320 280-520l56-56 104 104v-328h80v328l104-104 56 56-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/></svg>
                </button>
                <button class="delete-chat-btn" onclick="deleteChat(event, ${chat.id})" title="Delete Chat">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T720-120H280Zm440-600H240v520q0 8 6 14t14 6h440q8 0 14-6t6-14v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM240-720v520-520Z"/></svg>
                </button>
            </div>
        </div>
    `).join('');
}

window.deleteChat = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this chat?')) return;

    if (state.currentChatId === id) {
        await cancelActiveRequest('navigation');
        setSendingUi(false);
    }

    await dbApp.deleteChat(id);
    if (state.currentChatId === id) {
        state.currentChatId = null;
        state.messages = [];
        renderMessages();
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
    await cancelActiveRequest('navigation');
    setSendingUi(false);

    state.currentChatId = id;
    state.messages = await dbApp.getMessages(id);
    // Removed setModel override to keep model selection persistent globally
    renderMessages();
    toggleSidebar(false);
    renderChatList();
};

async function createNewChat() {
    await cancelActiveRequest('navigation');
    setSendingUi(false);

    state.currentChatId = null;
    state.messages = [];
    renderMessages();
    toggleSidebar(false);
    renderChatList();
    if (dom.textInput) dom.textInput.focus();
}

function renderMessages() {
    if (!dom.messagesArea) return;
    dom.messagesArea.innerHTML = '';

    if (state.messages.length === 0) {
        const isCloud = Boolean(state.currentModel)
            && state.cloudModels.includes(state.currentModel)
            && !state.localModels.includes(state.currentModel);
        const planNote = !isCloud ? '' : (isFreeCloudModel(state.currentModel, FREE_CLOUD_MODELS)
            ? '<div class="model-plan-note free">☁️ Free cloud model · uses free usage credits</div>'
            : '<div class="model-plan-note paid">☁️ Paid cloud model · requires a paid plan or usage credits · <a href="https://ollama.com/settings" target="_blank" rel="noopener noreferrer">Manage</a></div>');

        dom.messagesArea.innerHTML = `
            <div class="message assistant-msg" style="opacity: 0.5; text-align: center; margin-top: 2rem;">
                 <div class="message-content">Start a conversation using ${escapeHtml(state.currentModel || 'Ollama')}${planNote}</div>
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

function showChatError(message) {
    const errorBlock = document.createElement('div');
    errorBlock.className = 'chat-error';
    errorBlock.style.color = 'var(--error)';
    errorBlock.style.marginTop = '10px';
    errorBlock.textContent = message;
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

async function sendMessage() {
    const text = dom.textInput.value.trim();
    if (!text || state.isSending) return;

    if (!state.currentModel) {
        alert('Please select a model first.');
        return;
    }

    const model = state.currentModel;
    const isLocal = state.localModels.includes(model);
    const history = state.messages.map((message) => ({ role: message.role, content: message.content }));
    const request = requestRegistry.start({ model, chatId: state.currentChatId });
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

        dom.textInput.value = '';
        autoResizeInput.call(dom.textInput);
        if (dom.sendBtn) dom.sendBtn.disabled = true;

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
            model,
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
                contentBlock.appendChild(showChatError(`Error: ${describeFetchFailure(url, e)}`));
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
}

function toggleCloudList() {
    const isShowing = dom.cloudModelListContainer.classList.toggle('show');
    dom.toggleCloudBtn.textContent = isShowing ? 'Hide List' : 'Show All';
}

function toggleLocalList() {
    const isShowing = dom.localModelListContainer.classList.toggle('show');
    dom.toggleLocalBtn.textContent = isShowing ? 'Hide' : 'Show';
}

function renderLocalModelEditor() {
    if (!dom.localModelList) return;
    dom.localModelList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    if (state.localModels.length === 0) {
        dom.localModelList.innerHTML = '<div style="color:var(--text-secondary); padding:8px;">No local models found. Check connection.</div>';
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
        btn.classList.toggle('active', btn.dataset.size === size);
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
    if (isShow) {
        dropdown.classList.add('show');
        // Auto focus search if model dropdown
        if (name === 'model' && dom.modelSearchInput) {
            setTimeout(() => dom.modelSearchInput.focus(), 50);
        }
    } else {
        dropdown.classList.remove('show');
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
        dom.thinkingBtn.style.backgroundColor = state.showThinking ? 'var(--accent)' : 'var(--bg-tertiary)';
        dom.thinkingBtn.style.color = state.showThinking ? 'white' : 'var(--text-secondary)';
    }
    if (dom.qualityBtn) dom.qualityBtn.style.display = hasThinking ? 'flex' : 'none';

    if (dom.currentQualityName) {
        const labels = { 'none': 'Std', 'low': 'Low', 'medium': 'Med', 'high': 'High' };
        dom.currentQualityName.textContent = labels[state.qualityPreset] || 'Std';
    }
}
document.addEventListener('DOMContentLoaded', init);
