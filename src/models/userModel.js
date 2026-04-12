const db = require('../config/db');
const bcrypt = require('bcryptjs');

class User {
    static async findByEmail(email) {
        const [rows] = await db.execute(
            "SELECT * FROM users WHERE email = ? LIMIT 1",
            [email]
        );
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }

    static async create(role, email, passwordHash, fullName, companyName, registrationIp, deviceId) {
        return db.execute(
            "INSERT INTO users (role, full_name, company_name, email, password_hash, is_active, registration_ip, device_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
            [role, fullName || null, companyName || null, email, passwordHash, registrationIp || null, deviceId || null]
        );
    }
}

module.exports = User;
