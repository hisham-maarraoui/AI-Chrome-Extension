document.addEventListener('DOMContentLoaded', () => {
    const apiProvider = document.getElementById('apiProvider');
    const openrouterSection = document.getElementById('openrouterSection');
    const groqSection = document.getElementById('groqSection');
    const googleSection = document.getElementById('googleSection');

    // Handle API provider selection
    apiProvider.addEventListener('change', () => {
        openrouterSection.style.display = 'none';
        groqSection.style.display = 'none';
        googleSection.style.display = 'none';

        switch (apiProvider.value) {
            case 'openrouter':
                openrouterSection.style.display = 'block';
                break;
            case 'groq':
                groqSection.style.display = 'block';
                break;
            case 'google':
                googleSection.style.display = 'block';
                break;
        }
    });

    // Load saved settings
    chrome.storage.sync.get([
        'apiProvider',
        'openrouterKey',
        'groqKey',
        'googleKey',
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
        if (result.googleKey) {
            document.getElementById('googleKey').value = result.googleKey;
        }
    });

    // Save settings
    document.getElementById('save').addEventListener('click', () => {
        const selectedProvider = apiProvider.value;
        const openrouterKey = document.getElementById('openrouterKey').value.trim();
        const groqKey = document.getElementById('groqKey').value.trim();
        const googleKey = document.getElementById('googleKey').value.trim();
        const openrouterModel = document.getElementById('openrouterModel').value;
        const groqModel = document.getElementById('groqModel').value;

        const activeKey = {
            'openrouter': openrouterKey,
            'groq': groqKey,
            'google': googleKey
        }[selectedProvider];

        if (!activeKey) {
            showStatus('Please enter an API key', 'error');
            return;
        }

        chrome.storage.sync.set({
            apiProvider: selectedProvider,
            openrouterKey,
            groqKey,
            googleKey,
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