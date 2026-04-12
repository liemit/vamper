const db = require('../config/db');
const bcrypt = require('bcryptjs');
const Message = require('../models/messageModel');
const fs = require('fs');
const path = require('path');
const NotificationService = require('../services/notificationService');



exports.index = async (req, res) => {

    const perPage = 10;

    const rawPage = Number(req.query && req.query.page ? req.query.page : 1);

    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;



    try {

        const [categoryRows] = await db.query('SELECT id, name, slug FROM categories ORDER BY id ASC');

        const categories = Array.isArray(categoryRows) ? categoryRows : [];



        const [countRows] = await db.query('SELECT COUNT(*) AS total FROM jobs');

        const total = (Array.isArray(countRows) && countRows[0] && countRows[0].total !== undefined)

            ? Number(countRows[0].total)

            : 0;

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



        return res.render("freelancer/home", {

            user: req.session.user,

            query: req.query,

            basePath: '/freelancer',

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

        return res.render("freelancer/home", {

            user: req.session.user,

            query: req.query,

            basePath: '/freelancer',

            categories: [],

            jobs: [],

            pagination: { page: 1, perPage, total: 0, totalPages: 1 }

        });

    }

};



exports.listPlans = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT p.id, p.code, p.name, p.price_monthly, p.price_yearly, p.currency, pl.kind, pl.max_file_mb, pl.monthly_quota_mb
             FROM plans p
             LEFT JOIN plan_limits pl ON pl.plan_id = p.id AND pl.is_active = 1
             WHERE p.is_active = 1
             ORDER BY p.id ASC`
        );
        let activeCode = null;
        try {
            const [arows] = await db.query(
                `SELECT p.code 
                 FROM user_plans up 
                 JOIN plans p ON p.id = up.plan_id 
                 WHERE up.user_id = ? AND up.status = 'active' 
                 LIMIT 1`,
                [req.session.user.id]
            );
            activeCode = (Array.isArray(arows) && arows.length) ? arows[0].code : null;
        } catch (_) {}
        return res.json({ ok: true, items: Array.isArray(rows) ? rows : [], active_plan_code: activeCode });
    } catch (e) {
        return res.status(500).json({ ok: false, items: [] });
    }
};



exports.activatePlan = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const codeRaw = req.body && req.body.plan_code ? String(req.body.plan_code).trim() : '';
        if (!codeRaw) return res.status(400).json({ ok: false, error: 'Invalid plan' });
        const [prow] = await db.query(
            `SELECT id, price_monthly, currency FROM plans WHERE code = ? AND is_active = 1 LIMIT 1`,
            [codeRaw]
        );
        const plan = Array.isArray(prow) && prow.length ? prow[0] : null;
        if (!plan) return res.status(404).json({ ok: false, error: 'Plan not found' });
        const price = Number(plan.price_monthly || 0);
        if (price > 0) {
            const [upd] = await db.execute(
                `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
                [price, userId, price]
            );
            if (!upd || !upd.affectedRows) {
                return res.status(400).json({ ok: false, error: 'Insufficient balance' });
            }
            await db.execute(
                `INSERT INTO transactions (user_id, amount, type, status, description, related_contract_id)
                 VALUES (?, ?, 'service_fee', 'completed', ?, NULL)`,
                [userId, price, `Plan activation: ${codeRaw}`]
            );
        }
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const next = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
        const end = new Date(next.getTime() - 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const endStr = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())} ${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
        await db.query(
            `UPDATE user_plans SET status = 'canceled' WHERE user_id = ? AND status = 'active'`,
            [userId]
        );
        await db.query(
            `INSERT INTO user_plans (user_id, plan_id, status, start_utc, end_utc, auto_renew)
             VALUES (?, ?, 'active', UTC_TIMESTAMP(), ?, 1)`,
            [userId, plan.id, endStr]
        );
        let newBalance = null;
        try {
            const [b] = await db.query(`SELECT balance FROM users WHERE id = ? LIMIT 1`, [userId]);
            newBalance = (Array.isArray(b) && b.length) ? Number(b[0].balance || 0) : null;
        } catch(_) {}
        return res.json({ ok: true, charged: price, currency: plan.currency || 'USD', new_balance: newBalance });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.deleteMessage = async (req, res) => {

    try {

        const userId = req.session.user.id;
        const msgId = req.params.id;

        if (!msgId) {
            return res.status(400).json({ ok: false, error: 'Invalid message ID' });
        }

        const result = await Message.delete(msgId, userId);
        if (result && result.ok) {

            try {
                const url = result.attachment_url ? String(result.attachment_url) : '';
                if (url && url.startsWith('/img/')) {
                    const filename = path.basename(url);
                    const p = path.join(__dirname, '../public/img', filename);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                }
            } catch (_) {}

            return res.json({ ok: true });
        }

        return res.status(403).json({ ok: false, error: 'Message not found or unauthorized' });

    } catch (error) {

        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });

    }

};



