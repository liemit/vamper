const db = require('../config/db');
const NotificationService = require('../services/notificationService');
const bcrypt = require('bcryptjs');

exports.analyticsPage = async (req, res) => {
    try {
        const now = new Date();
        const selectedYear  = parseInt(req.query.year)  || now.getFullYear();
        const selectedMonth = parseInt(req.query.month) || (now.getMonth() + 1);
        const isFiltered = req.query.year || req.query.month;

        // Date range for filter
        const dateFilter = isFiltered
            ? `AND YEAR(created_at) = ${selectedYear} AND MONTH(created_at) = ${selectedMonth}`
            : '';
        const txDateFilter = isFiltered
            ? `AND YEAR(created_at) = ${selectedYear} AND MONTH(created_at) = ${selectedMonth}`
            : '';

        // 1. Total users
        const [totalUsersRows] = await db.query('SELECT COUNT(*) as count FROM users');
        const totalUsers = totalUsersRows[0].count;

        // 2. Users by role
        const [rolesRows] = await db.query('SELECT role, COUNT(*) as count FROM users GROUP BY role');
        const rolesStat = rolesRows.reduce((acc, row) => {
            acc[row.role] = row.count;
            return acc;
        }, { admin: 0, employer: 0, freelancer: 0 });

        // 3. Jobs Stats
        const [jobsRows] = await db.query('SELECT status, COUNT(*) as count FROM jobs GROUP BY status');
        const jobsStat = jobsRows.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, { open: 0, in_progress: 0, completed: 0, cancelled: 0 });

        const totalJobs = jobsRows.reduce((sum, row) => sum + row.count, 0);

        // 4. Financial Stats — filtered by month/year if selected
        const [financeRows] = await db.query(
            `SELECT type, SUM(amount) as total_amount
             FROM transactions
             WHERE status = 'completed' ${txDateFilter}
             GROUP BY type`
        );
        const financeStat = financeRows.reduce((acc, row) => {
            acc[row.type] = row.total_amount;
            return acc;
        }, { deposit: 0, withdrawal: 0, payment: 0, service_fee: 0 });

        // 5. Monthly breakdown for chart (last 6 months)
        const [monthlyRows] = await db.query(
            `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                    type,
                    SUM(amount) AS total
             FROM transactions
             WHERE status = 'completed'
               AND created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
             GROUP BY month, type
             ORDER BY month ASC`
        );

        // 5. Recent signups
        const [recentUsers] = await db.query('SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 5');

        res.render('admin/analytics', {
            user: req.session.user,
            selectedYear,
            selectedMonth,
            isFiltered: !!isFiltered,
            stats: {
                totalUsers,
                roles: rolesStat,
                jobs: jobsStat,
                totalJobs,
                finance: financeStat,
                recentUsers,
                monthlyRows
            }
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        req.flash('error_msg', 'Failed to load analytics data.');
        res.redirect('/admin');
    }
};

// User Management Methods
exports.users = async (req, res) => {
    try {
        const perPage = 10;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;

        const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM users');
        const totalPages = Math.ceil(total / perPage);

        const [users] = await db.query(
            'SELECT id, role, full_name, email, balance, is_active, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [perPage, offset]
        );
        res.render('admin/users', {
            user: req.session.user,
            users,
            pagination: { page, totalPages, total }
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        req.flash('error_msg', 'Failed to fetch users');
        res.redirect('/admin');
    }
};

exports.rolesPage = async (req, res) => {
    try {
        const filterRole = req.query.role || 'all';
        const perPage = 15;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;

        // Stats per role
        const [roleStats] = await db.query(
            `SELECT role, COUNT(*) as count FROM users GROUP BY role`
        );
        const stats = { admin: 0, employer: 0, freelancer: 0 };
        roleStats.forEach(r => { if (stats[r.role] !== undefined) stats[r.role] = r.count; });

        // Users filtered by role
        const whereClause = filterRole !== 'all' ? 'WHERE role = ?' : '';
        const params = filterRole !== 'all' ? [filterRole] : [];

        const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM users ${whereClause}`, params);
        const totalPages = Math.ceil(total / perPage);

        const [users] = await db.query(
            `SELECT id, role, full_name, company_name, email, is_active, created_at FROM users ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        res.render('admin/roles', {
            user: req.session.user,
            stats,
            users,
            filterRole,
            pagination: { page, totalPages, total }
        });
    } catch (error) {
        console.error('Error fetching roles:', error);
        req.flash('error_msg', 'Failed to load roles page');
        res.redirect('/admin');
    }
};

exports.updateUserRole = async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        const validRoles = ['admin', 'employer', 'freelancer'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ ok: false, error: 'Invalid role' });
        }
        await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);

        // Force logout: xóa tất cả session của user này
        const userId = Number(id);
        const [sessions] = await db.query('SELECT session_id, data FROM sessions');
        for (const s of sessions) {
            try {
                let d = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
                if (d && d.user && d.user.id === userId) {
                    await db.query('DELETE FROM sessions WHERE session_id = ?', [s.session_id]);
                }
            } catch (_) {}
        }

        return res.json({ ok: true });
    } catch (error) {
        console.error('Error updating role:', error);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
};

exports.createUser = (req, res) => {
    res.render('admin/create-user', { user: req.session.user });
};

exports.storeUser = async (req, res) => {
    const { full_name, email, password, role } = req.body;
    try {
        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            req.flash('error_msg', 'Email already in use');
            return res.redirect('/admin/users/create');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)',
            [full_name, email, hashedPassword, role]
        );
        req.flash('success_msg', 'User created successfully');
        res.redirect('/admin/users');
    } catch (error) {
        console.error('Error creating user:', error);
        req.flash('error_msg', 'Failed to create user');
        res.redirect('/admin/users/create');
    }
};

exports.editUser = async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
        if (users.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/users');
        }
        res.render('admin/edit-user', { user: req.session.user, editUser: users[0] });
    } catch (error) {
        console.error('Error fetching user:', error);
        req.flash('error_msg', 'Failed to fetch user');
        res.redirect('/admin/users');
    }
};

exports.updateUser = async (req, res) => {
    const { full_name, role, password } = req.body;
    try {
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            await db.query('UPDATE users SET full_name = ?, role = ?, password_hash = ? WHERE id = ?', [full_name, role, hashedPassword, req.params.id]);
        } else {
            await db.query('UPDATE users SET full_name = ?, role = ? WHERE id = ?', [full_name, role, req.params.id]);
        }
        req.flash('success_msg', 'User updated successfully');
        res.redirect('/admin/users');
    } catch (error) {
        console.error('Error updating user:', error);
        req.flash('error_msg', 'Failed to update user');
        res.redirect(`/admin/users/edit/${req.params.id}`);
    }
};

exports.deleteUser = async (req, res) => {
    try {
        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        req.flash('success_msg', 'User deleted successfully');
    } catch (error) {
        console.error('Error deleting user:', error);
        req.flash('error_msg', 'Failed to delete user');
    }
    res.redirect('/admin/users');
};

exports.blockUser = async (req, res) => {
    try {
        const userId = req.params.id;
        const adminId = req.session.user ? req.session.user.id : null;

        // Fetch user info for the admin notification message
        const [userRows] = await db.query('SELECT email FROM users WHERE id = ?', [userId]);
        const userEmail = (userRows && userRows.length > 0) ? userRows[0].email : `ID ${userId}`;

        await db.query('UPDATE users SET is_active = 0 WHERE id = ?', [userId]);

        // Send notification to the blocked user
        const notifTitle = 'Account Blocked';
        const notifMsg = 'Your account has been blocked for violating our platform policies. Please contact customer support immediately or send information through the contact page.';
        
        // Ensure NotificationService is used to send this to the specific user
        if (NotificationService && typeof NotificationService.createPersonal === 'function') {
             // 1. Notify the blocked user
             await NotificationService.createPersonal(userId, notifTitle, notifMsg, 'system', '/contact', 'danger');
             
             // 2. Notify the admin who performed the block
             if (adminId) {
                 const adminTitle = 'User Blocked Successfully';
                 const adminMsg = `You have successfully blocked the user account: ${userEmail}.`;
                 await NotificationService.createPersonal(adminId, adminTitle, adminMsg, 'system', '/admin/users', 'info');
             }
        } else {
             console.error('NotificationService.createPersonal is not available');
        }

        req.flash('success_msg', 'User blocked successfully');
    } catch (error) {
        console.error('Error blocking user:', error);
        req.flash('error_msg', 'Failed to block user');
    }
    res.redirect('/admin/users');
};

exports.unblockUser = async (req, res) => {
    try {
        await db.query('UPDATE users SET is_active = 1 WHERE id = ?', [req.params.id]);
        req.flash('success_msg', 'User unblocked successfully');
    } catch (error) {
        console.error('Error unblocking user:', error);
        req.flash('error_msg', 'Failed to unblock user');
    }
    res.redirect('/admin/users');
};

 function getAdminDisputeBasePath(req) {
     try {
         const p = (req && req.path) ? String(req.path) : '';
         const ou = (req && req.originalUrl) ? String(req.originalUrl) : '';
         if (p.startsWith('/reports') || ou.includes('/admin/reports')) return '/admin/reports';
     } catch (_) {}
     return '/admin/disputes';
 }

function safeDisputeStatus(raw) {
    const s = (raw !== undefined && raw !== null) ? String(raw).trim().toLowerCase() : '';
    const allowed = new Set(['open', 'under_review', 'resolved', 'rejected']);
    return allowed.has(s) ? s : 'open';
}

function safeDisputeAction(raw) {
    const s = (raw !== undefined && raw !== null) ? String(raw).trim().toLowerCase() : '';
    const allowed = new Set([
        'mark_under_review',
        'ban_temp',
        'ban_perm',
        'unban',
        'refund_employer',
        'pay_freelancer',
        'close_resolved',
        'close_rejected'
    ]);
    return allowed.has(s) ? s : null;
}

async function logDisputeAction(conn, disputeId, adminId, action, meta) {
    const safe = safeDisputeAction(action);
    if (!safe) return;
    try {
        await conn.query(
            `INSERT INTO dispute_actions (dispute_id, admin_id, action, meta_json)
             VALUES (?, ?, ?, ?)`,
            [disputeId, adminId, safe, meta ? JSON.stringify(meta) : null]
        );
    } catch (_) {}
}

const fs = require('fs-extra');
const path = require('path');

exports.paypalSettingsPage = (req, res) => {
    res.render('admin/paypal-settings', {
        user: req.session.user,
        paypalMode: process.env.PAYPAL_MODE || 'sandbox',
        paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
        paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
        success_msg: req.flash('success_msg'),
        error_msg: req.flash('error_msg')
    });
};

exports.captchaSettingsPage = (req, res) => {
    res.render('admin/captcha-settings', {
        user: req.session.user,
        hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || '',
        hcaptchaSecretKey: process.env.HCAPTCHA_SECRET_KEY || ''
    });
};

exports.updateCaptchaSettings = async (req, res) => {
    const { hcaptcha_site_key, hcaptcha_secret_key } = req.body;
    const envPath = path.join(process.cwd(), '.env');

    try {
        let envContent = await fs.readFile(envPath, 'utf8');

        const updates = {
            'HCAPTCHA_SITE_KEY': hcaptcha_site_key,
            'HCAPTCHA_SECRET_KEY': hcaptcha_secret_key
        };

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
            process.env[key] = value;
        }

        await fs.writeFile(envPath, envContent, 'utf8');
        req.flash('success_msg', 'Captcha settings updated successfully.');
        res.redirect('/admin/captcha-settings');
    } catch (error) {
        console.error('Error updating captcha settings:', error);
        req.flash('error_msg', 'Failed to update captcha settings.');
        res.redirect('/admin/captcha-settings');
    }
};

