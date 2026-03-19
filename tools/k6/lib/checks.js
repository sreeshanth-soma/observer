/**
 * Reusable check helpers for k6 load tests.
 *
 * Each function wraps k6's check() and tags results with the scenario name,
 * which enables per-scenario threshold tracking (e.g. http_req_duration{scenario:media_upload}).
 *
 * When a check fails, the response body is logged so you can see the exact
 * server error message in the k6 console output.
 */

import { check } from 'k6';

/**
 * Check a JSON API response for HTTP 200 and { status: true }.
 * Logs the response body on failure for debugging.
 * @param {object} res - k6 HTTP response
 * @param {string} scenario - scenario name for tagging
 * @returns {boolean}
 */
export function checkResponse(res, scenario) {
    const ok = check(res, {
        'status 200':     (r) => r.status === 200,
        'api success':    (r) => {
            try { return r.json().status === true; }
            catch (e) { return false; }
        },
    }, { scenario });

    if (!ok) {
        // Log first 300 chars of response body for debugging.
        const body = res.body ? res.body.substring(0, 300) : '(empty)';
        console.warn(`[${scenario}] check failed (HTTP ${res.status}): ${body}`);
    }

    return ok;
}

/**
 * Check an XML response from remote.php.
 * Expects HTTP 200, body contains <obconnect>, and no <error> tag.
 * @param {object} res - k6 HTTP response
 * @param {string} scenario - scenario name for tagging
 * @returns {boolean}
 */
export function checkXml(res, scenario) {
    const ok = check(res, {
        'status 200':       (r) => r.status === 200,
        'has <obconnect>':  (r) => r.body.includes('<obconnect'),
        'no <error>':       (r) => !r.body.includes('<error>'),
    }, { scenario });

    if (!ok) {
        const body = res.body ? res.body.substring(0, 300) : '(empty)';
        console.warn(`[${scenario}] XML check failed (HTTP ${res.status}): ${body}`);
    }

    return ok;
}

/**
 * Check that a file upload response succeeded.
 * Expects HTTP 200 and response body contains file_id.
 * @param {object} res - k6 HTTP response
 * @param {string} scenario - scenario name for tagging
 * @returns {boolean}
 */
export function checkUpload(res, scenario) {
    const ok = check(res, {
        'status 200':    (r) => r.status === 200,
        'has file_id':   (r) => {
            try { return r.json().file_id !== undefined; }
            catch (e) { return false; }
        },
    }, { scenario });

    if (!ok) {
        const body = res.body ? res.body.substring(0, 300) : '(empty)';
        console.warn(`[${scenario}] upload check failed (HTTP ${res.status}): ${body}`);
    }

    return ok;
}
