const axios = require('axios');
const { Log } = require('affordmed-logging-middleware');

// API endpoint
const API_URL = 'http://20.207.122.201/evaluation-service/notifications';

// Priority Weights (Higher is more important)
const WEIGHTS = {
    'Placement': 3,
    'Result': 2,
    'Event': 1
};

async function getTopNotifications() {
    const token = process.env.AUTH_TOKEN;
    
    let notifications = [];

    // Allow mocking if test server is down
    if (process.env.MOCK === 'true') {
        notifications = [
            { "ID": "1", "Type": "Result", "Message": "mid-sem", "Timestamp": "2026-04-22 17:51:30" },
            { "ID": "2", "Type": "Placement", "Message": "CSX Corporation hiring", "Timestamp": "2026-04-22 17:51:18" },
            { "ID": "3", "Type": "Event", "Message": "farewell", "Timestamp": "2026-04-22 17:51:06" },
            { "ID": "4", "Type": "Result", "Message": "project-review", "Timestamp": "2026-04-22 17:50:42" },
            { "ID": "5", "Type": "Placement", "Message": "Advanced Micro Devices Inc. hiring", "Timestamp": "2026-04-22 17:49:42" }
        ];
        await Log("backend", "info", "controller", "Fetched notifications from mock data");
    } else {
        if (!token) {
            console.error("Please set AUTH_TOKEN environment variable.");
            return;
        }
        try {
            const response = await axios.get(API_URL, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            notifications = response.data.notifications || [];
            await Log("backend", "info", "controller", "Successfully fetched notifications from server");
        } catch (error) {
            await Log("backend", "error", "controller", `Failed to fetch notifications: ${error.message}`);
            console.error("Error fetching notifications:", error.message);
            return;
        }
    }

    // Sort notifications:
    // 1. By Weight (Placement > Result > Event)
    // 2. By Recency (Timestamp DESC)
    notifications.sort((a, b) => {
        const weightA = WEIGHTS[a.Type] || 0;
        const weightB = WEIGHTS[b.Type] || 0;

        if (weightA !== weightB) {
            return weightB - weightA; // Descending order of weight
        }

        // If weights are equal, sort by recency (Timestamp descending)
        const timeA = new Date(a.Timestamp).getTime();
        const timeB = new Date(b.Timestamp).getTime();
        return timeB - timeA;
    });

    // Get top 10
    const top10 = notifications.slice(0, 10);
    
    console.log("=== TOP 10 PRIORITY NOTIFICATIONS ===");
    console.table(top10);
    return top10;
}

if (require.main === module) {
    getTopNotifications();
}

module.exports = { getTopNotifications };
