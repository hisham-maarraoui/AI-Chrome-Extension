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

// Add undo history tracking
let undoHistory = [];
const MAX_UNDO_HISTORY = 10;

function initializeExtension() {
    let activeInput = null;
    let currentSuggestion = null;
    let debounceTimeout = null;
    let lastInputText = '';
    let lastRequestController = null; // Track the latest request

    // Update the INPUT_SELECTOR to specifically target Google search
    const INPUT_SELECTOR = `
        input[type="text"], 
        input[type="search"], 
        input:not([type]), 
        textarea, 
        [contenteditable="true"],
        .editable,
        .docs-texteventtarget-iframe,
        [role="textbox"],
        [role="searchbox"],
        [role="combobox"],
        .public-DraftEditor-content,
        .notion-page-content [contenteditable="true"],
        .ql-editor,
        .ProseMirror,
        input[aria-label="Search"],
        input[name="q"],
        .gLFyf
    `.trim();

    // Enhanced MutationObserver configuration
    const observerConfig = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['contenteditable', 'role'], // Watch for dynamic contenteditable changes
        characterData: true // Watch for text changes
    };

    // Enhanced observer callback
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // Handle added nodes
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) { // Element node
                        // Check the node itself
                        if (node.matches && node.matches(INPUT_SELECTOR)) {
                            setupInput(node);
                        }
                        // Check child nodes
                        const inputs = node.querySelectorAll(INPUT_SELECTOR);
                        inputs.forEach(setupInput);
                    }
                }
            }
            
            // Handle attribute changes
            if (mutation.type === 'attributes') {
                const element = mutation.target;
                if (element.matches && element.matches(INPUT_SELECTOR)) {
                    setupInput(element);
                }
            }
        }
    });

    // Enhanced setupInput function
    function setupInput(input) {
        // Skip if already setup or is hidden/disabled
        if (input.dataset.autocompleteSetup || 
            input.style.display === 'none' || 
            input.style.visibility === 'hidden' ||
            input.disabled ||
            input.readOnly) {
            return;
        }

        input.dataset.autocompleteSetup = 'true';

        // Special handling for Google search
        if (window.location.hostname.includes('google') && 
            (input.matches('input[name="q"], .gLFyf') || 
             input.matches('.gb_je, .aJl'))) {
            // Force the input to be treated as a regular input field
            input.addEventListener('input', handleInput);
            input.addEventListener('keydown', handleKeyDown);
            input.addEventListener('focusin', handleFocusIn);
            input.addEventListener('focusout', handleFocusOut);
            return;
        }

        // Regular input handling
        input.addEventListener('focusin', handleFocusIn);
        input.addEventListener('focusout', handleFocusOut);
        input.addEventListener('input', handleInput);
        input.addEventListener('keydown', handleKeyDown);
    }

    // Start observing with the enhanced configuration
    observer.observe(document.body, observerConfig);

    // Initial setup for existing elements
    document.querySelectorAll(INPUT_SELECTOR).forEach(setupInput);

    // Cleanup on page unload
    window.addEventListener('unload', () => {
        observer.disconnect();
    });

    // Update event handlers to work with contenteditable
    function handleFocusIn(e) {
        const input = e.target;
        if (input.matches(INPUT_SELECTOR) && !input.readOnly && !input.disabled) {
            activeInput = input;
            undoHistory = []; // Clear undo history for new input
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

    // Update handleKeyDown function to better handle Gmail editors
    function handleKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && undoHistory.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            
            const lastState = undoHistory.pop();
            if (lastState) {
                const { input, value, selection } = lastState;
                input.value = value;
                input.selectionStart = selection.start;
                input.selectionEnd = selection.end;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                showUndoIndicator('Last suggestion undone');
            }
            return;
        }

        if (e.key === 'Tab' && currentSuggestion && activeInput) {
            e.preventDefault();
            e.stopPropagation();

            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }

            // Save current state before modification
            const currentState = {
                input: activeInput,
                value: activeInput.value,
                selection: {
                    start: activeInput.selectionStart,
                    end: activeInput.selectionEnd
                }
            };

            // Handle Google search with more careful text handling
            if (window.location.hostname.includes('google') && 
                activeInput.matches('input[name="q"], .gLFyf')) {
                const fullText = activeInput.value;
                const cursorPosition = activeInput.selectionStart;
                
                // Get the word at cursor
                const textBeforeCursor = fullText.slice(0, cursorPosition);
                const textAfterCursor = fullText.slice(cursorPosition);
                const wordsBeforeCursor = textBeforeCursor.split(/\s+/);
                const lastWord = wordsBeforeCursor[wordsBeforeCursor.length - 1] || '';
                
                const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                    currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

                let newValue;
                if (isCompletion && lastWord) {
                    // Replace only the last word
                    wordsBeforeCursor[wordsBeforeCursor.length - 1] = currentSuggestion;
                    newValue = [...wordsBeforeCursor, textAfterCursor].join(' ');
                } else {
                    // Add the suggestion with proper spacing
                    const needsSpace = !textBeforeCursor.endsWith(' ') && textBeforeCursor.length > 0;
                    newValue = textBeforeCursor + (needsSpace ? ' ' : '') + currentSuggestion + textAfterCursor;
                }

                // Update input
                activeInput.value = newValue;
                const newCursorPosition = newValue.length;
                activeInput.selectionStart = activeInput.selectionEnd = newCursorPosition;
                
                // Save to undo history and show indicator
                undoHistory.push(currentState);
                if (undoHistory.length > MAX_UNDO_HISTORY) {
                    undoHistory.shift();
                }
                showUndoIndicator('Ctrl+Z to undo');
                
                // Trigger input event
                activeInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Handle Gmail compose editor
            else if (activeInput.isContentEditable || activeInput.contentEditable === 'true') {
                const selection = window.getSelection();
                if (!selection.rangeCount) return;

                const range = selection.getRangeAt(0);
                const text = activeInput.textContent;
                const lastWord = text.split(/[\s.!?]+/).pop() || '';

                const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                    currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

                // If it's completing a word, delete the partial word first
                if (isCompletion) {
                    range.setStart(range.endContainer, range.endOffset - lastWord.length);
                    range.deleteContents();
                }

                // Insert the suggestion
                const needsSpace = !isCompletion && !text.endsWith(' ') && text.length > 0;
                const textNode = document.createTextNode((needsSpace ? ' ' : '') + currentSuggestion);
                range.insertNode(textNode);

                // Move cursor to end
                range.setStartAfter(textNode);
                range.setEndAfter(textNode);
                selection.removeAllRanges();
                selection.addRange(range);

                // Trigger input event for Gmail
                const inputEvent = new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                });
                activeInput.dispatchEvent(inputEvent);
            } 
            // Handle Gmail search field
            else if (window.location.hostname === 'mail.google.com' && 
                     (activeInput.matches('[role="searchbox"]') || activeInput.matches('[aria-label*="Search"]'))) {
                const text = activeInput.value;
                const lastWord = text.split(/[\s.!?]+/).pop() || '';
                
                const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                    currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

                if (isCompletion) {
                    // Replace the partial word
                    activeInput.value = text.slice(0, -lastWord.length) + currentSuggestion;
                } else {
                    // Add the full suggestion
                    const needsSpace = !text.endsWith(' ') && text.length > 0;
                    activeInput.value = text + (needsSpace ? ' ' : '') + currentSuggestion;
                }

                // Move cursor to end
                activeInput.selectionStart = activeInput.selectionEnd = activeInput.value.length;

                // Trigger input event
                activeInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Handle other inputs
            else {
                const text = getValue(activeInput);
                const lastWord = text.split(/[\s.!?]+/).pop() || '';

                const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                    currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

                let newValue;
                if (isCompletion) {
                    newValue = text.slice(0, -lastWord.length) + currentSuggestion;
                } else {
                    const needsSpace = !text.endsWith(' ') && text.length > 0;
                    newValue = text + (needsSpace ? ' ' : '') + currentSuggestion;
                }

                setValue(activeInput, newValue);
            }

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

    // Add visual indicator for undo availability
    function showUndoIndicator(message) {
        const existingIndicator = document.querySelector('.undo-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        const indicator = document.createElement('div');
        indicator.className = 'undo-indicator';
        indicator.style.cssText = `
            position: fixed;
            left: 50%;
            top: 20px;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 13px;
            z-index: 999999;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
        `;
        
        // Add keyboard icon
        indicator.innerHTML = `
            <span style="font-family: monospace;">⌘Z</span>
            <span>${message}</span>
        `;
        
        document.body.appendChild(indicator);

        // Animate
        requestAnimationFrame(() => {
            indicator.style.opacity = '1';
            setTimeout(() => {
                indicator.style.opacity = '0';
                setTimeout(() => indicator.remove(), 300);
            }, 2000);
        });
    }
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

        let body;
        if (API_PROVIDER === 'google') {
            const lastWord = text.split(/\s+/).pop() || '';
            const isPartialWord = !text.endsWith(' ');

            body = JSON.stringify({
                contents: [{
                    parts: [{
                        text: isPartialWord ?
                            `Complete this business-related word (only return the completion part): "${lastWord}"` :
                            `Suggest what comes next in a business context (1-3 new words only): "${text}". Focus on factual business descriptions.`
                    }]
                }],
                safetySettings: [{
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_NONE"
                }],
                generationConfig: {
                    temperature: 0.1, // Lower temperature for more focused suggestions
                    maxOutputTokens: 20,
                    topP: 0.3, // Lower top_p for more focused suggestions
                    topK: 10
                }
            });
        } else if (API_PROVIDER === 'groq') {
            body = JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a business-focused autocomplete assistant. Your task is to predict the next few words that would naturally complete business-related descriptions.

Rules:
1. Only suggest 1-3 words that directly continue the input text
2. Focus on factual, business-appropriate completions
3. Never repeat words from the input
4. Keep suggestions professional and contextual
5. No explanations or labels, just the completion
6. For partial words, complete only that word
7. For company descriptions, focus on their products, services, or industry position

Examples:
Input: "Microsoft is a company that" → develops software solutions
Input: "Apple focuses on" → consumer electronics innovation
Input: "Tesla manufactures" → electric vehicles and
Input: "Amazon provides" → cloud computing services
Input: "The business strategy" → focuses on growth`
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                max_tokens: 20,
                temperature: 0.1,     // Very low temperature for focused suggestions
                top_p: 0.2,          // Even lower top_p for more predictable completions
                frequency_penalty: 0.3,
                presence_penalty: 0.3
            });
        } else {
            body = JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an autocomplete assistant. Follow these rules strictly:
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
Input: "google is a company that" → provides search services`
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

// Update showSuggestion function with specific Gmail search handling
function showSuggestion(suggestion, input) {
    if (!suggestion || !input) return;

    try {
        const existingSuggestion = document.querySelector('.suggestion-span');
        if (existingSuggestion) {
            existingSuggestion.remove();
        }

        let rect;
        let textWidth;
        let font;
        let lineHeight;

        // Special handling for Gmail search field
        if (window.location.hostname === 'mail.google.com' && 
            (input.matches('[role="searchbox"]') || input.matches('[aria-label*="Search"]'))) {
            const computedStyle = window.getComputedStyle(input);
            rect = input.getBoundingClientRect();
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            
            // More accurate text measurement
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.font = font;
            textWidth = ctx.measureText(input.value).width;
            
            // Adjust for search icon and padding
            const searchIconWidth = 40; // Increased for better spacing
            const paddingLeft = parseFloat(computedStyle.paddingLeft) || 20;
            
            textWidth += searchIconWidth + paddingLeft;

            // Create suggestion with better positioning
            const suggestionSpan = document.createElement('span');
            suggestionSpan.className = 'suggestion-span';
            suggestionSpan.style.cssText = `
                position: fixed;
                left: ${rect.left + textWidth}px;
                top: ${rect.top}px;
                font: ${font || 'inherit'};
                color: #666;
                pointer-events: none;
                white-space: pre;
                z-index: 999999;
                height: ${rect.height}px;
                display: flex;
                align-items: center;
                padding-left: 4px;
                background: transparent;
            `;
            suggestionSpan.textContent = suggestion;
            document.body.appendChild(suggestionSpan);
            return;
        }

        // Handle contenteditable elements (like Gmail editor)
        else if (input.isContentEditable || input.contentEditable === 'true') {
            const selection = window.getSelection();
            if (!selection.rangeCount) return;

            const range = selection.getRangeAt(0);
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(input);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            
            // Get the client rect of the range
            const rects = range.getClientRects();
            rect = rects[rects.length - 1] || range.getBoundingClientRect();

            // Get computed style from the parent element
            const computedStyle = window.getComputedStyle(input);
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            
            // For contenteditable, we don't need additional text width
            textWidth = 0;
        } 
        // Handle regular input fields (like Google search)
        else {
            const computedStyle = window.getComputedStyle(input);
            rect = input.getBoundingClientRect();
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            textWidth = getTextWidth(input.value || getValue(input), font);

            // Adjust for padding in regular inputs
            const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
            textWidth += paddingLeft;
        }

        const suggestionSpan = document.createElement('span');
        suggestionSpan.className = 'suggestion-span';
        suggestionSpan.style.cssText = `
            position: fixed;
            left: ${rect.left + textWidth}px;
            top: ${rect.top}px;
            font: ${font || 'inherit'};
            color: #666;
            pointer-events: none;
            white-space: pre;
            z-index: 999999;
            line-height: ${lineHeight || 'inherit'};
            height: ${rect.height}px;
            display: flex;
            align-items: center;
        `;

        suggestionSpan.textContent = suggestion;
        document.body.appendChild(suggestionSpan);
    } catch (error) {
        console.error('Error showing suggestion:', error);
    }
}

// Update showLoadingIndicator similarly
function showLoadingIndicator(input) {
    if (!input) return;

    try {
        const existingLoading = document.querySelector('.suggestion-loading');
        if (existingLoading) existingLoading.remove();

        let rect;
        let textWidth;
        let font;
        let lineHeight;

        // Special handling for Gmail search field
        if (window.location.hostname === 'mail.google.com' && 
            (input.matches('[role="searchbox"]') || input.matches('[aria-label*="Search"]'))) {
            const computedStyle = window.getComputedStyle(input);
            rect = input.getBoundingClientRect();
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            
            const searchIconWidth = 32;
            const paddingLeft = parseFloat(computedStyle.paddingLeft) || 16;
            
            textWidth = getTextWidth(input.value || getValue(input), font);
            textWidth += paddingLeft + searchIconWidth;
        }
        // Handle contenteditable elements
        else if (input.isContentEditable || input.contentEditable === 'true') {
            const selection = window.getSelection();
            if (!selection.rangeCount) return;

            const range = selection.getRangeAt(0);
            const rects = range.getClientRects();
            rect = rects[rects.length - 1] || range.getBoundingClientRect();

            const computedStyle = window.getComputedStyle(input);
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            textWidth = 0;
        } 
        // Handle regular input fields
        else {
            const computedStyle = window.getComputedStyle(input);
            rect = input.getBoundingClientRect();
            font = computedStyle.font;
            lineHeight = computedStyle.lineHeight;
            textWidth = getTextWidth(input.value || getValue(input), font);

            const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
            textWidth += paddingLeft;
        }

        const loadingSpan = document.createElement('span');
        loadingSpan.className = 'suggestion-loading';
        loadingSpan.style.cssText = `
            position: fixed;
            left: ${rect.left + textWidth}px;
            top: ${rect.top}px;
            font: ${font || 'inherit'};
            line-height: ${lineHeight || 'inherit'};
            height: ${rect.height}px;
            display: flex;
            align-items: center;
        `;
        loadingSpan.textContent = '•••';
        document.body.appendChild(loadingSpan);
    } catch (error) {
        console.error('Error showing loading indicator:', error);
    }
}

// Helper function to calculate text width
function getTextWidth(text, font) {
    const canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    context.font = font;
    return context.measureText(text).width;
} 