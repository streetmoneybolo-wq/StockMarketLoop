/**
 * MOCK API RESPONSE FOR TESTING
 * In production, replace this with your actual API endpoint
 * 
 * This is for development/testing purposes only
 */

// Mock notifications data
const MOCK_NOTIFICATIONS = {
    notifications: [
        {
            title: "Market Alert",
            message: "AAPL just hit a new 52-week high",
            timestamp: "2 minutes ago"
        },
        {
            title: "Portfolio Update",
            message: "Your diversified portfolio gained 2.3% today",
            timestamp: "15 minutes ago"
        },
        {
            title: "Dividend Payment",
            message: "Dividend of $15.50 deposited to your account",
            timestamp: "1 hour ago"
        },
        {
            title: "News Flash",
            message: "Fed announces interest rate decision at 2 PM EST",
            timestamp: "3 hours ago"
        },
        {
            title: "Watchlist Update",
            message: "TSLA added to your watchlist notifications",
            timestamp: "Yesterday"
        }
    ]
};

// Empty notifications response for testing
const EMPTY_NOTIFICATIONS = {
    notifications: []
};

/**
 * Mock API endpoint
 * Replace /api/notifications with your actual backend endpoint
 * 
 * Expected response format:
 * {
 *     "notifications": [
 *         {
 *             "title": "string",
 *             "message": "string",
 *             "timestamp": "string"
 *         }
 *     ]
 * }
 */

// For testing locally, you can uncomment this to intercept fetch calls:
/*
const originalFetch = window.fetch;
window.fetch = function(url, options) {
    if (url === '/api/notifications') {
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(MOCK_NOTIFICATIONS)
        });
    }
    return originalFetch.call(this, url, options);
};
*/

console.log('Mock API loaded. Use MOCK_NOTIFICATIONS for testing.');
console.log('Current mock data:', MOCK_NOTIFICATIONS);