exports.pollMessages = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const toRaw = req.query && req.query.to ? String(req.query.to).trim() : '';

        const toId = toRaw ? Number(toRaw) : NaN;

        const jobRaw = req.query && req.query.job ? String(req.query.job).trim() : '';

        const jobId = jobRaw ? Number(jobRaw) : NaN;

        const afterRaw = req.query && req.query.afterId ? String(req.query.afterId).trim() : '0';

        const afterId = afterRaw ? Number(afterRaw) : 0;

        if (!Number.isFinite(toId) || toId <= 0) {

            return res.json({ ok: true, messages: [], ids: [] });

        }

        let messages = await Message.getConversationAfterId(

            userId,

            toId,

            Number.isFinite(afterId) ? afterId : 0,

            (Number.isFinite(jobId) && jobId > 0) ? jobId : null,

            200

        );

        if (!Array.isArray(messages)) messages = [];

        const ids = await Message.getLastMessageIds(
            userId,
            toId,
            (Number.isFinite(jobId) && jobId > 0) ? jobId : null,
            200
        );

        // Fetch Timer Status if Job ID is present
        let timerStatus = null;
        if (Number.isFinite(jobId) && jobId > 0) {
            const [propRows] = await db.query(
                `SELECT timer_status, timer_start_time, total_seconds_worked, paid_seconds, pending_balance,
                        TIMESTAMPDIFF(SECOND, timer_start_time, NOW()) AS elapsed_db
                 FROM proposals 
                 WHERE job_id = ? AND freelancer_id = ? 
                 LIMIT 1`,
                [jobId, userId]
            );
            if (propRows.length > 0) {
                const p = propRows[0];
                const currentTotal = Number(p.total_seconds_worked || 0);

                let clientStartTime = p.timer_start_time;
                if (p.timer_status === 'running' && p.elapsed_db !== null) {
                    clientStartTime = new Date(Date.now() - (p.elapsed_db * 1000)).toISOString();
                }

                timerStatus = {
                    status: p.timer_status,
                    start_time: clientStartTime,
                    total_seconds: currentTotal,
                    paid_seconds: Number(p.paid_seconds || 0),
                    pending_balance: Number(p.pending_balance || 0)
                };
            }
        }

        // Fetch Current Balance
        let currentBalance = 0;
        try {
            const [uRows] = await db.query('SELECT balance FROM users WHERE id = ? LIMIT 1', [userId]);
            currentBalance = (Array.isArray(uRows) && uRows.length) ? Number(uRows[0].balance) : 0;
        } catch (_) {}

        return res.json({ ok: true, messages, ids: Array.isArray(ids) ? ids : [], timer: timerStatus, balance: currentBalance });
    } catch (error) {

        console.error(error);

        return res.status(500).json({ ok: false, messages: [], ids: [] });

    }

};