exports.updatePaypalSettings = async (req, res) => {
    const { paypal_mode, paypal_client_id, paypal_client_secret } = req.body;
    const envPath = path.join(process.cwd(), '.env');

    try {
        let envContent = await fs.readFile(envPath, 'utf8');
        
        const updates = {
            'PAYPAL_MODE': paypal_mode,
            'PAYPAL_CLIENT_ID': paypal_client_id,
            'PAYPAL_CLIENT_SECRET': paypal_client_secret
        };

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
            // Cập nhật giá trị trong process.env ngay lập tức
            process.env[key] = value;
        }

        await fs.writeFile(envPath, envContent, 'utf8');
        
        req.flash('success_msg', 'PayPal settings updated successfully and saved to .env');
        res.redirect('/admin/paypal-settings');
    } catch (error) {
        console.error('Error updating .env file:', error);
        req.flash('error_msg', 'Failed to update PayPal settings.');
        res.redirect('/admin/paypal-settings');
    }
};

exports.index = async (req, res) => {
    try {
        const [[{ totalUsers }]] = await db.query('SELECT COUNT(*) AS totalUsers FROM users');
        const [[{ openJobs }]] = await db.query("SELECT COUNT(*) AS openJobs FROM jobs WHERE status = 'open'");
        const [[{ todayTx }]] = await db.query(
            "SELECT COUNT(*) AS todayTx FROM transactions WHERE DATE(created_at) = CURDATE()"
        );
        const [[{ pendingWithdrawals }]] = await db.query(
            "SELECT COUNT(*) AS pendingWithdrawals FROM withdraw_requests WHERE status = 'pending'"
        );
        const [[{ openDisputes }]] = await db.query(
            "SELECT COUNT(*) AS openDisputes FROM disputes WHERE status IN ('open','under_review')"
        );

        res.render("admin/index", {
            user: req.session.user,
            stats: { totalUsers, openJobs, todayTx, pendingWithdrawals, openDisputes }
        });
    } catch (err) {
        console.error(err);
        res.render("admin/index", {
            user: req.session.user,
            stats: { totalUsers: 0, openJobs: 0, todayTx: 0, pendingWithdrawals: 0, openDisputes: 0 }
        });
    }
};

