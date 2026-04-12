const db = require('../config/db');

async function getActiveRulesForPage(pageKey) {
    const key = pageKey ? String(pageKey).trim() : '';

    try {
        const [rows] = await db.query(
            `SELECT r.id, r.pattern, r.match_type, r.mask_with, r.apply_globally, r.apply_selected_pages
             FROM content_filter_rules r
             WHERE r.is_active = 1
               AND (
                    r.apply_globally = 1
                    OR (
                        r.apply_selected_pages = 1
                        AND ? <> ''
                        AND EXISTS (
                            SELECT 1
                            FROM content_filter_rule_pages rp
                            WHERE rp.rule_id = r.id AND rp.page_key = ?
                        )
                    )
               )
             ORDER BY r.id DESC`,
            [key, key]
        );

        return Array.isArray(rows) ? rows : [];
    } catch (err) {
        return [];
    }
}

function applyRulesToText(input, rules) {
    const str = (input === undefined || input === null) ? '' : String(input);
    const list = Array.isArray(rules) ? rules : [];

    return list.reduce((acc, rule) => {
        const pattern = rule && rule.pattern ? String(rule.pattern) : '';
        const matchType = rule && rule.match_type ? String(rule.match_type) : 'keyword';
        const maskWith = (rule && rule.mask_with !== undefined && rule.mask_with !== null)
            ? String(rule.mask_with)
            : '***';

        if (!pattern) return acc;

        if (matchType === 'regex') {
            try {
                const re = new RegExp(pattern, 'gi');
                return acc.replace(re, maskWith);
            } catch (err) {
                return acc;
            }
        }

        // Keyword mode:
        // - Normal keywords: replace only the keyword.
        // - URL-like keywords (http/https/www/domain): mask the entire URL token so it won't leak the remainder.
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lower = pattern.toLowerCase();

        // Mask full http(s) URL when keyword hints a URL.
        if (lower === 'http' || lower === 'https' || lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('http') || lower.startsWith('https')) {
            const urlRe = /https?:\/\/[^\s<>"']+/gi;
            return acc.replace(urlRe, (m) => (m.toLowerCase().includes(lower.replace(/:\/\/$/, '')) ? maskWith : m));
        }

        // Mask full www URL
        if (lower === 'www' || lower.startsWith('www.')) {
            const wwwRe = /www\.[^\s<>"']+/gi;
            return acc.replace(wwwRe, maskWith);
        }

        // Domain-like keyword: if pattern contains dot and no spaces, mask entire token from match onward
        if (pattern.includes('.') && !pattern.includes(' ')) {
            const domainRe = new RegExp(escaped + "[^\\s<>\"']*", 'gi');
            return acc.replace(domainRe, maskWith);
        }

        const re = new RegExp(escaped, 'gi');
        return acc.replace(re, maskWith);
    }, str);
}

function maskJobFields(job, rules) {
    const j = job && typeof job === 'object' ? job : {};
    const masked = { ...j };

    masked.title = applyRulesToText(j.title, rules);
    masked.company_name = applyRulesToText(j.company_name, rules);
    masked.description = applyRulesToText(j.description, rules);
    masked.company_description = applyRulesToText(j.company_description, rules);
    masked.website = applyRulesToText(j.website, rules);

    return masked;
}

module.exports = {
    getActiveRulesForPage,
    applyRulesToText,
    maskJobFields
};
