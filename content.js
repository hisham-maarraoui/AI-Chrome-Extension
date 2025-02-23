// Configuration
const DEBOUNCE_MS = 50; // Delay before making API calls

let OPENROUTER_API_KEY = null;
let GROQ_API_KEY = null;
let API_PROVIDER = 'openrouter';
let OPENROUTER_MODEL = 'deepseek/deepseek-r1:free';
let GROQ_MODEL = 'mixtral-8x7b-32768';

// Add Google configuration
let GOOGLE_API_KEY = null;
let GOOGLE_MODEL = 'gemini-1.5-flash'; // Fixed to Gemini 1.5 Flash

// Get API keys and settings from storage
chrome.storage.sync.get([
    'apiProvider',
    'openrouterKey',
    'groqKey',
    'googleKey',
    'openrouterModel',
    'groqModel'
], (result) => {
    if (result.apiProvider) {
        API_PROVIDER = result.apiProvider;
    }
    if (result.openrouterKey) {
        OPENROUTER_API_KEY = result.openrouterKey;
    }
    if (result.groqKey) {
        GROQ_API_KEY = result.groqKey;
    }
    if (result.googleKey) {
        GOOGLE_API_KEY = result.googleKey;
    }
    if (result.openrouterModel) {
        OPENROUTER_MODEL = result.openrouterModel;
    }
    if (result.groqModel) {
        GROQ_MODEL = result.groqModel;
    }
});

// Create suggestion overlay element
const overlay = document.createElement('div');
overlay.style.cssText = `
  position: fixed;
  background: #f0f0f0;
  border: 1px solid #ccc;
  padding: 8px 12px;
  font-size: 14px;
  display: none;
  color: #666;
  z-index: 999999;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  border-radius: 4px;
  pointer-events: none;
`;

// Add loading indicator styles
const loadingStyles = `
    @keyframes pulse {
        0% { opacity: 0.4; }
        50% { opacity: 0.8; }
        100% { opacity: 0.4; }
    }
    .suggestion-loading {
        position: fixed;
        color: #666;
        pointer-events: none;
        white-space: pre;
        z-index: 999999;
        animation: pulse 1.5s infinite;
    }
`;

// Add style element to document
const styleElement = document.createElement('style');
styleElement.textContent = loadingStyles;
document.head.appendChild(styleElement);

// Wait for DOM to be ready before appending overlay
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

// Add this function at the top level, before initializeExtension()
function getValue(el) {
    if (window.location.hostname === 'docs.google.com') {
        const editor = document.querySelector('.docs-texteventtarget-iframe');
        if (editor) {
            try {
                const text = editor.contentDocument.body.innerText;
                // Get the last paragraph or current line
                const lines = text.split('\n');
                return lines[lines.length - 1] || '';
            } catch (e) {
                console.error('Failed to get Google Docs text:', e);
                return '';
            }
        }
    }

    if (el.isContentEditable) {
        return el.textContent;
    }
    return el.value || '';
}

// Add this function as well
function setValue(el, value) {
    if (window.location.hostname === 'docs.google.com') {
        const editor = document.querySelector('.docs-texteventtarget-iframe');
        if (editor) {
            try {
                // Simulate typing in Google Docs
                value.split('').forEach(char => {
                    const event = new KeyboardEvent('keypress', {
                        key: char,
                        code: 'Key' + char.toUpperCase(),
                        bubbles: true
                    });
                    editor.contentDocument.body.dispatchEvent(event);
                });
            } catch (e) {
                console.error('Failed to set Google Docs text:', e);
            }
        }
        return;
    }

    if (el.isContentEditable) {
        el.textContent = value;
    } else {
        el.value = value;
    }
}