exports.uploadAttachment = async (req, res) => {

    try {

        if (!req.file) {

            return res.status(400).json({ ok: false, error: 'No file uploaded' });

        }

        const uploaderId = req.session.user.id;

        // Check deposit requirement
        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;

        if (Number.isFinite(toId) && toId > 0 && Number.isFinite(jobId) && jobId > 0) {
            const [propRows] = await db.query(
                `SELECT is_deposited FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 ORDER BY (status = 'accepted') DESC, id DESC
                 LIMIT 1`,
                [jobId, req.session.user.id]
            );
            const deposited = (Array.isArray(propRows) && propRows.length)
                ? Number(propRows[0].is_deposited || 0)
                : 0;
            if (!(deposited > 0)) {
                try {
                    const p = path.join(__dirname, '../public/img', req.file.filename);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                } catch (_) {}
                return res.status(403).json({ ok: false, error: 'Deposit required to upload files' });
            }
        }

        const attachmentUrl = '/img/' + req.file.filename;
        const isImage = req.file.mimetype && req.file.mimetype.startsWith('image/');
        const isVideo = req.file.mimetype && req.file.mimetype.startsWith('video/');
        const attachmentType = isImage ? 'image' : (isVideo ? 'video' : 'file');

        const now = new Date();
        const pk = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const size = Number(req.file.size || 0);

        let planId = null;
        try {
            const [up] = await db.query(
                `SELECT plan_id
                 FROM user_plans
                 WHERE user_id = ? AND status = 'active'
                 ORDER BY start_utc DESC
                 LIMIT 1`,
                [uploaderId]
            );
            planId = (Array.isArray(up) && up.length) ? Number(up[0].plan_id) : null;
        } catch (_) {}
        if (!Number.isFinite(planId) || planId <= 0) {
            try {
                const [bp] = await db.query(`SELECT id FROM plans WHERE code = 'basic' AND is_active = 1 LIMIT 1`);
                planId = (Array.isArray(bp) && bp.length) ? Number(bp[0].id) : null;
            } catch (_) {}
        }

        let maxFileBytes = null;
        let monthlyQuotaBytes = null;
        if (Number.isFinite(planId) && planId > 0) {
            try {
                const [lr] = await db.query(
                    `SELECT max_file_mb, monthly_quota_mb
                     FROM plan_limits
                     WHERE plan_id = ? AND kind = ? AND is_active = 1
                     LIMIT 1`,
                    [planId, attachmentType]
                );
                const lim = (Array.isArray(lr) && lr.length) ? lr[0] : null;
                if (lim) {
                    const mf = Number(lim.max_file_mb);
                    const mq = Number(lim.monthly_quota_mb);
                    if (Number.isFinite(mf) && mf > 0) maxFileBytes = mf * 1024 * 1024;
                    if (Number.isFinite(mq) && mq > 0) monthlyQuotaBytes = mq * 1024 * 1024;
                }
            } catch (_) {}
        }

        if (maxFileBytes !== null && Number.isFinite(size) && size > maxFileBytes) {
            try {
                const p = path.join(__dirname, '../public/img', req.file.filename);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (_) {}
            return res.status(400).json({ ok: false, error: 'File too large for your plan' });
        }

        if (monthlyQuotaBytes !== null && Number.isFinite(size) && size > 0) {
            try {
                const [urows] = await db.query(
                    `SELECT image_bytes, video_bytes, file_bytes
                     FROM upload_usage
                     WHERE user_id = ? AND period_key = ?
                     LIMIT 1`,
                    [uploaderId, pk]
                );
                const usage = (Array.isArray(urows) && urows.length) ? urows[0] : null;
                const cur = usage
                    ? Number((attachmentType === 'image') ? usage.image_bytes : ((attachmentType === 'video') ? usage.video_bytes : usage.file_bytes))
                    : 0;
                const curSafe = Number.isFinite(cur) && cur > 0 ? cur : 0;
                if ((curSafe + size) > monthlyQuotaBytes) {
                    try {
                        const p = path.join(__dirname, '../public/img', req.file.filename);
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    } catch (_) {}
                    return res.status(400).json({ ok: false, error: 'Monthly quota exceeded' });
                }
            } catch (_) {}
        }

        try {
            if (Number.isFinite(size) && size > 0) {
                const col = (attachmentType === 'image') ? 'image_bytes' : ((attachmentType === 'video') ? 'video_bytes' : 'file_bytes');
                await db.query(
                    `INSERT INTO upload_usage (user_id, period_key, image_bytes, video_bytes, file_bytes)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE ${col} = ${col} + VALUES(${col})`,
                    [
                        uploaderId,
                        pk,
                        attachmentType === 'image' ? size : 0,
                        attachmentType === 'video' ? size : 0,
                        attachmentType === 'file' ? size : 0
                    ]
                );
            }
        } catch (_) {}

        return res.json({ ok: true, url: attachmentUrl, type: attachmentType, original_name: req.file.originalname });

    } catch (error) {

        console.error(error);

        return res.status(500).json({ ok: false, error: 'Server Error' });

    }

};



exports.sendMessage = async (req, res) => {

    try {

        const senderId = req.session.user.id;

        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';

        const toId = toRaw ? Number(toRaw) : NaN;

        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';

        const jobId = jobRaw ? Number(jobRaw) : NaN;

        const contentRaw = (req.body && req.body.content !== undefined && req.body.content !== null) ? String(req.body.content) : '';

        const content = contentRaw.trim();



        if (!Number.isFinite(toId) || toId <= 0) {

            req.flash('error_msg', 'Invalid recipient');

            return res.redirect('/freelancer/messages');

        }



        const [toRows] = await db.query(

            `SELECT id FROM users WHERE id = ? AND role = 'employer' LIMIT 1`,

            [toId]

        );

        if (!Array.isArray(toRows) || toRows.length === 0) {

            req.flash('error_msg', 'Recipient not found');

            return res.redirect('/freelancer/messages');

        }



        let attachmentUrl = req.file ? ('/img/' + req.file.filename) : null;

        let attachmentType = req.file

            ? ((req.file.mimetype && req.file.mimetype.startsWith('image/'))

                ? 'image'

                : ((req.file.mimetype && req.file.mimetype.startsWith('video/')) ? 'video' : 'file'))

            : null;

        if (!attachmentUrl && req.body && req.body.attachmentUrl) {

            attachmentUrl = String(req.body.attachmentUrl).trim();

            attachmentType = req.body.attachmentType ? String(req.body.attachmentType).trim() : 'file';

        }

        // Deposit gating for attachments (before deposit: only text + emoji)
        if (attachmentUrl) {

            if (!Number.isFinite(jobId) || jobId <= 0) {

                try {

                    if (req.file) {

                        const p = path.join(__dirname, '../public/img', req.file.filename);

                        if (fs.existsSync(p)) fs.unlinkSync(p);

                    }

                } catch (_) {}

                req.flash('error_msg', 'Employer must deposit to unlock file uploads');

                return res.redirect(`/freelancer/messages?to=${toId}`);

            }

            const [propRows] = await db.query(
                `SELECT is_deposited FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 ORDER BY (status = 'accepted') DESC, id DESC
                 LIMIT 1`,
                [jobId, senderId]
            );

            const deposited = (Array.isArray(propRows) && propRows.length)

                ? Number(propRows[0].is_deposited || 0)

                : 0;

            if (!(deposited > 0)) {

                try {

                    if (req.file) {

                        const p = path.join(__dirname, '../public/img', req.file.filename);

                        if (fs.existsSync(p)) fs.unlinkSync(p);

                    }

                } catch (_) {}

                req.flash('error_msg', 'Employer must deposit to unlock file uploads');

                return res.redirect(`/freelancer/messages?to=${toId}&job=${jobId}`);

            }

        }



        if (!content && !attachmentUrl) {

            return res.redirect(`/freelancer/messages?to=${toId}${Number.isFinite(jobId) && jobId > 0 ? `&job=${jobId}` : ''}`);

        }



        await Message.create({

            sender_id: senderId,

            receiver_id: toId,

            job_id: (Number.isFinite(jobId) && jobId > 0) ? jobId : null,

            content,

            attachment_url: attachmentUrl,

            attachment_type: attachmentType

        });



        return res.redirect(`/freelancer/messages?to=${toId}${Number.isFinite(jobId) && jobId > 0 ? `&job=${jobId}` : ''}`);

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/messages');

    }

};



exports.dashboard = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const limit = 5;

        const [rows] = await db.query(

            `SELECT j.id, j.title, j.slug, j.thumbnail_url, j.budget, j.job_type, j.status, j.created_at,

                    u.company_name

             FROM jobs j

             LEFT JOIN users u ON u.id = j.employer_id

             ORDER BY j.created_at DESC

             LIMIT ?`,

            [limit]

        );



        let stats = { active_projects: 0, completed_projects: 0, pending_proposals: 0, total_earnings: 0 };

        // Project/Contract lifecycle in this codebase is driven mainly by proposals:
        // - proposals.status = 'accepted' indicates hired
        // - proposals.is_deposited = 1 indicates active/activated
        // - proposals.is_deposited = 2 indicates paid/completed
        // We still include contracts table counts for backward compatibility.
        let ac = 0;
        let cc = 0;
        let ap = 0;
        let cp = 0;
        let p = 0;
        let t = 0;

        try {
            const [activeContractRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM contracts
                 WHERE freelancer_id = ? AND status = 'active'`,
                [userId]
            );
            ac = (Array.isArray(activeContractRows) && activeContractRows.length) ? Number(activeContractRows[0].c || 0) : 0;
        } catch (_) {}

        try {
            const [completedContractRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM contracts
                 WHERE freelancer_id = ? AND status = 'completed'`,
                [userId]
            );
            cc = (Array.isArray(completedContractRows) && completedContractRows.length) ? Number(completedContractRows[0].c || 0) : 0;
        } catch (_) {}

        try {
            const [activeProposalRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM proposals
                 WHERE freelancer_id = ? AND status NOT IN ('rejected', 'withdrawn') AND is_deposited = 1`,
                [userId]
            );
            ap = (Array.isArray(activeProposalRows) && activeProposalRows.length) ? Number(activeProposalRows[0].c || 0) : 0;
        } catch (_) {}

        try {
            const [completedProposalRows] = await db.query(
                `SELECT COUNT(DISTINCT p.id) AS c
                 FROM proposals p
                 INNER JOIN jobs j ON j.id = p.job_id
                 LEFT JOIN timesheets t ON t.proposal_id = p.id AND t.status = 'paid'
                 WHERE p.freelancer_id = ?
                   AND p.status NOT IN ('rejected', 'withdrawn')
                   AND (
                        p.is_deposited = 2
                        OR (j.job_type = 'hourly' AND t.id IS NOT NULL)
                   )`,
                [userId]
            );
            cp = (Array.isArray(completedProposalRows) && completedProposalRows.length) ? Number(completedProposalRows[0].c || 0) : 0;
        } catch (_) {
            try {
                const [fallbackCompletedProposalRows] = await db.query(
                    `SELECT COUNT(*) AS c
                     FROM proposals
                     WHERE freelancer_id = ? AND status NOT IN ('rejected', 'withdrawn') AND is_deposited = 2`,
                    [userId]
                );
                cp = (Array.isArray(fallbackCompletedProposalRows) && fallbackCompletedProposalRows.length)
                    ? Number(fallbackCompletedProposalRows[0].c || 0)
                    : 0;
            } catch (_) {}
        }

        try {
            const [pendingRows] = await db.query(
                `SELECT COUNT(*) AS c
                 FROM proposals
                 WHERE freelancer_id = ? AND status = 'pending'`,
                [userId]
            );
            p = (Array.isArray(pendingRows) && pendingRows.length) ? Number(pendingRows[0].c || 0) : 0;
        } catch (_) {}

        try {
            const [earnRows] = await db.query(
                `SELECT COALESCE(SUM(amount), 0) AS total
                 FROM transactions
                 WHERE user_id = ? AND type = 'payment' AND status = 'completed'`,
                [userId]
            );
            t = (Array.isArray(earnRows) && earnRows.length) ? Number(earnRows[0].total || 0) : 0;
        } catch (_) {}

        stats = {
            active_projects: (Number.isFinite(ac) ? ac : 0) + (Number.isFinite(ap) ? ap : 0),
            completed_projects: (Number.isFinite(cc) ? cc : 0) + (Number.isFinite(cp) ? cp : 0),
            pending_proposals: Number.isFinite(p) ? p : 0,
            total_earnings: Number.isFinite(t) ? t : 0
        };

        // Recent Projects: proposals accepted/deposited
        let recentProjects = [];
        try {
            const [rpRows] = await db.query(
                `SELECT p.id AS proposal_id, p.status, p.is_deposited, p.bid_amount, p.created_at,
                        j.id AS job_id, j.title AS job_title, j.slug AS job_slug, j.job_type, j.thumbnail_url,
                        u.company_name, u.full_name AS employer_name
                 FROM proposals p
                 INNER JOIN jobs j ON j.id = p.job_id
                 LEFT JOIN users u ON u.id = j.employer_id
                 WHERE p.freelancer_id = ?
                   AND p.status NOT IN ('rejected', 'withdrawn')
                 ORDER BY p.created_at DESC
                 LIMIT 5`,
                [userId]
            );
            recentProjects = Array.isArray(rpRows) ? rpRows : [];
        } catch (_) {}

        return res.render("freelancer/dashboard", {

            user: req.session.user,

            jobs: Array.isArray(rows) ? rows : [],

            stats,

            recentProjects: recentProjects

        });

    } catch (err) {

        console.error(err);

        return res.render("freelancer/dashboard", {

            user: req.session.user,

            jobs: [],

            stats: { active_projects: 0, completed_projects: 0, pending_proposals: 0, total_earnings: 0 },

            recentProjects: []

        });

    }

};



exports.jobs = async (req, res) => {

    const perPage = 12;

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



        return res.render('freelancer/jobs-freelancer', {

            user: req.session.user,

            query: req.query,

            basePath: '/freelancer/jobs',

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

        return res.render('freelancer/jobs-freelancer', {

            user: req.session.user,

            query: req.query,

            basePath: '/freelancer/jobs',

            categories: [],

            jobs: [],

            pagination: { page: 1, perPage, total: 0, totalPages: 1 }

        });

    }

};



exports.jobDetail = async (req, res) => {

    const slug = String(req.params && req.params.slug ? req.params.slug : '').trim();

    if (!slug) {

        return res.status(404).send('Not Found');

    }



    try {

        const [rows] = await db.query(

            `SELECT j.id, j.title, j.slug, j.description, j.thumbnail_url, j.budget, j.job_type, j.status,

                    j.deadline, j.created_at,

                    u.id AS employer_id, u.company_name,

                    ep.website, ep.description AS company_description, ep.logo_url, ep.city,

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

        let hasApplied = false;

        try {

            const userId = req.session.user.id;

            const [prRows] = await db.query(

                'SELECT id FROM proposals WHERE job_id = ? AND freelancer_id = ? LIMIT 1',

                [job.id, userId]

            );

            hasApplied = Array.isArray(prRows) && prRows.length > 0;

        } catch (e) {

            hasApplied = false;

        }



        return res.render('freelancer/job-detail-freelacer', {

            user: req.session.user,

            job,

            hasApplied,

            banners: await db.query("SELECT * FROM banners WHERE is_active = 1 ORDER BY position, sort_order ASC").then(([r]) => r).catch(() => [])

        });

    } catch (err) {

        console.error(err);

        return res.status(500).send('Internal Server Error');

    }

};



exports.categoryJobs = async (req, res) => {

    const slug = String(req.params && req.params.slug ? req.params.slug : '').trim();

    if (!slug) {

        return res.status(404).send('Not Found');

    }



    const perPage = 10;

    const rawPage = Number(req.query && req.query.page ? req.query.page : 1);

    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;



    try {

        const [categoryRows] = await db.query(

            'SELECT id, name, slug FROM categories WHERE slug = ? LIMIT 1',

            [slug]

        );

        const category = (Array.isArray(categoryRows) && categoryRows.length) ? categoryRows[0] : null;

        if (!category) {

            return res.status(404).send('Category not found');

        }



        const [countRows] = await db.query('SELECT COUNT(*) AS total FROM jobs WHERE category_id = ?', [category.id]);

        const total = (Array.isArray(countRows) && countRows[0] && countRows[0].total !== undefined)

            ? Number(countRows[0].total)

            : 0;

        const totalPages = Math.max(1, Math.ceil(total / perPage));

        const safePage = Math.min(Math.max(page, 1), totalPages);

        const offset = (safePage - 1) * perPage;



        const [rows] = await db.query(

            `SELECT j.id, j.title, j.slug, j.thumbnail_url, j.budget, j.job_type, j.status, j.created_at,

                    u.company_name

             FROM jobs j

             LEFT JOIN users u ON u.id = j.employer_id

             WHERE j.category_id = ?

             ORDER BY j.created_at DESC

             LIMIT ? OFFSET ?`,

            [category.id, perPage, offset]

        );



        return res.render('freelancer/category-jobs-freelancer', {

            user: req.session.user,

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

};



exports.profile = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const [rows] = await db.query(

            `SELECT u.full_name, u.avatar_url,

                    fp.user_id, fp.headline, fp.bio, fp.hourly_rate, fp.portfolio_url, fp.github_url, fp.city, fp.country,

                    fp.skills, fp.linkedin_url, fp.website, fp.education, fp.experience_level, fp.cv_url

             FROM users u

             LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id

             WHERE u.id = ?

             LIMIT 1`,

            [userId]

        );



        const row = Array.isArray(rows) && rows.length ? rows[0] : null;

        const profile = row ? {

            full_name: row.full_name || '',

            avatar_url: row.avatar_url || '',

            title: row.headline || '',

            bio: row.bio || '',

            hourly_rate: row.hourly_rate,

            portfolio_url: row.portfolio_url || '',

            github_url: row.github_url || '',

            location: row.city || '',

            country: row.country || '',

            skills: row.skills || '',

            linkedin_url: row.linkedin_url || '',

            website: row.website || '',

            education: row.education || '',

            experience_level: row.experience_level || '',

            cv_url: row.cv_url || ''

        } : {};



        let planStatus = { code: null, name: null, price_monthly: null, currency: null, start_utc: null, end_utc: null, limits: {}, usage: {} };

        try {

            const [ap] = await db.query(

                `SELECT p.id AS plan_id, p.code, p.name, p.price_monthly, p.currency, up.start_utc, up.end_utc
                 FROM user_plans up
                 JOIN plans p ON p.id = up.plan_id
                 WHERE up.user_id = ? AND up.status = 'active'
                 ORDER BY up.start_utc DESC
                 LIMIT 1`,

                [userId]

            );

            let p = Array.isArray(ap) && ap.length ? ap[0] : null;
            if (!p) {
                const [ap2] = await db.query(
                    `SELECT p.id AS plan_id, p.code, p.name, p.price_monthly, p.currency, up.start_utc, up.end_utc
                     FROM user_plans up
                     JOIN plans p ON p.id = up.plan_id
                     WHERE up.user_id = ?
                     ORDER BY up.start_utc DESC
                     LIMIT 1`,
                    [userId]
                );
                p = Array.isArray(ap2) && ap2.length ? ap2[0] : null;
            }
            if (p) {
                planStatus.code = p.code || null;
                planStatus.name = p.name || null;
                planStatus.price_monthly = p.price_monthly !== undefined ? p.price_monthly : null;
                planStatus.currency = p.currency || null;
                planStatus.start_utc = p.start_utc || null;
                planStatus.end_utc = p.end_utc || null;
                const [lims] = await db.query(
                    `SELECT kind, max_file_mb, monthly_quota_mb
                     FROM plan_limits
                     WHERE plan_id = ? AND is_active = 1`,
                    [p.plan_id]
                );
                const limits = {};
                (Array.isArray(lims) ? lims : []).forEach(it => {
                    if (!it || !it.kind) return;
                    limits[String(it.kind)] = { max_file_mb: it.max_file_mb, monthly_quota_mb: it.monthly_quota_mb };
                });
                planStatus.limits = limits;
            }

        } catch (_) {}

        try {
            const now = new Date();
            const pk = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
            const [u] = await db.query(
                `SELECT image_bytes, video_bytes, file_bytes
                 FROM upload_usage
                 WHERE user_id = ? AND period_key = ?
                 LIMIT 1`,
                [userId, pk]
            );
            const usage = Array.isArray(u) && u.length ? u[0] : null;
            if (usage) {
                planStatus.usage = {
                    image_bytes: Number(usage.image_bytes || 0),
                    video_bytes: Number(usage.video_bytes || 0),
                    file_bytes: Number(usage.file_bytes || 0),
                    period_key: pk
                };
            } else {
                planStatus.usage = { image_bytes: 0, video_bytes: 0, file_bytes: 0, period_key: pk };
            }
        } catch (_) {}



        const useragent = require('useragent');
        const agent = useragent.parse(req.headers['user-agent']);
        const os = agent.os.family && agent.os.family !== 'Other' ? agent.os.family : 'Unknown OS';
        const browser = agent.family && agent.family !== 'Other' ? agent.family : 'Unknown Browser';
        const activeSession = `${os} • ${browser}`;

        return res.render("freelancer/profile-freelancer", {

            user: req.session.user,

            profile,

            planStatus,

            activeSession

        });

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/dashboard');

    }

};



exports.saveProfile = async (req, res) => {

    try {

        const userId = req.session.user.id;



        const full_name = (req.body && req.body.full_name) ? String(req.body.full_name).trim().slice(0, 120) : '';

        const title = (req.body && req.body.title) ? String(req.body.title).trim().slice(0, 255) : '';

        const bio = (req.body && req.body.bio) ? String(req.body.bio).trim() : '';

        const hourly_rate_raw = (req.body && req.body.hourly_rate !== undefined) ? String(req.body.hourly_rate).trim() : '';

        const hourly_rate_num = hourly_rate_raw.length ? Number(hourly_rate_raw) : null;

        const hourly_rate = (hourly_rate_num !== null && Number.isFinite(hourly_rate_num) && hourly_rate_num >= 0)

            ? hourly_rate_num

            : null;



        const portfolio_url = (req.body && req.body.portfolio_url) ? String(req.body.portfolio_url).trim().slice(0, 255) : '';

        const github_url = (req.body && req.body.github_url) ? String(req.body.github_url).trim().slice(0, 255) : '';

        const linkedin_url = (req.body && req.body.linkedin_url) ? String(req.body.linkedin_url).trim().slice(0, 255) : '';

        const website = (req.body && req.body.website) ? String(req.body.website).trim().slice(0, 255) : '';

        const education = (req.body && req.body.education) ? String(req.body.education).trim().slice(0, 255) : '';

        const skills = (req.body && req.body.skills) ? String(req.body.skills).trim().slice(0, 5000) : '';



        const expRaw = (req.body && req.body.experience_level) ? String(req.body.experience_level).trim().toLowerCase() : '';

        const allowedExp = new Set(['intern', 'junior', 'mid', 'senior']);

        const experience_level = allowedExp.has(expRaw) ? expRaw : '';



        const location = (req.body && req.body.location) ? String(req.body.location).trim().slice(0, 100) : '';

        const country = (req.body && req.body.country) ? String(req.body.country).trim().slice(0, 100) : '';



        const existing_avatar_url = (req.body && req.body.existing_avatar_url) ? String(req.body.existing_avatar_url).trim() : '';

        const uploadedAvatar = req.files && req.files.avatar && req.files.avatar[0] ? req.files.avatar[0] : null;

        const uploadedAvatarUrl = uploadedAvatar ? ('/img/' + uploadedAvatar.filename) : '';

        const avatar_url = uploadedAvatarUrl || existing_avatar_url || '';



        const existing_cv_url = (req.body && req.body.existing_cv_url) ? String(req.body.existing_cv_url).trim() : '';

        const uploadedCv = req.files && req.files.cv && req.files.cv[0] ? req.files.cv[0] : null;

        const uploadedCvUrl = uploadedCv ? ('/img/' + uploadedCv.filename) : '';

        const cv_url = uploadedCvUrl || existing_cv_url || '';



        if (full_name || avatar_url) {

            await db.query(

                'UPDATE users SET full_name = COALESCE(?, full_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',

                [full_name || null, avatar_url || null, userId]

            );

        }



        await db.query(

            `INSERT INTO freelancer_profiles (user_id, headline, bio, hourly_rate, portfolio_url, github_url, city, country, skills, linkedin_url, website, education, experience_level, cv_url)

             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

             ON DUPLICATE KEY UPDATE

               headline = VALUES(headline),

               bio = VALUES(bio),

               hourly_rate = VALUES(hourly_rate),

               portfolio_url = VALUES(portfolio_url),

               github_url = VALUES(github_url),

               city = VALUES(city),

               country = VALUES(country),

               skills = VALUES(skills),

               linkedin_url = VALUES(linkedin_url),

               website = VALUES(website),

               education = VALUES(education),

               experience_level = VALUES(experience_level),

               cv_url = VALUES(cv_url)`,

            [

                userId,

                title || null,

                bio || null,

                hourly_rate,

                portfolio_url || null,

                github_url || null,

                location || null,

                country || null,

                skills || null,

                linkedin_url || null,

                website || null,

                education || null,

                experience_level || null,

                cv_url || null

            ]

        );



        req.flash('success_msg', 'Profile updated');

        return res.redirect('/freelancer/profile');

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/profile');

    }

};



exports.applyToJob = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const jobIdRaw = (req.body && req.body.job_id !== undefined && req.body.job_id !== null) ? String(req.body.job_id).trim() : '';

        const jobId = jobIdRaw ? Number(jobIdRaw) : NaN;



        if (!Number.isFinite(jobId) || jobId <= 0) {

            req.flash('error_msg', 'Invalid job');

            return res.redirect('/freelancer/jobs');

        }



        const [jobRows] = await db.query(

            'SELECT id, employer_id, title, slug, budget, status FROM jobs WHERE id = ? LIMIT 1',

            [jobId]

        );

        const job = Array.isArray(jobRows) && jobRows.length ? jobRows[0] : null;

        if (!job || String(job.status) !== 'open') {

            req.flash('error_msg', 'Job not found or closed');

            return res.redirect('/freelancer/jobs');

        }



        const [dupRows] = await db.query(

            'SELECT id FROM proposals WHERE job_id = ? AND freelancer_id = ? LIMIT 1',

            [jobId, userId]

        );

        if (Array.isArray(dupRows) && dupRows.length > 0) {

            req.flash('error_msg', 'You have already applied to this job');

            return res.redirect(`/freelancer/jobs/${encodeURIComponent(job.slug)}`);

        }



        const rawBudget = (job.budget === undefined || job.budget === null) ? null : Number(job.budget);

        const bidAmount = Number.isFinite(rawBudget) ? rawBudget : 0;



        await db.query(

            `INSERT INTO proposals (job_id, freelancer_id, cover_letter, bid_amount, estimated_days, status)

             VALUES (?, ?, ?, ?, ?, 'pending')`,

            [job.id, userId, '', bidAmount, 0]

        );

        try {
            const employerId = (job && job.employer_id !== undefined && job.employer_id !== null) ? Number(job.employer_id) : NaN;
            if (Number.isFinite(employerId) && employerId > 0) {
                const freelancerName = (req.session && req.session.user && req.session.user.full_name)
                    ? String(req.session.user.full_name)
                    : 'A freelancer';
                const jobTitle = job && job.title ? String(job.title) : 'your job';
                await NotificationService.createPersonal(
                    employerId,
                    'New Application',
                    `${freelancerName} applied to your job: ${jobTitle}`,
                    'info',
                    '/employer/applications',
                    'info',
                    userId
                );
            }
        } catch (_) {}



        req.flash('success_msg', 'Applied successfully');

        return res.redirect(`/freelancer/jobs/${encodeURIComponent(job.slug)}?applied=1`);

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/jobs');

    }

};