exports.disputesPage = async (req, res) => {
    try {
        const basePath = getAdminDisputeBasePath(req);
        const perPage = 20;
        const rawPage = Number(req.query && req.query.page ? req.query.page : 1);
        const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
        const statusRaw = (req.query && req.query.status) ? String(req.query.status).trim().toLowerCase() : '';
        const status = safeDisputeStatus(statusRaw);
        const useStatusFilter = statusRaw ? status : '';

        const where = [];
        const params = [];
        if (useStatusFilter) {
            where.push('d.status = ?');
            params.push(useStatusFilter);
        }
        const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM disputes d
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
            `SELECT d.id, d.category, d.status, d.created_at,
                    d.job_id, j.title AS job_title,
                    d.created_by, cu.email AS creator_email, cu.full_name AS creator_name,
                    d.reported_user_id, ru.email AS reported_email, ru.full_name AS reported_name
             FROM disputes d
             LEFT JOIN jobs j ON j.id = d.job_id
             LEFT JOIN users cu ON cu.id = d.created_by
             LEFT JOIN users ru ON ru.id = d.reported_user_id
             ${whereSql}
             ORDER BY d.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        return res.render('admin/disputes', {
            user: req.session.user,
            disputes: Array.isArray(rows) ? rows : [],
            query: { status: useStatusFilter || '' },
            basePath,
            pagination: {
                page: safePage,
                perPage,
                total,
                totalPages
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.disputeDetailPage = async (req, res) => {
    try {
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }

        const [rows] = await db.query(
            `SELECT d.*, j.title AS job_title, j.job_type,
                    p.bid_amount AS proposal_bid_amount, p.pending_balance AS proposal_pending_balance,
                    cu.email AS creator_email, cu.full_name AS creator_name, cu.role AS creator_role,
                    ru.email AS reported_email, ru.full_name AS reported_name, ru.role AS reported_role,
                    ru.is_active AS reported_is_active, ru.banned_until AS reported_banned_until
             FROM disputes d
             LEFT JOIN jobs j ON j.id = d.job_id
             LEFT JOIN proposals p ON p.id = d.proposal_id
             LEFT JOIN users cu ON cu.id = d.created_by
             LEFT JOIN users ru ON ru.id = d.reported_user_id
             WHERE d.id = ?
             LIMIT 1`,
            [id]
        );
        const dispute = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!dispute) {
            req.flash('error_msg', 'Dispute not found');
            return res.redirect(basePath);
        }

        const [att] = await db.query(
            `SELECT id, url, kind, created_at
             FROM dispute_attachments
             WHERE dispute_id = ?
             ORDER BY id ASC`,
            [id]
        );

        const [actions] = await db.query(
            `SELECT da.id, da.action, da.meta_json, da.created_at,
                    u.email AS admin_email, u.full_name AS admin_name
             FROM dispute_actions da
             LEFT JOIN users u ON u.id = da.admin_id
             WHERE da.dispute_id = ?
             ORDER BY da.created_at DESC, da.id DESC`,
            [id]
        );

        return res.render('admin/dispute-detail', {
            user: req.session.user,
            dispute,
            attachments: Array.isArray(att) ? att : [],
            actions: Array.isArray(actions) ? actions : [],
            basePath
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.disputeMarkUnderReview = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM disputes WHERE id = ? FOR UPDATE', [id]);
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }

            await conn.query(
                `UPDATE disputes SET status = 'under_review', admin_id = ? WHERE id = ?`,
                [adminUser.id, id]
            );
            await logDisputeAction(conn, id, adminUser.id, 'mark_under_review', null);
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        req.flash('success_msg', 'Dispute marked under review');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to update dispute');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeResolve = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        const noteRaw = (req.body && req.body.admin_note) ? String(req.body.admin_note) : '';
        const admin_note = noteRaw.trim().slice(0, 255);

        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM disputes WHERE id = ? FOR UPDATE', [id]);
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }

            await conn.query(
                `UPDATE disputes SET status = 'resolved', admin_id = ?, admin_note = ? WHERE id = ?`,
                [adminUser.id, admin_note || null, id]
            );
            await logDisputeAction(conn, id, adminUser.id, 'close_resolved', { admin_note: admin_note || '' });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        req.flash('success_msg', 'Dispute resolved');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to resolve dispute');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeReject = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        const noteRaw = (req.body && req.body.admin_note) ? String(req.body.admin_note) : '';
        const admin_note = noteRaw.trim().slice(0, 255);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                `SELECT d.*, j.job_type, j.employer_id,
                        p.id AS proposal_id, p.pending_balance AS proposal_pending_balance
                 FROM disputes d
                 LEFT JOIN jobs j ON j.id = d.job_id
                 LEFT JOIN proposals p ON p.id = d.proposal_id
                 WHERE d.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [id]
            );
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }

            if (String(d.status || '') === 'resolved' || String(d.status || '') === 'rejected') {
                await conn.rollback();
                req.flash('error_msg', 'This dispute is already closed');
                return res.redirect(`${basePath}/${id}`);
            }

            // Special handling: hourly refund request disputes.
            // If admin rejects the dispute, we assume the pending hourly amount should be returned to employer
            // and the hourly timer/pending tracking should be reset.
            const jobType = d.job_type ? String(d.job_type).toLowerCase() : 'fixed_price';
            const employerId = Number(d.employer_id || d.created_by || 0);
            const proposalId = Number(d.proposal_id || 0);
            const pending = Number(d.proposal_pending_balance || 0);
            if (jobType === 'hourly' && employerId > 0 && proposalId > 0 && pending > 0) {
                await conn.query(
                    `UPDATE users
                     SET balance = balance + ?
                     WHERE id = ?`,
                    [pending, employerId]
                );

                await conn.query(
                    `UPDATE proposals
                     SET pending_balance = 0,
                         total_seconds_worked = 0,
                         paid_seconds = 0,
                         timer_status = 'stopped',
                         timer_start_time = NULL
                     WHERE id = ?`,
                    [proposalId]
                );

                // Best-effort: mark pending transactions related to this dispute/job as refunded/failed
                try {
                    await conn.query(
                        `UPDATE transactions
                         SET status = 'refunded', description = CONCAT(description, ' [Rejected by Admin]')
                         WHERE user_id = ? AND status = 'pending' AND type = 'payment' AND related_contract_id = ?`,
                        [employerId, Number(d.contract_id || 0)]
                    );
                } catch (_) {}
            }

            await conn.query(
                `UPDATE disputes SET status = 'rejected', admin_id = ?, admin_note = ? WHERE id = ?`,
                [adminUser.id, admin_note || null, id]
            );
            await logDisputeAction(conn, id, adminUser.id, 'close_rejected', { admin_note: admin_note || '' });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        req.flash('success_msg', 'Dispute rejected');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to reject dispute');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeBanTemp = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        const daysRaw = Number(req.body && req.body.days ? req.body.days : 7);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 365) : 7;

        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }

        const conn = await db.getConnection();
        let reportedUserId = null;
        let bannedUntil = null;
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM disputes WHERE id = ? FOR UPDATE', [id]);
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }
            reportedUserId = Number(d.reported_user_id);
            const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            bannedUntil = `${until.getUTCFullYear()}-${pad(until.getUTCMonth() + 1)}-${pad(until.getUTCDate())} ${pad(until.getUTCHours())}:${pad(until.getUTCMinutes())}:${pad(until.getUTCSeconds())}`;

            await conn.query(
                `UPDATE users SET banned_until = ? WHERE id = ?`,
                [bannedUntil, reportedUserId]
            );
            await logDisputeAction(conn, id, adminUser.id, 'ban_temp', { reported_user_id: reportedUserId, days, banned_until: bannedUntil });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        req.flash('success_msg', `User banned for ${days} day(s)`);
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to ban user');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeBanPerm = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM disputes WHERE id = ? FOR UPDATE', [id]);
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }
            const reportedUserId = Number(d.reported_user_id);
            await conn.query(`UPDATE users SET is_active = 0, banned_until = NULL WHERE id = ?`, [reportedUserId]);
            await logDisputeAction(conn, id, adminUser.id, 'ban_perm', { reported_user_id: reportedUserId });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }
        req.flash('success_msg', 'User banned permanently');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to ban user');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeUnban = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM disputes WHERE id = ? FOR UPDATE', [id]);
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }
            const reportedUserId = Number(d.reported_user_id);
            await conn.query(`UPDATE users SET is_active = 1, banned_until = NULL WHERE id = ?`, [reportedUserId]);
            await logDisputeAction(conn, id, adminUser.id, 'unban', { reported_user_id: reportedUserId });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }
        req.flash('success_msg', 'User unbanned');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to unban user');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputeRefundEmployer = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        const amountRaw = Number(req.body && req.body.amount ? req.body.amount : 0);
        const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? Math.round(amountRaw * 100) / 100 : 0;
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }
        if (!(amount > 0)) {
            req.flash('error_msg', 'Invalid refund amount');
            return res.redirect(`${basePath}/${id}`);
        }

        let employerId = null;
        let freelancerId = null;
        let jobId = null;
        let jobTitle = 'Job';
        let jobType = 'fixed_price';

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                `SELECT d.*, j.title AS job_title, j.employer_id, j.job_type,
                        p.freelancer_id, p.bid_amount, p.pending_balance
                 FROM disputes d
                 LEFT JOIN jobs j ON j.id = d.job_id
                 LEFT JOIN proposals p ON p.id = d.proposal_id
                 WHERE d.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [id]
            );
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }

            if (String(d.status || '') === 'resolved' || String(d.status || '') === 'rejected') {
                await conn.rollback();
                req.flash('error_msg', 'This dispute is already closed');
                return res.redirect(`${basePath}/${id}`);
            }

            const [already] = await conn.query(
                `SELECT id
                 FROM dispute_actions
                 WHERE dispute_id = ? AND action = 'refund_employer'
                 LIMIT 1
                 FOR UPDATE`,
                [id]
            );
            if (Array.isArray(already) && already.length) {
                await conn.rollback();
                req.flash('error_msg', 'Refund already processed for this dispute');
                return res.redirect(`${basePath}/${id}`);
            }

            employerId = Number(d.employer_id);
            freelancerId = Number(d.freelancer_id);
            jobId = Number(d.job_id);
            jobTitle = d.job_title ? String(d.job_title) : 'Job';
            jobType = d.job_type ? String(d.job_type).toLowerCase() : 'fixed_price';

            // Refund logic:
            // - Fixed: refund employer balance (admin decision), record refund tx.
            // - Hourly: reduce proposal.pending_balance if possible and mark pending transactions refunded/failed.
            if (jobType === 'hourly') {
                const pending = Number(d.pending_balance || 0);
                if (!(pending >= amount)) {
                    await conn.rollback();
                    req.flash('error_msg', 'Refund amount exceeds proposal pending balance');
                    return res.redirect(`${basePath}/${id}`);
                }

                await conn.query('UPDATE proposals SET pending_balance = pending_balance - ? WHERE id = ? AND pending_balance >= ?', [amount, d.proposal_id, amount]);
                await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, employerId]);

                // If pending is fully cleared, reset hourly counters for a fresh next cycle
                try {
                    const pendingAfter = pending - amount;
                    if (!(pendingAfter > 0)) {
                        await conn.query(
                            `UPDATE proposals
                             SET total_seconds_worked = 0,
                                 paid_seconds = 0,
                                 timer_status = 'stopped',
                                 timer_start_time = NULL,
                                 last_sync_time = NULL
                             WHERE id = ?`,
                            [d.proposal_id]
                        );
                    }
                } catch (_) {}

                await conn.query(
                    `UPDATE transactions
                     SET status = 'refunded', description = CONCAT(description, ' [Refunded by Admin]')
                     WHERE user_id = ? AND status = 'pending' AND type = 'payment' AND description LIKE ?`,
                    [employerId, `%${jobTitle}%`]
                );
                await conn.query(
                    `UPDATE transactions
                     SET status = 'failed', description = CONCAT(description, ' [Refunded by Admin]')
                     WHERE user_id = ? AND status = 'pending' AND type = 'payment' AND description LIKE ?`,
                    [freelancerId, `%${jobTitle}%`]
                );
            } else {
                await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, employerId]);
                await conn.query(
                    `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                     VALUES (?, ?, 'refund', 'completed', ?, NOW())`,
                    [employerId, amount, `Admin refund (dispute #${id}) for job: ${jobTitle}`]
                );

                // Sync fixed escrow state
                await conn.query(
                    `UPDATE proposals SET is_deposited = 0 WHERE id = ?`,
                    [d.proposal_id]
                );
            }

            await logDisputeAction(conn, id, adminUser.id, 'refund_employer', { amount, job_type: jobType });

            await conn.query(
                `UPDATE disputes
                 SET status = 'resolved', admin_id = ?
                 WHERE id = ?`,
                [adminUser.id, id]
            );
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        try {
            if (Number.isFinite(employerId) && employerId > 0) {
                const formattedAmount = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                await NotificationService.createPersonal(
                    employerId,
                    'Refund Approved',
                    `Admin approved a refund of ${formattedAmount} Diamonds for: ${jobTitle}.`,
                    'success',
                    `/employer/messages?to=${encodeURIComponent(String(freelancerId || ''))}&job=${encodeURIComponent(String(jobId || ''))}`
                );
            }
        } catch (_) {}
        // DO NOT notify Freelancer about the refund decision to protect employer's privacy
        // try {
        //     if (Number.isFinite(freelancerId) && freelancerId > 0) {
        //         const formattedAmount = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        //         await NotificationService.createPersonal(
        //             freelancerId,
        //             'Dispute Decision',
        //             `Admin refunded the employer ${formattedAmount} Credits for: ${jobTitle}.`,
        //             'warning',
        //             `/freelancer/messages?to=${encodeURIComponent(String(employerId || ''))}&job=${encodeURIComponent(String(jobId || ''))}`
        //         );
        //     }
        // } catch (_) {}

        req.flash('success_msg', 'Refund processed');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to refund');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.disputePayFreelancer = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const basePath = getAdminDisputeBasePath(req);
        const id = Number(req.params.id);
        const amountRaw = Number(req.body && req.body.amount ? req.body.amount : 0);
        const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? Math.round(amountRaw * 100) / 100 : 0;
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid dispute id');
            return res.redirect(basePath);
        }
        if (!(amount > 0)) {
            req.flash('error_msg', 'Invalid payment amount');
            return res.redirect(`${basePath}/${id}`);
        }

        let employerId = null;
        let freelancerId = null;
        let jobId = null;
        let jobTitle = 'Job';

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                `SELECT d.*, j.title AS job_title, j.employer_id, j.job_type,
                        p.freelancer_id, p.pending_balance
                 FROM disputes d
                 LEFT JOIN jobs j ON j.id = d.job_id
                 LEFT JOIN proposals p ON p.id = d.proposal_id
                 WHERE d.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [id]
            );
            const d = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!d) {
                await conn.rollback();
                req.flash('error_msg', 'Dispute not found');
                return res.redirect(basePath);
            }

            if (String(d.status || '') === 'resolved' || String(d.status || '') === 'rejected') {
                await conn.rollback();
                req.flash('error_msg', 'This dispute is already closed');
                return res.redirect(`${basePath}/${id}`);
            }

            const [already] = await conn.query(
                `SELECT id
                 FROM dispute_actions
                 WHERE dispute_id = ? AND action = 'pay_freelancer'
                 LIMIT 1
                 FOR UPDATE`,
                [id]
            );
            if (Array.isArray(already) && already.length) {
                await conn.rollback();
                req.flash('error_msg', 'Payment already processed for this dispute');
                return res.redirect(`${basePath}/${id}`);
            }

            employerId = Number(d.employer_id);
            freelancerId = Number(d.freelancer_id);
            jobId = Number(d.job_id);
            jobTitle = d.job_title ? String(d.job_title) : 'Job';
            const jobType = d.job_type ? String(d.job_type).toLowerCase() : 'fixed_price';

            if (jobType === 'hourly') {
                const pending = Number(d.pending_balance || 0);
                if (!(pending >= amount)) {
                    await conn.rollback();
                    req.flash('error_msg', 'Payment amount exceeds proposal pending balance');
                    return res.redirect(`${basePath}/${id}`);
                }

                // Move pending balance to freelancer
                await conn.query('UPDATE proposals SET pending_balance = pending_balance - ? WHERE id = ? AND pending_balance >= ?', [amount, d.proposal_id, amount]);
                await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, freelancerId]);

                // If pending is fully cleared, reset hourly counters for a fresh next cycle
                try {
                    const pendingAfter = pending - amount;
                    if (!(pendingAfter > 0)) {
                        await conn.query(
                            `UPDATE proposals
                             SET total_seconds_worked = 0,
                                 paid_seconds = 0,
                                 timer_status = 'stopped',
                                 timer_start_time = NULL,
                                 last_sync_time = NULL
                             WHERE id = ?`,
                            [d.proposal_id]
                        );
                    }
                } catch (_) {}
                await conn.query(
                    `UPDATE transactions
                     SET status = 'completed', description = CONCAT(description, ' [Released by Admin]')
                     WHERE user_id = ? AND status = 'pending' AND type = 'payment' AND description LIKE ?`,
                    [freelancerId, `%${jobTitle}%`]
                );
                await conn.query(
                    `UPDATE transactions
                     SET status = 'refunded', description = CONCAT(description, ' [Released by Admin]')
                     WHERE user_id = ? AND status = 'pending' AND type = 'payment' AND description LIKE ?`,
                    [employerId, `%${jobTitle}%`]
                );
            } else {
                // For fixed, admin pays freelancer from platform balance (no platform ledger here). We just credit freelancer and record transaction.
                await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, freelancerId]);
                await conn.query(
                    `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                     VALUES (?, ?, 'payment', 'completed', ?, NOW())`,
                    [freelancerId, amount, `Admin payment (dispute #${id}) for job: ${jobTitle}`]
                );

                // Sync fixed escrow state
                await conn.query(
                    `UPDATE proposals SET is_deposited = 2 WHERE id = ?`,
                    [d.proposal_id]
                );
            }

            await logDisputeAction(conn, id, adminUser.id, 'pay_freelancer', { amount, job_type: jobType });

            await conn.query(
                `UPDATE disputes
                 SET status = 'resolved', admin_id = ?
                 WHERE id = ?`,
                [adminUser.id, id]
            );
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        try {
            if (Number.isFinite(freelancerId) && freelancerId > 0) {
                const formattedAmount = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                await NotificationService.createPersonal(
                    freelancerId,
                    'Payment Released',
                    `Admin released ${formattedAmount} Credits to you for: ${jobTitle}.`,
                    'success',
                    `/freelancer/messages?to=${encodeURIComponent(String(employerId || ''))}&job=${encodeURIComponent(String(jobId || ''))}`
                );
            }
        } catch (_) {}
        try {
            if (Number.isFinite(employerId) && employerId > 0) {
                const formattedAmount = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                await NotificationService.createPersonal(
                    employerId,
                    'Dispute Decision',
                    `Admin released ${formattedAmount} Credits to the freelancer for: ${jobTitle}.`,
                    'info',
                    `/employer/messages?to=${encodeURIComponent(String(freelancerId || ''))}&job=${encodeURIComponent(String(jobId || ''))}`
                );
            }
        } catch (_) {}

        req.flash('success_msg', 'Payment processed');
        return res.redirect(`${basePath}/${id}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to pay');
        return res.redirect(getAdminDisputeBasePath(req));
    }
};

exports.securityPage = async (req, res) => {
    try {
        let rules = [];
        try {
            const [rows] = await db.query(
                `SELECT id, pattern, match_type, mask_with, apply_globally, apply_selected_pages, is_active, created_at, updated_at
                 FROM content_filter_rules
                 ORDER BY id DESC`
            );
            rules = Array.isArray(rows) ? rows : [];
        } catch (err) {
            rules = [];
        }

        const rulePagesMap = {};
        try {
            const [pageRows] = await db.query(
                `SELECT rule_id, page_key FROM content_filter_rule_pages`
            );
            (Array.isArray(pageRows) ? pageRows : []).forEach((r) => {
                const ruleId = r && r.rule_id !== undefined ? String(r.rule_id) : '';
                const pageKey = r && r.page_key ? String(r.page_key) : '';
                if (!ruleId || !pageKey) return;
                if (!rulePagesMap[ruleId]) rulePagesMap[ruleId] = [];
                rulePagesMap[ruleId].push(pageKey);
            });
        } catch (err) {}

        // Load account limit settings
        let accountLimits = {
            enabled: true,
            max_per_device: 3,
            max_per_ip: 5,
            max_per_ip_per_day: 10,
            message: 'Registration is not allowed. You have reached the maximum number of accounts allowed from your device or network. This is a platform policy to prevent abuse.'
        };
        try {
            const keys = ['account_limit_enabled','max_accounts_per_device','max_accounts_per_ip','max_signups_per_ip_per_day','account_limit_message'];
            const [settingRows] = await db.query('SELECT `key`, `value` FROM platform_settings WHERE `key` IN (?)', [keys]);
            const map = {};
            (Array.isArray(settingRows) ? settingRows : []).forEach(r => { map[r.key] = r.value; });
            if (map['account_limit_enabled'] !== undefined) accountLimits.enabled = map['account_limit_enabled'] === '1';
            if (map['max_accounts_per_device']) accountLimits.max_per_device = parseInt(map['max_accounts_per_device']) || 3;
            if (map['max_accounts_per_ip']) accountLimits.max_per_ip = parseInt(map['max_accounts_per_ip']) || 5;
            if (map['max_signups_per_ip_per_day']) accountLimits.max_per_ip_per_day = parseInt(map['max_signups_per_ip_per_day']) || 10;
            if (map['account_limit_message']) accountLimits.message = map['account_limit_message'];
        } catch (err) {}

        const availablePages = [
            { key: 'jobs_guest_list', label: 'Jobs - Guest List' },
            { key: 'jobs_freelancer_list', label: 'Jobs - Freelancer List' },
            { key: 'jobs_guest_detail', label: 'Jobs - Guest Detail' },
            { key: 'jobs_freelancer_detail', label: 'Jobs - Freelancer Detail' }
        ];

        return res.render('admin/security', {
            user: req.session.user,
            rules,
            rulePagesMap,
            availablePages,
            accountLimits,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.saveAccountLimits = async (req, res) => {
    try {
        const enabled = req.body.account_limit_enabled ? '1' : '0';
        const max_per_device = Math.max(1, parseInt(req.body.max_accounts_per_device) || 3);
        const max_per_ip = Math.max(1, parseInt(req.body.max_accounts_per_ip) || 5);
        const max_per_day = Math.max(1, parseInt(req.body.max_signups_per_ip_per_day) || 10);
        const message = (req.body.account_limit_message || '').trim().slice(0, 500) ||
            'Registration is not allowed. You have reached the maximum number of accounts allowed from your device or network.';

        const updates = [
            ['account_limit_enabled', enabled],
            ['max_accounts_per_device', String(max_per_device)],
            ['max_accounts_per_ip', String(max_per_ip)],
            ['max_signups_per_ip_per_day', String(max_per_day)],
            ['account_limit_message', message]
        ];

        for (const [key, value] of updates) {
            await db.query(
                'INSERT INTO platform_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                [key, value, value]
            );
        }

        req.flash('success_msg', 'Account limit settings saved.');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to save settings.');
    }
    res.redirect('/admin/security#pane-account-limits');
};

exports.createContentFilterRule = async (req, res) => {
    try {
        const pattern = (req.body && req.body.pattern) ? String(req.body.pattern).trim() : '';
        const matchTypeRaw = (req.body && req.body.match_type) ? String(req.body.match_type).trim().toLowerCase() : 'keyword';
        const match_type = (matchTypeRaw === 'regex') ? 'regex' : 'keyword';
        const mask_with = (req.body && req.body.mask_with) ? String(req.body.mask_with) : '***';
        const apply_globally = (req.body && req.body.apply_globally) ? 1 : 0;
        const apply_selected_pages = apply_globally ? 0 : ((req.body && req.body.apply_selected_pages) ? 1 : 1);
        const is_active = (req.body && req.body.is_active) ? 1 : 0;

        if (!pattern) {
            req.flash('error_msg', 'Pattern is required');
            return res.redirect('/admin/security');
        }

        const [result] = await db.query(
            `INSERT INTO content_filter_rules (pattern, match_type, mask_with, apply_globally, apply_selected_pages, is_active)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [pattern, match_type, mask_with || '***', apply_globally, apply_selected_pages, is_active]
        );

        const ruleId = result && result.insertId ? Number(result.insertId) : null;
        const pages = Array.isArray(req.body && req.body.pages) ? req.body.pages : ((req.body && req.body.pages) ? [req.body.pages] : []);

        if (ruleId && apply_selected_pages && pages.length) {
            const cleaned = pages.map((p) => String(p).trim()).filter(Boolean);
            if (cleaned.length) {
                const values = cleaned.map((p) => [ruleId, p]);
                await db.query('INSERT INTO content_filter_rule_pages (rule_id, page_key) VALUES ?', [values]);
            }
        }

        req.flash('success_msg', 'Content filter rule created');
        return res.redirect('/admin/security');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to create rule');
        return res.redirect('/admin/security');
    }
};

