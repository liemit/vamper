const express = require('express');
const router = express.Router();

const db = require('../config/db');

const authRoutes = require('./authRoutes');
const adminRoutes = require('./adminRoutes');
const employerRoutes = require('./employerRoutes');
const freelancerRoutes = require('./freelancerRoutes');
const authMiddleware = require('../middlewares/authMiddleware');
const freelancerController = require('../controllers/freelancerController');
const paymentController = require('../controllers/paymentController');
const notificationController = require('../controllers/notificationController');
const { getActiveRulesForPage, maskJobFields } = require('../utils/contentFilter');

router.use('/', authRoutes);
router.use('/admin', adminRoutes);
router.use('/employer', employerRoutes);
router.use('/freelancer', freelancerRoutes);

// Public Payment Routes (IPN/Callback)
router.post('/payment/zalopay/callback', paymentController.zaloPayCallback);
router.get('/payment/zalopay/redirect', paymentController.zaloPayRedirect);
router.get('/payment/paypal/return', paymentController.paypalReturn);
router.get('/payment/paypal/cancel', paymentController.paypalCancel);

// Notification Routes
router.get('/notifications', authMiddleware.isAuthenticated, notificationController.getNotifications);
router.get('/notifications/all', authMiddleware.isAuthenticated, notificationController.redirectNotificationsAll);
router.get('/notifications/unread-count', authMiddleware.isAuthenticated, notificationController.getUnreadCount);
router.post('/notifications/read', authMiddleware.isAuthenticated, notificationController.markAsRead);
router.post('/notifications/read-all', authMiddleware.isAuthenticated, notificationController.markAllAsRead);

// Role-specific notifications pages
router.get('/freelancer/notifications', authMiddleware.isAuthenticated, authMiddleware.restrictTo('freelancer'), notificationController.notificationsPage);
router.get('/employer/notifications', authMiddleware.isAuthenticated, authMiddleware.restrictTo('employer'), notificationController.notificationsPage);

router.post('/freelancer/proposals/apply', authMiddleware.isAuthenticated, authMiddleware.restrictTo('freelancer'), freelancerController.applyToJob);
router.get('/freelancer/proposals', authMiddleware.isAuthenticated, authMiddleware.restrictTo('freelancer'), freelancerController.myProposals);
router.post('/freelancer/proposals/:id/withdraw', authMiddleware.isAuthenticated, authMiddleware.restrictTo('freelancer'), freelancerController.withdrawProposal);
router.all('/freelancer/proposals/:id/delete', authMiddleware.isAuthenticated, authMiddleware.restrictTo('freelancer'), freelancerController.deleteProposal);

router.get('/how-it-works', (req, res) => {
    return res.render('how-it-works', {
        user: (req.session && req.session.user) ? req.session.user : null
    });
});

router.get('/policy', (req, res) => {
    return res.render('policy', {
        user: (req.session && req.session.user) ? req.session.user : null
    });
});

router.get('/contact', (req, res) => {
    return res.render('contact', {
        user: (req.session && req.session.user) ? req.session.user : null
    });
});

router.post('/contact', async (req, res) => {
    const fullNameRaw = req.body && req.body.full_name ? String(req.body.full_name) : '';
    const emailRaw = req.body && req.body.email ? String(req.body.email) : '';
    const subjectRaw = req.body && req.body.subject ? String(req.body.subject) : '';
    const messageRaw = req.body && req.body.message ? String(req.body.message) : '';

    const full_name = fullNameRaw.trim().slice(0, 120);
    const email = emailRaw.trim().slice(0, 190);
    const subject = subjectRaw.trim().slice(0, 255);
    const message = messageRaw.trim();

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!email || !emailOk) {
        req.flash('error_msg', 'Invalid email.');
        return res.redirect('/contact');
    }

    if (!message || message.length < 5) {
        req.flash('error_msg', 'Message is required.');
        return res.redirect('/contact');
    }

    try {
        const userId = (req.session && req.session.user && req.session.user.id) ? Number(req.session.user.id) : null;
        const ipAddress = req.ip ? String(req.ip).slice(0, 45) : null;
        const userAgent = req.get('user-agent') ? String(req.get('user-agent')).slice(0, 255) : null;

        await db.execute(
            `INSERT INTO contact_messages (user_id, full_name, email, subject, message, status, ip_address, user_agent)
             VALUES (?, ?, ?, ?, ?, 'new', ?, ?)` ,
            [
                Number.isFinite(userId) ? userId : null,
                full_name || null,
                email,
                subject || null,
                message,
                ipAddress,
                userAgent
            ]
        );

        req.flash('success_msg', 'Your message has been sent successfully.');
        return res.redirect('/contact');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to send message. Please try again later.');
        return res.redirect('/contact');
    }
});

