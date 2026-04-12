const db = require('../config/db');

class NotificationService {
    static async createPersonal(recipientId, title, body, type = 'info', url = '#', severity = 'info', actorId = null) {
        try {
            const [ins] = await db.query(
                `INSERT INTO notifications (type, title, body, url, severity, actor_id, is_broadcast, audience_role)
                 VALUES (?, ?, ?, ?, ?, ?, 0, 'all')`,
                [type, title, body, url, severity, actorId]
            );

            const notificationId = ins && ins.insertId ? Number(ins.insertId) : null;
            if (!notificationId) return false;

            await db.query(
                `INSERT INTO notification_recipients (notification_id, user_id)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE user_id = user_id`,
                [notificationId, recipientId]
            );

            return true;
        } catch (error) {
            console.error('Notification Create Error:', error);
            return false;
        }
    }

    static async listForUserPaged(userId, role = 'all', limit = 20, offset = 0) {
        try {
            const safeLimit = (Number.isFinite(Number(limit)) && Number(limit) > 0)
                ? Math.min(50, Math.floor(Number(limit)))
                : 20;
            const safeOffset = (Number.isFinite(Number(offset)) && Number(offset) >= 0)
                ? Math.floor(Number(offset))
                : 0;

            const audienceRole = role && role !== 'publisher' ? String(role).toLowerCase() : 'freelancer';

            const [rows] = await db.query(
                `SELECT x.id, x.type, x.title, x.body, x.url, x.severity, x.created_at, x.is_read
                 FROM (
                     SELECT n.id, n.type, n.title, n.body, n.url, n.severity, n.created_at,
                            (nr.read_at IS NOT NULL) AS is_read
                     FROM notification_recipients nr
                     INNER JOIN notifications n ON n.id = nr.notification_id
                     WHERE nr.user_id = ?

                     UNION ALL

                     SELECT n.id, n.type, n.title, n.body, n.url, n.severity, n.created_at,
                            (n.created_at <= COALESCE(uns.broadcast_read_at, '1970-01-01 00:00:00')) AS is_read
                     FROM notifications n
                     LEFT JOIN user_notification_state uns ON uns.user_id = ?
                     WHERE n.is_broadcast = 1
                       AND (n.audience_role = 'all' OR n.audience_role = ?)
                       AND (n.expires_at IS NULL OR n.expires_at > NOW())
                 ) x
                 ORDER BY x.created_at DESC
                 LIMIT ? OFFSET ?`,
                [userId, userId, audienceRole, safeLimit, safeOffset]
            );

            return (Array.isArray(rows) ? rows : []).map((n) => ({
                id: n.id,
                type: n.type,
                title: n.title,
                body: n.body,
                url: n.url,
                severity: n.severity,
                created_at: n.created_at,
                is_read: !!n.is_read
            }));
        } catch (error) {
            console.error('Notification List Paged Error:', error);
            return [];
        }
    }

    static async getUnreadCount(userId, role = 'all') {
        try {
            const [personalRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM notification_recipients nr
                 INNER JOIN notifications n ON n.id = nr.notification_id
                 WHERE nr.user_id = ?
                   AND nr.read_at IS NULL
                   AND (n.expires_at IS NULL OR n.expires_at > NOW())`,
                [userId]
            );
            const personalUnread = (Array.isArray(personalRows) && personalRows.length)
                ? Number(personalRows[0].c || 0)
                : 0;

            const [stateRows] = await db.query(
                `SELECT broadcast_read_at
                 FROM user_notification_state
                 WHERE user_id = ?
                 LIMIT 1`,
                [userId]
            );
            const broadcastReadAt = (Array.isArray(stateRows) && stateRows.length && stateRows[0].broadcast_read_at)
                ? new Date(stateRows[0].broadcast_read_at)
                : new Date('1970-01-01T00:00:00Z');

            const audienceRole = role && role !== 'publisher' ? String(role).toLowerCase() : 'freelancer';

            const [broadcastRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM notifications n
                 WHERE n.is_broadcast = 1
                   AND (n.audience_role = 'all' OR n.audience_role = ?)
                   AND (n.expires_at IS NULL OR n.expires_at > NOW())
                   AND n.created_at > ?`,
                [audienceRole, broadcastReadAt]
            );
            const broadcastUnread = (Array.isArray(broadcastRows) && broadcastRows.length)
                ? Number(broadcastRows[0].c || 0)
                : 0;

            return (Number.isFinite(personalUnread) ? personalUnread : 0) + (Number.isFinite(broadcastUnread) ? broadcastUnread : 0);
        } catch (error) {
            console.error('Notification Unread Count Error:', error);
            return 0;
        }
    }