exports.myProposals = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const [rows] = await db.query(

            `SELECT p.id AS proposal_id, p.bid_amount, p.estimated_days, p.status, p.created_at,

                    j.id AS job_id, j.title AS job_title, j.slug AS job_slug, j.thumbnail_url, j.budget, j.job_type,

                    j.employer_id,

                    u.company_name, u.full_name AS employer_name

             FROM proposals p

             INNER JOIN jobs j ON j.id = p.job_id

             LEFT JOIN users u ON u.id = j.employer_id

             WHERE p.freelancer_id = ?

             ORDER BY p.created_at DESC`,

            [userId]

        );

        const proposals = Array.isArray(rows) ? rows : [];

        return res.render('freelancer/my-project', {

            user: req.session.user,

            proposals

        });

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/dashboard');

    }

};



exports.timesheets = async (req, res) => {

    try {

        const userId = req.session.user.id;
        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';
        const proposalId = rawId ? Number(rawId) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {
            req.flash('error_msg', 'Invalid proposal');
            return res.redirect('/freelancer/proposals');
        }

        const [propRows] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id, p.bid_amount, p.status,
                    j.title AS job_title, j.slug AS job_slug, j.job_type
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.id = ? AND p.freelancer_id = ?
             LIMIT 1`,
            [proposalId, userId]
        );

        const proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
        if (!proposal) {
            req.flash('error_msg', 'Proposal not found');
            return res.redirect('/freelancer/proposals');
        }

        if (proposal.job_type !== 'hourly') {
            req.flash('error_msg', 'Timesheets are only available for hourly jobs');
            return res.redirect('/freelancer/proposals');
        }

        const [timesheets] = await db.query(
            `SELECT * FROM timesheets WHERE proposal_id = ? ORDER BY week_start DESC, created_at DESC`,
            [proposalId]
        );

        return res.render('freelancer/timesheets', {
            user: req.session.user,
            proposal,
            timesheets: Array.isArray(timesheets) ? timesheets : []
        });

    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/freelancer/proposals');
    }

};



exports.saveTimesheet = async (req, res) => {

    try {

        const userId = req.session.user.id;
        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';
        const proposalId = rawId ? Number(rawId) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {
            req.flash('error_msg', 'Invalid proposal');
            return res.redirect('/freelancer/proposals');
        }

        const [propRows] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id,
                    j.job_type
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.id = ? AND p.freelancer_id = ?
             LIMIT 1`,
            [proposalId, userId]
        );
        const proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
        if (!proposal) {
            req.flash('error_msg', 'Proposal not found');
            return res.redirect('/freelancer/proposals');
        }
        if (proposal.job_type !== 'hourly') {
            req.flash('error_msg', 'Timesheets are only available for hourly jobs');
            return res.redirect('/freelancer/proposals');
        }

        const weekStartRaw = (req.body && req.body.week_start) ? String(req.body.week_start).trim() : '';
        const hoursRaw = (req.body && req.body.hours !== undefined && req.body.hours !== null) ? String(req.body.hours).trim() : '';
        const notesRaw = (req.body && req.body.notes !== undefined && req.body.notes !== null) ? String(req.body.notes) : '';

        const weekStart = weekStartRaw;
        const hours = hoursRaw ? Number(hoursRaw) : 0;
        const notes = notesRaw.trim().slice(0, 2000);

        if (!weekStart || !Number.isFinite(hours) || hours <= 0) {
            req.flash('error_msg', 'Invalid input data');
            return res.redirect(`/freelancer/timesheets/${proposalId}`);
        }

        await db.query(
            `INSERT INTO timesheets (proposal_id, week_start, hours, notes, status) VALUES (?, ?, ?, ?, 'pending')`,
            [proposalId, weekStart, hours, notes]
        );

        req.flash('success_msg', 'Timesheet submitted successfully');
        return res.redirect(`/freelancer/timesheets/${proposalId}`);

    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/freelancer/proposals');
    }

};



