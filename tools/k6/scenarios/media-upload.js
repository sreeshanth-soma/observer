/**
 * Scenario: Media Upload
 *
 * Two-step upload process matching Observer's architecture:
 *   1. POST raw file bytes to /upload.php → get file_id and file_key
 *   2. POST media metadata via v1 API (media/save) → create the media record
 *
 * Auth: Step 1 has no per-request auth (raw binary body, no POST params).
 *       Step 2 uses v1 session auth (i/k params).
 *
 * Endpoint 1: POST /upload.php (raw binary body)
 * Endpoint 2: POST /api.php (form-encoded: c=media, a=save, d=JSON, i, k)
 */

import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { BASE_URL } from '../lib/config.js';
import { apiCall } from '../lib/auth.js';
import { checkUpload, checkResponse } from '../lib/checks.js';

const SCENARIO = 'media_upload';

// Load the sample MP3 at init time (shared across all VUs in memory).
const fileData = open('../testdata/sample.mp3', 'b');

export default function (data) {
    const vu   = exec.vu.idInTest;
    const iter = exec.vu.iterationInScenario;

    // Step 1: Upload raw file bytes.
    const uploadRes = http.post(
        `${BASE_URL}/upload.php`,
        fileData,
        {
            headers: { 'Content-Type': 'application/octet-stream' },
            tags: { scenario: SCENARIO },
        }
    );

    if (!checkUpload(uploadRes, SCENARIO)) {
        sleep(1);
        return; // skip step 2 if upload failed
    }

    const uploadData = uploadRes.json();

    // Step 2: Create media record via v1 API.
    // Required fields: artist, album, year, category_id (from core_metadata).
    // Also include optional fields that media_model.php accesses without
    // isset checks — omitting them causes PHP warnings that corrupt the JSON.
    const createRes = apiCall(data.session, 'media', 'save', {
        media: [{
            local_id:           0,
            file_id:            uploadData.file_id,
            file_key:           uploadData.file_key,
            artist:             'k6 Load Test',
            title:              `Load Test ${vu}-${iter}`,
            album:              'k6 Load Test',
            year:               new Date().getFullYear().toString(),
            category_id:        1,
            country:            '',
            language:           '',
            comments:           '',
            genre_id:           '',
            status:             'private',
            type:               uploadData.media_info ? uploadData.media_info.type : 'audio',
            is_copyright_owner: 0,
            is_approved:        0,
            dynamic_select:     0,
        }],
    }, { tags: { scenario: SCENARIO } });

    checkResponse(createRes, SCENARIO);

    sleep(1);
}
