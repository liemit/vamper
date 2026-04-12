const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vamper',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function migrate() {
    try {
        console.log('Connecting to database...');
        const connection = await pool.getConnection();
        
        console.log('Checking columns in proposals table...');
        const [columns] = await connection.query("SHOW COLUMNS FROM proposals LIKE 'timer_status'");
        
        if (columns.length === 0) {
            console.log('Adding timer columns to proposals table...');
            await connection.query(`
                ALTER TABLE proposals 
                ADD COLUMN timer_status ENUM('stopped', 'running', 'paused') DEFAULT 'stopped',
                ADD COLUMN timer_start_time DATETIME NULL,
                ADD COLUMN total_seconds_worked INT UNSIGNED DEFAULT 0,
                ADD COLUMN paid_seconds INT UNSIGNED DEFAULT 0,
                ADD COLUMN last_sync_time DATETIME NULL
            `);
            console.log('Columns added successfully.');
        } else {
            console.log('Columns already exist.');
        }

        connection.release();
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();