exports.withdrawProposal = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';

        const proposalId = rawId ? Number(rawId) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {

            req.flash('error_msg', 'Invalid proposal');

            return res.redirect('/freelancer/proposals');

        }

        const [rows] = await db.query(

            `SELECT p.id, p.status

             FROM proposals p

             WHERE p.id = ? AND p.freelancer_id = ?

             LIMIT 1`,

            [proposalId, userId]

        );

        const pr = Array.isArray(rows) && rows.length ? rows[0] : null;

        if (!pr) {

            req.flash('error_msg', 'Proposal not found');

            return res.redirect('/freelancer/proposals');

        }

        await db.query('UPDATE proposals SET status = ? WHERE id = ?', ['withdrawn', proposalId]);

        req.flash('success_msg', 'Proposal withdrawn');

        return res.redirect('/freelancer/proposals');

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/proposals');

    }

};



exports.messagesPage = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const toRaw = req.query && req.query.to ? String(req.query.to).trim() : '';

        const toId = toRaw ? Number(toRaw) : NaN;

        const jobRaw = req.query && req.query.job ? String(req.query.job).trim() : '';

        const jobId = jobRaw ? Number(jobRaw) : NaN;



        // Fetch current user details for avatar

        const [userRows] = await db.query('SELECT avatar_url, full_name FROM users WHERE id = ? LIMIT 1', [userId]);

        const currentUser = (Array.isArray(userRows) && userRows.length) ? userRows[0] : {};



        let employer = null;

        if (Number.isFinite(toId) && toId > 0) {

            const [rows] = await db.query(

                `SELECT u.id, u.company_name, ep.logo_url

                 FROM users u

                 LEFT JOIN employer_profiles ep ON ep.user_id = u.id

                 WHERE u.id = ? AND u.role = 'employer'

                 LIMIT 1`,

                [toId]

            );

            employer = Array.isArray(rows) && rows.length ? rows[0] : null;

        }

        let job = null;

        if (Number.isFinite(jobId) && jobId > 0) {

            const [rows] = await db.query(

                `SELECT id, title, slug, job_type

                 FROM jobs

                 WHERE id = ?

                 LIMIT 1`,

                [jobId]

            );

            job = Array.isArray(rows) && rows.length ? rows[0] : null;

        }

        // Check deposit status and fetch Proposal details (bid_amount)
        let isDeposited = 0;
        let proposal = null;
        if (Number.isFinite(jobId) && jobId > 0 && Number.isFinite(userId) && userId > 0) {
            const [propRows] = await db.query(
                `SELECT id, is_deposited, bid_amount FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 LIMIT 1`,
                [jobId, userId]
            );
            if (Array.isArray(propRows) && propRows.length > 0) {
                const raw = propRows[0].is_deposited;
                const n = (raw === undefined || raw === null) ? 0 : Number(raw);
                isDeposited = (Number.isFinite(n) && n >= 0) ? n : 0;
                proposal = propRows[0];
            }
        }



        let messages = [];

        if (Number.isFinite(toId) && toId > 0) {

            messages = await Message.getConversation(userId, toId, (Number.isFinite(jobId) && jobId > 0) ? jobId : null, 200, 0);

            if (!Array.isArray(messages)) messages = [];

        }



        return res.render('freelancer/messages', {

            user: { ...req.session.user, avatar_url: currentUser.avatar_url, full_name: currentUser.full_name },

            employer,

            job,

            messages,

            toId: Number.isFinite(toId) ? toId : null,

            jobId: Number.isFinite(jobId) ? jobId : null,

            isDeposited,

            proposal

        });

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/dashboard');

    }

};



