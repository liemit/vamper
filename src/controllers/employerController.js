const db = require('../config/db');
const useragent = require('useragent');
const bcrypt = require('bcryptjs');
const NotificationService = require('../services/notificationService');
const Message = require('../models/messageModel');
const fs = require('fs');
const path = require('path');

const slugify = require('slugify');
const sanitizeHtml = require('sanitize-html');

function sanitizeJobDescription(raw) {
    const html = (raw === undefined || raw === null) ? '' : String(raw);

    return sanitizeHtml(html, {
        allowedTags: [
            'p', 'br',
            'strong', 'b', 'em', 'i', 'u', 's',
            'ul', 'ol', 'li',
            'a',
            'blockquote',
            'h1', 'h2', 'h3',
            'span',
            'img'
        ],
        allowedAttributes: {
            a: ['href', 'target', 'rel'],
            p: ['class'],
            h1: ['class'],
            h2: ['class'],
            h3: ['class'],
            span: ['class'],
            img: ['src', 'alt', 'width', 'height', 'style']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowProtocolRelative: false,
        transformTags: {
            a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true)
        }
    });
}

function getPlainTextFromHtml(html) {
    return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}

async function isJobInDispute({ jobId, employerId, freelancerId }) {
    try {
        const jid = Number(jobId);
        const eid = Number(employerId);
        const fid = Number(freelancerId);
        if (!Number.isFinite(jid) || jid <= 0 || !Number.isFinite(eid) || eid <= 0 || !Number.isFinite(fid) || fid <= 0) return false;

        const [cRows] = await db.query(
            `SELECT id
             FROM contracts
             WHERE job_id = ? AND employer_id = ? AND freelancer_id = ? AND status = 'disputed'
             LIMIT 1`,
            [jid, eid, fid]
        );
        if (Array.isArray(cRows) && cRows.length) return true;

        const [dRows] = await db.query(
            `SELECT d.id
             FROM disputes d
             WHERE d.job_id = ? AND d.proposal_id IN (
                 SELECT p.id FROM proposals p WHERE p.job_id = ? AND p.freelancer_id = ? LIMIT 1
             )
             AND d.status IN ('open', 'under_review')
             LIMIT 1`,
            [jid, jid, fid]
        );
        return Array.isArray(dRows) && dRows.length > 0;
    } catch (_) {
        return false;
    }
}

async function blockIfDisputedJson({ res, jobId, employerId, freelancerId }) {
    const blocked = await isJobInDispute({ jobId, employerId, freelancerId });
    if (!blocked) return false;
    res.status(423).json({ ok: false, error: 'This contract is currently under dispute. Payments are temporarily locked.' });
    return true;
}

async function notifyAdmins(title, body, url) {
    try {
        const [admins] = await db.query(
            `SELECT id
             FROM users
             WHERE role = 'admin' AND is_active = 1
             ORDER BY id ASC
             LIMIT 50`
        );
        const list = Array.isArray(admins) ? admins : [];
        for (const a of list) {
            const adminId = a && a.id ? Number(a.id) : null;
            if (!adminId) continue;
            try {
                await NotificationService.createPersonal(
                    adminId,
                    title,
                    body,
                    'warning',
                    url
                );
            } catch (_) {}
        }
    } catch (_) {}
}

