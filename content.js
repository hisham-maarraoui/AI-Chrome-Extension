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
    .tab-indicator {
        font-size: 11px;
        color: #999;
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 4px;
        border-radius: 3px;
        margin-left: 4px;
        font-family: system-ui, -apple-system, sans-serif;
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

// Add a flag to track when we're typing a suggestion
let isTypingSuggestion = false;

// Add a timestamp to track when we last updated a suggestion
let lastSuggestionUpdateTime = 0;
const SUGGESTION_COOLDOWN_MS = 3000; // Increase to 3 seconds for testing

// Add a flag to track when we're updating a suggestion due to typing
let isUpdatingSuggestion = false;

// Add a flag to track when we're typing to match a suggestion
let isTypingToMatchSuggestion = false;

// Add a function to log debug info to the console
function debugLog(message, data = {}) {
    console.log(`%c[AI Autocomplete] ${message}`, 'color: #4285f4; font-weight: bold;', data);
}

// Update the isTypingCurrentSuggestion function to be more accurate
function isTypingCurrentSuggestion(currentText, previousText, currentSuggestion) {
    if (!currentSuggestion || !previousText) return false;

    // If text got shorter, user is deleting, not typing the suggestion
    if (currentText.length < previousText.length) return false;

    // Get the new characters typed
    const newChars = currentText.slice(previousText.length);

    // Check if the new characters match the beginning of the suggestion
    const suggestionStart = currentSuggestion.slice(0, newChars.length);
    return suggestionStart.toLowerCase() === newChars.toLowerCase();
}

function initializeExtension() {
    let activeInput = null;
    let currentSuggestion = null;
    let debounceTimeout = null;
    let lastInputText = '';
    let lastRequestController = null; // Track the latest request

    // Update INPUT_SELECTOR to include YouTube search
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
        input[name="search_query"],
        .gLFyf,
        #search,
        .ytd-searchbox
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

    // Add a new function to update suggestion text without removing it
    function updateSuggestionText(suggestion, input) {
        if (!suggestion || !input) return;

        try {
            // Check if there's an existing suggestion
            let suggestionSpan = document.querySelector('.suggestion-span');

            if (suggestionSpan) {
                // Find the text span
                const textSpan = suggestionSpan.querySelector('span:first-child');
                if (textSpan) {
                    // Just update the text content
                    textSpan.textContent = suggestion;

                    // Update position
                    const rect = input.getBoundingClientRect();
                    const computedStyle = window.getComputedStyle(input);

                    // For regular input fields like Google search
                    const inputValue = input.value || getValue(input);

                    // Measure text width
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    context.font = computedStyle.font;
                    const textWidth = context.measureText(inputValue).width;

                    // Calculate position
                    let leftPosition = rect.left + parseFloat(computedStyle.paddingLeft || 0) + textWidth;

                    // Special handling for Google search
                    if (window.location.hostname.includes('google') &&
                        input.matches('input[name="q"], .gLFyf')) {
                        leftPosition += 2; // Add a small offset for cursor width
                    }

                    // Update position
                    suggestionSpan.style.left = `${leftPosition}px`;

                    return true; // Successfully updated
                }
            }

            return false; // Couldn't update
        } catch (error) {
            console.error('Error updating suggestion text:', error);
            return false;
        }
    }

    // Completely rewrite the handleKeyDown function to fix the Tab key behavior
    function handleKeyDown(e) {
        // Only handle Tab key with a suggestion
        if (e.key === 'Tab' && currentSuggestion && activeInput) {
            e.preventDefault(); // Always prevent default Tab behavior

            // Get current text
            const currentText = getValue(activeInput);

            // Get the last word the user is typing
            const lastWord = currentText.split(/\s+/).pop() || '';

            console.log('Tab pressed with suggestion:', {
                currentText,
                lastWord,
                currentSuggestion,
                isTypingToMatchSuggestion
            });

            // Remove any suggestion display
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) suggestionSpan.remove();

            // Determine what text to insert
            let textToInsert = currentSuggestion;
            let newValue;

            // If the last word is a partial match of the suggestion
            if (lastWord && lastWord.length > 0) {
                const suggestionLower = currentSuggestion.toLowerCase();
                const lastWordLower = lastWord.toLowerCase();

                // Check if the suggestion starts with the last word
                if (suggestionLower.startsWith(lastWordLower)) {
                    console.log('Partial match detected');

                    // Only insert the remaining part of the suggestion
                    textToInsert = currentSuggestion.substring(lastWord.length);
                    console.log('Text to insert:', textToInsert);

                    // If we're in the middle of a word, we need to handle it differently
                    if (lastWord !== currentText) {
                        // Get the text before the last word
                        const textBeforeLastWord = currentText.substring(0, currentText.length - lastWord.length);
                        newValue = textBeforeLastWord + lastWord + textToInsert;
                    } else {
                        newValue = currentText + textToInsert;
                    }
                } else {
                    // If the suggestion doesn't start with the last word,
                    // just add the full suggestion
                    newValue = currentText + textToInsert;
                }
            } else {
                // No partial word, just add the full suggestion
                newValue = currentText + textToInsert;
            }

            console.log('Final value to set:', newValue);

            // For contenteditable elements
            if (activeInput.isContentEditable) {
                document.execCommand('insertText', false, textToInsert);
            } else {
                // For input elements, set the value directly
                activeInput.value = newValue;

                // Dispatch input event
                const inputEvent = new Event('input', { bubbles: true });
                activeInput.dispatchEvent(inputEvent);

                // Also dispatch change event
                const changeEvent = new Event('change', { bubbles: true });
                activeInput.dispatchEvent(changeEvent);
            }

            // Add to undo history
            if (undoHistory.length >= MAX_UNDO_HISTORY) {
                undoHistory.shift();
            }
            undoHistory.push({
                input: activeInput,
                before: currentText,
                after: newValue
            });

            // Reset suggestion state
            currentSuggestion = null;
            isTypingToMatchSuggestion = false;
            lastSuggestionUpdateTime = Date.now();

            return;
        }

        // Handle Ctrl+Z or Cmd+Z for undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && undoHistory.length > 0) {
            const lastUndo = undoHistory.pop();
            if (lastUndo.input === activeInput) {
                setValue(activeInput, lastUndo.before);

                // Dispatch input event
                const inputEvent = new Event('input', { bubbles: true });
                activeInput.dispatchEvent(inputEvent);

                e.preventDefault();
            }
        }
    }

    // Completely rewrite handleInput to combine typing pause with suggestion matching
    function handleInput(e) {
        if (!activeInput) return;

        // Get current text
        const currentText = getValue(activeInput);

        // Check if backspace was pressed (text is shorter than before)
        const isBackspace = lastInputText && currentText.length < lastInputText.length;

        console.log('Input event:', {
            currentText,
            lastInputText,
            currentSuggestion,
            isBackspace,
            isTypingToMatchSuggestion
        });

        // Clear previous timeout to prevent multiple requests
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
            debounceTimeout = null;
        }

        // PART 1: HANDLE SUGGESTION MATCHING
        // Check if we have an active suggestion and the user is typing
        if (currentSuggestion && lastInputText) {
            // If backspace was pressed
            if (isBackspace) {
                // Get the last word the user is typing
                const lastWord = currentText.split(/\s+/).pop() || '';

                // Check if the user was typing to match a suggestion and is still matching
                if (isTypingToMatchSuggestion && lastWord.length > 0) {
                    const fullSuggestion = lastInputText + currentSuggestion;

                    // Check if the full suggestion still starts with the current text
                    if (fullSuggestion.toLowerCase().startsWith(currentText.toLowerCase())) {
                        console.log('Still matching suggestion after backspace');

                        // Update the suggestion to show the remaining part
                        const remainingSuggestion = fullSuggestion.substring(currentText.length);

                        // Update the suggestion
                        currentSuggestion = remainingSuggestion;

                        // Show the updated suggestion
                        showSuggestion(remainingSuggestion, activeInput);

                        // Update timestamp and last input text
                        lastSuggestionUpdateTime = Date.now();
                        lastInputText = currentText;

                        return;
                    }
                }

                // If we get here, clear the suggestion
                console.log('No longer matching suggestion, clearing');
                currentSuggestion = null;
                isTypingToMatchSuggestion = false;

                // Remove any suggestion display
                const suggestionSpan = document.querySelector('.suggestion-span');
                if (suggestionSpan) suggestionSpan.remove();
            }
            // If text is longer (user typed something)
            else if (currentText.length > lastInputText.length) {
                // Check if the user is typing to match the suggestion
                const fullSuggestion = lastInputText + currentSuggestion;

                // Get what was newly typed
                const newlyTyped = currentText.substring(lastInputText.length);

                // Special handling for Gmail search overlap
                const isGmailSearch = window.location.hostname.includes('mail.google.com') &&
                    (activeInput.getAttribute('placeholder')?.includes('Search') ||
                        activeInput.getAttribute('aria-label')?.includes('Search') ||
                        activeInput.matches('[role="searchbox"]') ||
                        activeInput.closest('[role="search"]'));

                // For Gmail search, always check for overlap
                if (isGmailSearch) {
                    console.log('Gmail search detected - checking for overlap');
                    console.log('Current suggestion:', currentSuggestion);
                    console.log('Newly typed:', newlyTyped);

                    // If there's any overlap between what was typed and the suggestion
                    if (currentSuggestion.toLowerCase().startsWith(newlyTyped.toLowerCase())) {
                        console.log('Overlap detected in Gmail search');

                        // Remove the overlap from the suggestion
                        const adjustedSuggestion = currentSuggestion.substring(newlyTyped.length);
                        currentSuggestion = adjustedSuggestion;

                        console.log('Adjusted suggestion:', currentSuggestion);
                    }
                }

                // Check if the full suggestion starts with the current text
                if (fullSuggestion.toLowerCase().startsWith(currentText.toLowerCase())) {
                    console.log('User is typing to match suggestion');

                    // Calculate the remaining part of the suggestion
                    const remainingSuggestion = fullSuggestion.substring(currentText.length);

                    // Update the suggestion
                    currentSuggestion = remainingSuggestion;
                    isTypingToMatchSuggestion = true;

                    // Show the updated suggestion
                    showSuggestion(remainingSuggestion, activeInput);

                    // Update timestamp and last input text
                    lastSuggestionUpdateTime = Date.now();
                    lastInputText = currentText;

                    return;
                } else {
                    // User typed something that doesn't match the suggestion
                    console.log('User typed something that doesn\'t match suggestion');
                    currentSuggestion = null;
                    isTypingToMatchSuggestion = false;

                    // Remove any suggestion display
                    const suggestionSpan = document.querySelector('.suggestion-span');
                    if (suggestionSpan) suggestionSpan.remove();
                }
            }
        }

        // PART 2: HANDLE NEW SUGGESTIONS AFTER TYPING PAUSE

        // Update last input text
        lastInputText = currentText;

        // Cancel any pending request
        if (lastRequestController) {
            lastRequestController.abort();
            lastRequestController = null;
        }

        // Only set a new timeout if the text isn't empty and meets minimum length
        if (currentText.trim().length >= 2) {
            // Set a longer timeout to wait for typing to pause
            const TYPING_PAUSE_MS = 1000; // Wait 1 second after typing stops

            debounceTimeout = setTimeout(async () => {
                // Check if we're within the cooldown period after typing a suggestion
                if (Date.now() - lastSuggestionUpdateTime < SUGGESTION_COOLDOWN_MS) {
                    console.log('Skipping request - within suggestion cooldown period');
                    return;
                }

                // Double-check that the text hasn't changed during the timeout
                if (currentText !== getValue(activeInput)) return;

                try {
                    // Show loading indicator
                    showLoadingIndicator(activeInput);

                    // Create new controller for this request
                    lastRequestController = new AbortController();

                    const suggestion = await getAISuggestion(currentText, lastRequestController.signal);

                    // Remove loading indicator
                    const loadingSpan = document.querySelector('.suggestion-loading');
                    if (loadingSpan) loadingSpan.remove();

                    // Only show suggestion if the input hasn't changed and we still have focus
                    if (suggestion &&
                        currentText === getValue(activeInput) &&
                        document.activeElement === activeInput) {
                        currentSuggestion = suggestion;
                        showSuggestion(suggestion, activeInput);
                        lastSuggestionUpdateTime = Date.now();
                        isTypingToMatchSuggestion = false;
                    }
                } catch (error) {
                    // Remove loading indicator on error
                    const loadingSpan = document.querySelector('.suggestion-loading');
                    if (loadingSpan) loadingSpan.remove();

                    if (error.name !== 'AbortError') {
                        console.error('Error getting suggestion:', error);
                    }
                }
            }, TYPING_PAUSE_MS);
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

    // Add specific handler for Gmail compose
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Tab' && currentSuggestion) {
            const activeElement = document.activeElement;
            const isGmailCompose = window.location.hostname === 'mail.google.com' &&
                (activeElement.getAttribute('role') === 'textbox' ||
                    activeElement.classList.contains('Am') ||
                    activeElement.classList.contains('Al-editable') ||
                    (activeElement.isContentEditable &&
                        activeElement.closest('[contenteditable="true"]')));

            if (isGmailCompose) {
                e.preventDefault();
                e.stopImmediatePropagation();

                const selection = window.getSelection();
                if (!selection.rangeCount) return;

                const range = selection.getRangeAt(0);
                const container = range.startContainer;
                const offset = range.startOffset;

                // Get text before cursor
                let textBeforeCursor = '';
                if (container.nodeType === Node.TEXT_NODE) {
                    textBeforeCursor = container.textContent.slice(0, offset);
                }
                const lastWord = textBeforeCursor.split(/\s+/).pop() || '';

                const isCompletion = currentSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
                    currentSuggestion.toLowerCase() !== lastWord.toLowerCase();

                // Save current state for undo
                const currentState = {
                    input: activeElement,
                    value: activeElement.textContent,
                    selection: {
                        start: offset,
                        end: offset
                    }
                };

                if (isCompletion && lastWord) {
                    // Delete the partial word
                    range.setStart(container, offset - lastWord.length);
                    range.deleteContents();
                }

                // Insert the suggestion
                const needsSpace = !isCompletion && !textBeforeCursor.endsWith(' ') && textBeforeCursor.length > 0;
                const textNode = document.createTextNode((needsSpace ? ' ' : '') + currentSuggestion);
                range.insertNode(textNode);

                // Move cursor to end
                range.setStartAfter(textNode);
                range.setEndAfter(textNode);
                selection.removeAllRanges();
                selection.addRange(range);

                // Save to undo history
                undoHistory.push(currentState);
                if (undoHistory.length > MAX_UNDO_HISTORY) {
                    undoHistory.shift();
                }
                showUndoIndicator('Ctrl+Z to undo');

                // Trigger input event
                activeElement.dispatchEvent(new InputEvent('input', { bubbles: true }));

                // Remove suggestion span
                const suggestionSpan = document.querySelector('.suggestion-span');
                if (suggestionSpan) {
                    suggestionSpan.remove();
                }

                currentSuggestion = null;
                return false;
            }
        }
    }, true); // Use capture phase to handle event before Gmail's handlers
}