router.get('/jobs', async (req, res) => {
    const role = (req.session && req.session.user && req.session.user.role) ? String(req.session.user.role).toLowerCase() : '';
    if (role === 'freelancer' || role === 'publisher') {
        const qs = new URLSearchParams(req.query || {}).toString();
        const suffix = qs ? ('?' + qs) : '';
        return res.redirect('/freelancer/jobs' + suffix);
    }

    const perPage = 10;
    const rawPage = Number(req.query && req.query.page ? req.query.page : 1);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

    const qRaw = (req.query && req.query.q) ? String(req.query.q).trim() : '';
    const q = qRaw.length ? qRaw : '';
    const categorySlugRaw = (req.query && req.query.category) ? String(req.query.category).trim() : '';
    const categorySlug = categorySlugRaw.length ? categorySlugRaw : '';

    try {
        const [categoryRows] = await db.query('SELECT id, name, slug FROM categories ORDER BY id ASC');
        const categories = Array.isArray(categoryRows) ? categoryRows : [];

        let categoryId = null;
        if (categorySlug) {
            const [catRows] = await db.query('SELECT id FROM categories WHERE slug = ? LIMIT 1', [categorySlug]);
            if (Array.isArray(catRows) && catRows.length) {
                categoryId = Number(catRows[0].id);
            }
        }

        const where = [];
        const params = [];

        if (q) {
            where.push('(j.title LIKE ? OR u.company_name LIKE ?)');
            params.push('%' + q + '%', '%' + q + '%');
        }

        if (categoryId) {
            where.push('j.category_id = ?');
            params.push(categoryId);
        }

        const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             ${whereSql}`,
            params
        );

        const total = (Array.isArray(countRows) && countRows[0] && countRows[0].total !== undefined)
            ? Number(countRows[0].total)
            : 0;
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * perPage;

        const [rows] = await db.query(
            `SELECT j.id, j.title, j.slug, j.thumbnail_url, j.budget, j.job_type, j.status, j.created_at,
                    u.company_name,
                    (SELECT COALESCE(SUM(view_count), 0) FROM job_views WHERE job_id = j.id) AS total_views
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             ${whereSql}
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        return res.render('jobs-guest', {
            user: (req.session && req.session.user) ? req.session.user : null,
            query: req.query,
            basePath: '/jobs',
            categories,
            jobs: Array.isArray(rows) ? rows : [],
            banners: await db.query("SELECT * FROM banners WHERE is_active = 1 ORDER BY position, sort_order ASC").then(([r]) => r).catch(() => []),
            pagination: {
                page: safePage,
                perPage,
                total,
                totalPages
            }
        });
    } catch (err) {
        console.error(err);
        return res.render('jobs-guest', {
            user: (req.session && req.session.user) ? req.session.user : null,
            query: req.query,
            basePath: '/jobs',
            categories: [],
            jobs: [],
            pagination: { page: 1, perPage, total: 0, totalPages: 1 }
        });
    }
});