exports.updateContentFilterRule = async (req, res) => {
    try {
        const ruleId = Number(req.params.id);
        if (!Number.isFinite(ruleId) || ruleId <= 0) {
            req.flash('error_msg', 'Invalid rule id');
            return res.redirect('/admin/security');
        }

        const pattern = (req.body && req.body.pattern) ? String(req.body.pattern).trim() : '';
        const matchTypeRaw = (req.body && req.body.match_type) ? String(req.body.match_type).trim().toLowerCase() : 'keyword';
        const match_type = (matchTypeRaw === 'regex') ? 'regex' : 'keyword';
        const mask_with = (req.body && req.body.mask_with) ? String(req.body.mask_with) : '***';
        const apply_globally = (req.body && req.body.apply_globally) ? 1 : 0;
        const apply_selected_pages = apply_globally ? 0 : ((req.body && req.body.apply_selected_pages) ? 1 : 1);
        const is_active = (req.body && req.body.is_active) ? 1 : 0;

        if (!pattern) {
            req.flash('error_msg', 'Pattern is required');
            return res.redirect('/admin/security');
        }

        await db.query(
            `UPDATE content_filter_rules
             SET pattern = ?, match_type = ?, mask_with = ?, apply_globally = ?, apply_selected_pages = ?, is_active = ?
             WHERE id = ?`,
            [pattern, match_type, mask_with || '***', apply_globally, apply_selected_pages, is_active, ruleId]
        );

        try {
            await db.query('DELETE FROM content_filter_rule_pages WHERE rule_id = ?', [ruleId]);
        } catch (err) {
        }

        const pages = Array.isArray(req.body && req.body.pages) ? req.body.pages : ((req.body && req.body.pages) ? [req.body.pages] : []);
        if (apply_selected_pages && pages.length) {
            const cleaned = pages.map((p) => String(p).trim()).filter(Boolean);
            if (cleaned.length) {
                const values = cleaned.map((p) => [ruleId, p]);
                await db.query('INSERT INTO content_filter_rule_pages (rule_id, page_key) VALUES ?', [values]);
            }
        }

        req.flash('success_msg', 'Rule updated');
        return res.redirect('/admin/security');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to update rule');
        return res.redirect('/admin/security');
    }
};

exports.deleteContentFilterRule = async (req, res) => {
    try {
        const ruleId = Number(req.params.id);
        if (!Number.isFinite(ruleId) || ruleId <= 0) {
            req.flash('error_msg', 'Invalid rule id');
            return res.redirect('/admin/security');
        }

        try {
            await db.query('DELETE FROM content_filter_rule_pages WHERE rule_id = ?', [ruleId]);
        } catch (err) {
        }

        await db.query('DELETE FROM content_filter_rules WHERE id = ?', [ruleId]);
        req.flash('success_msg', 'Rule deleted');
        return res.redirect('/admin/security');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to delete rule');
        return res.redirect('/admin/security');
    }
};

exports.withdrawalsPage = async (req, res) => {
    try {
        const perPage = 20;
        const rawPage = Number(req.query && req.query.page ? req.query.page : 1);
        const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

        const statusRaw = (req.query && req.query.status) ? String(req.query.status).trim().toLowerCase() : '';
        const roleRaw = (req.query && req.query.role) ? String(req.query.role).trim().toLowerCase() : '';
        const qRaw = (req.query && req.query.q) ? String(req.query.q).trim() : '';
        const monthRaw = parseInt(req.query && req.query.month) || 0;
        const yearRaw  = parseInt(req.query && req.query.year)  || 0;

        const allowedStatus = new Set(['pending', 'approved', 'paid', 'rejected', 'cancelled']);
        const allowedRole = new Set(['freelancer', 'employer']);

        const status = allowedStatus.has(statusRaw) ? statusRaw : '';
        const role = allowedRole.has(roleRaw) ? roleRaw : '';
        const q = qRaw.length ? qRaw.slice(0, 190) : '';
        const month = (monthRaw >= 1 && monthRaw <= 12) ? monthRaw : 0;
        const year  = (yearRaw  >= 2020 && yearRaw <= 2100) ? yearRaw : 0;

        const where = [];
        const params = [];

        if (status) {
            where.push('wr.status = ?');
            params.push(status);
        }

        if (role) {
            where.push('wr.role = ?');
            params.push(role);
        }

        if (q) {
            where.push('(wr.paypal_email LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)');
            params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
        }

        if (year) {
            where.push('YEAR(wr.created_at) = ?');
            params.push(year);
        }

        if (month) {
            where.push('MONTH(wr.created_at) = ?');
            params.push(month);
        }

        const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

        // Build date filter for stats cards
        const statsWhere = [];
        const statsParams = [];
        statsWhere.push("status = 'paid'");
        if (year)  { statsWhere.push('YEAR(created_at) = ?');  statsParams.push(year); }
        if (month) { statsWhere.push('MONTH(created_at) = ?'); statsParams.push(month); }
        const statsWhereSql = 'WHERE ' + statsWhere.join(' AND ');

        let totalPaid = 0;
        let totalPaidFreelancer = 0;
        let totalPaidEmployer = 0;
        try {
            const [paidRows] = await db.query(
                `SELECT COALESCE(SUM(net_credits), 0) AS total_paid
                 FROM withdraw_requests
                 ${statsWhereSql}`,
                statsParams
            );
            totalPaid = (Array.isArray(paidRows) && paidRows[0] && paidRows[0].total_paid !== undefined)
                ? Number(paidRows[0].total_paid)
                : 0;
            if (!Number.isFinite(totalPaid)) totalPaid = 0;
        } catch (err) {
            totalPaid = 0;
        }

        try {
            const [paidRoleRows] = await db.query(
                `SELECT role, COALESCE(SUM(net_credits), 0) AS total_paid
                 FROM withdraw_requests
                 ${statsWhereSql}
                 GROUP BY role`,
                statsParams
            );

            (Array.isArray(paidRoleRows) ? paidRoleRows : []).forEach((r) => {
                const role = r && r.role ? String(r.role).toLowerCase() : '';
                const val = (r && r.total_paid !== undefined) ? Number(r.total_paid) : 0;
                const safeVal = Number.isFinite(val) ? val : 0;
                if (role === 'freelancer') totalPaidFreelancer = safeVal;
                if (role === 'employer') totalPaidEmployer = safeVal;
            });
        } catch (err) {
            totalPaidFreelancer = 0;
            totalPaidEmployer = 0;
        }

        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM withdraw_requests wr
             LEFT JOIN users u ON u.id = wr.user_id
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
            `SELECT wr.id, wr.user_id, wr.role, wr.method, wr.paypal_email,
                    wr.amount_credits, wr.fee_credits, wr.net_credits,
                    wr.status, wr.transaction_id, wr.processed_by, wr.admin_note,
                    wr.payout_txid, wr.created_at, wr.approved_at, wr.paid_at, wr.rejected_at,
                    u.email AS user_email, u.full_name AS user_full_name,
                    t.status AS tx_status, t.created_at AS tx_created_at
             FROM withdraw_requests wr
             LEFT JOIN users u ON u.id = wr.user_id
             LEFT JOIN transactions t ON t.id = wr.transaction_id
             ${whereSql}
             ORDER BY wr.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        return res.render('admin/withdrawals', {
            user: req.session.user,
            withdrawals: Array.isArray(rows) ? rows : [],
            query: {
                status: status || '',
                role: role || '',
                q: q || '',
                month: month || '',
                year: year || ''
            },
            totalPaid,
            totalPaidFreelancer,
            totalPaidEmployer,
            pagination: {
                page: safePage,
                perPage,
                total,
                totalPages
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.approveWithdrawal = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid withdrawal id');
            return res.redirect('/admin/withdrawals');
        }

        const conn = await db.getConnection();
        let wr = null;
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                'SELECT * FROM withdraw_requests WHERE id = ? FOR UPDATE',
                [id]
            );
            wr = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!wr) {
                await conn.rollback();
                req.flash('error_msg', 'Withdrawal request not found');
                return res.redirect('/admin/withdrawals');
            }

            const currentStatus = wr.status ? String(wr.status).toLowerCase() : '';
            if (currentStatus !== 'pending') {
                await conn.rollback();
                req.flash('error_msg', 'Only pending requests can be approved');
                return res.redirect('/admin/withdrawals');
            }

            await conn.query(
                `UPDATE withdraw_requests
                 SET status = 'approved', processed_by = ?, approved_at = NOW()
                 WHERE id = ?`,
                [adminUser.id, id]
            );

            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (e) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        try {
            const role = wr && wr.role ? String(wr.role).toLowerCase() : 'freelancer';
            const link = `/${role}/withdraw`;
            await NotificationService.createPersonal(
                Number(wr.user_id),
                'Withdrawal Approved',
                `Your withdrawal request for ${wr.amount_credits} Credits to PayPal (${wr.paypal_email}) has been approved. Our team will process the payout shortly.`,
                'info',
                link
            );
        } catch (notifyErr) {
        }

        req.flash('success_msg', `Withdrawal #${id} approved`);
        return res.redirect('/admin/withdrawals');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to approve withdrawal');
        return res.redirect('/admin/withdrawals');
    }
};