async function createAdminRefundRequestDispute({ employerId, freelancerId, jobId, message, category }) {
    const eId = Number(employerId);
    const fId = Number(freelancerId);
    const jId = Number(jobId);
    const msg = (message !== undefined && message !== null) ? String(message).trim() : '';
    const cat = (category !== undefined && category !== null) ? String(category).trim().toLowerCase() : 'non_payment';
    if (!Number.isFinite(eId) || eId <= 0 || !Number.isFinite(fId) || fId <= 0 || !Number.isFinite(jId) || jId <= 0) {
        return { ok: false, error: 'Invalid parameters' };
    }
    if (!msg) return { ok: false, error: 'Message is required' };

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [jobRows] = await conn.query(
            `SELECT id, title, job_type
             FROM jobs
             WHERE id = ? AND employer_id = ?
             LIMIT 1
             FOR UPDATE`,
            [jId, eId]
        );
        const job = Array.isArray(jobRows) && jobRows.length ? jobRows[0] : null;
        if (!job) {
            await conn.rollback();
            return { ok: false, error: 'Job not found or unauthorized' };
        }

        const [propRows] = await conn.query(
            `SELECT id
             FROM proposals
             WHERE job_id = ? AND freelancer_id = ?
             LIMIT 1
             FOR UPDATE`,
            [jId, fId]
        );
        const proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
        if (!proposal) {
            await conn.rollback();
            return { ok: false, error: 'Proposal not found' };
        }
        const proposalId = Number(proposal.id);

        let contractId = null;
        try {
            const [cRows] = await conn.query(
                `SELECT id
                 FROM contracts
                 WHERE job_id = ? AND freelancer_id = ? AND employer_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [jId, fId, eId]
            );
            const c = Array.isArray(cRows) && cRows.length ? cRows[0] : null;
            if (c && c.id) {
                contractId = Number(c.id);
                await conn.query(
                    `UPDATE contracts SET status = 'disputed' WHERE id = ?`,
                    [contractId]
                );
            }
        } catch (_) {}

        const [ins] = await conn.query(
            `INSERT INTO disputes (created_by, reported_user_id, job_id, proposal_id, contract_id, category, message, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
            [eId, fId, jId, proposalId, contractId, cat, msg]
        );
        const disputeId = ins && ins.insertId ? Number(ins.insertId) : null;
        if (!disputeId) {
            await conn.rollback();
            return { ok: false, error: 'Failed to create refund request' };
        }

        await conn.commit();

        const jobTitle = job.title ? String(job.title) : 'Job';
        const url = `/admin/reports/${disputeId}`;
        await notifyAdmins(
            'Refund Request',
            `Employer requested a refund for job: ${jobTitle}`,
            url
        );

        // DO NOT notify Freelancer about refund request to protect employer's privacy
        // try {
        //     await NotificationService.createPersonal(
        //         fId,
        //         'Refund requested',
        //         `Employer requested a refund for job: ${jobTitle}. Please submit evidence if needed.`,
        //         'warning',
        //         `/freelancer/messages?to=${encodeURIComponent(String(eId))}&job=${encodeURIComponent(String(jId))}`
        //     );
        // } catch (_) {}

        try {
            await NotificationService.createPersonal(
                eId,
                'Refund request submitted',
                `Your refund request for job: ${jobTitle} has been submitted and is awaiting admin review.`,
                'info',
                `/employer/messages?to=${encodeURIComponent(String(fId))}&job=${encodeURIComponent(String(jId))}`
            );
        } catch (_) {}

        return { ok: true, id: disputeId };
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        console.error(err);
        return { ok: false, error: 'Server Error' };
    } finally {
        try { conn.release(); } catch (_) {}
    }
}

exports.index = async (req, res) => {
    try {
        const employerId = req.session.user.id;

        // Thống kê Active posts (các job có status 'open')
        const [activePostsResult] = await db.query(
            `SELECT COUNT(*) as count FROM jobs WHERE employer_id = ? AND status = 'open'`, 
            [employerId]
        );
        const activePostsCount = activePostsResult[0].count || 0;

        // Thống kê New applicants (tổng số proposal cho các job của employer này, trạng thái pending/interview)
        const [applicantsResult] = await db.query(
            `SELECT COUNT(*) as count FROM proposals p
             JOIN jobs j ON p.job_id = j.id
             WHERE j.employer_id = ? AND p.status IN ('pending', 'interview')`, 
            [employerId]
        );
        const newApplicantsCount = applicantsResult[0].count || 0;

        // Thống kê Interviews (các proposal đang ở trạng thái interview)
        const [interviewsResult] = await db.query(
            `SELECT COUNT(*) as count FROM proposals p
             JOIN jobs j ON p.job_id = j.id
             WHERE j.employer_id = ? AND p.status = 'interview'`, 
            [employerId]
        );
        const interviewsCount = interviewsResult[0].count || 0;

        // Recent project posts (Lấy 5 job mới nhất của employer kèm số lượng applicant)
        const [recentJobs] = await db.query(
            `SELECT j.id, j.title, j.slug, j.status, j.created_at, 
                    (SELECT COUNT(*) FROM proposals p WHERE p.job_id = j.id) as applicant_count
             FROM jobs j 
             WHERE j.employer_id = ? 
             ORDER BY j.created_at DESC 
             LIMIT 5`, 
            [employerId]
        );

        res.render("employer/dashboard", { 
            user: req.session.user,
            stats: {
                activePosts: activePostsCount,
                newApplicants: newApplicantsCount,
                interviews: interviewsCount,
                responseRate: 100 // Tạm thời để 100%, có thể tính toán thực tế sau dựa trên tốc độ phản hồi tin nhắn
            },
            recentJobs: recentJobs || []
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        res.render("employer/dashboard", { 
            user: req.session.user,
            stats: { activePosts: 0, newApplicants: 0, interviews: 0, responseRate: 0 },
            recentJobs: []
        });
    }
};

exports.depositPage = (req, res) => {
    res.render("employer/deposit", { user: req.session.user });
};

exports.jobsPage = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        // Thống kê Active Jobs
        const [activeJobsResult] = await db.query(
            `SELECT COUNT(*) as count FROM jobs WHERE employer_id = ? AND status = 'open'`, 
            [userId]
        );
        const activeJobsCount = activeJobsResult[0].count || 0;

        // Thống kê Total Applicants (tổng số proposal cho tất cả các job của employer này)
        const [totalApplicantsResult] = await db.query(
            `SELECT COUNT(*) as count FROM proposals p
             JOIN jobs j ON p.job_id = j.id
             WHERE j.employer_id = ?`, 
            [userId]
        );
        const totalApplicantsCount = totalApplicantsResult[0].count || 0;

        // Thống kê Views This Week (tổng số view của tất cả job của employer trong 7 ngày gần nhất)
        const [viewsResult] = await db.query(
            `SELECT SUM(v.view_count) as total_views 
             FROM job_views v
             JOIN jobs j ON v.job_id = j.id
             WHERE j.employer_id = ? AND v.view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
            [userId]
        );
        const viewsThisWeekCount = viewsResult[0].total_views || 0;

        // Count total jobs for pagination
        const [countResult] = await db.query('SELECT COUNT(*) as total FROM jobs WHERE employer_id = ?', [userId]);
        const totalJobs = countResult[0].total;
        const totalPages = Math.ceil(totalJobs / limit);

        // Fetch jobs for current page kèm theo số lượng applicant của từng job
        const [jobs] = await db.query(`
            SELECT j.*, 
                   (SELECT COUNT(*) FROM proposals p WHERE p.job_id = j.id) as applicant_count,
                   (SELECT COALESCE(SUM(view_count), 0) FROM job_views WHERE job_id = j.id) AS total_views
            FROM jobs j 
            WHERE j.employer_id = ? 
            ORDER BY j.created_at DESC
            LIMIT ? OFFSET ?
        `, [userId, limit, offset]);

        res.render("employer/jobs", {
            user: req.session.user,
            jobs: jobs,
            currentPage: page,
            totalPages: totalPages,
            totalJobs: totalJobs,
            stats: {
                activeJobs: activeJobsCount,
                totalApplicants: totalApplicantsCount,
                viewsThisWeek: viewsThisWeekCount
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Server Error");
    }
};

exports.browseJobsPage = async (req, res) => {
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

        return res.render('employer/browse-jobs', {
            user: req.session.user,
            query: req.query,
            basePath: '/employer/browse-jobs',
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
        return res.render('employer/browse-jobs', {
            user: req.session.user,
            query: req.query,
            basePath: '/employer/browse-jobs',
            categories: [],
            jobs: [],
            pagination: { page: 1, perPage, total: 0, totalPages: 1 }
        });
    }
};

exports.browseJobDetailPage = async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) {
        return res.status(404).send('Not Found');
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
        // Employer có thể xem full không cần mask content filter, hoặc có thể tái sử dụng job-detail
        // Ở đây render lại view job-detail chung hoặc tạo view mới, ta sẽ dùng chung job-detail.ejs nhưng có thể custom
        // Để giữ tính nhất quán của giao diện guest/employer, ta render thẳng job-detail chung.

        return res.render('job-detail', { job: job, banners: await db.query("SELECT * FROM banners WHERE is_active = 1 ORDER BY position, sort_order ASC").then(([r]) => r).catch(() => []) });
    } catch (err) {
        console.error(err);
        return res.status(500).send('Internal Server Error');
    }
};

exports.createJobPage = async (req, res) => {
    try {
        const [categories] = await db.query("SELECT * FROM categories ORDER BY name ASC");
        res.render("employer/post-job", {
            user: req.session.user,
            categories: categories
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Server Error");
    }
};

exports.uploadJobImage = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ ok: false, error: 'No image uploaded' });
        }
        const imageUrls = req.files.map(file => '/img/' + file.filename);
        return res.json({ ok: true, urls: imageUrls });
    } catch (err) {
        console.error('Upload job image error:', err);
        return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
};

exports.createJob = async (req, res) => {
    try {
        const { title, category_id, job_type, description, budget, deadline, skills } = req.body;
        const employer_id = req.session.user.id;

        const safeDescription = sanitizeJobDescription(description);
        const plainDescription = getPlainTextFromHtml(safeDescription);

        // Basic validation
        if (!title || !category_id || !job_type || !plainDescription || !budget) {
            return res.status(400).send("Missing required fields");
        }

        // Handle File Upload
        let thumbnail_url = null;
        if (req.file) {
            // Save path relative to public directory (e.g., /img/filename.jpg)
            thumbnail_url = '/img/' + req.file.filename;
        }

        // Generate Slug
        let slug = slugify(title, { lower: true, strict: true });
        // Ensure slug is unique by appending timestamp (simple way)
        // Ideally we should check DB for existence, but for now this reduces collision chance
        slug = `${slug}-${Date.now()}`;

        // Insert Job
        const [result] = await db.query(
            `INSERT INTO jobs (employer_id, category_id, title, slug, description, budget, job_type, deadline, thumbnail_url, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
            [employer_id, category_id, title, slug, safeDescription, budget, job_type, deadline || null, thumbnail_url]
        );

        const jobId = result.insertId;

        // Note: Skills handling would go here (requires inserting into skills table and job_skills table)
        // For this MVP step, we are focusing on the main job record.

        req.flash('success_msg', 'Job posted successfully!');
        res.redirect('/employer/jobs');

    } catch (error) {
        res.status(500).send("Error creating job: " + error.message);
    }
};

exports.deleteJob = async (req, res) => {
    try {
        const jobId = req.params.id;
        const employerId = req.session.user.id;

        const [result] = await db.query("DELETE FROM jobs WHERE id = ? AND employer_id = ?", [jobId, employerId]);

        if (result.affectedRows === 0) {
            req.flash('error_msg', 'Job not found or unauthorized');
        } else {
            req.flash('success_msg', 'Job deleted successfully');
        }

        res.redirect('/employer/jobs');
    } catch (error) {
        console.error("Delete Job Error:", error);
        res.status(500).send("Server Error");
    }
};

exports.editJobPage = async (req, res) => {
    try {
        const jobId = req.params.id;
        const employerId = req.session.user.id;

        // Fetch job details
        const [jobs] = await db.query("SELECT * FROM jobs WHERE id = ? AND employer_id = ?", [jobId, employerId]);

        if (jobs.length === 0) {
            req.flash('error_msg', 'Job not found or unauthorized');
            return res.redirect('/employer/jobs');
        }

        // Fetch categories for dropdown
        const [categories] = await db.query("SELECT * FROM categories ORDER BY name ASC");

        res.render("employer/edit-job", {
            user: req.session.user,
            job: jobs[0],
            categories: categories
        });

    } catch (error) {
        console.error("Edit Job Page Error:", error);
        res.status(500).send("Server Error");
    }
};

exports.updateJob = async (req, res) => {
    try {
        const jobId = req.params.id;
        const employerId = req.session.user.id;
        const { title, category_id, job_type, description, budget, deadline, skills } = req.body;

        const safeDescription = sanitizeJobDescription(description);
        const plainDescription = getPlainTextFromHtml(safeDescription);

        // Verify ownership
        const [jobs] = await db.query("SELECT id FROM jobs WHERE id = ? AND employer_id = ?", [jobId, employerId]);
        if (jobs.length === 0) {
            req.flash('error_msg', 'Job not found or unauthorized');
            return res.redirect('/employer/jobs');
        }

        // Handle File Upload (Update only if new file exists)
        if (!title || !category_id || !job_type || !plainDescription || !budget) {
            req.flash('error_msg', 'Missing required fields');
            return res.redirect('/employer/jobs/edit/' + jobId);
        }

        let sql = `UPDATE jobs SET title=?, category_id=?, description=?, budget=?, job_type=?, deadline=?`;
        let params = [title, category_id, safeDescription, budget, job_type, deadline || null];

        // If slug update is desired, it can be done here, but usually slugs should remain stable or handle redirects.
        // For now, let's keep slug as is or update it? Let's update it for consistency if title changes wildly.
        // But updating slug breaks existing links. Let's KEEP slug for now or only update if you want.
        // Let's re-generate slug if title changes? No, simpler to keep it stable for now unless requested.

        if (req.file) {
            const thumbnail_url = '/img/' + req.file.filename;
            sql += `, thumbnail_url=?`;
            params.push(thumbnail_url);
        }

        sql += ` WHERE id=?`;
        params.push(jobId);

        await db.query(sql, params);

        req.flash('success_msg', 'Job updated successfully');
        res.redirect('/employer/jobs');

    } catch (error) {
        console.error("Update Job Error:", error);
        res.status(500).send("Server Error: " + error.message);
    }
};

exports.applicationsPage = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const [rows] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id, p.cover_letter, p.bid_amount, p.estimated_days, p.status, p.created_at, p.is_deposited,
                    j.title AS job_title, j.slug AS job_slug,
                    u.full_name AS freelancer_name, u.email AS freelancer_email,
                    fp.headline AS freelancer_headline
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             LEFT JOIN users u ON u.id = p.freelancer_id
             LEFT JOIN freelancer_profiles fp ON fp.user_id = p.freelancer_id
             WHERE j.employer_id = ?
             ORDER BY p.created_at DESC, p.id DESC`,
            [employerId]
        );
        const proposals = Array.isArray(rows) ? rows : [];
        return res.render('employer/applications', {
            user: req.session.user,
            proposals
        });
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/jobs');
    }
};

exports.updateApplicationStatus = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const proposalIdRaw = (req.params && req.params.id) ? String(req.params.id).trim() : '';
        const proposalId = proposalIdRaw ? Number(proposalIdRaw) : NaN;
        const nextStatusRaw = (req.body && req.body.status !== undefined && req.body.status !== null)
            ? String(req.body.status)
            : '';
        const nextStatus = nextStatusRaw.trim().toLowerCase();
        const allowed = new Set(['pending', 'accepted', 'rejected']);

        if (!Number.isFinite(proposalId) || proposalId <= 0) {
            req.flash('error_msg', 'Invalid application');
            return res.redirect('/employer/applications');
        }

        if (!allowed.has(nextStatus)) {
            req.flash('error_msg', 'Invalid status');
            return res.redirect('/employer/applications');
        }

        const [ownRows] = await db.query(
            `SELECT p.id
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.id = ? AND j.employer_id = ?
             LIMIT 1`,
            [proposalId, employerId]
        );

        if (!Array.isArray(ownRows) || ownRows.length === 0) {
            req.flash('error_msg', 'Application not found or unauthorized');
            return res.redirect('/employer/applications');
        }

        await db.query('UPDATE proposals SET status = ? WHERE id = ?', [nextStatus, proposalId]);
        req.flash('success_msg', 'Application status updated');
        return res.redirect('/employer/applications');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/applications');
    }
};

exports.logoutSession = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const sessionIdToRevoke = req.body.session_id;

        if (!sessionIdToRevoke) {
            return res.status(400).json({ ok: false, error: 'session_id required' });
        }

        // Kiểm tra quyền sở hữu session
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
        console.error('Employer revoke session error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { current_password, new_password, confirm_new_password } = req.body;
        const isJson = req.headers.accept && req.headers.accept.includes('application/json');

        if (!current_password || !new_password || !confirm_new_password) {
            if (isJson) return res.status(400).json({ ok: false, error: 'All password fields are required.' });
            req.flash('error_msg', 'All password fields are required.');
            return res.redirect('/employer/company-profile#pane-settings');
        }

        if (new_password !== confirm_new_password) {
            if (isJson) return res.status(400).json({ ok: false, error: 'New passwords do not match.' });
            req.flash('error_msg', 'New passwords do not match.');
            return res.redirect('/employer/company-profile#pane-settings');
        }

        if (new_password.length < 6) {
            if (isJson) return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters long.' });
            req.flash('error_msg', 'New password must be at least 6 characters long.');
            return res.redirect('/employer/company-profile#pane-settings');
        }

        const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        const isMatch = await bcrypt.compare(current_password, user.password_hash);
        if (!isMatch) {
            if (isJson) return res.status(400).json({ ok: false, error: 'Current password is incorrect.' });
            req.flash('error_msg', 'Current password is incorrect.');
            return res.redirect('/employer/company-profile#pane-settings');
        }

        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(new_password, salt);

        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

        if (isJson) return res.json({ ok: true, message: 'Password updated successfully.' });
        req.flash('success_msg', 'Password updated successfully.');
        res.redirect('/employer/company-profile#pane-settings');
    } catch (err) {
        console.error('Employer change password error:', err);
        const isJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (isJson) return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
        req.flash('error_msg', 'Server error. Please try again.');
        res.redirect('/employer/company-profile#pane-settings');
    }
};

exports.freelancerApplicationProfile = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';
        const freelancerId = rawId ? Number(rawId) : NaN;
        if (!Number.isFinite(freelancerId) || freelancerId <= 0) {
            req.flash('error_msg', 'Ứng viên không hợp lệ');
            return res.redirect('/employer/applications');
        }
        const [appliedRows] = await db.query(
            `SELECT p.id AS proposal_id, p.bid_amount, p.estimated_days, p.status, p.created_at,
                    j.id AS job_id, j.title AS job_title, j.slug AS job_slug
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.freelancer_id = ? AND j.employer_id = ?
             ORDER BY p.created_at DESC, p.id DESC`,
            [freelancerId, employerId]
        );
        const proposals = Array.isArray(appliedRows) ? appliedRows : [];
        if (!proposals.length) {
            req.flash('error_msg', 'Ứng viên không tồn tại hoặc chưa ứng tuyển công việc của bạn');
            return res.redirect('/employer/applications');
        }
        const [userRows] = await db.query(
            `SELECT u.id, u.full_name, u.avatar_url, u.email,
                    fp.headline, fp.bio, fp.hourly_rate, fp.portfolio_url, fp.github_url,
                    fp.city, fp.country, fp.skills, fp.linkedin_url, fp.website, fp.education,
                    fp.experience_level, fp.cv_url
             FROM users u
             LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id
             WHERE u.id = ? LIMIT 1`,
            [freelancerId]
        );
        const base = (Array.isArray(userRows) && userRows.length) ? userRows[0] : null;
        if (!base) {
            req.flash('error_msg', 'Không tìm thấy thông tin ứng viên');
            return res.redirect('/employer/applications');
        }
        const [skillRows] = await db.query(
            `SELECT s.name, fs.level
             FROM freelancer_skills fs
             INNER JOIN skills s ON s.id = fs.skill_id
             WHERE fs.freelancer_id = ?`,
            [freelancerId]
        );
        const skillsFromTable = Array.isArray(skillRows) ? skillRows.map(r => ({ name: r.name, level: r.level || '' })) : [];
        const skillsText = base.skills ? String(base.skills) : '';
        const skillsFromText = skillsText
            ? skillsText.split(',').map(s => s.trim()).filter(Boolean).map(n => ({ name: n, level: '' }))
            : [];
        const mergedSkills = [];
        const seen = new Set();
        [...skillsFromTable, ...skillsFromText].forEach(it => {
            const key = it.name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                mergedSkills.push(it);
            }
        });
        const profile = {
            id: base.id,
            user_id: base.id,
            full_name: base.full_name || base.email,
            avatar_url: base.avatar_url || '',
            email: base.email || '',
            title: base.headline || '',
            bio: base.bio || '',
            hourly_rate: base.hourly_rate,
            location: base.city || '',
            country: base.country || '',
            portfolio_url: base.portfolio_url || '',
            github_url: base.github_url || '',
            linkedin_url: base.linkedin_url || '',
            website: base.website || '',
            education: base.education || '',
            experience_level: base.experience_level || '',
            cv_url: base.cv_url || ''
        };
        return res.render('employer/profile-freelancer-apply', {
            user: req.session.user,
            profile,
            skills: mergedSkills,
            proposals
        });
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/applications');
    }
};

exports.companyProfilePage = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [rows] = await db.query(
            'SELECT user_id, company_name, website, description, logo_url, address, city, tax_code FROM employer_profiles WHERE user_id = ? LIMIT 1',
            [userId]
        );
        const profile = Array.isArray(rows) && rows.length ? rows[0] : null;

        let planStatus = { code: null, name: null, price_monthly: null, currency: null, start_utc: null, end_utc: null, limits: {}, usage: {}, auto_renew: 1 };
        try {
            const [ap] = await db.query(
                `SELECT p.id AS plan_id, p.code, p.name, p.price_monthly, p.currency, up.start_utc, up.end_utc, up.auto_renew
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
                    `SELECT p.id AS plan_id, p.code, p.name, p.price_monthly, p.currency, up.start_utc, up.end_utc, up.auto_renew
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
                planStatus.auto_renew = p.auto_renew !== undefined ? Number(p.auto_renew) : 1;
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

        return res.render('employer/company-profile', {
            user: req.session.user,
            profile,
            planStatus,
            activeSession
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send('Server Error');
    }
};

exports.saveCompanyProfile = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const company_name = (req.body && req.body.company_name) ? String(req.body.company_name).trim() : '';
        const website = (req.body && req.body.website) ? String(req.body.website).trim() : '';
        const descriptionRaw = (req.body && req.body.description) ? String(req.body.description) : '';
        const safeDescription = sanitizeJobDescription(descriptionRaw);
        const existing_logo_url = (req.body && req.body.existing_logo_url) ? String(req.body.existing_logo_url).trim() : '';
        const address = (req.body && req.body.address) ? String(req.body.address).trim() : '';
        const city = (req.body && req.body.city) ? String(req.body.city).trim() : '';
        const tax_code = (req.body && req.body.tax_code) ? String(req.body.tax_code).trim() : '';

        const uploadedLogoUrl = req.file ? ('/img/' + req.file.filename) : '';
        const logo_url = uploadedLogoUrl || existing_logo_url || '';

        await db.query(
            `INSERT INTO employer_profiles (user_id, company_name, website, description, logo_url, address, city, tax_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               company_name = VALUES(company_name),
               website = VALUES(website),
               description = VALUES(description),
               logo_url = VALUES(logo_url),
               address = VALUES(address),
               city = VALUES(city),
               tax_code = VALUES(tax_code)`,
            [
                userId,
                company_name || null,
                website || null,
                safeDescription || null,
                logo_url || null,
                address || null,
                city || null,
                tax_code || null
            ]
        );

        req.flash('success_msg', 'Company profile updated');
        return res.redirect('/employer/company-profile');
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/company-profile');
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
        } else {
            return res.status(403).json({ ok: false, error: 'Message not found or unauthorized' });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.endContract = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;

        if (!Number.isFinite(toId) || toId <= 0 || !Number.isFinite(jobId) || jobId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid parameters' });
        }

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();

            const [jobRows] = await conn.query(
                `SELECT id, title, job_type
                 FROM jobs
                 WHERE id = ? AND employer_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [jobId, userId]
            );
            const job = Array.isArray(jobRows) && jobRows.length ? jobRows[0] : null;
            if (!job) {
                await conn.rollback();
                return res.status(403).json({ ok: false, error: 'Unauthorized' });
            }
            const jobType = (job.job_type ? String(job.job_type).toLowerCase() : 'fixed_price');
            if (jobType !== 'hourly') {
                await conn.rollback();
                return res.status(400).json({ ok: false, error: 'End contract is only available for hourly jobs' });
            }

            const [propRows] = await conn.query(
                `SELECT id
                 FROM proposals
                 WHERE job_id = ? AND freelancer_id = ? AND status = 'accepted'
                 LIMIT 1
                 FOR UPDATE`,
                [jobId, toId]
            );
            const proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;
            if (!proposal) {
                await conn.rollback();
                return res.status(404).json({ ok: false, error: 'Proposal not found' });
            }

            // Safety: stop any running timers for this job/freelancer pair (in case multiple proposal rows exist)
            await conn.query(
                `UPDATE proposals
                 SET timer_status = 'stopped',
                     timer_start_time = NULL,
                     last_sync_time = NULL
                 WHERE job_id = ? AND freelancer_id = ?`,
                [jobId, toId]
            );

            // Terminate contract if present
            try {
                const [cRows] = await conn.query(
                    `SELECT id
                     FROM contracts
                     WHERE job_id = ? AND employer_id = ? AND freelancer_id = ?
                     LIMIT 1
                     FOR UPDATE`,
                    [jobId, userId, toId]
                );
                const c = Array.isArray(cRows) && cRows.length ? cRows[0] : null;
                if (c && c.id) {
                    await conn.query(
                        `UPDATE contracts
                         SET status = 'terminated'
                         WHERE id = ?`,
                        [Number(c.id)]
                    );
                }
            } catch (_) {}

            // Reset hourly relationship to initial state
            await conn.query(
                `UPDATE proposals
                 SET is_deposited = 0,
                     pending_balance = 0,
                     total_seconds_worked = 0,
                     paid_seconds = 0,
                     timer_status = 'stopped',
                     timer_start_time = NULL,
                     last_sync_time = NULL
                 WHERE id = ?`,
                [Number(proposal.id)]
            );

            await conn.commit();
            return res.json({ ok: true, message: 'Contract ended' });
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            try { conn.release(); } catch (_) {}
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.messagesPage = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const toRaw = req.query && req.query.to ? String(req.query.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = req.query && req.query.job ? String(req.query.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;
        
        // Fetch current user (employer) details for avatar
        const [userRows] = await db.query('SELECT company_name, id FROM users WHERE id = ? LIMIT 1', [userId]);
        const currentUser = (Array.isArray(userRows) && userRows.length) ? userRows[0] : {};
        
        // Fetch employer profile for logo
        const [profileRows] = await db.query('SELECT logo_url FROM employer_profiles WHERE user_id = ? LIMIT 1', [userId]);
        const employerProfile = (Array.isArray(profileRows) && profileRows.length) ? profileRows[0] : {};

        let freelancer = null;
        if (Number.isFinite(toId) && toId > 0) {
            const [rows] = await db.query(
                `SELECT u.id, u.full_name, u.avatar_url
                 FROM users u
                 WHERE u.id = ? AND u.role = 'freelancer'
                 LIMIT 1`,
                [toId]
            );
            freelancer = Array.isArray(rows) && rows.length ? rows[0] : null;
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

        let proposalId = null;
        let proposalRate = 0;
        // Check deposit status & get proposal ID
        let isDeposited = 0;
        if (Number.isFinite(toId) && toId > 0 && Number.isFinite(jobId) && jobId > 0) {
            const [propRows] = await db.query(
                `SELECT id, is_deposited, bid_amount FROM proposals 
                 WHERE job_id = ? AND freelancer_id = ?
                 ORDER BY (status = 'accepted') DESC, id DESC
                 LIMIT 1`,
                [jobId, toId]
            );
            if (Array.isArray(propRows) && propRows.length > 0) {
                const raw = propRows[0].is_deposited;
                const n = (raw === undefined || raw === null) ? 0 : Number(raw);
                isDeposited = (Number.isFinite(n) && n >= 0) ? n : 0;
                proposalId = propRows[0].id;
                proposalRate = Number(propRows[0].bid_amount || 0);
            }
        }

        let messages = [];
        if (Number.isFinite(toId) && toId > 0) {
            messages = await Message.getConversation(userId, toId, (Number.isFinite(jobId) && jobId > 0) ? jobId : null, 200, 0);
            if (!Array.isArray(messages)) messages = [];
        }

        return res.render('employer/messages', {
            user: { 
                ...req.session.user, 
                company_name: currentUser.company_name,
                logo_url: employerProfile.logo_url 
            },
            freelancer,
            job,
            messages,
            toId: Number.isFinite(toId) ? toId : null,
            jobId: Number.isFinite(jobId) ? jobId : null,
            proposalId,
            proposalRate,
            isDeposited,
            uploadLimits: await (async () => {
                try {
                    const [planRows] = await db.query(
                        `SELECT pl.kind, pl.max_file_mb FROM user_plans up
                         JOIN plan_limits pl ON pl.plan_id = up.plan_id
                         WHERE up.user_id = ? AND up.end_utc > NOW() AND pl.is_active = 1`,
                        [req.session.user.id]
                    );
                    const limits = { image: 10, video: 500, file: 1000 };
                    (Array.isArray(planRows) ? planRows : []).forEach(r => {
                        if (r.kind && r.max_file_mb) limits[r.kind] = Number(r.max_file_mb);
                    });
                    return limits;
                } catch(_) { return { image: 10, video: 500, file: 1000 }; }
            })()
        });
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/dashboard');
    }
};

exports.makeDeposit = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;

        if (!Number.isFinite(toId) || toId <= 0 || !Number.isFinite(jobId) || jobId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid parameters' });
        }

        // Verify job ownership and get bid amount
        const [jobRows] = await db.query('SELECT id, title, job_type FROM jobs WHERE id = ? AND employer_id = ?', [jobId, userId]);
        if (!Array.isArray(jobRows) || jobRows.length === 0) {
            return res.status(403).json({ ok: false, error: 'Unauthorized' });
        }

        if (await blockIfDisputedJson({ res, jobId, employerId: userId, freelancerId: toId })) return;

        const jobTitle = jobRows[0].title;
        const jobType = (jobRows[0].job_type) ? String(jobRows[0].job_type).toLowerCase() : 'fixed_price';

        // Get Proposal
        const [propRows] = await db.query(
            `SELECT id, bid_amount, is_deposited
             FROM proposals
             WHERE job_id = ? AND freelancer_id = ?
             ORDER BY (status = 'accepted') DESC, id DESC
             LIMIT 1`,
            [jobId, toId]
        );
        if (!Array.isArray(propRows) || propRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Proposal not found' });
        }
        const proposal = propRows[0];

        if (proposal.is_deposited > 0) {
            return res.status(400).json({ ok: false, error: 'Already deposited' });
        }

        // Logic for Hourly: Activate and mark proposal as accepted
        if (jobType === 'hourly') {
            await db.query(
                `UPDATE proposals 
                 SET is_deposited = 1,
                     status = 'accepted'
                 WHERE id = ?`,
                [proposal.id]
            );
            return res.json({ ok: true, message: 'Contract activated' });
        }

        // Logic for Fixed Price: Deduct Deposit
        const amount = Number(proposal.bid_amount);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid bid amount' });
        }

        // Check Balance
        const [userRows] = await db.query('SELECT balance FROM users WHERE id = ? LIMIT 1', [userId]);
        const balance = (Array.isArray(userRows) && userRows.length) ? Number(userRows[0].balance) : 0;

        if (balance < amount) {
            return res.status(400).json({ ok: false, error: 'Insufficient balance' });
        }

        // Execute Transaction (Deduct from Employer)
        // 1. Deduct balance
        await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);

        // 2. Record transaction
        await db.query(
            `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
             VALUES (?, ?, 'payment', 'completed', ?, NOW())`,
            [userId, amount, `Escrow deposit for job: ${jobTitle}`]
        );

        // 3. Update proposal status
        await db.query(
            `UPDATE proposals SET is_deposited = 1 
             WHERE id = ?`,
            [proposal.id]
        );

        return res.json({ ok: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.releasePayment = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;

        if (!Number.isFinite(toId) || toId <= 0 || !Number.isFinite(jobId) || jobId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid parameters' });
        }

        // Verify job ownership
        const [jobRows] = await db.query(
            `SELECT j.id, j.title,
                    u.company_name, u.full_name
             FROM jobs j
             INNER JOIN users u ON u.id = j.employer_id
             WHERE j.id = ? AND j.employer_id = ?
             LIMIT 1`,
            [jobId, userId]
        );
        if (!Array.isArray(jobRows) || jobRows.length === 0) {
            return res.status(403).json({ ok: false, error: 'Unauthorized' });
        }

        if (await blockIfDisputedJson({ res, jobId, employerId: userId, freelancerId: toId })) return;

        const jobTitle = jobRows[0].title;
        const employerDisplayName = jobRows[0].company_name || jobRows[0].full_name || 'Employer';

        // Get Proposal
        const [propRows] = await db.query(
            `SELECT id, bid_amount, is_deposited
             FROM proposals
             WHERE job_id = ? AND freelancer_id = ?
             ORDER BY (status = 'accepted') DESC, id DESC
             LIMIT 1`,
            [jobId, toId]
        );
        if (!Array.isArray(propRows) || propRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Proposal not found' });
        }
        const proposal = propRows[0];

        if (proposal.is_deposited !== 1) {
            return res.status(400).json({ ok: false, error: 'No active deposit to release' });
        }

        const rawAmount = (req.body && req.body.amount !== undefined) ? Number(req.body.amount) : null;
        const bidAmount = Number(proposal.bid_amount);
        const amount = (rawAmount !== null && Number.isFinite(rawAmount) && rawAmount > 0) ? rawAmount : bidAmount;

        if (amount > bidAmount) {
            return res.status(400).json({ ok: false, error: 'Cannot release more than deposited amount' });
        }

        // Execute Transaction (Credit to Freelancer)
        // 1. Add balance to Freelancer
        await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, toId]);

        // 2. Record transaction for Freelancer
        await db.query(
            `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
             VALUES (?, ?, 'payment', 'completed', ?, NOW())`,
            [toId, amount, `Payment received for job: ${jobTitle}`]
        );

        try {
            const amt = Number(amount) || 0;
            await NotificationService.createPersonal(
                toId,
                'Payment Received',
                `${employerDisplayName} paid you ${amt} for: ${jobTitle}`,
                'success',
                '/freelancer/earnings',
                'success',
                userId
            );
        } catch (_) {}

        // 3. Refund remainder to Employer if any
        if (amount < bidAmount) {
            const refund = bidAmount - amount;
            await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [refund, userId]);
            await db.query(
                `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                 VALUES (?, ?, 'refund', 'completed', ?, NOW())`,
                [userId, refund, `Escrow refund (partial) for job: ${jobTitle}`]
            );
        }

        // 4. Update proposal status to Paid (2)
        await db.query(
            `UPDATE proposals SET is_deposited = 2
             WHERE id = ?`,
            [proposal.id]
        );

        return res.json({ ok: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.refundDeposit = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const toRaw = (req.body && req.body.to) ? String(req.body.to).trim() : '';
        const toId = toRaw ? Number(toRaw) : NaN;
        const jobRaw = (req.body && req.body.job) ? String(req.body.job).trim() : '';
        const jobId = jobRaw ? Number(jobRaw) : NaN;

        if (!Number.isFinite(toId) || toId <= 0 || !Number.isFinite(jobId) || jobId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid parameters' });
        }

        // Verify job ownership
        const [jobRows] = await db.query('SELECT id, title, job_type FROM jobs WHERE id = ? AND employer_id = ?', [jobId, userId]);
        if (!Array.isArray(jobRows) || jobRows.length === 0) {
            return res.status(403).json({ ok: false, error: 'Unauthorized' });
        }

        if (await blockIfDisputedJson({ res, jobId, employerId: userId, freelancerId: toId })) return;

        const jobTitle = jobRows[0].title;
        const jobType = (jobRows[0].job_type) ? String(jobRows[0].job_type).toLowerCase() : 'fixed_price';

        // Get Proposal
        const [propRows] = await db.query(
            `SELECT id, bid_amount, is_deposited
             FROM proposals
             WHERE job_id = ? AND freelancer_id = ?
             ORDER BY (status = 'accepted') DESC, id DESC
             LIMIT 1`,
            [jobId, toId]
        );
        if (!Array.isArray(propRows) || propRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Proposal not found' });
        }
        const proposal = propRows[0];

        if (proposal.is_deposited !== 1) {
            return res.status(400).json({ ok: false, error: 'No active deposit to refund' });
        }

        const msg = `Employer requested a refund for job: ${jobTitle} (${jobType}). Awaiting admin approval.`;
        const r = await createAdminRefundRequestDispute({
            employerId: userId,
            freelancerId: toId,
            jobId,
            message: msg,
            category: 'non_payment'
        });
        if (!r.ok) return res.status(400).json({ ok: false, error: r.error || 'Failed to create refund request' });
        return res.json({ ok: true, request_id: r.id, message: 'Refund request submitted to admin for approval.' });
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
                 ORDER BY (status = 'accepted') DESC, id DESC
                 LIMIT 1`,
                [jobId, toId]
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
                [jobId, toId]
            );
            if (!Array.isArray(propRows) || propRows.length === 0 || !propRows[0].is_deposited) {
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
                    const usedMB = Math.round(curSafe / 1024 / 1024);
                    const limitMB = Math.round(monthlyQuotaBytes / 1024 / 1024);
                    const remainMB = Math.max(0, limitMB - usedMB);
                    const fileMB = Math.round(size / 1024 / 1024 * 10) / 10;
                    return res.status(400).json({ ok: false, error: `Monthly quota exceeded. Used: ${usedMB}MB / ${limitMB}MB (${remainMB}MB remaining, file is ${fileMB}MB). Upgrade your plan to continue.` });
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

exports.timesheets = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const rawId = (req.params && req.params.id) ? String(req.params.id).trim() : '';
        const proposalId = rawId ? Number(rawId) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {
            req.flash('error_msg', 'Invalid proposal');
            return res.redirect('/employer/applications');
        }

        const [propRows] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id, p.bid_amount, j.title, j.slug, j.job_type, u.full_name AS freelancer_name, fp.hourly_rate
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             LEFT JOIN users u ON u.id = p.freelancer_id
             LEFT JOIN freelancer_profiles fp ON fp.user_id = p.freelancer_id
             WHERE p.id = ? AND j.employer_id = ?
             LIMIT 1`,
            [proposalId, employerId]
        );

        const proposal = Array.isArray(propRows) && propRows.length ? propRows[0] : null;

        if (!proposal) {
            req.flash('error_msg', 'Proposal not found or unauthorized');
            return res.redirect('/employer/applications');
        }

        if (proposal.job_type !== 'hourly') {
            req.flash('error_msg', 'Timesheets are only available for hourly jobs');
            return res.redirect('/employer/applications');
        }

        const [timesheets] = await db.query(
            `SELECT * FROM timesheets WHERE proposal_id = ? ORDER BY week_start DESC, created_at DESC`,
            [proposalId]
        );

        return res.render('employer/timesheets', {
            user: req.session.user,
            proposal,
            timesheets: Array.isArray(timesheets) ? timesheets : []
        });

    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/applications');
    }
};

