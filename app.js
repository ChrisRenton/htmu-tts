/**
 * Libby TTS - AAC-style Text-to-Speech PWA
 * Loads voice from .htmuvoice file, persists in IndexedDB
 */

const APP = {
    tts: null,
    phrases: null,
    currentPath: [],
    history: [],
    isGenerating: false,
    audioCtx: null,
    currentSource: null,  // Track current audio source for stopping
    allPhrases: [],
    voiceName: null,
    db: null,
};

const DB_NAME = 'HTMU_TTS';
const DB_VERSION = 1;
const VOICE_STORE = 'voices';

/**
 * Initialize IndexedDB
 */
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            APP.db = request.result;
            resolve(APP.db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(VOICE_STORE)) {
                db.createObjectStore(VOICE_STORE, { keyPath: 'name' });
            }
        };
    });
}

/**
 * Save voice file to IndexedDB
 */
async function saveVoiceToStorage(name, fileData) {
    return new Promise((resolve, reject) => {
        const tx = APP.db.transaction(VOICE_STORE, 'readwrite');
        const store = tx.objectStore(VOICE_STORE);
        
        // Request persistent storage
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(granted => {
                console.log('Persistent storage:', granted ? 'granted' : 'denied');
            });
        }
        
        const request = store.put({ name, data: fileData, savedAt: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/**
 * Load voice file from IndexedDB
 */
async function loadVoiceFromStorage(name) {
    return new Promise((resolve, reject) => {
        const tx = APP.db.transaction(VOICE_STORE, 'readonly');
        const store = tx.objectStore(VOICE_STORE);
        const request = store.get(name);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all saved voice names
 */
async function getSavedVoices() {
    return new Promise((resolve, reject) => {
        const tx = APP.db.transaction(VOICE_STORE, 'readonly');
        const store = tx.objectStore(VOICE_STORE);
        const request = store.getAllKeys();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete voice from storage
 */
async function deleteVoiceFromStorage(name) {
    return new Promise((resolve, reject) => {
        const tx = APP.db.transaction(VOICE_STORE, 'readwrite');
        const store = tx.objectStore(VOICE_STORE);
        const request = store.delete(name);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// DOM elements
const voiceLoadScreen = document.getElementById('voiceLoadScreen');
const uploadArea = document.getElementById('uploadArea');
const voiceFileInput = document.getElementById('voiceFileInput');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const textInput = document.getElementById('textInput');
const speakBtn = document.getElementById('speakBtn');
const clearBtn = document.getElementById('clearBtn');
const breadcrumb = document.getElementById('breadcrumb');
const phraseGrid = document.getElementById('phraseGrid');
const statusText = document.getElementById('statusText');
const suggestions = document.getElementById('suggestions');
const btnPhrases = document.getElementById('btnPhrases');
const btnHistory = document.getElementById('btnHistory');
const changeVoiceBtn = document.getElementById('changeVoiceBtn');
const editModal = document.getElementById('editModal');
const editPhraseText = document.getElementById('editPhraseText');
const editCancel = document.getElementById('editCancel');
const editDelete = document.getElementById('editDelete');
const editSave = document.getElementById('editSave');

// Long press state
const LONG_PRESS_DURATION = 800; // ms
let longPressTimer = null;
let editingPhraseIndex = null;
let editingGroupPath = [];

/**
 * Load voice from .htmuvoice file or ArrayBuffer
 */
async function loadVoiceFile(fileOrBuffer, fileName) {
    loadingOverlay.classList.remove('hidden');
    loadingText.textContent = 'Preparing voice...';
    const timings = { start: performance.now() };
    
    const voiceName = fileName || (fileOrBuffer.name ? fileOrBuffer.name.replace('.htmuvoice', '') : 'voice');
    const isFile = fileOrBuffer instanceof File;
    
    try {
        // If it's a File, read it and save to storage
        let zipData;
        if (isFile) {
            zipData = await fileOrBuffer.arrayBuffer();
            // Save to IndexedDB for next time
            await saveVoiceToStorage(voiceName, zipData);
            console.log('Voice saved to storage:', voiceName);
        } else {
            zipData = fileOrBuffer;
        }
        
        timings.savedToStorage = performance.now();
        console.log(`[Timing] Save to storage: ${timings.savedToStorage - timings.start}ms`);
        
        loadingText.textContent = 'Opening voice package...';
        const zip = await JSZip.loadAsync(zipData);
        timings.zipLoaded = performance.now();
        console.log(`[Timing] ZIP loaded: ${timings.zipLoaded - timings.savedToStorage}ms`);
        
        // Extract files
        const files = {};
        let fileCount = 0;
        const totalFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir).length;
        
        for (const [name, zipEntry] of Object.entries(zip.files)) {
            if (!zipEntry.dir) {
                fileCount++;
                const baseName = name.split('/').pop();
                loadingText.textContent = `Loading voice (${Math.round(fileCount/totalFiles*100)}%)...`;
                
                if (baseName.endsWith('.js')) {
                    files[baseName] = await zipEntry.async('string');
                } else {
                    files[baseName] = await zipEntry.async('arraybuffer');
                }
            }
        }
        
        // Verify required files
        const required = ['sherpa-onnx-tts.js', 'sherpa-onnx-wasm-main-tts.js', 
                         'sherpa-onnx-wasm-main-tts.wasm', 'sherpa-onnx-wasm-main-tts.data'];
        for (const req of required) {
            if (!files[req]) {
                throw new Error(`Voice package is incomplete`);
            }
        }
        
        loadingText.textContent = 'Starting voice engine...';
        
        // Create blob URLs
        const wasmBlob = new Blob([files['sherpa-onnx-wasm-main-tts.wasm']], {type: 'application/wasm'});
        const dataBlob = new Blob([files['sherpa-onnx-wasm-main-tts.data']], {type: 'application/octet-stream'});
        const wasmUrl = URL.createObjectURL(wasmBlob);
        const dataUrl = URL.createObjectURL(dataBlob);
        
        // Patch the glue code to use blob URLs
        let glueCode = files['sherpa-onnx-wasm-main-tts.js'];
        
        // Create Module object with locateFile
        window.Module = {
            locateFile: function(path) {
                if (path.endsWith('.wasm')) return wasmUrl;
                if (path.endsWith('.data')) return dataUrl;
                return path;
            },
            onRuntimeInitialized: function() {
                console.log('WASM initialized');
                loadingText.textContent = 'Almost ready...';
                
                try {
                    APP.tts = createOfflineTts(Module);
                    timings.ttsCreated = performance.now();
                    console.log(`[Timing] TTS created: ${timings.ttsCreated - timings.wasmInitialized}ms`);
                    console.log(`[Timing] TOTAL: ${timings.ttsCreated - timings.start}ms`);
                    
                    // Enable UI
                    loadingOverlay.classList.add('hidden');
                    voiceLoadScreen.classList.add('hidden');
                    textInput.disabled = false;
                    speakBtn.disabled = false;
                    statusText.textContent = 'Ready';
                    
                    // Store voice name
                    APP.voiceName = voiceName;
                    
                    // Load phrases
                    loadPhrases();
                } catch (error) {
                    console.error('TTS creation failed:', error);
                    loadingText.textContent = 'Failed to load voice. Please try again.';
                }
            }
        };
        
        // Execute the TTS API script
        const ttsScript = document.createElement('script');
        ttsScript.textContent = files['sherpa-onnx-tts.js'];
        document.head.appendChild(ttsScript);
        
        // Execute the glue code
        const glueScript = document.createElement('script');
        glueScript.textContent = glueCode;
        document.head.appendChild(glueScript);
        
    } catch (error) {
        console.error('Failed to load voice:', error);
        loadingOverlay.classList.add('hidden');
        alert('Failed to load voice: ' + error.message);
    }
}

/**
 * Load phrases from JSON
 */
async function loadPhrases() {
    try {
        const response = await fetch('default.json');
        APP.phrases = await response.json();
        APP.allPhrases = getAllPhrases(APP.phrases);
        renderPhrases();
    } catch (error) {
        console.error('Failed to load phrases:', error);
        APP.phrases = { phrases: [{ type: 'phrase', text: 'Hello' }], groups: {} };
        APP.allPhrases = ['Hello'];
        renderPhrases();
    }
}

/**
 * Get all phrases for typeahead
 */
function getAllPhrases(data) {
    const phrases = [];
    
    if (data.phrases) {
        data.phrases.forEach(item => {
            if (item.type === 'phrase') phrases.push(item.text);
        });
    }
    
    if (data.groups) {
        Object.values(data.groups).forEach(group => {
            if (group.phrases) {
                group.phrases.forEach(item => {
                    if (item.type === 'phrase') phrases.push(item.text);
                });
            }
        });
    }
    
    phrases.push(...APP.history);
    return [...new Set(phrases)];
}

/**
 * Show typeahead suggestions
 */
function showSuggestions(query) {
    if (!query || query.length < 2) {
        suggestions.classList.remove('active');
        return;
    }
    
    const q = query.toLowerCase();
    const matches = APP.allPhrases
        .filter(p => p.toLowerCase().includes(q))
        .slice(0, 8);
    
    if (matches.length === 0) {
        suggestions.classList.remove('active');
        return;
    }
    
    suggestions.innerHTML = matches.map(text => {
        const highlighted = text.replace(new RegExp(`(${query})`, 'gi'), '<mark>$1</mark>');
        return `<div class="suggestion-item" data-text="${text}">${highlighted}</div>`;
    }).join('');
    
    suggestions.classList.add('active');
}

function hideSuggestions() {
    suggestions.classList.remove('active');
}

/**
 * Get current items based on path
 */
function getCurrentItems() {
    if (APP.currentPath.length === 0) {
        return APP.phrases.phrases;
    }
    const groupName = APP.currentPath[APP.currentPath.length - 1];
    const group = APP.phrases.groups[groupName];
    return group ? group.phrases : [];
}

/**
 * Render breadcrumb
 */
function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    
    const homeBtn = document.createElement('span');
    homeBtn.className = 'breadcrumb-item';
    homeBtn.textContent = '🏠';
    homeBtn.onclick = () => { APP.currentPath = []; renderPhrases(); };
    breadcrumb.appendChild(homeBtn);
    
    APP.currentPath.forEach((name, i) => {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = ' › ';
        breadcrumb.appendChild(sep);
        
        const btn = document.createElement('span');
        btn.className = 'breadcrumb-item';
        btn.textContent = name;
        btn.onclick = () => { APP.currentPath = APP.currentPath.slice(0, i + 1); renderPhrases(); };
        breadcrumb.appendChild(btn);
    });
}

/**
 * Render phrase buttons
 */
function renderPhrases() {
    renderBreadcrumb();
    phraseGrid.innerHTML = '';
    
    const items = getCurrentItems();
    
    items.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.className = 'phrase-btn' + (item.type === 'group' ? ' group' : '');
        
        if (item.type === 'group') {
            btn.innerHTML = `<span class="text">${item.name}</span>`;
            btn.onclick = () => { APP.currentPath.push(item.name); renderPhrases(); };
        } else {
            btn.innerHTML = `<span class="text">${item.text}</span>`;
            
            // Long press detection for phrases
            setupLongPress(btn, item.text, idx);
        }
        
        phraseGrid.appendChild(btn);
    });
}

/**
 * Setup long press detection on a phrase button
 */
function setupLongPress(btn, text, idx) {
    let pressTimer = null;
    let isLongPress = false;
    
    const startPress = (e) => {
        isLongPress = false;
        btn.classList.add('long-pressing');
        
        pressTimer = setTimeout(() => {
            isLongPress = true;
            btn.classList.remove('long-pressing');
            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(50);
            // Open edit modal
            openEditModal(text, idx);
        }, LONG_PRESS_DURATION);
    };
    
    const endPress = (e) => {
        btn.classList.remove('long-pressing');
        clearTimeout(pressTimer);
        
        if (!isLongPress) {
            // Regular click - append phrase
            appendPhrase(text);
        }
        isLongPress = false;
    };
    
    const cancelPress = () => {
        btn.classList.remove('long-pressing');
        clearTimeout(pressTimer);
    };
    
    // Mouse events
    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('mouseup', endPress);
    btn.addEventListener('mouseleave', cancelPress);
    
    // Touch events
    btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startPress(e);
    });
    btn.addEventListener('touchend', endPress);
    btn.addEventListener('touchcancel', cancelPress);
}

/**
 * Open edit modal for a phrase
 */
function openEditModal(text, idx) {
    editingPhraseIndex = idx;
    editingGroupPath = [...APP.currentPath];
    editPhraseText.value = text;
    editModal.classList.remove('hidden');
    editPhraseText.focus();
}

/**
 * Close edit modal
 */
function closeEditModal() {
    editModal.classList.add('hidden');
    editingPhraseIndex = null;
    editingGroupPath = [];
}

/**
 * Save edited phrase
 */
function saveEditedPhrase() {
    const newText = editPhraseText.value.trim();
    if (!newText) return;
    
    // Get the items array to modify
    let items;
    if (editingGroupPath.length === 0) {
        items = APP.phrases.phrases;
    } else {
        const groupName = editingGroupPath[editingGroupPath.length - 1];
        items = APP.phrases.groups[groupName].phrases;
    }
    
    // Update the phrase
    if (items[editingPhraseIndex]) {
        items[editingPhraseIndex].text = newText;
    }
    
    closeEditModal();
    renderPhrases();
    
    // TODO: Save to storage when phrase customization is implemented
}

/**
 * Delete a phrase
 */
function deletePhrase() {
    // Get the items array to modify
    let items;
    if (editingGroupPath.length === 0) {
        items = APP.phrases.phrases;
    } else {
        const groupName = editingGroupPath[editingGroupPath.length - 1];
        items = APP.phrases.groups[groupName].phrases;
    }
    
    // Remove the phrase
    items.splice(editingPhraseIndex, 1);
    
    closeEditModal();
    renderPhrases();
    
    // TODO: Save to storage when phrase customization is implemented
}

/**
 * Append phrase to text input with smart spacing (AAC sentence building)
 */
function appendPhrase(newPhrase) {
    const currentText = textInput.value;
    
    if (currentText.length === 0) {
        // Empty - just add the phrase
        textInput.value = newPhrase;
    } else {
        // Check if last character is a space
        const lastChar = currentText.slice(-1);
        if (lastChar === ' ') {
            textInput.value = currentText + newPhrase;
        } else {
            // Add smart space before the new phrase
            textInput.value = currentText + ' ' + newPhrase;
        }
    }
    
    // Auto-resize textarea
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 100) + 'px';
    
    // Speak the new phrase only (not the whole sentence)
    speak(newPhrase);
}

/**
 * Generate speech
 */
async function speak(text) {
    if (!APP.tts || !text.trim() || APP.isGenerating) return;
    
    APP.isGenerating = true;
    speakBtn.disabled = true;
    statusText.textContent = 'Generating...';
    
    try {
        const audio = APP.tts.generate({ text, sid: 0, speed: 1.0 });
        playAudio(audio.samples, audio.sampleRate);
        addToHistory(text);
        statusText.textContent = 'Playing...';
    } catch (error) {
        console.error('Generation failed:', error);
        statusText.textContent = 'Error: ' + error.message;
    } finally {
        APP.isGenerating = false;
        speakBtn.disabled = false;
    }
}

/**
 * Play audio
 */
function playAudio(samples, sampleRate) {
    if (!APP.audioCtx) {
        APP.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    }
    
    const buffer = APP.audioCtx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    
    const source = APP.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(APP.audioCtx.destination);
    source.onended = () => { statusText.textContent = 'Ready'; };
    source.start();
}

/**
 * Add to history
 */
function addToHistory(text) {
    APP.history = APP.history.filter(h => h !== text);
    APP.history.unshift(text);
    APP.history = APP.history.slice(0, 20);
    localStorage.setItem('htmu_history', JSON.stringify(APP.history));
}

/**
 * Render history
 */
function renderHistory() {
    phraseGrid.innerHTML = '';
    breadcrumb.innerHTML = '<span class="breadcrumb-item">📜 History</span>';
    
    if (APP.history.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'grid-column: 1/-1; text-align: center; color: #999; padding: 40px;';
        empty.textContent = 'No history yet';
        phraseGrid.appendChild(empty);
        return;
    }
    
    APP.history.forEach(text => {
        const btn = document.createElement('button');
        btn.className = 'phrase-btn';
        btn.innerHTML = `<span class="text">${text}</span>`;
        btn.onclick = () => { appendPhrase(text); };
        phraseGrid.appendChild(btn);
    });
}

// Event listeners

// Upload area
uploadArea.onclick = () => voiceFileInput.click();

uploadArea.ondragover = (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragging');
};

uploadArea.ondragleave = () => {
    uploadArea.classList.remove('dragging');
};

uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.htmuvoice')) {
        loadVoiceFile(file);
    } else {
        alert('Please drop a .htmuvoice file');
    }
};

voiceFileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) loadVoiceFile(file);
};

// Speak button
speakBtn.onclick = () => {
    const text = textInput.value.trim();
    if (text) speak(text);
};

clearBtn.onclick = () => {
    textInput.value = '';
    textInput.focus();
    // Stop any currently playing audio
    stopAudio();
};

/**
 * Stop currently playing audio
 */
function stopAudio() {
    if (APP.currentSource) {
        try { 
            APP.currentSource.stop(); 
        } catch(e) {}
        APP.currentSource = null;
    }
    APP.isGenerating = false;
    speakBtn.disabled = false;
    statusText.textContent = 'Ready';
}

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textInput.value.trim();
        if (text) speak(text);
    }
});

