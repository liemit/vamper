const db = require('../config/db');

class Message {
    static async create({ sender_id, receiver_id, job_id, content, attachment_url, attachment_type }) {
        const [result] = await db.execute(
            `INSERT INTO messages (sender_id, receiver_id, job_id, content, attachment_url, attachment_type) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [sender_id, receiver_id, job_id || null, content || null, attachment_url || null, attachment_type || null]
        );
        return result.insertId;
    }

    static async delete(messageId, userId) {
        const safeId = Number(messageId);
        const safeUserId = Number(userId);

        if (!Number.isFinite(safeId) || safeId <= 0 || !Number.isFinite(safeUserId) || safeUserId <= 0) {
            return { ok: false, attachment_url: null };
        }

        const [rows] = await db.query(
            `SELECT id, attachment_url
             FROM messages
             WHERE id = ? AND (sender_id = ? OR receiver_id = ?)
             LIMIT 1`,
            [safeId, safeUserId, safeUserId]
        );

        if (!Array.isArray(rows) || rows.length === 0) {
            return { ok: false, attachment_url: null };
        }

        const attachmentUrl = rows[0].attachment_url || null;

        const [result] = await db.execute(
            `DELETE FROM messages WHERE id = ? AND (sender_id = ? OR receiver_id = ?)`,
            [safeId, safeUserId, safeUserId]
        );

        const affected = result && typeof result.affectedRows === 'number' ? result.affectedRows : 0;
        return { ok: affected > 0, attachment_url: attachmentUrl };
    }

    static async getConversation(userId1, userId2, jobId = null, limit = 50, offset = 0) {
        let sql = `
            SELECT m.*, 
                   s.full_name as sender_name, s.avatar_url as sender_avatar, s.company_name as sender_company,
                   r.full_name as receiver_name, r.avatar_url as receiver_avatar, r.company_name as receiver_company
            FROM messages m
            JOIN users s ON m.sender_id = s.id
            JOIN users r ON m.receiver_id = r.id
            WHERE ((m.sender_id = ? AND m.receiver_id = ?) 
               OR (m.sender_id = ? AND m.receiver_id = ?))
        `;
        
        const params = [userId1, userId2, userId2, userId1];

        if (jobId) {
            sql += ` AND m.job_id = ?`;
            params.push(jobId);
        }

        sql += ` ORDER BY m.created_at ASC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [rows] = await db.query(sql, params);
        return rows;
    }

    static async getConversationAfterId(userId1, userId2, afterId = 0, jobId = null, limit = 200) {
        let sql = `
            SELECT m.*, 
                   s.full_name as sender_name, s.avatar_url as sender_avatar, s.company_name as sender_company,
                   r.full_name as receiver_name, r.avatar_url as receiver_avatar, r.company_name as receiver_company
            FROM messages m
            JOIN users s ON m.sender_id = s.id
            JOIN users r ON m.receiver_id = r.id
            WHERE ((m.sender_id = ? AND m.receiver_id = ?) 
               OR (m.sender_id = ? AND m.receiver_id = ?))
              AND m.id > ?
        `;

        const safeAfter = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
        const params = [userId1, userId2, userId2, userId1, safeAfter];

        if (jobId) {
            sql += ` AND m.job_id = ?`;
            params.push(jobId);
        }

        sql += ` ORDER BY m.created_at ASC LIMIT ?`;
        params.push(limit);

        const [rows] = await db.query(sql, params);
        return rows;
    }

    static async getLastMessageIds(userId1, userId2, jobId = null, limit = 200) {
        let sql = `
            SELECT m.id
            FROM messages m
            WHERE ((m.sender_id = ? AND m.receiver_id = ?) 
               OR (m.sender_id = ? AND m.receiver_id = ?))
        `;

        const params = [userId1, userId2, userId2, userId1];

        if (jobId) {
            sql += ` AND m.job_id = ?`;
            params.push(jobId);
        }

        sql += ` ORDER BY m.id DESC LIMIT ?`;
        params.push(limit);

        const [rows] = await db.query(sql, params);
        return Array.isArray(rows) ? rows.map((r) => r.id) : [];
    }

    static async getThreads(userId) {
        // This is a complex query to get the latest message for each conversation
        // Simplified version: grouped by the other party
        const sql = `
            SELECT 
                CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END as other_user_id,
                MAX(m.id) as last_message_id
            FROM messages m
            WHERE m.sender_id = ? OR m.receiver_id = ?
            GROUP BY other_user_id
            ORDER BY last_message_id DESC
        `;
        
        const [rows] = await db.query(sql, [userId, userId, userId]);
        
        if (!rows.length) return [];

        // Fetch details for these messages
        const ids = rows.map(r => r.last_message_id).join(',');
        const [details] = await db.query(`
            SELECT m.*, 
                   u.full_name as other_name, u.avatar_url as other_avatar, u.company_name as other_company, u.role as other_role,
                   j.title as job_title, j.slug as job_slug
            FROM messages m
            JOIN users u ON u.id = (CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END)
            LEFT JOIN jobs j ON m.job_id = j.id
            WHERE m.id IN (${ids})
            ORDER BY m.created_at DESC
        `, [userId]);

        return details;
    }

    static async markAsRead(sender_id, receiver_id, job_id = null) {
        let sql = `UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`;
        const params = [sender_id, receiver_id];
        
        if (jobId) {
            sql += ` AND job_id = ?`;
            params.push(jobId);
        }
        
        return db.execute(sql, params);
    }
}

module.exports = Message;
