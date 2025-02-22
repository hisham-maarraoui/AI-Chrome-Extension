document.addEventListener('DOMContentLoaded', () => {
    const apiProvider = document.getElementById('apiProvider');
    const openrouterSection = document.getElementById('openrouterSection');
    const groqSection = document.getElementById('groqSection');

    // Handle API provider selection
    apiProvider.addEventListener('change', () => {
        if (apiProvider.value === 'openrouter') {
            openrouterSection.style.display = 'block';
            groqSection.style.display = 'none';
        } else {
            openrouterSection.style.display = 'none';
            groqSection.style.display = 'block';
        }
    });

    // Load saved settings
    chrome.storage.sync.get([
        'apiProvider',
        'openrouterKey',
        'groqKey',
        'openrouterModel',
        'groqModel'
    ], (result) => {
        if (result.apiProvider) {
            apiProvider.value = result.apiProvider;
            apiProvider.dispatchEvent(new Event('change'));
        }
        if (result.openrouterKey) {
            document.getElementById('openrouterKey').value = result.openrouterKey;
        }
        if (result.groqKey) {
            document.getElementById('groqKey').value = result.groqKey;
        }
        if (result.openrouterModel) {
            document.getElementById('openrouterModel').value = result.openrouterModel;
        }
        if (result.groqModel) {
            document.getElementById('groqModel').value = result.groqModel;
        }
    });

    // Save settings
    document.getElementById('save').addEventListener('click', () => {
        const selectedProvider = apiProvider.value;
        const openrouterKey = document.getElementById('openrouterKey').value.trim();
        const groqKey = document.getElementById('groqKey').value.trim();
        const openrouterModel = document.getElementById('openrouterModel').value;
        const groqModel = document.getElementById('groqModel').value;

        // Validate the active API key
        const activeKey = selectedProvider === 'openrouter' ? openrouterKey : groqKey;
        if (!activeKey) {
            showStatus('Please enter an API key', 'error');
            return;
        }

        // Save all settings
        chrome.storage.sync.set({
            apiProvider: selectedProvider,
            openrouterKey,
            groqKey,
            openrouterModel,
            groqModel
        }, () => {
            showStatus('Settings saved successfully!', 'success');
        });
    });

    function showStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = `status ${type}`;
        status.style.display = 'block';
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    }
}); 