exports.rejectWithdrawal = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid withdrawal id');
            return res.redirect('/admin/withdrawals');
        }

        const adminNoteRaw = (req.body && req.body.admin_note) ? String(req.body.admin_note) : '';
        const admin_note = adminNoteRaw.trim().slice(0, 255);

        const conn = await db.getConnection();
        let wr = null;
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                'SELECT * FROM withdraw_requests WHERE id = ? FOR UPDATE',
                [id]
            );
            wr = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!wr) {
                await conn.rollback();
                req.flash('error_msg', 'Withdrawal request not found');
                return res.redirect('/admin/withdrawals');
            }

            const currentStatus = wr.status ? String(wr.status).toLowerCase() : '';
            if (currentStatus === 'paid' || currentStatus === 'rejected' || currentStatus === 'cancelled') {
                await conn.rollback();
                req.flash('error_msg', 'This request can no longer be rejected');
                return res.redirect('/admin/withdrawals');
            }

            const amount = Number(wr.amount_credits);
            if (!Number.isFinite(amount) || amount <= 0) {
                await conn.rollback();
                req.flash('error_msg', 'Invalid withdrawal amount');
                return res.redirect('/admin/withdrawals');
            }

            const [uUpd] = await conn.query(
                'UPDATE users SET locked_balance = locked_balance - ?, balance = balance + ? WHERE id = ? AND locked_balance >= ?',
                [amount, amount, wr.user_id, amount]
            );
            const affected = uUpd && typeof uUpd.affectedRows === 'number' ? uUpd.affectedRows : 0;
            if (affected < 1) {
                await conn.rollback();
                req.flash('error_msg', 'User locked balance is insufficient to unlock');
                return res.redirect('/admin/withdrawals');
            }

            await conn.query(
                `UPDATE withdraw_requests
                 SET status = 'rejected', processed_by = ?, rejected_at = NOW(), admin_note = ?
                 WHERE id = ?`,
                [adminUser.id, admin_note || null, id]
            );

            if (wr.transaction_id) {
                await conn.query(
                    "UPDATE transactions SET status = 'failed' WHERE id = ?",
                    [wr.transaction_id]
                );
            }

            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (e) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        try {
            const role = wr && wr.role ? String(wr.role).toLowerCase() : 'freelancer';
            const link = `/${role}/withdraw`;
            const reason = admin_note ? ` Reason: ${admin_note}` : '';
            const msg = `Your withdrawal request for ${wr.amount_credits} Credits to PayPal (${wr.paypal_email}) has been rejected.${reason} The reserved funds have been released back to your available balance.`;
            await NotificationService.createPersonal(
                Number(wr.user_id),
                'Withdrawal Rejected',
                msg,
                'warning',
                link
            );
        } catch (notifyErr) {
        }

        req.flash('success_msg', `Withdrawal #${id} rejected and funds unlocked`);
        return res.redirect('/admin/withdrawals');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to reject withdrawal');
        return res.redirect('/admin/withdrawals');
    }
};

exports.markWithdrawalPaid = async (req, res) => {
    try {
        const adminUser = req.session.user;
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            req.flash('error_msg', 'Invalid withdrawal id');
            return res.redirect('/admin/withdrawals');
        }

        const payoutTxidRaw = (req.body && req.body.payout_txid) ? String(req.body.payout_txid) : '';
        const payout_txid = payoutTxidRaw.trim().slice(0, 100);

        const adminNoteRaw = (req.body && req.body.admin_note) ? String(req.body.admin_note) : '';
        const admin_note = adminNoteRaw.trim().slice(0, 255);

        const conn = await db.getConnection();
        let wr = null;
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                'SELECT * FROM withdraw_requests WHERE id = ? FOR UPDATE',
                [id]
            );
            wr = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!wr) {
                await conn.rollback();
                req.flash('error_msg', 'Withdrawal request not found');
                return res.redirect('/admin/withdrawals');
            }

            const currentStatus = wr.status ? String(wr.status).toLowerCase() : '';
            if (currentStatus === 'paid') {
                await conn.rollback();
                req.flash('error_msg', 'This request is already paid');
                return res.redirect('/admin/withdrawals');
            }
            if (currentStatus === 'rejected' || currentStatus === 'cancelled') {
                await conn.rollback();
                req.flash('error_msg', 'This request can no longer be paid');
                return res.redirect('/admin/withdrawals');
            }

            const amount = Number(wr.amount_credits);
            if (!Number.isFinite(amount) || amount <= 0) {
                await conn.rollback();
                req.flash('error_msg', 'Invalid withdrawal amount');
                return res.redirect('/admin/withdrawals');
            }

            const [uUpd] = await conn.query(
                'UPDATE users SET locked_balance = locked_balance - ? WHERE id = ? AND locked_balance >= ?',
                [amount, wr.user_id, amount]
            );
            const affected = uUpd && typeof uUpd.affectedRows === 'number' ? uUpd.affectedRows : 0;
            if (affected < 1) {
                await conn.rollback();
                req.flash('error_msg', 'User locked balance is insufficient to mark paid');
                return res.redirect('/admin/withdrawals');
            }

            await conn.query(
                `UPDATE withdraw_requests
                 SET status = 'paid', processed_by = ?, paid_at = NOW(), payout_txid = ?, admin_note = ?
                 WHERE id = ?`,
                [adminUser.id, payout_txid ? payout_txid : null, admin_note || null, id]
            );

            if (wr.transaction_id) {
                await conn.query(
                    "UPDATE transactions SET status = 'completed' WHERE id = ?",
                    [wr.transaction_id]
                );
            }

            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (e) {}
            throw err;
        } finally {
            if (conn) conn.release();
        }

        try {
            const role = wr && wr.role ? String(wr.role).toLowerCase() : 'freelancer';
            const link = `/${role}/withdraw`;
            await NotificationService.createPersonal(
                Number(wr.user_id),
                'Withdrawal Paid',
                `Your withdrawal request for ${wr.amount_credits} Credits to PayPal (${wr.paypal_email}) has been paid successfully.${payout_txid ? (' Payout TXID: ' + payout_txid + '.') : ''}`,
                'success',
                link
            );
        } catch (notifyErr) {
        }

        req.flash('success_msg', `Withdrawal #${id} marked as paid`);
        return res.redirect('/admin/withdrawals');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to mark withdrawal paid');
        return res.redirect('/admin/withdrawals');
    }
};

exports.menus = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 3;
        const offset = (page - 1) * limit;

        const [menus] = await db.query('SELECT * FROM menus LIMIT ? OFFSET ?', [limit, offset]);
        const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM menus');

        const totalPages = Math.ceil(total / limit);

        const requestedMenuId = Number(req.query.id);
        const selectedMenuId = (Number.isFinite(requestedMenuId) && requestedMenuId > 0)
            ? requestedMenuId
            : (Array.isArray(menus) && menus.length ? Number(menus[0].id) : null);

        const rawItemsPage = Number(req.query.items_page);
        let itemsPage = Number.isFinite(rawItemsPage) && rawItemsPage > 0 ? Math.floor(rawItemsPage) : 1;
        const itemsLimit = 10;
        let itemsOffset = (itemsPage - 1) * itemsLimit;

        let menuItems = [];
        let itemsTotalPages = 1;
        let itemsTotal = 0;

        {
            const [countRows] = await db.query(
                'SELECT COUNT(*) as total FROM menu_items'
            );
            const itemsCount = Array.isArray(countRows) && countRows.length ? Number(countRows[0].total) : 0;
            itemsTotal = Number.isFinite(itemsCount) ? itemsCount : 0;
            itemsTotalPages = Math.max(1, Math.ceil(itemsTotal / itemsLimit));

            if (itemsPage > itemsTotalPages) {
                itemsPage = itemsTotalPages;
                itemsOffset = (itemsPage - 1) * itemsLimit;
            }

            const [itemsRows] = await db.query(
                `SELECT mi.*, m.name AS menu_name, m.code AS menu_code
                 FROM menu_items mi
                 LEFT JOIN menus m ON m.id = mi.menu_id
                 ORDER BY mi.menu_id ASC, mi.sort_order ASC, mi.id ASC
                 LIMIT ? OFFSET ?`,
                [itemsLimit, itemsOffset]
            );
            menuItems = Array.isArray(itemsRows) ? itemsRows : [];
        }

        let allMenus = [];
        try {
            const [allMenusRows] = await db.query('SELECT id, name, code, is_active FROM menus ORDER BY id ASC');
            allMenus = Array.isArray(allMenusRows) ? allMenusRows : [];
        } catch (err) {
            allMenus = [];
        }

        const menuLocations = {
            header: {},
            footer: {},
            body: {},
        };
        try {
            const [locRows] = await db.query('SELECT location, role, menu_id FROM menu_locations');
            (Array.isArray(locRows) ? locRows : []).forEach((r) => {
                const location = r && r.location ? String(r.location).toLowerCase() : '';
                const role = r && r.role ? String(r.role).toLowerCase() : '';
                const menuId = r && r.menu_id ? Number(r.menu_id) : null;
                if (!menuLocations[location]) return;
                if (!role || !Number.isFinite(menuId) || menuId <= 0) return;
                menuLocations[location][role] = menuId;
            });
        } catch (err) {
            // table may not exist yet; ignore
        }

        res.render("admin/menus", {
            user: req.session.user,
            menus: menus,
            currentPage: page,
            totalPages: totalPages,
            selectedMenuId,
            menuItems,
            itemsCurrentPage: itemsPage,
            itemsTotalPages,
            itemsTotal,
            allMenus,
            menuLocations
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching menus');
    }
};

