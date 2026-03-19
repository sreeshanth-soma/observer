/**
 * Scenario: Media Availability Check
 *
 * Fetches media item details via v1 API (media/get) to check if it exists.
 * This is the lightest scenario — read-only with no side effects.
 *
 * Endpoint: POST /api.php (c=media, a=get)
 * Auth: v1 session auth (i/k params)
 * Body: { id: <media_id> }
 * Response: { status: true, msg: "Media data.", data: { id, artist, title, ... } }
 */

import { sleep } from 'k6';
import { apiCall } from '../lib/auth.js';
import { checkResponse } from '../lib/checks.js';

const SCENARIO = 'media_availability';

export default function (data) {
    const res = apiCall(data.session, 'media', 'get', {
        id: data.mediaId,
    }, { tags: { scenario: SCENARIO } });

    checkResponse(res, SCENARIO);

    sleep(0.3);
}
