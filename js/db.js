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
            const request = index.getAll(); // Logic sort usually happens in memory or via cursor
            request.onsuccess = () => resolve(request.result.reverse()); // Descending
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
            
            // Delete associated messages (Need to use cursor or index)
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

    async addMessage(chatId, role, content, thinking = '') {
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
                created_at: new Date().toISOString()
            };

            msgStore.add(msg);
            
            // Update chat timestamp
            const chatReq = chatStore.get(Number(chatId));
            chatReq.onsuccess = () => {
                const chat = chatReq.result;
                if (chat) {
                    chat.updated_at = new Date().toISOString();
                    // Update model if provided in context? (logic usually in app)
                    chatStore.put(chat);
                }
            };

            tx.oncomplete = () => resolve(msg);
            tx.onerror = () => reject(tx.error);
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
            request.onsuccess = () => resolve(request.result); // Already sorted by ID (auto-increment) which implies time
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

export const dbApp = new DB();