exports.saveMenuLocations = async (req, res) => {
    try {
        const allowedLocations = new Set(['header', 'footer', 'body']);
        const allowedRoles = new Set(['guest', 'employer', 'freelancer', 'admin']);

        const body = req.body || {};
        const entries = [];

        Object.keys(body).forEach((k) => {
            if (!k.startsWith('map_')) return;
            const parts = k.split('_');
            if (parts.length !== 3) return;
            const location = String(parts[1] || '').toLowerCase();
            const role = String(parts[2] || '').toLowerCase();
            if (!allowedLocations.has(location) || !allowedRoles.has(role)) return;
            const raw = body[k];
            const menuId = raw === '' || raw === null || typeof raw === 'undefined' ? null : Number(raw);
            entries.push({ location, role, menuId: Number.isFinite(menuId) && menuId > 0 ? menuId : null });
        });

        for (const e of entries) {
            if (!e.menuId) {
                await db.execute('DELETE FROM menu_locations WHERE location = ? AND role = ?', [e.location, e.role]);
                continue;
            }
            await db.execute(
                'INSERT INTO menu_locations (location, role, menu_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id)',
                [e.location, e.role, e.menuId]
            );
        }

        req.flash('success_msg', 'Menu locations updated successfully');
        return res.redirect('/admin/menus');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Failed to update menu locations');
        return res.redirect('/admin/menus');
    }
};

exports.updateMenu = async (req, res) => {
    try {
        const menuId = req.params.id;
        const { name, code, is_active } = req.body;

        if (!name || !code) {
            return res.redirect(`/admin/menus/edit/${menuId}`);
        }

        await db.execute(
            'UPDATE menus SET name = ?, code = ?, is_active = ? WHERE id = ?',
            [name, code, is_active === 'on' ? 1 : 0, menuId]
        );

        return res.redirect('/admin/menus');
    } catch (error) {
        console.error(error);
        return res.redirect(`/admin/menus/edit/${req.params.id}`);
    }
};

exports.createMenu = (req, res) => {
    res.render("admin/create-menu", { user: req.session.user });
};

exports.editMenu = async (req, res) => {
    try {
        const menuId = req.params.id;
        const [rows] = await db.query('SELECT * FROM menus WHERE id = ? LIMIT 1', [menuId]);
        const menu = Array.isArray(rows) && rows.length ? rows[0] : null;

        if (!menu) {
            return res.redirect('/admin/menus');
        }

        return res.render('admin/edit-menu', {
            user: req.session.user,
            menu
        });
    } catch (error) {
        console.error(error);
        return res.redirect('/admin/menus');
    }
};

exports.storeMenu = async (req, res) => {
    try {
        const { name, code, is_active } = req.body;

        if (!name || !code) {
            req.flash('error_msg', 'Name and Code are required');
            return res.redirect('/admin/menus/create');
        }

        await db.execute('INSERT INTO menus (name, code, is_active) VALUES (?, ?, ?)', [
            name,
            code,
            is_active === 'on' ? 1 : 0
        ]);

        req.flash('success_msg', 'Menu created successfully');
        res.redirect('/admin/menus');
    } catch (error) {
        console.error(error);
        if (error.code === 'ER_DUP_ENTRY') {
            req.flash('error_msg', 'Menu code must be unique');
            return res.redirect('/admin/menus/create');
        }
        req.flash('error_msg', 'Error creating menu');
        return res.redirect('/admin/menus/create');
    }
};

exports.deleteMenu = async (req, res) => {
    try {
        const rawId = req.params.id;
        const menuId = Number(rawId);
        if (!Number.isFinite(menuId) || menuId <= 0) {
            req.flash('error_msg', 'Invalid menu id');
            return res.redirect('/admin/menus');
        }

        // Optional: Delete menu items associated with this menu first to avoid constraint errors
        // or ensure DB has ON DELETE CASCADE
        const [itemsResult] = await db.execute('DELETE FROM menu_items WHERE menu_id = ?', [menuId]);

        const [menuResult] = await db.execute('DELETE FROM menus WHERE id = ?', [menuId]);

        const menuAffected = menuResult && typeof menuResult.affectedRows === 'number' ? menuResult.affectedRows : 0;
        const itemsAffected = itemsResult && typeof itemsResult.affectedRows === 'number' ? itemsResult.affectedRows : 0;

        if (menuAffected === 0) {
            req.flash('error_msg', `Menu not found or not deleted (id=${menuId})`);
            return res.redirect('/admin/menus');
        }

        req.flash('success_msg', `Menu deleted successfully (deleted ${itemsAffected} items)`);
        res.redirect('/admin/menus');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Error deleting menu');
        return res.redirect('/admin/menus');
    }
};

exports.createMenuItem = async (req, res) => {
    try {
        const requestedMenuId = Number(req.query.menu_id);

        const [menus] = await db.query('SELECT * FROM menus ORDER BY id ASC');
        const selectedMenuId = (Number.isFinite(requestedMenuId) && requestedMenuId > 0)
            ? requestedMenuId
            : (Array.isArray(menus) && menus.length ? Number(menus[0].id) : null);

        let parentOptions = [];
        if (selectedMenuId) {
            const [rows] = await db.query(
                'SELECT id, label FROM menu_items WHERE menu_id = ? ORDER BY sort_order ASC, id ASC',
                [selectedMenuId]
            );
            parentOptions = Array.isArray(rows) ? rows : [];
        }

        return res.render('admin/create-menu-item', {
            user: req.session.user,
            menus,
            selectedMenuId,
            parentOptions
        });
    } catch (error) {
        console.error(error);
        return res.redirect('/admin/menus');
    }
};

exports.storeMenuItem = async (req, res) => {
    try {
        const {
            menu_id,
            parent_id,
            label,
            url,
            route_name,
            icon,
            item_type,
            target,
            sort_order,
            is_active,
            requires_auth,
            roles
        } = req.body;

        const menuId = Number(menu_id);
        const parentIdRaw = parent_id === '' || typeof parent_id === 'undefined' ? null : Number(parent_id);
        const parentId = parentIdRaw === null ? null : (Number.isFinite(parentIdRaw) && parentIdRaw > 0 ? parentIdRaw : null);
        const sortOrder = Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0;

        if (!Number.isFinite(menuId) || menuId <= 0 || !label) {
            req.flash('error_msg', 'Menu and Label are required');
            return res.redirect(`/admin/menu-items/create?menu_id=${encodeURIComponent(menuId || '')}`);
        }

        const allowedTypes = new Set(['link', 'dropdown', 'divider', 'header']);
        const allowedTargets = new Set(['_self', '_blank']);
        const safeType = allowedTypes.has(item_type) ? item_type : 'link';
        const safeTarget = allowedTargets.has(target) ? target : '_self';

        const allowedRoles = new Set(['guest', 'employer', 'freelancer', 'admin']);
        const requestedRoles = Array.isArray(roles) ? roles : (roles ? [roles] : []);
        const normalizedRoles = requestedRoles
            .map((r) => String(r).toLowerCase().trim())
            .filter((r) => allowedRoles.has(r));
        const selectedRoles = normalizedRoles.length ? normalizedRoles : ['guest'];

        const [insertResult] = await db.execute(
            'INSERT INTO menu_items (menu_id, parent_id, label, url, route_name, icon, item_type, target, sort_order, is_active, requires_auth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                menuId,
                parentId,
                label,
                url || null,
                route_name || null,
                icon || null,
                safeType,
                safeTarget,
                sortOrder,
                is_active === 'on' ? 1 : 0,
                requires_auth === 'on' ? 1 : 0
            ]
        );

        const itemId = insertResult && insertResult.insertId ? Number(insertResult.insertId) : null;
        if (itemId && selectedRoles.length) {
            const values = selectedRoles.map((r) => [itemId, r]);
            await db.query('INSERT INTO menu_item_roles (menu_item_id, role) VALUES ?', [values]);
        }

        req.flash('success_msg', 'Menu item created successfully');
        return res.redirect(`/admin/menus?id=${encodeURIComponent(menuId)}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Error creating menu item');
        const menuId = Number(req.body && req.body.menu_id);
        return res.redirect(`/admin/menu-items/create?menu_id=${encodeURIComponent(Number.isFinite(menuId) ? menuId : '')}`);
    }
};

exports.editMenuItem = async (req, res) => {
    try {
        const itemId = Number(req.params.id);
        if (!Number.isFinite(itemId) || itemId <= 0) {
            req.flash('error_msg', 'Invalid menu item id');
            return res.redirect('/admin/menus');
        }

        const [rows] = await db.query('SELECT * FROM menu_items WHERE id = ? LIMIT 1', [itemId]);
        const item = Array.isArray(rows) && rows.length ? rows[0] : null;
        if (!item) {
            req.flash('error_msg', 'Menu item not found');
            return res.redirect('/admin/menus');
        }

        const [menus] = await db.query('SELECT * FROM menus ORDER BY id ASC');
        const selectedMenuId = Number(item.menu_id);

        let parentOptions = [];
        if (selectedMenuId) {
            const [parentRows] = await db.query(
                'SELECT id, label FROM menu_items WHERE menu_id = ? AND id <> ? ORDER BY sort_order ASC, id ASC',
                [selectedMenuId, itemId]
            );
            parentOptions = Array.isArray(parentRows) ? parentRows : [];
        }

        const [roleRows] = await db.query('SELECT role FROM menu_item_roles WHERE menu_item_id = ?', [itemId]);
        const selectedRoles = (Array.isArray(roleRows) ? roleRows : [])
            .map((r) => (r && r.role ? String(r.role).toLowerCase() : ''))
            .filter(Boolean);

        return res.render('admin/edit-menu-item', {
            user: req.session.user,
            menus,
            selectedMenuId,
            parentOptions,
            item,
            selectedRoles
        });
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Error loading menu item');
        return res.redirect('/admin/menus');
    }
};

exports.updateMenuItem = async (req, res) => {
    try {
        const itemId = Number(req.params.id);
        if (!Number.isFinite(itemId) || itemId <= 0) {
            req.flash('error_msg', 'Invalid menu item id');
            return res.redirect('/admin/menus');
        }

        const {
            menu_id,
            parent_id,
            label,
            url,
            route_name,
            icon,
            item_type,
            target,
            sort_order,
            is_active,
            requires_auth,
            roles
        } = req.body;

        const menuId = Number(menu_id);
        const parentIdRaw = parent_id === '' || typeof parent_id === 'undefined' ? null : Number(parent_id);
        const parentId = parentIdRaw === null ? null : (Number.isFinite(parentIdRaw) && parentIdRaw > 0 ? parentIdRaw : null);
        const sortOrder = Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0;

        if (!Number.isFinite(menuId) || menuId <= 0 || !label) {
            req.flash('error_msg', 'Menu and Label are required');
            return res.redirect(`/admin/menu-items/edit/${encodeURIComponent(itemId)}`);
        }

        const allowedTypes = new Set(['link', 'dropdown', 'divider', 'header']);
        const allowedTargets = new Set(['_self', '_blank']);
        const safeType = allowedTypes.has(item_type) ? item_type : 'link';
        const safeTarget = allowedTargets.has(target) ? target : '_self';

        const allowedRoles = new Set(['guest', 'employer', 'freelancer', 'admin']);
        const requestedRoles = Array.isArray(roles) ? roles : (roles ? [roles] : []);
        const normalizedRoles = requestedRoles
            .map((r) => String(r).toLowerCase().trim())
            .filter((r) => allowedRoles.has(r));
        const selectedRoles = normalizedRoles.length ? normalizedRoles : ['guest'];

        const [result] = await db.execute(
            'UPDATE menu_items SET menu_id = ?, parent_id = ?, label = ?, url = ?, route_name = ?, icon = ?, item_type = ?, target = ?, sort_order = ?, is_active = ?, requires_auth = ? WHERE id = ?',
            [
                menuId,
                parentId,
                label,
                url || null,
                route_name || null,
                icon || null,
                safeType,
                safeTarget,
                sortOrder,
                is_active === 'on' ? 1 : 0,
                requires_auth === 'on' ? 1 : 0,
                itemId
            ]
        );

        const affected = result && typeof result.affectedRows === 'number' ? result.affectedRows : 0;
        if (affected === 0) {
            req.flash('error_msg', 'Menu item not updated');
            return res.redirect(`/admin/menu-items/edit/${encodeURIComponent(itemId)}`);
        }

        await db.execute('DELETE FROM menu_item_roles WHERE menu_item_id = ?', [itemId]);
        if (selectedRoles.length) {
            const values = selectedRoles.map((r) => [itemId, r]);
            await db.query('INSERT INTO menu_item_roles (menu_item_id, role) VALUES ?', [values]);
        }

        req.flash('success_msg', 'Menu item updated successfully');
        return res.redirect(`/admin/menus?id=${encodeURIComponent(menuId)}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Error updating menu item');
        return res.redirect(`/admin/menu-items/edit/${encodeURIComponent(req.params.id)}`);
    }
};

