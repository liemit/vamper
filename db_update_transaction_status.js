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
        
        console.log('Modifying transactions table status enum...');
        // Add 'refunded' to the ENUM list
        await connection.query(`
            ALTER TABLE transactions 
            MODIFY COLUMN status ENUM('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending'
        `);
        console.log('Transaction status enum updated successfully.');

        connection.release();
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();