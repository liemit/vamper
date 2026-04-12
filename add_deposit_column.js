require('dotenv').config();
const db = require('./src/config/db');

async function run() {
    try {
        await db.query('ALTER TABLE proposals ADD COLUMN is_deposited TINYINT(1) NOT NULL DEFAULT 0');
        console.log('Column added successfully');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column already exists');
        } else {
            console.error('Error adding column:', err);
        }
    }
    process.exit();
}

run();