exports.deleteMenuItem = async (req, res) => {
    try {
        const itemId = Number(req.params.id);
        if (!Number.isFinite(itemId) || itemId <= 0) {
            req.flash('error_msg', 'Invalid menu item id');
            return res.redirect('/admin/menus');
        }

        const [rows] = await db.query('SELECT menu_id FROM menu_items WHERE id = ? LIMIT 1', [itemId]);
        const existing = Array.isArray(rows) && rows.length ? rows[0] : null;
        const menuId = existing ? Number(existing.menu_id) : null;

        await db.execute('DELETE FROM menu_item_roles WHERE menu_item_id = ?', [itemId]);
        const [result] = await db.execute('DELETE FROM menu_items WHERE id = ?', [itemId]);
        const affected = result && typeof result.affectedRows === 'number' ? result.affectedRows : 0;

        if (affected === 0) {
            req.flash('error_msg', 'Menu item not found or not deleted');
            return res.redirect(menuId ? `/admin/menus?id=${encodeURIComponent(menuId)}` : '/admin/menus');
        }

        req.flash('success_msg', 'Menu item deleted successfully');
        return res.redirect(menuId ? `/admin/menus?id=${encodeURIComponent(menuId)}` : '/admin/menus');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Error deleting menu item');
        return res.redirect('/admin/menus');
    }
};

exports.bannersPage = async (req, res) => {
    try {
        const editId = req.query.edit ? Number(req.query.edit) : null;
        const [banners] = await db.query('SELECT * FROM banners ORDER BY position, sort_order ASC');
        const editBanner = editId ? (banners.find(b => b.id === editId) || null) : null;
        res.render('admin/banners', {
            user: req.session.user, banners, editBanner,
            csrfToken: res.locals.csrfToken || '',
            success_msg: req.flash('success_msg'), error_msg: req.flash('error_msg')
        });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.storeBanner = async (req, res) => {
    try {
        const { title, link_url, ad_code, position, sort_order, is_active } = req.body;
        if (!title) { req.flash('error_msg', 'Title is required.'); return res.redirect('/admin/banners'); }
        const hasAdCode = ad_code && ad_code.trim().length > 0;
        if (!req.file && !hasAdCode) { req.flash('error_msg', 'Either an image or ad code is required.'); return res.redirect('/admin/banners'); }
        const image_url = req.file ? '/img/' + req.file.filename : null;
        await db.query(
            'INSERT INTO banners (title, image_url, link_url, ad_code, position, sort_order, is_active) VALUES (?,?,?,?,?,?,?)',
            [title, image_url, link_url || null, hasAdCode ? ad_code.trim() : null, position || 'home_top', parseInt(sort_order) || 0, is_active ? 1 : 0]
        );
        req.flash('success_msg', 'Banner created.');
    } catch (err) { console.error(err); req.flash('error_msg', 'Failed to create banner.'); }
    res.redirect('/admin/banners');
};

exports.updateBanner = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { title, link_url, ad_code, position, sort_order, is_active } = req.body;
        const hasAdCode = ad_code && ad_code.trim().length > 0;
        let image_url = null;
        if (req.file) image_url = '/img/' + req.file.filename;

        if (image_url) {
            await db.query('UPDATE banners SET title=?,image_url=?,link_url=?,ad_code=?,position=?,sort_order=?,is_active=? WHERE id=?',
                [title, image_url, link_url||null, hasAdCode ? ad_code.trim() : null, position||'home_top', parseInt(sort_order)||0, is_active?1:0, id]);
        } else {
            await db.query('UPDATE banners SET title=?,link_url=?,ad_code=?,position=?,sort_order=?,is_active=? WHERE id=?',
                [title, link_url||null, hasAdCode ? ad_code.trim() : null, position||'home_top', parseInt(sort_order)||0, is_active?1:0, id]);
        }
        req.flash('success_msg', 'Banner updated.');
    } catch (err) { console.error(err); req.flash('error_msg', 'Failed to update banner.'); }
    res.redirect('/admin/banners');
};

exports.toggleBanner = async (req, res) => {
    try {
        await db.query('UPDATE banners SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    } catch (err) { req.flash('error_msg', 'Failed to toggle banner.'); }
    res.redirect('/admin/banners');
};

exports.deleteBanner = async (req, res) => {
    try {
        await db.query('DELETE FROM banners WHERE id = ?', [req.params.id]);
        req.flash('success_msg', 'Banner deleted.');
    } catch (err) { req.flash('error_msg', 'Failed to delete banner.'); }
    res.redirect('/admin/banners');
};

exports.transactionsPage = async (req, res) => {
    try {
        const perPage = 25;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;
        const type   = req.query.type   || '';
        const status = req.query.status || '';
        const q      = req.query.q ? String(req.query.q).trim() : '';
        const month  = parseInt(req.query.month) || 0;
        const year   = parseInt(req.query.year)  || 0;

        const where = [];
        const params = [];
        if (type)   { where.push('t.type = ?');   params.push(type); }
        if (status) { where.push('t.status = ?'); params.push(status); }
        if (month)  { where.push('MONTH(t.created_at) = ?'); params.push(month); }
        if (year)   { where.push('YEAR(t.created_at) = ?');  params.push(year); }
        if (q)      { where.push('(u.full_name LIKE ? OR u.email LIKE ?)'); params.push('%'+q+'%','%'+q+'%'); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) as total FROM transactions t LEFT JOIN users u ON u.id = t.user_id ${whereSql}`, params
        );
        const totalPages = Math.ceil(total / perPage);

        const [transactions] = await db.query(
            `SELECT t.id, t.user_id, t.amount, t.type, t.status, t.description, t.created_at,
                    u.full_name, u.email
             FROM transactions t
             LEFT JOIN users u ON u.id = t.user_id
             ${whereSql}
             ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        // Summary by type (filtered, only completed)
        const summaryWhere = where.length ? whereSql + ' AND t.status = \'completed\'' : 'WHERE t.status = \'completed\'';
        const [sumRows] = await db.query(
            `SELECT type, SUM(amount) as total FROM transactions t LEFT JOIN users u ON u.id = t.user_id ${summaryWhere} GROUP BY type`, params
        );
        const summary = { deposit: 0, withdrawal: 0, payment: 0, service_fee: 0, refund: 0 };
        sumRows.forEach(r => { if (summary[r.type] !== undefined) summary[r.type] = r.total; });

        res.render('admin/transactions', {
            user: req.session.user,
            transactions,
            summary,
            query: { type, status, q, month, year },
            pagination: { page, totalPages, total }
        });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.skillsPage = async (req, res) => {
    try {
        const editId = req.query.edit ? Number(req.query.edit) : null;
        const [skills] = await db.query('SELECT * FROM skills ORDER BY name ASC');
        res.render('admin/skills', { user: req.session.user, skills, editId, success_msg: req.flash('success_msg'), error_msg: req.flash('error_msg') });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.storeSkill = async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) { req.flash('error_msg', 'Name is required.'); return res.redirect('/admin/skills'); }
        await db.query('INSERT INTO skills (name) VALUES (?)', [name]);
        req.flash('success_msg', 'Skill created.');
    } catch (err) { req.flash('error_msg', 'Failed to create skill.'); }
    res.redirect('/admin/skills');
};

exports.updateSkill = async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) { req.flash('error_msg', 'Name is required.'); return res.redirect('/admin/skills'); }
        await db.query('UPDATE skills SET name = ? WHERE id = ?', [name, req.params.id]);
        req.flash('success_msg', 'Skill updated.');
    } catch (err) { req.flash('error_msg', 'Failed to update skill.'); }
    res.redirect('/admin/skills');
};

exports.deleteSkill = async (req, res) => {
    try {
        await db.query('DELETE FROM freelancer_skills WHERE skill_id = ?', [req.params.id]);
        await db.query('DELETE FROM job_skills WHERE skill_id = ?', [req.params.id]);
        await db.query('DELETE FROM skills WHERE id = ?', [req.params.id]);
        req.flash('success_msg', 'Skill deleted.');
    } catch (err) { req.flash('error_msg', 'Failed to delete skill.'); }
    res.redirect('/admin/skills');
};

exports.proposalsPage = async (req, res) => {
    try {
        const perPage = 20;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;
        const status = req.query.status || '';
        const q = req.query.q ? String(req.query.q).trim() : '';

        const where = [];
        const params = [];
        if (status) { where.push('p.status = ?'); params.push(status); }
        if (q) { where.push('(fu.full_name LIKE ? OR fu.email LIKE ?)'); params.push('%'+q+'%', '%'+q+'%'); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM proposals p LEFT JOIN users fu ON fu.id = p.freelancer_id ${whereSql}`, params);
        const totalPages = Math.ceil(total / perPage);

        const [proposals] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id, p.bid_amount, p.status, p.is_deposited, p.created_at,
                    j.title AS job_title, j.employer_id,
                    fu.full_name AS freelancer_name, fu.email AS freelancer_email,
                    eu.company_name, eu.full_name AS employer_name
             FROM proposals p
             LEFT JOIN jobs j ON j.id = p.job_id
             LEFT JOIN users fu ON fu.id = p.freelancer_id
             LEFT JOIN users eu ON eu.id = j.employer_id
             ${whereSql}
             ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );
        res.render('admin/proposals', { user: req.session.user, proposals, query: { status, q }, pagination: { page, totalPages, total } });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.contractsPage = async (req, res) => {
    try {
        const perPage = 20;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;
        const status = req.query.status || '';

        const where = status ? 'WHERE c.status = ?' : '';
        const params = status ? [status] : [];

        const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM contracts c ${where}`, params);
        const totalPages = Math.ceil(total / perPage);

        const [contracts] = await db.query(
            `SELECT c.id, c.job_id, c.freelancer_id, c.employer_id, c.agreed_amount, c.status, c.start_date,
                    j.title AS job_title,
                    fu.full_name AS freelancer_name,
                    eu.company_name, eu.full_name AS employer_name
             FROM contracts c
             LEFT JOIN jobs j ON j.id = c.job_id
             LEFT JOIN users fu ON fu.id = c.freelancer_id
             LEFT JOIN users eu ON eu.id = c.employer_id
             ${where}
             ORDER BY c.start_date DESC LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );
        res.render('admin/contracts', { user: req.session.user, contracts, query: { status }, pagination: { page, totalPages, total } });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.reviewsPage = async (req, res) => {
    try {
        const perPage = 20;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;

        const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM reviews');
        const totalPages = Math.ceil(total / perPage);

        const [reviews] = await db.query(
            `SELECT r.id, r.reviewer_id, r.reviewee_id, r.rating, r.comment, r.created_at,
                    ru.full_name AS reviewer_name, re.full_name AS reviewee_name
             FROM reviews r
             LEFT JOIN users ru ON ru.id = r.reviewer_id
             LEFT JOIN users re ON re.id = r.reviewee_id
             ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
            [perPage, offset]
        );
        res.render('admin/reviews', { user: req.session.user, reviews, pagination: { page, totalPages, total }, success_msg: req.flash('success_msg') });
    } catch (err) { console.error(err); res.redirect('/admin'); }
};

