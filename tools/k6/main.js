/**
 * OpenBroadcaster Observer — k6 Load Test Entry Point
 *
 * Orchestrates all 5 test scenarios with configurable load levels.
 * Run via: ./run.sh [low|medium|high]
 *
 * Scenarios:
 *   1. media_upload          — Two-step file upload + media creation
 *   2. playlist_creation     — Create playlists via v1 API
 *   3. scheduling            — Create timeslots via v1 API
 *   4. media_availability    — GET media by ID via v1 API
 *   5. playout_device_sync   — OBPlayer schedule fetch via remote.php
 *
 * Auth strategy:
 *   - setup() logs in via v1 API and returns session credentials (id/key)
 *   - All scenarios use v1 session auth (c/a/d/i/k POST params)
 *   - playout_device_sync uses device auth (id/pw on remote.php)
 */

import http from 'k6/http';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { BASE_URL, USERNAME, PASSWORD, LOAD_LEVEL, TEST_MEDIA_ID, VU_MAP, DURATION_MAP } from './lib/config.js';
import { login, apiCall } from './lib/auth.js';
import { checkUpload, checkResponse } from './lib/checks.js';

// Import scenario functions.
import mediaUpload        from './scenarios/media-upload.js';
import playlistCreation   from './scenarios/playlist-creation.js';
import scheduling         from './scenarios/scheduling.js';
import mediaAvailability  from './scenarios/media-availability.js';
import playoutDeviceSync  from './scenarios/playout-device-sync.js';

// Load sample file at init time (k6 requires open() in module scope, not in setup).
const sampleFile = open('./testdata/sample.mp3', 'b');

// Resolve VU counts and duration for the current load level.
const vus      = VU_MAP[LOAD_LEVEL]      || VU_MAP.low;
const duration = DURATION_MAP[LOAD_LEVEL] || DURATION_MAP.low;

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
    scenarios: {
        media_upload: {
            executor:   'constant-vus',
            exec:       'mediaUploadScenario',
            vus:        vus.media_upload,
            duration:   duration,
        },
        playlist_creation: {
            executor:   'constant-vus',
            exec:       'playlistCreationScenario',
            vus:        vus.playlist_creation,
            duration:   duration,
        },
        scheduling: {
            executor:   'constant-vus',
            exec:       'schedulingScenario',
            vus:        vus.scheduling,
            duration:   duration,
        },
        media_availability: {
            executor:   'constant-vus',
            exec:       'mediaAvailabilityScenario',
            vus:        vus.media_availability,
            duration:   duration,
        },
        playout_device_sync: {
            executor:   'constant-vus',
            exec:       'playoutDeviceSyncScenario',
            vus:        vus.playout_device_sync,
            duration:   duration,
        },
    },

    thresholds: {
        // Global thresholds
        'http_req_failed':   ['rate<0.01'],        // < 1% error rate
        'http_req_duration': ['p(95)<500'],         // 95th percentile under 500ms

        // Per-scenario response time thresholds
        'http_req_duration{scenario:media_upload}':         ['p(95)<2000'],  // upload + ffprobe is slow
        'http_req_duration{scenario:playlist_creation}':    ['p(95)<500'],
        'http_req_duration{scenario:scheduling}':           ['p(95)<500'],
        'http_req_duration{scenario:media_availability}':   ['p(95)<200'],   // simple GET
        'http_req_duration{scenario:playout_device_sync}':  ['p(95)<1000'],  // XML schedule generation

        // Per-scenario error rate thresholds
        'http_req_failed{scenario:media_upload}':           ['rate<0.01'],
        'http_req_failed{scenario:playlist_creation}':      ['rate<0.01'],
        'http_req_failed{scenario:scheduling}':             ['rate<0.05'],   // collisions may cause some failures
        'http_req_failed{scenario:media_availability}':     ['rate<0.01'],
        'http_req_failed{scenario:playout_device_sync}':    ['rate<0.01'],
    },
};

