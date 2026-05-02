const axios = require('axios');

/**
 * Reusable Log function
 * @param {string} stack - Accepts "backend" or "frontend"
 * @param {string} level - Accepts "debug", "info", "warn", "error", "fatal"
 * @param {string} pkg - The package name generating the log
 * @param {string} message - The log message
 */
async function Log(stack, level, pkg, message) {
    const token = process.env.AUTH_TOKEN;
    if (!token) {
        console.warn("AUTH_TOKEN environment variable is not set. Log will not be sent to server.");
        console.log(`[LOCAL LOG] ${level.toUpperCase()} [${stack} - ${pkg}]: ${message}`);
        return;
    }

    try {
        await axios.post('http://20.207.122.201/evaluation-service/logs', {
            stack: stack.toLowerCase(),
            level: level.toLowerCase(),
            package: pkg.toLowerCase(),
            message: message
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error("Failed to push log to server:", error.message);
    }
}

module.exports = { Log };
