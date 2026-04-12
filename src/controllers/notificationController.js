const NotificationService = require('../services/notificationService');

exports.getNotifications = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const role = req.session && req.session.user && req.session.user.role ? String(req.session.user.role) : 'all';
        const limitRaw = req.query && req.query.limit ? Number(req.query.limit) : 20;
        const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
        const notifications = await NotificationService.listForUser(userId, role, limit);
        return res.json(notifications);
    } catch (error) {
        return res.status(500).json({ error: 'Server Error' });
    }
};

exports.redirectNotificationsAll = (req, res) => {
    const roleRaw = req.session && req.session.user && req.session.user.role ? String(req.session.user.role) : '';
    const role = roleRaw.toLowerCase();
    const qs = req.originalUrl && req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    if (role === 'employer') {
        return res.redirect('/employer/notifications' + qs);
    }
    return res.redirect('/freelancer/notifications' + qs);
};

exports.getUnreadCount = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const role = req.session && req.session.user && req.session.user.role ? String(req.session.user.role) : 'all';
        const unread = await NotificationService.getUnreadCount(userId, role);
        return res.json({ unread: Number.isFinite(Number(unread)) ? Number(unread) : 0 });
    } catch (error) {
        return res.status(500).json({ error: 'Server Error' });
    }
};

exports.markAsRead = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { id } = req.body;
        const ok = await NotificationService.markAsRead(id, userId);
        if (!ok) {
            return res.status(500).json({ error: 'Failed to mark notification as read' });
        }
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Server Error' });
    }
};

exports.markAllAsRead = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await NotificationService.markAllAsRead(userId);
        if (!ok) {
            return res.status(500).json({ error: 'Failed to mark all notifications as read' });
        }
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Server Error' });
    }
};

exports.notificationsPage = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const role = req.session && req.session.user && req.session.user.role ? String(req.session.user.role) : 'all';

        let viewRole = role ? String(role).toLowerCase() : 'freelancer';
        if (viewRole === 'publisher') viewRole = 'freelancer';
        if (viewRole !== 'freelancer' && viewRole !== 'employer') viewRole = 'freelancer';

        const pageRaw = req.query && req.query.page ? Number(req.query.page) : 1;
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
        const perPage = 20;
        const offset = (page - 1) * perPage;

        const notifications = await NotificationService.listForUserPaged(userId, role, perPage, offset);

        return res.render(`${viewRole}/notifications-all`, {
            user: (req.session && req.session.user) ? req.session.user : null,
            notifications,
            basePath: viewRole === 'employer' ? '/employer/notifications' : '/freelancer/notifications',
            pagination: {
                page,
                perPage,
                hasNext: Array.isArray(notifications) && notifications.length === perPage,
                hasPrev: page > 1
            }
        });
    } catch (error) {
        return res.status(500).send('Server Error');
    }
};