// ---------------------------------------------------------------------------
// Setup: runs once before all VUs start
// ---------------------------------------------------------------------------
export function setup() {
    console.log(`Load level: ${LOAD_LEVEL} | Duration: ${duration}`);
    console.log(`VUs: upload=${vus.media_upload} playlist=${vus.playlist_creation} schedule=${vus.scheduling} media_get=${vus.media_availability} sync=${vus.playout_device_sync}`);

    // 1. Login via v1 API to get session credentials.
    const session = login(USERNAME, PASSWORD);
    console.log(`Logged in (session id: ${session.id})`);

    // 2. Ensure we have a media ID for the availability scenario.
    let mediaId = TEST_MEDIA_ID;

    if (!mediaId) {
        // Upload the sample file and create a media record for testing.
        console.log('No TEST_MEDIA_ID configured — creating one from sample.mp3');

        const uploadRes = http.post(`${BASE_URL}/upload.php`, sampleFile, {
            headers: { 'Content-Type': 'application/octet-stream' },
        });

        if (checkUpload(uploadRes, 'setup')) {
            const upload = uploadRes.json();

            // Create the media item via v1 API.
            // Required fields: artist, album, year, category_id (from core_metadata).
            // Also include optional fields that media_model.php accesses without
            // isset checks — omitting them causes PHP warnings that corrupt the JSON.
            const createRes = apiCall(session, 'media', 'save', {
                media: [{
                    local_id:           0,
                    file_id:            upload.file_id,
                    file_key:           upload.file_key,
                    artist:             'k6 Setup',
                    title:              'Setup Media Item',
                    album:              'k6 Load Test',
                    year:               new Date().getFullYear().toString(),
                    category_id:        1,
                    country:            '',
                    language:           '',
                    comments:           '',
                    genre_id:           '',
                    status:             'private',
                    type:               upload.media_info ? upload.media_info.type : 'audio',
                    is_copyright_owner: 0,
                    is_approved:        0,
                    dynamic_select:     0,
                }],
            });

            if (checkResponse(createRes, 'setup')) {
                const body = createRes.json();
                const ids = body.data;
                mediaId = Array.isArray(ids) ? String(ids[0]) : String(ids);
                console.log(`Setup media created (id: ${mediaId})`);
            }
        }

        if (!mediaId) {
            console.warn('Could not create setup media. media_availability scenario may fail.');
            mediaId = '1'; // fallback
        }
    }

    // Return session credentials + media ID for all VUs.
    return { session, mediaId };
}

// ---------------------------------------------------------------------------
// Scenario executor functions (thin wrappers around imported modules)
// ---------------------------------------------------------------------------
export function mediaUploadScenario(data)       { mediaUpload(data); }
export function playlistCreationScenario(data)   { playlistCreation(data); }
export function schedulingScenario(data)         { scheduling(data); }
export function mediaAvailabilityScenario(data)  { mediaAvailability(data); }
export function playoutDeviceSyncScenario(data)  { playoutDeviceSync(data); }

// ---------------------------------------------------------------------------
// Custom summary: write structured JSON for baseline comparison
// ---------------------------------------------------------------------------
export function handleSummary(data) {
    const scenarios = [
        'media_upload', 'playlist_creation', 'scheduling',
        'media_availability', 'playout_device_sync',
    ];

    const summary = {
        timestamp:  new Date().toISOString(),
        load_level: LOAD_LEVEL,
        scenarios:  {},
        global: {
            p95_ms:       data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'] : null,
            avg_ms:       data.metrics.http_req_duration ? data.metrics.http_req_duration.values.avg : null,
            error_rate:   data.metrics.http_req_failed   ? data.metrics.http_req_failed.values.rate : null,
            total_reqs:   data.metrics.http_reqs          ? data.metrics.http_reqs.values.count : null,
        },
        thresholds: {},
    };

    // Per-scenario metrics (from tagged sub-metrics).
    for (const name of scenarios) {
        const durKey  = `http_req_duration{scenario:${name}}`;
        const failKey = `http_req_failed{scenario:${name}}`;
        const reqKey  = `http_reqs{scenario:${name}}`;

        summary.scenarios[name] = {
            p95_ms:     data.metrics[durKey]  ? data.metrics[durKey].values['p(95)'] : null,
            avg_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.avg : null,
            med_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.med : null,
            min_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.min : null,
            max_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.max : null,
            error_rate: data.metrics[failKey] ? data.metrics[failKey].values.rate : null,
            requests:   data.metrics[reqKey]  ? data.metrics[reqKey].values.count : null,
        };
    }

    // Threshold pass/fail status.
    if (data.thresholds) {
        for (const [name, info] of Object.entries(data.thresholds)) {
            summary.thresholds[name] = info.ok !== undefined ? info.ok : null;
        }
    }

    return {
        'outputs/latest.json': JSON.stringify(summary, null, 2),
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
    };
}
