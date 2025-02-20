// Configuration
const OPENROUTER_API_KEY = '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';
const DEBOUNCE_MS = 300; // Delay before making API calls

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
document.body.appendChild(overlay);

// Track current active input
let activeInput = null;
let currentSuggestion = null;
let debounceTimeout = null;
let lastInputText = ''; // Track the last input text

// Add event listeners to all text inputs
document.addEventListener('focusin', (e) => {
    if (e.target.matches('input[type="text"], textarea')) {
        activeInput = e.target;
    }
});

document.addEventListener('focusout', (e) => {
    overlay.style.display = 'none';
    activeInput = null;
    currentSuggestion = null;
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
            overlay.style.display = 'none';
            return;
        }

        try {
            const suggestion = await getAISuggestion(text);
            // Only show suggestion if the input hasn't changed
            if (suggestion && lastInputText === activeInput.value) {
                currentSuggestion = suggestion;
                showSuggestion(suggestion, activeInput);
            } else {
                overlay.style.display = 'none';
                currentSuggestion = null;
            }
        } catch (error) {
            console.error('Error getting suggestion:', error);
            overlay.style.display = 'none';
        }
    }, DEBOUNCE_MS);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && currentSuggestion) {
        e.preventDefault();
        // Combine the current input with the suggestion
        activeInput.value = `${activeInput.value} ${currentSuggestion}`;
        overlay.style.display = 'none';
        currentSuggestion = null;
    }
});

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
                'Referer': 'https://openrouter.ai/'
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

function showSuggestion(suggestion, input) {
    console.log('Showing suggestion:', suggestion);
    const rect = input.getBoundingClientRect();
    const top = rect.bottom + window.scrollY;
    const left = rect.left + window.scrollX;

    // Show the full text (current input + suggestion)
    const fullText = `${input.value} ${suggestion}`;
    overlay.textContent = fullText;
    overlay.style.top = `${top}px`;
    overlay.style.left = `${left}px`;
    overlay.style.display = 'block';

    console.log('Overlay position:', { top, left });
    console.log('Overlay visible:', overlay.style.display);
} 