exports.deleteReview = async (req, res) => {
    try {
        await db.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
        req.flash('success_msg', 'Review deleted.');
    } catch (err) { req.flash('error_msg', 'Failed to delete review.'); }
    res.redirect('/admin/reviews');
};

exports.jobsModerationPage = async (req, res) => {
    try {
        const perPage = 15;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * perPage;
        const status = req.query.status || '';
        const category = req.query.category || '';
        const q = req.query.q ? String(req.query.q).trim() : '';

        const where = [];
        const params = [];
        if (status) { where.push('j.status = ?'); params.push(status); }
        if (category) { where.push('j.category_id = ?'); params.push(category); }
        if (q) { where.push('j.title LIKE ?'); params.push('%' + q + '%'); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) as total FROM jobs j ${whereSql}`, params
        );
        const totalPages = Math.ceil(total / perPage);

        const [jobs] = await db.query(
            `SELECT j.id, j.title, j.slug, j.budget, j.job_type, j.status, j.created_at,
                    j.employer_id, u.company_name, u.full_name AS employer_name,
                    c.name AS category_name
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             LEFT JOIN categories c ON c.id = j.category_id
             ${whereSql}
             ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        const [categories] = await db.query('SELECT id, name FROM categories ORDER BY name ASC');

        res.render('admin/jobs', {
            user: req.session.user,
            jobs,
            categories,
            query: { status, category, q },
            pagination: { page, totalPages, total },
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
};

exports.toggleJobStatus = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [[job]] = await db.query('SELECT status FROM jobs WHERE id = ?', [id]);
        if (!job) { req.flash('error_msg', 'Job not found'); return res.redirect('/admin/jobs'); }
        const newStatus = job.status === 'cancelled' ? 'open' : 'cancelled';
        await db.query('UPDATE jobs SET status = ? WHERE id = ?', [newStatus, id]);
        req.flash('success_msg', `Job ${newStatus === 'cancelled' ? 'cancelled' : 'reopened'} successfully.`);
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update job status.');
    }
    res.redirect('/admin/jobs');
};

exports.deleteJob = async (req, res) => {
    try {
        const id = Number(req.params.id);
        await db.query('DELETE FROM jobs WHERE id = ?', [id]);
        req.flash('success_msg', 'Job deleted successfully.');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to delete job.');
    }
    res.redirect('/admin/jobs');
};

exports.categoriesPage = async (req, res) => {
    try {
        const editId = req.query.edit ? Number(req.query.edit) : null;
        const [categories] = await db.query(
            `SELECT c.id, c.name, c.slug,
                    COUNT(j.id) AS job_count
             FROM categories c
             LEFT JOIN jobs j ON j.category_id = c.id
             GROUP BY c.id ORDER BY c.id ASC`
        );
        res.render('admin/categories', {
            user: req.session.user,
            categories,
            editId,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
};

exports.storeCategory = async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (!name || !slug) { req.flash('error_msg', 'Name and slug are required.'); return res.redirect('/admin/categories'); }
        await db.query('INSERT INTO categories (name, slug) VALUES (?, ?)', [name, slug]);
        req.flash('success_msg', 'Category created.');
    } catch (err) {
        req.flash('error_msg', err.code === 'ER_DUP_ENTRY' ? 'Slug already exists.' : 'Failed to create category.');
    }
    res.redirect('/admin/categories');
};

exports.updateCategory = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const name = String(req.body.name || '').trim();
        const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (!name || !slug) { req.flash('error_msg', 'Name and slug are required.'); return res.redirect('/admin/categories'); }
        await db.query('UPDATE categories SET name = ?, slug = ? WHERE id = ?', [name, slug, id]);
        req.flash('success_msg', 'Category updated.');
    } catch (err) {
        req.flash('error_msg', 'Failed to update category.');
    }
    res.redirect('/admin/categories');
};

exports.deleteCategory = async (req, res) => {
    try {
        const id = Number(req.params.id);
        await db.query('UPDATE jobs SET category_id = NULL WHERE category_id = ?', [id]);
        await db.query('DELETE FROM categories WHERE id = ?', [id]);
        req.flash('success_msg', 'Category deleted.');
    } catch (err) {
        req.flash('error_msg', 'Failed to delete category.');
    }
    res.redirect('/admin/categories');
};

exports.plansPage = async (req, res) => {
    try {
        const [plans] = await db.query('SELECT * FROM plans ORDER BY price_monthly ASC');
        const [limits] = await db.query('SELECT * FROM plan_limits');

        // Attach limits to each plan
        for (const plan of plans) {
            plan.limits = limits.filter(l => l.plan_id === plan.id);
        }

        res.render('admin/plans', {
            user: req.session.user,
            plans,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (error) {
        console.error('Error loading plans:', error);
        req.flash('error_msg', 'Failed to load plans.');
        res.redirect('/admin');
    }
};

exports.updatePlan = async (req, res) => {
    const { id } = req.params;
    const { name, price_monthly } = req.body;
    const kinds = ['image', 'video', 'file'];

    try {
        await db.query('UPDATE plans SET name = ?, price_monthly = ? WHERE id = ?', [name, price_monthly, id]);

        for (const kind of kinds) {
            const max_file_mb = req.body[`limit_${kind}_max_file_mb`] || 0;
            const monthly_quota_mb = req.body[`limit_${kind}_monthly_quota_mb`] || 0;

            const [existing] = await db.query(
                'SELECT id FROM plan_limits WHERE plan_id = ? AND kind = ?',
                [id, kind]
            );

            if (existing.length > 0) {
                await db.query(
                    'UPDATE plan_limits SET max_file_mb = ?, monthly_quota_mb = ? WHERE plan_id = ? AND kind = ?',
                    [max_file_mb, monthly_quota_mb, id, kind]
                );
            } else {
                await db.query(
                    'INSERT INTO plan_limits (plan_id, kind, max_file_mb, monthly_quota_mb, is_active) VALUES (?, ?, ?, ?, 1)',
                    [id, kind, max_file_mb, monthly_quota_mb]
                );
            }
        }

        req.flash('success_msg', 'Plan updated successfully.');
    } catch (error) {
        console.error('Error updating plan:', error);
        req.flash('error_msg', 'Failed to update plan.');
    }
    res.redirect('/admin/plans');
};

// ─── System Settings ────────────────────────────────────────────────────────

const SETTINGS_KEYS = [
    'site_name', 'site_description', 'site_url', 'site_timezone',
    'platform_commission_percent', 'min_withdrawal_credits', 'credits_to_usd_rate',
    'registration_enabled', 'email_verification_required',
    'mail_host', 'mail_port', 'mail_user', 'mail_pass', 'mail_from_name', 'mail_from_address'
];

async function loadSettings(db) {
    const [rows] = await db.query('SELECT `key`, `value` FROM platform_settings WHERE `key` IN (?)', [SETTINGS_KEYS]);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { map[r.key] = r.value; });
    return map;
}

exports.systemSettingsPage = async (req, res) => {
    try {
        const s = await loadSettings(db);
        res.render('admin/settings', {
            user: req.session.user,
            s,
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
};

exports.updateSystemSettings = async (req, res) => {
    try {
        const group = req.body.group;
        let keys = [];
        if (group === 'general')      keys = ['site_name', 'site_description', 'site_url', 'site_timezone'];
        else if (group === 'finance') keys = ['platform_commission_percent', 'min_withdrawal_credits', 'credits_to_usd_rate'];
        else if (group === 'registration') keys = ['registration_enabled', 'email_verification_required'];
        else if (group === 'email')   keys = ['mail_host', 'mail_port', 'mail_user', 'mail_pass', 'mail_from_name', 'mail_from_address'];

        for (const key of keys) {
            // checkboxes: if not in body, value is '0'
            let value = req.body[key] !== undefined ? String(req.body[key]) : '0';
            await db.query(
                'INSERT INTO platform_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
                [key, value, value]
            );
        }

        req.flash('success_msg', 'Settings saved successfully.');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to save settings.');
    }
    res.redirect('/admin/settings#pane-' + (req.body.group || 'general'));
};

exports.testEmail = async (req, res) => {
    try {
        const s = await loadSettings(db);
        const nodemailer = require('nodemailer');
        const adminUser = req.session.user;
        const to = adminUser.email || s.mail_user;

        const transporter = nodemailer.createTransport({
            host: s.mail_host || process.env.MAIL_HOST,
            port: Number(s.mail_port || process.env.MAIL_PORT || 587),
            secure: false,
            auth: {
                user: s.mail_user || process.env.MAIL_USER,
                pass: s.mail_pass || process.env.MAIL_PASS
            }
        });

        await transporter.sendMail({
            from: `"${s.mail_from_name || 'Vamper'}" <${s.mail_from_address || s.mail_user}>`,
            to,
            subject: 'Vamper - Test Email',
            text: 'This is a test email from your Vamper System Settings.'
        });

        return res.json({ success: true, to });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: err.message });
    }
};

// ─── Boost Views ─────────────────────────────────────────────────────────────

exports.boostViewsPage = async (req, res) => {
    try {
        const perPage = 20;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const q = req.query.q ? String(req.query.q).trim() : '';
        const offset = (page - 1) * perPage;

        const where = q ? `WHERE (j.title LIKE ? OR u.full_name LIKE ? OR u.company_name LIKE ? OR u.email LIKE ?)` : '';
        const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : [];

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM jobs j LEFT JOIN users u ON u.id = j.employer_id ${where}`,
            params
        );

        const [jobs] = await db.query(
            `SELECT j.id, j.title, j.slug, j.budget, j.job_type, j.status, j.created_at,
                    u.full_name AS employer_name, u.company_name, u.email AS employer_email,
                    COALESCE((SELECT SUM(view_count) FROM job_views WHERE job_id = j.id), 0) AS total_views
             FROM jobs j
             LEFT JOIN users u ON u.id = j.employer_id
             ${where}
             ORDER BY j.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, perPage, offset]
        );

        res.render('admin/boost-views', {
            user: req.session.user,
            jobs: Array.isArray(jobs) ? jobs : [],
            q,
            pagination: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
            success_msg: req.flash('success_msg'),
            error_msg: req.flash('error_msg')
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
};

exports.applyBoostViews = async (req, res) => {
    try {
        const jobId = parseInt(req.body.job_id);
        const addViews = Math.min(10000, Math.max(1, parseInt(req.body.add_views) || 0));

        if (!jobId || !addViews) {
            req.flash('error_msg', 'Invalid input.');
            return res.redirect('/admin/boost-views');
        }

        // Spread views across past 7 days
        const perDay = Math.floor(addViews / 7);
        const remainder = addViews % 7;

        for (let i = 0; i < 7; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const count = i === 0 ? perDay + remainder : perDay;
            if (count <= 0) continue;

            await db.query(
                `INSERT INTO job_views (job_id, view_date, view_count) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE view_count = view_count + ?`,
                [jobId, dateStr, count, count]
            );
        }

        req.flash('success_msg', `Added ${addViews} views successfully.`);
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to boost views.');
    }
    res.redirect('/admin/boost-views');
};

exports.runAutoRenewNow = async (req, res) => {
    try {
        // Dynamically require to avoid circular dependency
        const { runAutoRenew } = require('../server');
        const results = await runAutoRenew();
        return res.json({
            ok: true,
            renewed: results.renewed,
            skipped: results.skipped,
            errors: results.errors,
            summary: `Renewed: ${results.renewed.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`
        });
    } catch (err) {
        console.error('[Admin] runAutoRenewNow error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