function initializeExtension() {
    let activeInput = null;
    let currentSuggestion = null;
    let debounceTimeout = null;
    let lastInputText = '';
    let lastRequestController = null; // Track the latest request

    // Update selector to include contenteditable elements and specific Gmail/Google Docs selectors
    const INPUT_SELECTOR = `
        input[type="text"], 
        input[type="search"], 
        input:not([type]), 
        textarea, 
        [contenteditable="true"],
        .editable,
        .docs-texteventtarget-iframe,
        .kix-lineview,
        .docs-texteventtarget-iframe body
    `.trim();

    // Add mutation observer to handle dynamically added editors
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) { // Element node
                    const inputs = node.matches(INPUT_SELECTOR) ?
                        [node] :
                        node.querySelectorAll(INPUT_SELECTOR);

                    for (const input of inputs) {
                        setupInput(input);
                    }
                }
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Setup handlers for an input element
    function setupInput(input) {
        // Skip if already setup
        if (input.dataset.autocompleteSetup) return;
        input.dataset.autocompleteSetup = 'true';

        // Special handling for Google Docs
        if (window.location.hostname === 'docs.google.com') {
            const editor = document.querySelector('.docs-texteventtarget-iframe');
            if (editor) {
                try {
                    const iframeDoc = editor.contentDocument || editor.contentWindow.document;
                    iframeDoc.body.addEventListener('focusin', handleFocusIn);
                    iframeDoc.body.addEventListener('focusout', handleFocusOut);
                    iframeDoc.body.addEventListener('input', handleInput);
                    iframeDoc.body.addEventListener('keydown', handleKeyDown);
                } catch (e) {
                    console.error('Failed to attach to Google Docs iframe:', e);
                }
            }
            return;
        }

        // Regular input handling
        input.addEventListener('focusin', handleFocusIn);
        input.addEventListener('focusout', handleFocusOut);
        input.addEventListener('input', handleInput);
        input.addEventListener('keydown', handleKeyDown);
    }

    // Setup existing inputs
    document.querySelectorAll(INPUT_SELECTOR).forEach(setupInput);

    // Update event handlers to work with contenteditable
    function handleFocusIn(e) {
        const input = e.target;
        if (input.matches(INPUT_SELECTOR) && !input.readOnly && !input.disabled) {
            activeInput = input;
        }
    }

    function handleFocusOut(e) {
        if (activeInput) {
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }
            activeInput = null;
            currentSuggestion = null;
        }
    }

    // Update input handler for contenteditable
    function handleInput(e) {
        if (!activeInput) return;

        // Clear existing suggestion and loading indicator
        const suggestionSpan = document.querySelector('.suggestion-span');
        const loadingSpan = document.querySelector('.suggestion-loading');
        if (suggestionSpan) suggestionSpan.remove();
        if (loadingSpan) loadingSpan.remove();
        currentSuggestion = null;

        // Cancel any pending request
        if (lastRequestController) {
            lastRequestController.abort();
        }

        // Clear previous timeout
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
        }

        debounceTimeout = setTimeout(async () => {
            const text = getValue(activeInput);
            lastInputText = text;

            if (text.length < 2) return;

            try {
                // Show loading indicator
                showLoadingIndicator(activeInput);

                // Create new controller for this request
                lastRequestController = new AbortController();

                const suggestion = await getAISuggestion(text, lastRequestController.signal);

                // Remove loading indicator
                const loadingSpan = document.querySelector('.suggestion-loading');
                if (loadingSpan) loadingSpan.remove();

                // Only show suggestion if the input hasn't changed and we still have focus
                if (suggestion &&
                    lastInputText === text &&
                    document.activeElement === activeInput) {
                    currentSuggestion = suggestion;
                    showSuggestion(suggestion, activeInput);
                }
            } catch (error) {
                // Remove loading indicator on error
                const loadingSpan = document.querySelector('.suggestion-loading');
                if (loadingSpan) loadingSpan.remove();

                if (error.name !== 'AbortError') {
                    console.error('Error getting suggestion:', error);
                }
            }
        }, DEBOUNCE_MS);
    }

    // Add this function after handleInput
    function handleKeyDown(e) {
        if (e.key === 'Backspace' && activeInput) {
            // Immediately clear suggestion on backspace
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
                currentSuggestion = null;
            }
        }

        if (e.key === 'Tab' && currentSuggestion && activeInput) {
            e.preventDefault();

            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }

            // Get text content appropriately based on input type
            const inputText = getValue(activeInput);
            const lastWord = inputText.split(/[\s.!?]+/).pop() || '';

            const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

            let displayText = isCompletion ? currentSuggestion.slice(lastWord.length) : currentSuggestion;
            const needsSpace = !isCompletion && !inputText.endsWith(' ') && inputText.length > 0;

            setValue(activeInput, inputText + (needsSpace ? ' ' : '') + displayText);
            currentSuggestion = null;
        }
    }

    // Update event listeners to use new handlers
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('input', handleInput);
    document.addEventListener('keydown', handleKeyDown);

    document.addEventListener('visibilitychange', () => {
        if (activeInput) {
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }
            currentSuggestion = null;
        }
    });
}

