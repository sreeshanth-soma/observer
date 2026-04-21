/**
 * Scenario: Bulk Metadata Edit
 *
 * Saves metadata for a large batch of existing media items in a single API call.
 * Reproduces the reported perf issue where editing 10 items is instant but
 * 50-100 items takes 30-60 seconds. Each VU iteration submits an update for
 * every item in data.bulkMediaIds (up to 50 items per request).
 *
 * Endpoint: POST /api.php (c=media, a=save)
 * Auth: v1 session auth (i/k params)
 * Body: { media: [ { id, artist, title, comments, ... }, ... ] }
 * Response: { status: true, msg: "Media has been saved.", data: [ids] }
 */

import { sleep } from 'k6';
import exec from 'k6/execution';
import { apiCall } from '../lib/auth.js';
import { checkResponse } from '../lib/checks.js';

const SCENARIO = 'bulk_metadata_edit';

export default function (data) {
    const vu   = exec.vu.idInTest;
    const iter = exec.vu.iterationInScenario;

    if (!data.bulkMediaIds || data.bulkMediaIds.length === 0) {
        return; // setup didn't provide any items to edit
    }

    // Build an update payload using the original snapshot, rewriting a couple of
    // free-form fields so each iteration produces a real DB write. file_id/file_key
    // must be empty strings to flag these as updates (see media.save in media.php).
    const mediaItems = data.bulkMediaIds.map((snapshot) => ({
        id:                 snapshot.id,
        local_id:           0, // media_model.php:1668 reads this without isset — omit and PHP warns, corrupting JSON
        file_id:            '',
        file_key:           '',
        artist:             snapshot.artist || `k6 Bulk ${vu}-${iter}`,
        title:              snapshot.title  || 'Bulk Edit Test',
        album:              snapshot.album  || 'k6 Load Test',
        year:               snapshot.year   || new Date().getFullYear().toString(),
        category_id:        snapshot.category_id || 1,
        country:            snapshot.country  || '',
        language:           snapshot.language || '',
        comments:           `k6-bulk-edit vu${vu} iter${iter}`,
        genre_id:           snapshot.genre_id || '',
        status:             snapshot.status   || 'private',
        type:               snapshot.type     || 'audio',
        is_copyright_owner: snapshot.is_copyright_owner || 0,
        is_approved:        snapshot.is_approved || 0,
        dynamic_select:     0,
    }));

    const res = apiCall(data.session, 'media', 'save', {
        media: mediaItems,
    }, { tags: { scenario: SCENARIO }, timeout: '120s' });

    checkResponse(res, SCENARIO);

    sleep(1);
}
