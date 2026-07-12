/**
 * StockMarketLoop Inbox/Notification Module
 * Fixed rendering, safe DOM injection, proper toggle logic
 */

const InboxModule = (() => {
    // Private state
    let isOpen = false;
    let autoRefreshInterval = null;
    const API_ENDPOINT = '/api/notifications'; // Adjust to your API
    const AUTO_REFRESH_INTERVAL = 45000; // 45 seconds

    /**
     * Safely escape HTML to prevent injection attacks
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Fetch notifications from API
     */
    async function fetchNotifications() {
        try {
            const response = await fetch(API_ENDPOINT);
            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('Error fetching notifications:', error);
            return null;
        }
    }

    /**
     * Safe HTML template rendering for notifications
     */
    function renderNotificationsList(notifications) {
        // Guard: if no notifications, return empty state
        if (!notifications || notifications.length === 0) {
            return `<div class="notification-empty">No notifications yet.</div>`;
        }

        // Map each notification safely
        const items = notifications
            .map(notification => {
                const title = escapeHtml(notification.title || 'Untitled');
                const message = escapeHtml(notification.message || '');
                const timestamp = escapeHtml(notification.timestamp || '');

                return `
                    <div class="notification-item">
                        <div class="notification-title">${title}</div>
                        <div class="notification-message">${message}</div>
                        <div class="notification-timestamp">${timestamp}</div>
                    </div>
                `;
            })
            .join('');

        return `<div class="notification-list">${items}</div>`;
    }

    /**
     * Render the inbox container and inject notifications
     */
    function renderInbox() {
        let inboxContainer = document.getElementById('inbox-container');

        // Create container if it doesn't exist
        if (!inboxContainer) {
            inboxContainer = document.createElement('div');
            inboxContainer.id = 'inbox-container';
            inboxContainer.className = 'inbox-container';
            document.body.appendChild(inboxContainer);
        }

        // Set loading state
        inboxContainer.innerHTML = `<div class="notification-loading">Loading notifications...</div>`;
        inboxContainer.setAttribute('data-open', isOpen ? '1' : '0');

        // Fetch and render notifications
        fetchNotifications().then(data => {
            if (data && data.notifications) {
                inboxContainer.innerHTML = renderNotificationsList(data.notifications);
            } else {
                // Fallback if API fails
                inboxContainer.innerHTML = renderNotificationsList([]);
            }
        }).catch(() => {
            // Clean fallback on error
            inboxContainer.innerHTML = renderNotificationsList([]);
        });
    }

    /**
     * Toggle inbox open/closed
     */
    function toggleInbox() {
        isOpen = !isOpen;

        // Update toggle button state
        const toggleBtn = document.getElementById('inbox-toggle');
        if (toggleBtn) {
            toggleBtn.setAttribute('data-open', isOpen ? '1' : '0');
            toggleBtn.textContent = isOpen ? '✕ Inbox' : '📬 Inbox';
        }

        // Only load notifications when opening
        if (isOpen) {
            renderInbox();
            startAutoRefresh();
        } else {
            stopAutoRefresh();
            // Hide inbox when closing
            const inboxContainer = document.getElementById('inbox-container');
            if (inboxContainer) {
                inboxContainer.setAttribute('data-open', '0');
            }
        }
    }

    /**
     * Start auto-refresh (only when inbox is open)
     */
    function startAutoRefresh() {
        if (autoRefreshInterval) return; // Already running

        autoRefreshInterval = setInterval(() => {
            if (isOpen) {
                renderInbox();
            }
        }, AUTO_REFRESH_INTERVAL);
    }

    /**
     * Stop auto-refresh when inbox closes
     */
    function stopAutoRefresh() {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    }

    /**
     * Initialize the inbox module
     */
    function init() {
        // Create inbox toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'inbox-toggle';
        toggleBtn.className = 'inbox-toggle';
        toggleBtn.setAttribute('data-open', '0');
        toggleBtn.textContent = '📬 Inbox';
        toggleBtn.onclick = toggleInbox;

        document.body.appendChild(toggleBtn);

        // Create empty inbox container
        const inboxContainer = document.createElement('div');
        inboxContainer.id = 'inbox-container';
        inboxContainer.className = 'inbox-container';
        inboxContainer.setAttribute('data-open', '0');
        document.body.appendChild(inboxContainer);
    }

    /**
     * Public API
     */
    return {
        init: init,
        toggle: toggleInbox,
        open: () => {
            if (!isOpen) toggleInbox();
        },
        close: () => {
            if (isOpen) toggleInbox();
        },
        refresh: renderInbox
    };
})();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    InboxModule.init();
});
