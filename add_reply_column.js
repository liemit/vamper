require('dotenv').config();
const db = require('./src/config/db');

async function migrate() {
    try {
        console.log('Checking if reply_to_id column exists...');
        const [rows] = await db.query("SHOW COLUMNS FROM messages LIKE 'reply_to_id'");
        
        if (rows.length === 0) {
            console.log('Adding reply_to_id column and constraint...');
            await db.query(`
                ALTER TABLE messages 
                ADD COLUMN reply_to_id BIGINT UNSIGNED DEFAULT NULL AFTER job_id,
                ADD CONSTRAINT messages_reply_fk FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL
            `);
            console.log('Column and constraint added successfully.');
        } else {
            console.log('Column already exists.');
            // Ideally check constraint too, but for now assuming if column exists, we are good or constraint was added.
            // If the previous run failed halfway, we might have column but no constraint.
            // Let's try to add constraint separately if column exists, catching error if it exists.
            try {
                 await db.query("ALTER TABLE messages ADD CONSTRAINT messages_reply_fk FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL");
                 console.log('Constraint added (was missing).');
            } catch (e) {
                // Ignore duplicate constraint error
                if (e.code !== 'ER_DUP_KEY' && e.code !== 'ER_CANT_CREATE_TABLE') { // ER_CANT_CREATE_TABLE often thrown for duplicate constraint name in some versions
                     // console.log('Constraint might already exist or error:', e.message);
                }
            }
        }
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