exports.updateContractRate = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const rawPid = (req.params && req.params.pid) ? String(req.params.pid).trim() : '';
        const proposalId = rawPid ? Number(rawPid) : NaN;
        const newRateRaw = (req.body && req.body.rate) ? Number(req.body.rate) : NaN;

        if (!Number.isFinite(proposalId) || proposalId <= 0) {
             return res.status(400).json({ ok: false, error: 'Invalid proposal' });
        }
        if (!Number.isFinite(newRateRaw) || newRateRaw <= 0) {
             return res.status(400).json({ ok: false, error: 'Invalid rate' });
        }

        // Verify ownership and get current state
        const [propRows] = await db.query(
            `SELECT p.id, p.bid_amount, p.is_deposited, j.title AS job_title
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.id = ? AND j.employer_id = ? AND j.job_type = 'hourly'
             LIMIT 1`,
            [proposalId, employerId]
        );

        if (!Array.isArray(propRows) || propRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Proposal not found or not hourly' });
        }

        const proposal = propRows[0];
        
        // If currently deposited, we must refund the OLD amount first to avoid exploits/losses
        if (proposal.is_deposited === 1) {
            const oldAmount = Number(proposal.bid_amount);
            
            // Refund to Employer
            await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [oldAmount, employerId]);
            
            // Record Transaction
            await db.query(
                `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                 VALUES (?, ?, 'refund', 'completed', ?, NOW())`,
                [employerId, oldAmount, `Security bond refund (Rate Change) for job: ${proposal.job_title}`]
            );
            
            // Set as not deposited
            await db.query(`UPDATE proposals SET is_deposited = 0 WHERE id = ?`, [proposalId]);
        }

        // Update to new rate
        await db.query(`UPDATE proposals SET bid_amount = ? WHERE id = ?`, [newRateRaw, proposalId]);

        return res.json({ ok: true, message: 'Rate updated. Please re-deposit the security bond if needed.' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.approveTimesheet = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const rawTid = (req.params && req.params.tid) ? String(req.params.tid).trim() : '';
        const timesheetId = rawTid ? Number(rawTid) : NaN;

        if (!Number.isFinite(timesheetId) || timesheetId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid timesheet' });
        }

        // Verify ownership via proposal -> job -> employer
        const [tsRows] = await db.query(
            `SELECT t.*, p.id AS proposal_id, p.job_id, p.freelancer_id, p.bid_amount, p.is_deposited,
                    j.title AS job_title, j.job_type, fp.hourly_rate,
                    u.company_name AS employer_company_name, u.full_name AS employer_full_name
             FROM timesheets t
             INNER JOIN proposals p ON p.id = t.proposal_id
             INNER JOIN jobs j ON j.id = p.job_id
             INNER JOIN users u ON u.id = j.employer_id
             LEFT JOIN freelancer_profiles fp ON fp.user_id = p.freelancer_id
             WHERE t.id = ? AND j.employer_id = ?
             LIMIT 1`,
            [timesheetId, employerId]
        );

        const timesheet = Array.isArray(tsRows) && tsRows.length ? tsRows[0] : null;
        if (!timesheet) {
            return res.status(404).json({ ok: false, error: 'Timesheet not found' });
        }

        if (await blockIfDisputedJson({ res, jobId: timesheet.job_id, employerId, freelancerId: timesheet.freelancer_id })) return;

        if (timesheet.status === 'paid') {
            return res.status(400).json({ ok: false, error: 'Timesheet already paid' });
        }

        // For Hourly, use Proposal Rate (bid_amount) as the agreed contract rate.
        // For Fixed Price (if ever used here), bid_amount is total project price.
        const rate = (timesheet.job_type === 'hourly') 
            ? (Number(timesheet.bid_amount) || 0) 
            : (Number(timesheet.hourly_rate) || 0);

        const hours = Number(timesheet.hours) || 0;
        const amount = rate * hours;

        if (amount <= 0) {
             await db.query(`UPDATE timesheets SET status = 'approved' WHERE id = ?`, [timesheetId]);
             return res.json({ ok: true });
        }

        // Hourly requires active deposit (activation bond)
        const depositedState = (timesheet.is_deposited === undefined || timesheet.is_deposited === null)
            ? 0
            : Number(timesheet.is_deposited);
        
        if (depositedState !== 1 && timesheet.job_type === 'hourly') {
            return res.status(400).json({ ok: false, error: 'Contract must be activated (deposited) first' });
        }

        // PAYMENT LOGIC:
        // For Hourly, the initial deposit is a SECURITY BOND (held in escrow).
        // Actual payments for timesheets come from the Employer's MAIN BALANCE.
        // This ensures the deposit is preserved for the end of contract or disputes.
        
        const payFromBalance = amount;

        // Check Employer Balance
        const [uRows] = await db.query('SELECT balance FROM users WHERE id = ?', [employerId]);
        const balance = (Array.isArray(uRows) && uRows.length) ? Number(uRows[0].balance) : 0;
        
        if (balance < payFromBalance) {
            return res.status(400).json({ ok: false, error: `Insufficient balance. Please top up $${payFromBalance}.` });
        }
        
        // Deduct from Employer
        await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [payFromBalance, employerId]);
            
        // Record transaction for Employer
        await db.query(
            `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                VALUES (?, ?, 'payment', 'completed', ?, NOW())`,
            [employerId, payFromBalance, `Payment for timesheet #${timesheetId} (${hours} hrs @ $${rate}/hr)`]
        );

        // Add to Freelancer
        await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, timesheet.freelancer_id]);

        // Record Transactions for Freelancer
        await db.query(
            `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
             VALUES (?, ?, 'payment', 'completed', ?, NOW())`,
            [timesheet.freelancer_id, amount, `Payment received for timesheet #${timesheetId} (${hours} hrs @ $${rate}/hr)`]
        );

        try {
            const employerDisplayName = timesheet.employer_company_name || timesheet.employer_full_name || 'Employer';
            const jobTitle = timesheet.job_title || 'your job';
            const amt = Number(amount) || 0;
            await NotificationService.createPersonal(
                timesheet.freelancer_id,
                'Payment Received',
                `${employerDisplayName} paid you ${amt} for: ${jobTitle}`,
                'success',
                '/freelancer/earnings',
                'success',
                employerId
            );
        } catch (_) {}

        // Update Timesheet Status
        await db.query(`UPDATE timesheets SET status = 'paid' WHERE id = ?`, [timesheetId]);

        return res.json({ ok: true });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.rejectTimesheet = async (req, res) => {
    try {
        const employerId = req.session.user.id;
        const rawTid = (req.params && req.params.tid) ? String(req.params.tid).trim() : '';
        const timesheetId = rawTid ? Number(rawTid) : NaN;

        if (!Number.isFinite(timesheetId) || timesheetId <= 0) {
             return res.status(400).json({ ok: false, error: 'Invalid timesheet' });
        }

        const [tsRows] = await db.query(
            `SELECT t.id
             FROM timesheets t
             INNER JOIN proposals p ON p.id = t.proposal_id
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE t.id = ? AND j.employer_id = ?
             LIMIT 1`,
            [timesheetId, employerId]
        );

        if (!Array.isArray(tsRows) || tsRows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Timesheet not found' });
        }

        await db.query(`UPDATE timesheets SET status = 'disputed' WHERE id = ?`, [timesheetId]);

        return res.json({ ok: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.getTimerStatus = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const jobId = (req.query && req.query.job_id) ? Number(req.query.job_id) : NaN;
        
        if (!Number.isFinite(jobId) || jobId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid Job ID' });
        }

        // Fetch proposal associated with this job
        // Note: For Employer, we need to find the accepted proposal or the one in chat context
        // The user usually provides 'to_id' (freelancer) as well in chat context
        const toId = (req.query && req.query.to_id) ? Number(req.query.to_id) : NaN;
        
        if (!Number.isFinite(toId) || toId <= 0) {
             return res.status(400).json({ ok: false, error: 'Invalid Freelancer ID' });
        }

        const [propRows] = await db.query(
            `SELECT p.id, p.job_id, p.freelancer_id, p.bid_amount, p.is_deposited,
                    p.timer_status, p.timer_start_time, p.total_seconds_worked, p.paid_seconds
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [jobId, toId]
        );

        if (!Array.isArray(propRows) || propRows.length === 0) {
            return res.json({ ok: false, error: 'Proposal not found' });
        }

        const proposal = propRows[0];
        
        // Calculate current accumulated seconds
        let currentTotal = Number(proposal.total_seconds_worked || 0);
        let isRunning = (proposal.timer_status === 'running');
        
        if (isRunning && proposal.timer_start_time) {
            const start = new Date(proposal.timer_start_time).getTime();
            const now = Date.now();
            const elapsed = Math.floor((now - start) / 1000);
            if (elapsed > 0) {
                currentTotal += elapsed;
            }
        }

        return res.json({
            ok: true,
            status: proposal.timer_status,
            start_time: proposal.timer_start_time,
            total_seconds: currentTotal,
            paid_seconds: Number(proposal.paid_seconds || 0),
            hourly_rate: Number(proposal.bid_amount || 0),
            is_deposited: Number(proposal.is_deposited || 0)
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.startTimer = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { job_id, to_id } = req.body;
        
        if (!job_id || !to_id) return res.status(400).json({ ok: false, error: 'Missing parameters' });

        // Verify Deposit/Activation
        const [propRows] = await db.query(
            `SELECT p.id, p.bid_amount, p.is_deposited, p.timer_status, j.employer_id
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [job_id, to_id]
        );

        if (!propRows.length) return res.status(404).json({ ok: false, error: 'Proposal not found' });
        const proposal = propRows[0];

        if (proposal.is_deposited !== 1) {
            return res.status(403).json({ ok: false, error: 'Contract not activated (Deposit required)' });
        }

        if (proposal.timer_status === 'running') {
            return res.json({ ok: true, message: 'Already running' });
        }

        // Start Timer
        await db.query(
            `UPDATE proposals 
             SET timer_status = 'running', timer_start_time = NOW() 
             WHERE id = ?`,
            [proposal.id]
        );

        return res.json({ ok: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.stopTimer = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { job_id, to_id } = req.body;

        const [propRows] = await db.query(
            `SELECT p.id, p.timer_status, p.timer_start_time, p.total_seconds_worked, p.paid_seconds, p.bid_amount,
                    j.employer_id, j.title AS job_title,
                    TIMESTAMPDIFF(SECOND, p.timer_start_time, NOW()) AS elapsed_db
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [job_id, to_id]
        );

        if (!propRows.length) return res.status(404).json({ ok: false, error: 'Proposal not found' });
        const proposal = propRows[0];

        if (proposal.timer_status !== 'running') {
            return res.json({ ok: true, message: 'Already stopped' });
        }

        // Calculate elapsed from DB
        const elapsed = Number(proposal.elapsed_db) || 0;
        const newTotal = (Number(proposal.total_seconds_worked) || 0) + (elapsed > 0 ? elapsed : 0);

        // Immediate Payment for Unpaid Seconds
        const paidSeconds = Number(proposal.paid_seconds || 0);
        const unpaidSeconds = newTotal - paidSeconds;
        
        let paidAmount = 0;
        let newPaidSeconds = paidSeconds;

        if (unpaidSeconds > 0) {
            const rate = Number(proposal.bid_amount);
            // Calculate prorated amount: (unpaid_seconds / 3600) * rate
            const amountToPay = (unpaidSeconds / 3600) * rate;
            
            // Round to 2 decimal places for currency, but keep precision internally? 
            // Let's standardise to 2 decimals for transactions to avoid float issues.
            const amountRounded = Math.round(amountToPay * 100) / 100;

            if (amountRounded > 0) {
                const employerId = proposal.employer_id;
                const freelancerId = to_id;

                // Check Balance
                const [uRows] = await db.query('SELECT balance FROM users WHERE id = ?', [employerId]);
                const balance = (Array.isArray(uRows) && uRows.length) ? Number(uRows[0].balance) : 0;

                if (balance >= amountRounded) {
                    // Execute Payment to PENDING BALANCE
                    // Deduct from Employer
                    await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amountRounded, employerId]);
                    // Add to Proposal Pending Balance
                    await db.query('UPDATE proposals SET pending_balance = pending_balance + ? WHERE id = ?', [amountRounded, proposal.id]);

                    await db.query(
                        `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                         VALUES (?, ?, 'payment', 'pending', ?, NOW())`,
                        [employerId, amountRounded, `Hourly Payment (Stop Timer - ${unpaidSeconds}s) (Pending Review) for job: ${proposal.job_title}`]
                    );
                    await db.query(
                        `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                         VALUES (?, ?, 'payment', 'pending', ?, NOW())`,
                        [freelancerId, amountRounded, `Hourly Payment (Stop Timer - ${unpaidSeconds}s) (Pending Review) for job: ${proposal.job_title}`]
                    );
                    
                    paidAmount = amountRounded;
                    newPaidSeconds = newTotal; // All seconds are now paid
                }
            }
        }

        await db.query(
            `UPDATE proposals 
             SET timer_status = 'stopped', timer_start_time = NULL, total_seconds_worked = ?, paid_seconds = ?
             WHERE id = ?`,
            [newTotal, newPaidSeconds, proposal.id]
        );
        
        return res.json({ ok: true, paid: paidAmount });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.syncTimer = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { job_id, to_id } = req.body;

        // 1. Get Proposal & Job info
        const [propRows] = await db.query(
            `SELECT p.id, p.bid_amount, p.is_deposited, p.timer_status, p.timer_start_time, 
                    p.total_seconds_worked, p.paid_seconds,
                    j.employer_id, j.title AS job_title,
                    TIMESTAMPDIFF(SECOND, p.timer_start_time, NOW()) AS elapsed_db
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [job_id, to_id]
        );

        if (!propRows.length) return res.status(404).json({ ok: false, error: 'Proposal not found' });
        const proposal = propRows[0];
        const employerId = proposal.employer_id;
        const freelancerId = to_id; // from req
        const rate = Number(proposal.bid_amount);

        // 2. Calculate Total Worked Seconds (including current session if running)
        let currentTotal = Number(proposal.total_seconds_worked || 0);
        if (proposal.timer_status === 'running' && proposal.elapsed_db !== null) {
            const elapsed = Number(proposal.elapsed_db) || 0;
            if (elapsed > 0) currentTotal += elapsed;
        }

        // 3. Check for Due Payments (Every 1 minute = 60 seconds) for TESTING, or keep 1 hour?
        // User complained about discrepancy.
        // If unpaidSeconds >= 3600...
        // Let's stick to 1 hour, BUT ensure precise floating point math.
        
        const paidSeconds = Number(proposal.paid_seconds || 0);
        const unpaidSeconds = currentTotal - paidSeconds;
        
        if (unpaidSeconds >= 3600) {
            // Calculate how many FULL hours to pay
            const hoursToPay = Math.floor(unpaidSeconds / 3600);
            
            // Use exact rate calculation
            // amount = hours * rate
            const amountToPay = hoursToPay * rate;
            
            // Round to 2 decimals for currency
            const amountRounded = Math.round(amountToPay * 100) / 100;
            
            if (hoursToPay > 0 && amountRounded > 0) {
                // Check Employer Balance
                const [uRows] = await db.query('SELECT balance FROM users WHERE id = ?', [employerId]);
                const balance = (Array.isArray(uRows) && uRows.length) ? Number(uRows[0].balance) : 0;
                
                if (balance < amountRounded) {
                    // STOP TIMER if insufficient funds
                    if (proposal.timer_status === 'running') {
                         await db.query(
                            `UPDATE proposals 
                             SET timer_status = 'stopped', timer_start_time = NULL, total_seconds_worked = ? 
                             WHERE id = ?`,
                            [currentTotal, proposal.id]
                        );
                    }
                    return res.status(402).json({ 
                        ok: false, 
                        error: 'Insufficient funds. Timer stopped.', 
                        stopped: true 
                    });
                }

                // Execute Payment to PENDING BALANCE
                // Deduct from Employer (Main Balance)
                await db.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amountRounded, employerId]);
                
                // Add to Proposal Pending Balance (NOT Freelancer Main Balance yet)
                await db.query('UPDATE proposals SET pending_balance = pending_balance + ? WHERE id = ?', [amountRounded, proposal.id]);

                // Record Transactions
                await db.query(
                    `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                     VALUES (?, ?, 'payment', 'pending', ?, NOW())`,
                    [employerId, amountRounded, `Hourly Payment (Pending Review) (${hoursToPay} hrs) for job: ${proposal.job_title}`]
                );
                // Freelancer sees this as 'pending'
                await db.query(
                    `INSERT INTO transactions (user_id, amount, type, status, description, created_at)
                     VALUES (?, ?, 'payment', 'pending', ?, NOW())`,
                    [freelancerId, amountRounded, `Hourly Payment (Pending Review) (${hoursToPay} hrs) for job: ${proposal.job_title}`]
                );

                // Update Paid Seconds
                const newPaidSeconds = paidSeconds + (hoursToPay * 3600);
                await db.query(`UPDATE proposals SET paid_seconds = ? WHERE id = ?`, [newPaidSeconds, proposal.id]);
                
                return res.json({ ok: true, paid: amountRounded, hours: hoursToPay });
            }
        }

        return res.json({ ok: true, paid: 0 });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.releasePendingPayment = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { job_id, to_id } = req.body;

        // Verify Proposal & Pending Balance
        const [propRows] = await db.query(
            `SELECT p.id, p.pending_balance, j.title AS job_title
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND j.employer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [job_id, to_id, userId]
        );

        if (!propRows.length) return res.status(404).json({ ok: false, error: 'Proposal not found' });
        const proposal = propRows[0];

        if (await blockIfDisputedJson({ res, jobId: job_id, employerId: userId, freelancerId: to_id })) return;

        const pendingAmount = Number(proposal.pending_balance || 0);

        if (pendingAmount <= 0) {
            return res.status(400).json({ ok: false, error: 'No pending balance to release' });
        }

        // Transfer to Freelancer Main Balance
        await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [pendingAmount, to_id]);
        
        // Reset Pending Balance AND Reset Timer to 0 (New Cycle)
        await db.query(
            `UPDATE proposals 
             SET pending_balance = 0,
                 total_seconds_worked = 0,
                 paid_seconds = 0,
                 timer_status = 'stopped',
                 timer_start_time = NULL,
                 last_sync_time = NULL
             WHERE id = ?`,
            [proposal.id]
        );

        // Update Transactions Status
        await db.query(
            `UPDATE transactions 
             SET status = 'completed', description = CONCAT(description, ' [Released]')
             WHERE user_id IN (?, ?) AND status = 'pending' AND description LIKE ?`,
            [userId, to_id, `%${proposal.job_title}%`]
        );

        // Notify Freelancer & Employer
        try {
            const employerName = req.session.user.full_name || 'Employer';
            
            // Get Freelancer name for Employer's notification
            const [fRows] = await db.query('SELECT full_name FROM users WHERE id = ? LIMIT 1', [to_id]);
            const freelancerName = (Array.isArray(fRows) && fRows.length) ? fRows[0].full_name : 'Freelancer';

            // 1. Notify Freelancer (Nhận tiền)
            await NotificationService.createPersonal(
                to_id,
                'Payment Received',
                `${employerName} has approved and released ${pendingAmount} Diamonds for your work on: ${proposal.job_title}`,
                'success',
                '/freelancer/earnings',
                'success',
                userId
            );

            // 2. Notify Employer (Đã trả tiền)
            await NotificationService.createPersonal(
                userId,
                'Payment Released',
                `You have successfully released ${pendingAmount} Diamonds to ${freelancerName} for: ${proposal.job_title}`,
                'info',
                '/employer/transactions', // Hoặc trang quản lý chi tiêu của employer
                'success',
                to_id
            );
        } catch (e) {
            console.error('Failed to notify about released payment:', e);
        }

        return res.json({ ok: true, released: pendingAmount });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.refundPendingPayment = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { job_id, to_id } = req.body;

        // Verify Proposal & Pending Balance
        const [propRows] = await db.query(
            `SELECT p.id, p.pending_balance, j.title AS job_title
             FROM proposals p
             INNER JOIN jobs j ON j.id = p.job_id
             WHERE p.job_id = ? AND p.freelancer_id = ? AND j.employer_id = ? AND p.status = 'accepted'
             LIMIT 1`,
            [job_id, to_id, userId]
        );

        if (!propRows.length) return res.status(404).json({ ok: false, error: 'Proposal not found' });
        const proposal = propRows[0];

        if (await blockIfDisputedJson({ res, jobId: job_id, employerId: userId, freelancerId: to_id })) return;

        const pendingAmount = Number(proposal.pending_balance || 0);

        if (pendingAmount <= 0) {
            return res.status(400).json({ ok: false, error: 'No pending balance to refund' });
        }

        const msg = `Employer requested a refund of pending hourly payment: ${pendingAmount} for job: ${proposal.job_title}. Awaiting admin approval.`;
        const r = await createAdminRefundRequestDispute({
            employerId: userId,
            freelancerId: to_id,
            jobId: job_id,
            message: msg,
            category: 'non_payment'
        });
        if (!r.ok) return res.status(400).json({ ok: false, error: r.error || 'Failed to create refund request' });
        return res.json({ ok: true, request_id: r.id, message: 'Refund request submitted to admin for approval.' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'Server Error' });
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
        let autoRenew = 1;
        try {
            const [arows] = await db.query(
                `SELECT p.code, up.auto_renew
                 FROM user_plans up
                 JOIN plans p ON p.id = up.plan_id
                 WHERE up.user_id = ? AND up.status = 'active'
                 LIMIT 1`,
                [req.session.user.id]
            );
            if (Array.isArray(arows) && arows.length) {
                activeCode = arows[0].code;
                autoRenew = arows[0].auto_renew;
            }
        } catch (_) {}
        return res.json({ ok: true, items: Array.isArray(rows) ? rows : [], active_plan_code: activeCode, auto_renew: autoRenew });
    } catch (e) {
        return res.status(500).json({ ok: false, items: [] });
    }
};

exports.toggleAutoRenew = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const val = req.body && req.body.auto_renew !== undefined ? Number(req.body.auto_renew) : null;
        if (val !== 0 && val !== 1) return res.status(400).json({ ok: false, error: 'Invalid value' });
        await db.execute(
            `UPDATE user_plans SET auto_renew = ? WHERE user_id = ? AND status = 'active'`,
            [val, userId]
        );
        return res.json({ ok: true, auto_renew: val });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Server Error' });
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
             VALUES (?, ?, 'active', UTC_TIMESTAMP(), ?, ?)`,
            [userId, plan.id, endStr, price > 0 ? 1 : 0]
        );

        // Reset upload usage for current month only when switching to a paid plan
        if (price > 0) {
            const pk = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
            await db.query(
                `DELETE FROM upload_usage WHERE user_id = ? AND period_key = ?`,
                [userId, pk]
            );
        }

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

exports.toggleAutoRenew = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const val = req.body && req.body.auto_renew !== undefined ? Number(req.body.auto_renew) : null;
        if (val !== 0 && val !== 1) return res.status(400).json({ ok: false, error: 'Invalid value' });
        await db.execute(
            `UPDATE user_plans SET auto_renew = ? WHERE user_id = ? AND status = 'active'`,
            [val, userId]
        );
        return res.json({ ok: true, auto_renew: val });
    } catch (e) {
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
        const replyToRaw = (req.body && req.body.replyTo) ? String(req.body.replyTo).trim() : '';
        const replyToId = replyToRaw ? Number(replyToRaw) : null;
        
        // DEBUG: Temporary check to see if replyTo is received
        // if (replyToId) {
        //    console.log('ReplyTo received:', replyToId);
        // }

        if (!Number.isFinite(toId) || toId <= 0) {
            req.flash('error_msg', 'Invalid recipient');
            return res.redirect('/employer/messages');
        }

        const [toRows] = await db.query(
            `SELECT id FROM users WHERE id = ? AND role = 'freelancer' LIMIT 1`,
            [toId]
        );
        if (!Array.isArray(toRows) || toRows.length === 0) {
            req.flash('error_msg', 'Recipient not found');
            return res.redirect('/employer/messages');
        }

        let attachmentUrl = req.file ? ('/img/' + req.file.filename) : null;
        let attachmentType = req.file
            ? ((req.file.mimetype && req.file.mimetype.startsWith('image/'))
                ? 'image'
                : ((req.file.mimetype && req.file.mimetype.startsWith('video/')) ? 'video' : 'file'))
            : null;

        if (!attachmentUrl && req.body.attachmentUrl) {
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
                req.flash('error_msg', 'Deposit required to unlock file uploads');
                return res.redirect(`/employer/messages?to=${toId}`);
            }

            const [propRows] = await db.query(
                `SELECT is_deposited FROM proposals
                 WHERE job_id = ? AND freelancer_id = ?
                 ORDER BY (status = 'accepted') DESC, id DESC
                 LIMIT 1`,
                [jobId, toId]
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
                req.flash('error_msg', 'Deposit required to unlock file uploads');
                return res.redirect(`/employer/messages?to=${toId}&job=${jobId}`);
            }
        }

        if (!content && !attachmentUrl) {
            return res.redirect(`/employer/messages?to=${toId}${Number.isFinite(jobId) && jobId > 0 ? `&job=${jobId}` : ''}`);
        }

        await Message.create({
            sender_id: senderId,
            receiver_id: toId,
            job_id: (Number.isFinite(jobId) && jobId > 0) ? jobId : null,
            content,
            attachment_url: attachmentUrl,
            attachment_type: attachmentType,
            reply_to_id: (Number.isFinite(replyToId) && replyToId > 0) ? replyToId : null
        });

        return res.redirect(`/employer/messages?to=${toId}${Number.isFinite(jobId) && jobId > 0 ? `&job=${jobId}` : ''}&debug_reply=${replyToRaw || 'empty'}`);
    } catch (error) {
        console.error(error);
        req.flash('error_msg', 'Server Error');
        return res.redirect('/employer/messages');
    }
};