exports.deleteProposal = async (req, res) => {

    try {

        const userId = req.session.user.id;

        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';

        const proposalId = rawId ? Number(rawId) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {

            req.flash('error_msg', 'Invalid proposal');

            return res.redirect('/freelancer/proposals');

        }

        const [rows] = await db.query(

            `SELECT id FROM proposals WHERE id = ? AND freelancer_id = ? LIMIT 1`,

            [proposalId, userId]

        );

        const pr = Array.isArray(rows) && rows.length ? rows[0] : null;

        if (!pr) {

            req.flash('error_msg', 'Proposal not found');

            return res.redirect('/freelancer/proposals');

        }

        await db.query('DELETE FROM proposals WHERE id = ?', [proposalId]);

        req.flash('success_msg', 'Proposal deleted');

        return res.redirect('/freelancer/proposals');

    } catch (error) {

        console.error(error);

        req.flash('error_msg', 'Server Error');

        return res.redirect('/freelancer/proposals');

    }

};


exports.logoutSession = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const sessionIdToRevoke = req.body.session_id;

        if (!sessionIdToRevoke) {
            return res.status(400).json({ ok: false, error: 'session_id required' });
        }

        const [rows] = await db.query(
            "SELECT session_id, data FROM sessions WHERE session_id = ?",
            [sessionIdToRevoke]
        );

        if (!rows.length) {
            return res.status(403).json({ ok: false, error: 'Unauthorized or not found' });
        }

        let sessionData = {};
        try {
            const raw = rows[0].data;
            const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            // express-mysql-session có thể double-encode
            let parsed = JSON.parse(str);
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
            sessionData = parsed;
        } catch (e) {
            console.error('Session parse error:', e.message);
        }

        if (!sessionData.user || Number(sessionData.user.id) !== Number(userId)) {
            console.error('Ownership fail: sessionData.user=', sessionData.user, 'userId=', userId);
            return res.status(403).json({ ok: false, error: 'Unauthorized or not found' });
        }

        await db.query("DELETE FROM sessions WHERE session_id = ?", [sessionIdToRevoke]);
        return res.json({ ok: true });
    } catch (err) {
        console.error('Freelancer revoke session error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { current_password, new_password, confirm_new_password } = req.body;
        const isJson = req.headers.accept && req.headers.accept.includes('application/json');

        if (!current_password || !new_password || !confirm_new_password) {
            if (isJson) return res.json({ ok: false, error: 'All password fields are required.' });
            req.flash('error_msg', 'All password fields are required.');
            return res.redirect('/freelancer/profile#pane-settings');
        }

        if (new_password !== confirm_new_password) {
            if (isJson) return res.json({ ok: false, error: 'New passwords do not match.' });
            req.flash('error_msg', 'New passwords do not match.');
            return res.redirect('/freelancer/profile#pane-settings');
        }

        if (new_password.length < 6) {
            if (isJson) return res.json({ ok: false, error: 'New password must be at least 6 characters long.' });
            req.flash('error_msg', 'New password must be at least 6 characters long.');
            return res.redirect('/freelancer/profile#pane-settings');
        }

        const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        const isMatch = await bcrypt.compare(current_password, user.password_hash);
        if (!isMatch) {
            if (isJson) return res.json({ ok: false, error: 'Current password is incorrect.' });
            req.flash('error_msg', 'Current password is incorrect.');
            return res.redirect('/freelancer/profile#pane-settings');
        }

        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(new_password, salt);

        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

        if (isJson) return res.json({ ok: true, message: 'Password updated successfully.' });
        req.flash('success_msg', 'Password updated successfully.');
        res.redirect('/freelancer/profile#pane-settings');
    } catch (err) {
        console.error('Freelancer change password error:', err);
        const isJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (isJson) return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
        req.flash('error_msg', 'Server error. Please try again.');
        res.redirect('/freelancer/profile#pane-settings');
    }
};