textInput.addEventListener('input', () => {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 100) + 'px';
    showSuggestions(textInput.value.trim());
});

textInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 200);
});

suggestions.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item) {
        const text = item.dataset.text;
        // For suggestions, replace since user was typing
        textInput.value = text;
        hideSuggestions();
        // Don't auto-speak for suggestions - user may want to keep building
    }
});

btnPhrases.onclick = () => {
    btnPhrases.classList.add('active');
    btnHistory.classList.remove('active');
    renderPhrases();
};

btnHistory.onclick = () => {
    btnHistory.classList.add('active');
    btnPhrases.classList.remove('active');
    renderHistory();
};

changeVoiceBtn.onclick = () => {
    location.reload();
};

// Edit modal handlers
editCancel.onclick = closeEditModal;
editSave.onclick = saveEditedPhrase;
editDelete.onclick = deletePhrase;

// Close modal on overlay click
editModal.onclick = (e) => {
    if (e.target === editModal) closeEditModal();
};

// Save on Enter in edit input
editPhraseText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveEditedPhrase();
    } else if (e.key === 'Escape') {
        closeEditModal();
    }
});

// Load history
APP.history = JSON.parse(localStorage.getItem('libby_history') || '[]');

/**
 * Initialize app - check for saved voices
 */
async function init() {
    console.log('HTMU TTS initializing...');
    
    try {
        await initDB();
        
        // Check for saved voices
        const savedVoices = await getSavedVoices();
        console.log('Saved voices:', savedVoices);
        
        if (savedVoices.length > 0) {
            // Load the first saved voice
            const voiceName = savedVoices[0];
            const voiceData = await loadVoiceFromStorage(voiceName);
            
            if (voiceData && voiceData.data) {
                console.log('Loading saved voice:', voiceName);
                await loadVoiceFile(voiceData.data, voiceName);
                return;
            }
        }
        
        // No saved voice, show upload screen
        console.log('No saved voice, showing upload screen');
        showSavedVoicesList(savedVoices);
        
    } catch (error) {
        console.error('Init error:', error);
    }
}

/**
 * Show list of saved voices (if any) plus upload option
 */
function showSavedVoicesList(savedVoices) {
    if (savedVoices.length > 0) {
        const listHtml = savedVoices.map(name => 
            `<button class="saved-voice-btn" data-name="${name}">
                📦 ${name}
            </button>`
        ).join('');
        
        uploadArea.insertAdjacentHTML('beforebegin', `
            <div class="saved-voices">
                <p style="margin-bottom: 12px; font-size: 14px; color: #666;">Saved voices:</p>
                ${listHtml}
                <p style="margin: 16px 0; font-size: 14px; color: #999;">— or —</p>
            </div>
        `);
        
        // Add click handlers
        document.querySelectorAll('.saved-voice-btn').forEach(btn => {
            btn.onclick = async () => {
                const name = btn.dataset.name;
                const voiceData = await loadVoiceFromStorage(name);
                if (voiceData && voiceData.data) {
                    await loadVoiceFile(voiceData.data, name);
                }
            };
        });
    }
}

// Start
init();
