// Configuration
const DEBOUNCE_MS = 300; // Delay before making API calls

// Use the API key from config
const OPENROUTER_API_KEY = config.OPENROUTER_API_KEY;

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

// Wait for DOM to be ready before appending overlay
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

function initializeExtension() {
    let activeInput = null;
    let currentSuggestion = null;
    let debounceTimeout = null;
    let lastInputText = '';

    const INPUT_SELECTOR = 'input[type="text"], input[type="search"], input:not([type]), textarea';

    function showSuggestion(suggestion, input) {
        if (!suggestion || !input) return;

        // Remove any existing suggestion elements
        const existingSuggestion = document.querySelector('.suggestion-span');
        if (existingSuggestion) {
            existingSuggestion.remove();
        }

        // Get the computed styles and position of the input
        const computedStyle = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        
        // Calculate the width of the current input text
        const textWidth = getTextWidth(input.value, computedStyle.font);

        // Create the suggestion span
        const suggestionSpan = document.createElement('span');
        suggestionSpan.className = 'suggestion-span';
        suggestionSpan.style.cssText = `
            position: fixed;
            left: ${rect.left + textWidth + parseFloat(computedStyle.paddingLeft)}px;
            top: ${rect.top + parseFloat(computedStyle.paddingTop)}px;
            font-family: ${computedStyle.fontFamily};
            font-size: ${computedStyle.fontSize};
            line-height: ${computedStyle.lineHeight};
            color: #666;
            pointer-events: none;
            white-space: pre;
            z-index: 999999;
        `;
        
        // Add a space before the suggestion if there isn't one
        const needsSpace = !input.value.endsWith(' ') && input.value.length > 0;
        suggestionSpan.textContent = needsSpace ? ' ' + suggestion : suggestion;

        // Add the suggestion span directly to body
        document.body.appendChild(suggestionSpan);
    }

    document.addEventListener('focusin', (e) => {
        const input = e.target;
        if (input.matches(INPUT_SELECTOR) && !input.readOnly && !input.disabled) {
            activeInput = input;
        }
    });

    document.addEventListener('focusout', (e) => {
        if (activeInput) {
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }
            activeInput = null;
            currentSuggestion = null;
        }
    });

    document.addEventListener('input', (e) => {
        if (!activeInput) {
            console.log('No active input');
            return;
        }

        console.log('Input event triggered:', activeInput.value);

        // Clear previous timeout
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
        }

        // Set new timeout to avoid too many API calls
        debounceTimeout = setTimeout(async () => {
            const text = activeInput.value;
            lastInputText = text; // Store the current input text
            console.log('Debounced input value:', text);
            if (text.length < 2) {
                return;
            }

            try {
                const suggestion = await getAISuggestion(text);
                // Only show suggestion if the input hasn't changed
                if (suggestion && lastInputText === activeInput.value) {
                    currentSuggestion = suggestion;
                    showSuggestion(suggestion, activeInput);
                }
            } catch (error) {
                console.error('Error getting suggestion:', error);
            }
        }, DEBOUNCE_MS);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && currentSuggestion && activeInput) {
            e.preventDefault();
            
            // Remove the suggestion span
            const suggestionSpan = document.querySelector('.suggestion-span');
            if (suggestionSpan) {
                suggestionSpan.remove();
            }

            // Add a space if needed
            const needsSpace = !activeInput.value.endsWith(' ') && activeInput.value.length > 0;
            
            // Update the input value
            activeInput.value = activeInput.value + (needsSpace ? ' ' : '') + currentSuggestion;
            
            // Clear the current suggestion
            currentSuggestion = null;
        }
    });

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

async function getAISuggestion(text) {
    try {
        console.log('Making API request for text:', text);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'Origin': 'https://openrouter.ai',
                'Referer': 'https://openrouter.ai/',
                'HTTP-Referer': 'https://openrouter.ai/'
            },
            body: JSON.stringify({
                model: 'anthropic/claude-3-haiku',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an autocomplete assistant. Given the start of a sentence, extend it with a natural completion. Only respond with the completion part, no explanation. Keep completions concise.'
                    },
                    {
                        role: 'user',
                        content: `Complete this text naturally: "${text}"`
                    }
                ],
                max_tokens: 50,
                temperature: 0.3
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('API Response not OK:', response.status, errorData);
            if (response.status === 401) {
                console.error('Authentication failed. Please check your API key.');
            }
            throw new Error(`API request failed: ${response.status} ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        console.log('API Response:', data);

        const suggestion = data.choices[0]?.message?.content?.trim();
        console.log('Processed suggestion:', suggestion);

        if (suggestion) {
            // Clean up the suggestion
            const cleanSuggestion = suggestion
                .replace(/^["']|["']$/g, '') // Remove quotes
                .replace(/^[.,!?]\s*/, '') // Remove leading punctuation
                .replace(/^\s+/, ''); // Remove leading whitespace

            // Only return the completion part, not the full text
            return cleanSuggestion;
        }
        return null;
    } catch (error) {
        console.error('Error in getAISuggestion:', error);
        if (error.name === 'AbortError') {
            console.log('Request timed out');
        }
        throw error;
    }
}

// Helper function to calculate text width
function getTextWidth(text, font) {
    const canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    context.font = font;
    return context.measureText(text).width;
} 