router.get('/jobs/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) {
        return res.status(404).send('Not Found');
    }

    const role = (req.session && req.session.user && req.session.user.role) ? String(req.session.user.role).toLowerCase() : '';
    if (role === 'freelancer' || role === 'publisher') {
        return res.redirect(`/freelancer/jobs/${encodeURIComponent(slug)}`);
    } else if (role === 'employer') {
        // Just render the job detail for employer, they shouldn't be redirected to freelancer
        // Continue to the normal flow below
    }

    try {
        const [rows] = await db.query(
            `SELECT j.id, j.title, j.slug, j.description, j.thumbnail_url, j.budget, j.job_type, j.status,
                    j.deadline, j.created_at,
                    u.id AS employer_id, u.company_name,
                    ep.website, ep.description AS company_description, ep.logo_url, ep.address, ep.city, ep.tax_code,
                    c.name AS category_name,
                    (SELECT COALESCE(SUM(view_count), 0) FROM job_views WHERE job_id = j.id) AS total_views
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             LEFT JOIN employer_profiles ep ON ep.user_id = j.employer_id
             LEFT JOIN categories c ON c.id = j.category_id
             WHERE j.slug = ?
             LIMIT 1`,
            [slug]
        );

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(404).send('Job not found');
        }

        const job = rows[0];

        // Record job view
        try {
            const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
            await db.query(
                `INSERT INTO job_views (job_id, view_date, view_count) 
                 VALUES (?, ?, 1) 
                 ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
                [job.id, today]
            );
        } catch (viewErr) {
            console.error('Error recording job view:', viewErr);
            // Non-blocking error, just log it
        }

        const rules = await getActiveRulesForPage('jobs_guest_detail');
        const maskedJob = maskJobFields(job, rules);

        let banners = [];
        try { const [br] = await db.query("SELECT * FROM banners WHERE is_active = 1 ORDER BY position, sort_order ASC"); banners = br; } catch(_) {}

        return res.render('job-detail', { job: maskedJob, banners });
    } catch (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
    }
});

router.get('/', async (req, res) => {
    // If logged in, redirect to dashboard?
    if (req.session && req.session.user) {
        return res.redirect(`/${req.session.user.role}`);
    }

    const perPage = 10;
    const rawPage = Number(req.query && req.query.page ? req.query.page : 1);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const offset = (page - 1) * perPage;

    try {
        const [categoryRows] = await db.query('SELECT id, name, slug FROM categories ORDER BY id ASC');
        const categories = Array.isArray(categoryRows) ? categoryRows : [];

        const [countRows] = await db.query('SELECT COUNT(*) AS total FROM jobs');
        const total = (Array.isArray(countRows) && countRows[0] && countRows[0].total !== undefined) ? Number(countRows[0].total) : 0;
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        const safePage = Math.min(page, totalPages);
        const safeOffset = (safePage - 1) * perPage;

        const [rows] = await db.query(
            `SELECT j.id, j.title, j.slug, j.thumbnail_url, j.budget, j.job_type, j.status, j.created_at,
                    u.company_name,
                    (SELECT COALESCE(SUM(view_count), 0) FROM job_views WHERE job_id = j.id) AS total_views
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`,
            [perPage, safeOffset]
        );

        let banners = [];
        try {
            const [bannerRows] = await db.query(
                "SELECT * FROM banners WHERE is_active = 1 ORDER BY position, sort_order ASC"
            );
            banners = Array.isArray(bannerRows) ? bannerRows : [];
        } catch (_) {}

        return res.render('index', {
            user: null,
            query: req.query,
            basePath: '/',
            categories,
            jobs: Array.isArray(rows) ? rows : [],
            banners,
            pagination: {
                page: safePage,
                perPage,
                total,
                totalPages
            }
        });
    } catch (err) {
        console.error(err);
        return res.render('index', { user: null, query: req.query, basePath: '/', categories: [], jobs: [], pagination: { page: 1, perPage, total: 0, totalPages: 1 } });
    }
});

router.get('/categories/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) {
        return res.status(404).send('Not Found');
    }

    const perPage = 10;
    const rawPage = Number(req.query && req.query.page ? req.query.page : 1);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const offset = (page - 1) * perPage;

    try {
        const [categoryRows] = await db.query('SELECT id, name, slug FROM categories WHERE slug = ? LIMIT 1', [slug]);
        const category = Array.isArray(categoryRows) && categoryRows.length ? categoryRows[0] : null;
        if (!category) {
            return res.status(404).send('Category not found');
        }

        const [countRows] = await db.query('SELECT COUNT(*) AS total FROM jobs WHERE category_id = ?', [category.id]);
        const total = (Array.isArray(countRows) && countRows[0] && countRows[0].total !== undefined) ? Number(countRows[0].total) : 0;
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        const safePage = Math.min(page, totalPages);
        const safeOffset = (safePage - 1) * perPage;

        const [rows] = await db.query(
            `SELECT j.id, j.title, j.slug, j.thumbnail_url, j.budget, j.job_type, j.status, j.created_at,
                    u.company_name,
                    (SELECT COALESCE(SUM(view_count), 0) FROM job_views WHERE job_id = j.id) AS total_views
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             WHERE j.category_id = ?
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`,
            [category.id, perPage, safeOffset]
        );

        return res.render('category-jobs', {
            category,
            jobs: Array.isArray(rows) ? rows : [],
            pagination: {
                page: safePage,
                perPage,
                total,
                totalPages
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
