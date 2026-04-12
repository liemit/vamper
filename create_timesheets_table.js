const mysql = require('mysql2/promise');

async function up() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'vamper'
    });

    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS timesheets (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                proposal_id BIGINT UNSIGNED NOT NULL,
                week_start DATE NOT NULL,
                hours DECIMAL(5,2) NOT NULL DEFAULT 0,
                status ENUM('pending', 'approved', 'disputed', 'paid') NOT NULL DEFAULT 'pending',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('Timesheets table created successfully.');
    } catch (err) {
        console.error(err);
    } finally {
        await connection.end();
    }
}

up();