// Add a function to extract page context
function getPageContext() {
    try {
        // Get page title
        const pageTitle = document.title || '';

        // Get meta description
        const metaDescription = document.querySelector('meta[name="description"]')?.content || '';

        // Get current URL
        const currentUrl = window.location.href;

        // Get visible text from the page (limited to avoid token overuse)
        let visibleText = '';

        // First try to get text from main content areas
        const mainContent = document.querySelector('main, article, #content, .content, [role="main"]');
        if (mainContent) {
            visibleText = mainContent.innerText.slice(0, 500);
        } else {
            // Fallback to getting text from the body
            const bodyText = document.body.innerText;
            visibleText = bodyText.slice(0, 500);
        }

        // Combine the context
        const pageContext = {
            title: pageTitle,
            description: metaDescription,
            url: currentUrl,
            visibleText: visibleText
        };

        return pageContext;
    } catch (error) {
        console.error('Error getting page context:', error);
        return {
            title: document.title || '',
            url: window.location.href
        };
    }
}

// Update the getAISuggestion function to fix the Google API implementation
async function getAISuggestion(text, signal) {
    try {
        // Get API settings from storage
        const settings = await new Promise(resolve => {
            chrome.storage.sync.get([
                'apiProvider',
                'openrouterKey',
                'groqKey',
                'googleKey',
                'openrouterModel',
                'groqModel'
            ], resolve);
        });

        // Default to OpenRouter if no provider is set
        const API_PROVIDER = settings.apiProvider || 'openrouter';

        // Get API keys
        const OPENROUTER_API_KEY = settings.openrouterKey || '';
        const GROQ_API_KEY = settings.groqKey || '';
        const GOOGLE_API_KEY = settings.googleKey || '';

        // Get models
        const OPENROUTER_MODEL = settings.openrouterModel || 'deepseek/deepseek-r1:free';
        const GROQ_MODEL = settings.groqModel || 'mixtral-8x7b-32768';

        // Get the current page context
        const pageContext = getPageContext();

        let apiUrl, headers, body, model;

        if (API_PROVIDER === 'openrouter') {
            apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
            model = OPENROUTER_MODEL;
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://github.com/yourusername/ai-autocomplete',
                'X-Title': 'AI Autocomplete Extension'
            };

            body = JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an autocomplete assistant. Your task is to predict the next few words that would naturally complete the user's text.

IMPORTANT RULES:
1. ONLY provide the exact completion text - no quotes, no explanations, no labels
2. Suggest ONLY 1-3 words that directly continue the input text
3. Never repeat words from the input
4. For partial words, complete only that word
5. Keep suggestions contextually relevant to the page the user is viewing

Current page context:
Title: ${pageContext.title}
URL: ${pageContext.url}
Description: ${pageContext.description}
Content: ${pageContext.visibleText.substring(0, 200)}`
                    },
                    {
                        role: 'user',
                        content: `Complete this text (ONLY provide the completion, nothing else): "${text}"`
                    }
                ],
                max_tokens: 20,
                temperature: 0.1,
                top_p: 0.3
            });
        } else if (API_PROVIDER === 'groq') {
            apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
            model = GROQ_MODEL;
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            };

            body = JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an autocomplete assistant. Your task is to predict the next few words that would naturally complete the user's text.

IMPORTANT RULES:
1. ONLY provide the exact completion text - no quotes, no explanations, no labels
2. Suggest ONLY 1-3 words that directly continue the input text
3. Never repeat words from the input
4. For partial words, complete only that word
5. Keep suggestions contextually relevant to the page the user is viewing

Current page context:
Title: ${pageContext.title}
URL: ${pageContext.url}
Description: ${pageContext.description}
Content: ${pageContext.visibleText.substring(0, 200)}`
                    },
                    {
                        role: 'user',
                        content: `Complete this text (ONLY provide the completion, nothing else): "${text}"`
                    }
                ],
                max_tokens: 20,
                temperature: 0.1,
                top_p: 0.2,
                frequency_penalty: 0.3,
                presence_penalty: 0.3
            });
        } else if (API_PROVIDER === 'google') {
            apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
            headers = {
                'Content-Type': 'application/json'
            };

            body = JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [{
                        text: `You are an autocomplete assistant. Complete this text with 1-3 words (ONLY provide the exact completion, no explanations): "${text}"

Current page context:
Title: ${pageContext.title}
URL: ${pageContext.url}`
                    }]
                }],
                safetySettings: [{
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_NONE"
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 20,
                    topP: 0.3,
                    topK: 10
                }
            });

            // Add API key as query parameter
            apiUrl += `?key=${GOOGLE_API_KEY}`;
        } else {
            throw new Error('Invalid API provider');
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: body,
            signal: signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();

        let suggestion = '';

        if (API_PROVIDER === 'openrouter' || API_PROVIDER === 'groq') {
            suggestion = data.choices[0].message.content.trim();
        } else if (API_PROVIDER === 'google') {
            if (data.candidates && data.candidates.length > 0 &&
                data.candidates[0].content && data.candidates[0].content.parts &&
                data.candidates[0].content.parts.length > 0) {
                suggestion = data.candidates[0].content.parts[0].text.trim();
            } else {
                console.log('Unexpected Google API response format:', data);
                return null;
            }
        }

        // Aggressive cleaning of the suggestion
        suggestion = suggestion
            // Remove quotes, brackets and other common delimiters
            .replace(/^["'`\[\(\{]+|["'`\]\)\}]+$/g, '')
            // Remove common prefixes that models tend to add
            .replace(/^(I would suggest|I suggest|Suggestion:|Here's a suggestion:|Next words:|Completion:|The next words could be:|The completion is:|The text continues with:|Continuing:|Completed text:|Autocomplete:|Predicted text:|Next:|Suggestion would be:|Possible completion:|Recommended completion:)/i, '')
            // Remove any "quotes" or similar text
            .replace(/(^|\s)["']([^"']*)["'](\s|$)/g, '$1$2$3')
            // Remove any explanations in parentheses or brackets
            .replace(/\s*[\(\[\{].*?[\)\]\}]\s*/g, ' ')
            // Remove any text after a period, comma, semicolon, or colon if it looks like an explanation
            .replace(/[.,;:].*$/g, '')
            // Limit to 3 words maximum
            .split(/\s+/).slice(0, 3).join(' ')
            // Final trim of whitespace and punctuation
            .replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, '');

        // If the suggestion is empty after cleaning, return null
        if (!suggestion) {
            return null;
        }

        return suggestion;
    } catch (error) {
        console.error('Error in getAISuggestion:', error);
        throw error;
    }
}

// Add a style element to prevent suggestion removal
function addPreventRemovalStyle() {
    const styleId = 'prevent-suggestion-removal-style';

    // Check if the style already exists
    if (document.getElementById(styleId)) {
        return;
    }

    // Create a style element
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .suggestion-span {
            position: fixed;
            pointer-events: none;
            white-space: pre;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 4px;
            background: transparent;
        }
        .suggestion-text {
            display: inline-block;
            color: #666;
            opacity: 0.8;
        }
        .tab-indicator {
            font-size: 11px;
            color: #999;
            background: rgba(0, 0, 0, 0.06);
            padding: 1px 4px;
            border-radius: 3px;
            margin-left: 4px;
            font-family: system-ui, -apple-system, sans-serif;
        }
    `;

    // Add the style to the document
    document.head.appendChild(style);
}

// Call this function when the extension initializes
addPreventRemovalStyle();

// Completely rewrite showSuggestion with special Gmail handling
function showSuggestion(suggestion, input) {
    if (!suggestion || !input) return;

    try {
        // Remove any existing suggestion
        const existingSuggestion = document.querySelector('.suggestion-span');
        if (existingSuggestion) {
            existingSuggestion.remove();
        }

        // Create suggestion element
        const suggestionSpan = document.createElement('span');
        suggestionSpan.className = 'suggestion-span';

        // Create text element
        const textSpan = document.createElement('span');
        textSpan.className = 'suggestion-text';
        textSpan.textContent = suggestion;

        // Create Tab indicator
        const tabIndicator = document.createElement('span');
        tabIndicator.className = 'tab-indicator';
        tabIndicator.textContent = 'Tab';

        // Add elements to suggestion span
        suggestionSpan.appendChild(textSpan);
        suggestionSpan.appendChild(tabIndicator);

        // Detect Gmail
        const isGmail = window.location.hostname.includes('mail.google.com');

        // Special handling for Gmail search
        const isGmailSearch = isGmail && (
            input.getAttribute('placeholder')?.includes('Search') ||
            input.getAttribute('aria-label')?.includes('Search') ||
            input.matches('[role="searchbox"]') ||
            input.closest('[role="search"]')
        );

        // Special handling for Gmail compose
        const isGmailCompose = isGmail && (
            input.getAttribute('aria-label')?.includes('Message Body') ||
            input.closest('[role="textbox"]') ||
            input.closest('.editable')
        );

        // Get input position and style
        const rect = input.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(input);

        // Default position calculation
        let leftPosition, topPosition;

        // Gmail search specific positioning - FINAL FIX
        if (isGmailSearch) {
            console.log('Gmail search detected - using final fixed positioning');

            // Get the selection/cursor position
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const cursorRect = range.getBoundingClientRect();

                // Use cursor position directly if available
                if (cursorRect.width > 0 || cursorRect.height > 0) {
                    leftPosition = cursorRect.right + 1; // Minimal offset
                    topPosition = cursorRect.top;

                    console.log('Using cursor position for Gmail search:', {
                        cursorRect,
                        leftPosition,
                        topPosition
                    });
                } else {
                    // Fallback to a more precise calculation
                    const searchText = input.textContent || input.value || '';

                    // Create a temporary span to measure the exact text width
                    const tempSpan = document.createElement('span');
                    tempSpan.style.visibility = 'hidden';
                    tempSpan.style.position = 'absolute';
                    tempSpan.style.whiteSpace = 'pre';
                    tempSpan.style.font = computedStyle.font;
                    tempSpan.textContent = searchText;
                    document.body.appendChild(tempSpan);

                    // Get the exact width of the text
                    const exactTextWidth = tempSpan.getBoundingClientRect().width;
                    document.body.removeChild(tempSpan);

                    // Calculate position - use a smaller offset (20px instead of 40px)
                    leftPosition = rect.left + 20 + exactTextWidth;

                    // Align with the text baseline
                    topPosition = rect.top + (rect.height / 2) - (parseFloat(computedStyle.fontSize) / 3);

                    console.log('Using text measurement for Gmail search:', {
                        searchText,
                        exactTextWidth,
                        leftPosition,
                        topPosition
                    });
                }
            } else {
                // Fallback if no selection
                leftPosition = rect.left + rect.width / 2;
                topPosition = rect.top + rect.height / 2;
            }
        }
        // Gmail compose specific positioning - FINAL FIX
        else if (isGmailCompose) {
            console.log('Gmail compose detected - using final fixed positioning');

            // For Gmail compose, we need to get the exact cursor position
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const cursorRect = range.getBoundingClientRect();

                // Use cursor position with minimal adjustments
                leftPosition = cursorRect.right + 1; // Minimal offset

                // Use the exact top position from the cursor
                topPosition = cursorRect.top;

                console.log('Gmail compose positioning:', {
                    cursorRect,
                    leftPosition,
                    topPosition
                });
            } else {
                // Fallback if no selection
                leftPosition = rect.left + rect.width / 2;
                topPosition = rect.top + rect.height / 2;
            }
        }
        // Default positioning for other inputs
        else {
            // Get current text value
            const inputValue = getValue(input);

            // Measure text width
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = computedStyle.font;
            const textWidth = context.measureText(inputValue).width;

            leftPosition = rect.left + parseFloat(computedStyle.paddingLeft || 0) + textWidth;
            topPosition = rect.top + parseFloat(computedStyle.paddingTop || 0);
        }

        // Set position
        suggestionSpan.style.left = `${leftPosition}px`;
        suggestionSpan.style.top = `${topPosition}px`;

        // Match font styles
        suggestionSpan.style.fontFamily = computedStyle.fontFamily;
        suggestionSpan.style.fontSize = computedStyle.fontSize;
        suggestionSpan.style.lineHeight = computedStyle.lineHeight;

        // Add to document
        document.body.appendChild(suggestionSpan);

        console.log('Suggestion displayed at:', { leftPosition, topPosition });

        return true;
    } catch (error) {
        console.error('Error showing suggestion:', error);
        return false;
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