require('dotenv').config();
const db = require('./src/config/db');

async function check() {
    try {
        console.log('Checking latest 5 messages...');
        const [rows] = await db.query("SELECT id, content, reply_to_id, created_at FROM messages ORDER BY id DESC LIMIT 5");
        console.log(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

check();