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
        
        console.log('Checking pending_balance column in proposals table...');
        const [columns] = await connection.query("SHOW COLUMNS FROM proposals LIKE 'pending_balance'");
        
        if (columns.length === 0) {
            console.log('Adding pending_balance column to proposals table...');
            await connection.query(`
                ALTER TABLE proposals 
                ADD COLUMN pending_balance DECIMAL(15,2) DEFAULT 0.00
            `);
            console.log('Column added successfully.');
        } else {
            console.log('Column already exists.');
        }

        connection.release();
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();