async function getAISuggestion(text, signal) {
    try {
        if (!text) {
            console.log('Empty text, skipping suggestion');
            return null;
        }

        const activeKey = {
            'openrouter': OPENROUTER_API_KEY,
            'groq': GROQ_API_KEY,
            'google': GOOGLE_API_KEY
        }[API_PROVIDER];

        if (!activeKey) {
            console.error('No API key set. Please configure in extension settings.');
            return null;
        }

        console.log('Making API request for text:', text);

        const endpoint = {
            'openrouter': 'https://openrouter.ai/api/v1/chat/completions',
            'groq': 'https://api.groq.com/openai/v1/chat/completions',
            'google': `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_API_KEY}`
        }[API_PROVIDER];

        const headers = {
            'openrouter': {
                'Authorization': `Bearer ${activeKey}`,
                'Content-Type': 'application/json',
                'Origin': 'https://openrouter.ai',
                'Referer': 'https://openrouter.ai/',
                'HTTP-Referer': 'https://openrouter.ai/'
            },
            'groq': {
                'Authorization': `Bearer ${activeKey}`,
                'Content-Type': 'application/json'
            },
            'google': {
                'Content-Type': 'application/json'
            }
        }[API_PROVIDER];

        const model = {
            'openrouter': OPENROUTER_MODEL,
            'groq': GROQ_MODEL,
            'google': 'gemini-1.5-flash' // Fixed to Gemini 1.5 Flash
        }[API_PROVIDER];

        const systemPrompt = API_PROVIDER === 'openrouter' ?
            `You are an autocomplete assistant. Follow these rules strictly:
1. If input ends with a partial word, complete that word naturally in the context
2. If input ends with a complete word or space, suggest the next 1-3 words that make sense in context
3. Never repeat words that are already in the input
4. Only provide the raw completion/suggestion - no labels or explanations
5. Keep suggestions concise and natural
6. Never output more than 3 words
7. Suggestions must make grammatical sense in the context
8. For partial words, complete them based on the full context, not just the last word

Examples:
Input: "I need to fi" → find
Input: "I need to" → get started with
Input: "The weather is" → very nice today
Input: "google translate is a search engine that" → helps users translate
Input: "google is a company that" → provides search services` :
            // Stricter prompt for Groq
            `You are an autocomplete assistant. Return ONLY contextually appropriate completions.

Rules:
1. Output only 1-3 words maximum
2. NO explanations or labels
3. NO punctuation except spaces between words
4. If input ends with partial word, complete it based on full context
5. If input ends with full word or space, suggest next logical words
6. Never repeat words from input
7. Keep suggestions natural and contextual
8. Suggestions must continue the sentence grammatically

Examples:
Input: "I need to fi" → find
Input: "I need to" → get started with
Input: "The weather is" → very nice today
Input: "google translate is a search engine that" → helps users translate
Input: "google is a company that" → provides search services`;

        let body;
        if (API_PROVIDER === 'google') {
            const lastWord = text.split(/\s+/).pop() || '';
            const isPartialWord = !text.endsWith(' ');

            body = JSON.stringify({
                contents: [{
                    parts: [{
                        text: isPartialWord ?
                            `Complete this word (only return the completion part): "${lastWord}"` :
                            `Suggest what comes next (1-3 new words only): "${text}"`
                    }]
                }],
                safetySettings: [{
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_NONE"
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 20,
                    topP: 0.8,
                    topK: 10
                }
            });
        } else {
            body = JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                max_tokens: 50,
                temperature: 0.3
            });
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            signal,
            headers,
            body
        });

        if (!response.ok) {
            console.error('API Response not OK:', response.status);
            return null;
        }

        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            console.error('Failed to parse API response:', parseError);
            return null;
        }

        // More detailed error logging
        if (!data) {
            console.error('Empty response data');
            return null;
        }

        if (data.error) {
            console.error('API returned error:', data.error);
            return null;
        }

        let suggestion;
        if (API_PROVIDER === 'google') {
            if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
                console.error('No candidates in response:', data);
                return null;
            }

            const candidate = data.candidates[0];
            if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                console.error('Invalid candidate structure:', candidate);
                return null;
            }

            let completionText = candidate.content.parts[0].text;

            // Get the last word of input to help with separation
            const lastWord = text.split(/\s+/).pop() || '';
            const isPartialWord = !text.endsWith(' ');

            // Clean up the response
            completionText = completionText
                .replace(/^.*?["']/, '') // Remove everything up to first quote
                .replace(/["'].*$/, '') // Remove everything after last quote
                .replace(/^[.,!?]\s*/, '') // Remove leading punctuation
                .replace(/\s*[.,!?]\s*$/, '') // Remove trailing punctuation
                .trim();

            if (isPartialWord) {
                // For partial words, only return the completion part
                completionText = completionText
                    .split(/\s+/)[0] // Take only first word
                    .replace(new RegExp(`^${lastWord}`, 'i'), '') // Remove any repeated part
                    .replace(/^[.,!?]\s*/, '') // Clean up again after removal
                    .trim();
            } else {
                // For full words, ensure we're only getting new words
                const inputWords = text.toLowerCase().split(/\s+/);
                completionText = completionText
                    .split(/\s+/)
                    .filter(word => !inputWords.includes(word.toLowerCase())) // Remove any words from input
                    .slice(0, 3) // Keep max 3 words
                    .join(' ')
                    .trim();

                // Add leading space for full word completions
                if (completionText) {
                    completionText = ' ' + completionText;
                }
            }

            suggestion = completionText;
        } else {
            // OpenRouter and Groq handling
            if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
                console.error('Invalid choices in response:', data);
                return null;
            }

            const choice = data.choices[0];
            if (!choice || !choice.message || !choice.message.content) {
                console.error('Invalid choice structure:', choice);
                return null;
            }

            suggestion = choice.message.content.trim();
        }

        if (!suggestion) {
            console.log('Empty suggestion received');
            return null;
        }

        // More aggressive cleaning to remove any prefixes and keep only the actual suggestion
        return suggestion
            .split('\n')[0] // Take only first line
            .replace(/^["']|["']$/g, '') // Remove quotes
            .replace(/^[.,!?]\s*/, '') // Remove leading punctuation
            .replace(/\s*[.,!?]\s*$/, '') // Remove trailing punctuation
            .replace(/^(?:Output:|Output|→|\s)*/, '') // Remove Output: prefix and arrows
            .replace(/^.*?:\s*/, '') // Remove any other prefixes with colons
            .replace(/^.*?→\s*/, '') // Remove anything before and including →
            .split(/\s+/).slice(0, 3).join(' ') // Keep max 3 words
            .trim();

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Request cancelled');
        } else {
            console.error('Error in getAISuggestion:', error);
        }
        return null;
    }
}

function showSuggestion(suggestion, input) {
    if (!suggestion || !input) return;

    const existingSuggestion = document.querySelector('.suggestion-span');
    if (existingSuggestion) {
        existingSuggestion.remove();
    }

    let rect;
    let textWidth;
    let font;
    let lineHeight;

    // Handle Google Docs
    if (window.location.hostname === 'docs.google.com') {
        const cursor = document.querySelector('.kix-cursor');
        if (cursor) {
            rect = cursor.getBoundingClientRect();
            font = '11pt Arial';
            textWidth = 0;
            lineHeight = parseInt(font) * 1.2;
        } else {
            return;
        }
    } else {
        const computedStyle = window.getComputedStyle(input);
        rect = input.getBoundingClientRect();
        font = computedStyle.font;
        lineHeight = computedStyle.lineHeight;
        textWidth = getTextWidth(getValue(input), font);
    }

    const suggestionSpan = document.createElement('span');
    suggestionSpan.className = 'suggestion-span';
    suggestionSpan.style.cssText = `
        position: fixed;
        left: ${rect.left + textWidth}px;
        top: ${rect.top + (rect.height - parseFloat(lineHeight)) / 2}px;
        font: ${font};
        color: #666;
        pointer-events: none;
        white-space: pre;
        z-index: 999999;
        line-height: ${lineHeight};
    `;

    suggestionSpan.textContent = suggestion;
    document.body.appendChild(suggestionSpan);
}

// Add this function to show loading indicator
function showLoadingIndicator(input) {
    const existingLoading = document.querySelector('.suggestion-loading');
    if (existingLoading) existingLoading.remove();

    let rect;
    let textWidth;
    let font;
    let lineHeight;

    // Handle Google Docs
    if (window.location.hostname === 'docs.google.com') {
        const cursor = document.querySelector('.kix-cursor');
        if (cursor) {
            rect = cursor.getBoundingClientRect();
            font = '11pt Arial';
            textWidth = 0;
            lineHeight = parseInt(font) * 1.2;
        } else {
            return;
        }
    } else {
        const computedStyle = window.getComputedStyle(input);
        rect = input.getBoundingClientRect();
        font = computedStyle.font;
        lineHeight = computedStyle.lineHeight;
        textWidth = getTextWidth(getValue(input), font);
    }

    const loadingSpan = document.createElement('span');
    loadingSpan.className = 'suggestion-loading';
    loadingSpan.style.cssText = `
        position: fixed;
        left: ${rect.left + textWidth}px;
        top: ${rect.top + (rect.height - parseFloat(lineHeight)) / 2}px;
        font: ${font};
        line-height: ${lineHeight};
    `;
    loadingSpan.textContent = '•••';
    document.body.appendChild(loadingSpan);
}

// Helper function to calculate text width
function getTextWidth(text, font) {
    const canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    context.font = font;
    return context.measureText(text).width;
} 