    static async listForUser(userId, role = 'all', limit = 20) {
        try {
            const safeLimit = (Number.isFinite(Number(limit)) && Number(limit) > 0) ? Math.min(50, Math.floor(Number(limit))) : 20;
            const audienceRole = role && role !== 'publisher' ? String(role).toLowerCase() : 'freelancer';

            const [stateRows] = await db.query(
                `SELECT broadcast_read_at
                 FROM user_notification_state
                 WHERE user_id = ?
                 LIMIT 1`,
                [userId]
            );
            const broadcastReadAtRaw = (Array.isArray(stateRows) && stateRows.length) ? stateRows[0].broadcast_read_at : null;
            const broadcastReadAt = broadcastReadAtRaw ? new Date(broadcastReadAtRaw) : new Date('1970-01-01T00:00:00Z');

            const [personalRows] = await db.query(
                `SELECT n.id, n.type, n.title, n.body, n.url, n.severity, n.created_at,
                        (nr.read_at IS NOT NULL) AS is_read
                 FROM notification_recipients nr
                 INNER JOIN notifications n ON n.id = nr.notification_id
                 WHERE nr.user_id = ?
                 ORDER BY n.created_at DESC
                 LIMIT ?`,
                [userId, safeLimit]
            );

            const [broadcastRows] = await db.query(
                `SELECT n.id, n.type, n.title, n.body, n.url, n.severity, n.created_at,
                        (n.created_at <= ?) AS is_read
                 FROM notifications n
                 WHERE n.is_broadcast = 1
                   AND (n.audience_role = 'all' OR n.audience_role = ?)
                   AND (n.expires_at IS NULL OR n.expires_at > NOW())
                 ORDER BY n.created_at DESC
                 LIMIT ?`,
                [broadcastReadAt, audienceRole, safeLimit]
            );

            const items = [...(Array.isArray(personalRows) ? personalRows : []), ...(Array.isArray(broadcastRows) ? broadcastRows : [])]
                .map((n) => ({
                    id: n.id,
                    type: n.type,
                    title: n.title,
                    body: n.body,
                    url: n.url,
                    severity: n.severity,
                    created_at: n.created_at,
                    is_read: !!n.is_read
                }))
                .sort((a, b) => {
                    const da = a && a.created_at ? new Date(a.created_at).getTime() : 0;
                    const dbt = b && b.created_at ? new Date(b.created_at).getTime() : 0;
                    return dbt - da;
                })
                .slice(0, safeLimit);

            return items;
        } catch (error) {
            console.error('Notification List Error:', error);
            return [];
        }
    }

    static async markAsRead(notificationId, userId) {
        try {
            await db.query(
                `UPDATE notification_recipients
                 SET read_at = COALESCE(read_at, NOW())
                 WHERE notification_id = ? AND user_id = ?`,
                [notificationId, userId]
            );
            return true;
        } catch (error) {
            console.error('Notification Mark Read Error:', error);
            return false;
        }
    }

    static async markAllAsRead(userId) {
        try {
            await db.query(
                `UPDATE notification_recipients
                 SET read_at = NOW()
                 WHERE user_id = ? AND read_at IS NULL`,
                [userId]
            );

            await db.query(
                `INSERT INTO user_notification_state (user_id, broadcast_read_at)
                 VALUES (?, NOW())
                 ON DUPLICATE KEY UPDATE broadcast_read_at = NOW()`,
                [userId]
            );

            return true;
        } catch (error) {
            console.error('Notification Mark All Read Error:', error);
            return false;
        }
    }
}

module.exports = NotificationService;
