/**
 * OpenBroadcaster Observer — k6 Load Test Entry Point
 *
 * Orchestrates all 8 test scenarios at 10, 50, 100, or 1000 concurrent users.
 * Run via: ./run.sh [10|50|100|1000]
 *
 * Scenarios:
 *   1. media_upload                — Two-step file upload + media creation
 *   2. playlist_creation           — Create playlists via v1 API
 *   3. scheduling                  — Create timeslots via v1 API
 *   4. media_availability          — GET media by ID via v1 API
 *   5. playout_device_sync         — OBPlayer schedule fetch via remote.php
 *   6. preview_encoding            — GET /v2/downloads/media/{id}/preview (ffmpeg transcode)
 *   7. playlist_dynamic_sections   — Resolve a playlist with many dynamic sections
 *   8. bulk_metadata_edit          — POST media/save with a batch of ~50 items
 *
 * Auth strategy:
 *   - setup() logs in via v1 API and returns session credentials (id/key)
 *   - Most scenarios use v1 session auth (c/a/d/i/k POST params)
 *   - preview_encoding uses X-Auth-ID/X-Auth-Key headers on v2 URL
 *   - playout_device_sync uses device auth (id/pw on remote.php)
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { BASE_URL, USERNAME, PASSWORD, LOAD_LEVEL, TEST_MEDIA_ID, VU_MAP, DURATION_MAP } from './lib/config.js';
import { login, apiCall } from './lib/auth.js';
import { checkUpload, checkResponse } from './lib/checks.js';

// Import scenario functions.
import mediaUpload             from './scenarios/media-upload.js';
import playlistCreation        from './scenarios/playlist-creation.js';
import scheduling              from './scenarios/scheduling.js';
import mediaAvailability       from './scenarios/media-availability.js';
import playoutDeviceSync       from './scenarios/playout-device-sync.js';
import previewEncoding         from './scenarios/preview-encoding.js';
import playlistDynamicSections from './scenarios/playlist-dynamic-sections.js';
import bulkMetadataEdit        from './scenarios/bulk-metadata-edit.js';

// Load sample file at init time (k6 requires open() in module scope, not in setup).
const sampleFile = open('./testdata/sample.mp3', 'b');

// Resolve VU counts and duration for the current load level.
const vus      = VU_MAP[LOAD_LEVEL]      || VU_MAP['10'];
const duration = DURATION_MAP[LOAD_LEVEL] || DURATION_MAP['10'];

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
        preview_encoding: {
            executor:   'constant-vus',
            exec:       'previewEncodingScenario',
            vus:        vus.preview_encoding,
            duration:   duration,
        },
        playlist_dynamic_sections: {
            executor:   'constant-vus',
            exec:       'playlistDynamicSectionsScenario',
            vus:        vus.playlist_dynamic_sections,
            duration:   duration,
        },
        bulk_metadata_edit: {
            executor:   'constant-vus',
            exec:       'bulkMetadataEditScenario',
            vus:        vus.bulk_metadata_edit,
            duration:   duration,
        },
    },

    thresholds: {
        // Global thresholds (tuned for production Apache/Nginx; PHP dev server will exceed these)
        'http_req_failed':   ['rate<0.01'],        // < 1% error rate
        'http_req_duration': ['p(95)<2000'],        // 95th percentile under 2s

        // Per-scenario response time thresholds
        'http_req_duration{scenario:media_upload}':              ['p(95)<5000'],  // upload + ffprobe is slow
        'http_req_duration{scenario:playlist_creation}':         ['p(95)<2000'],
        'http_req_duration{scenario:scheduling}':                ['p(95)<2000'],
        'http_req_duration{scenario:media_availability}':        ['p(95)<1000'],  // simple GET
        'http_req_duration{scenario:playout_device_sync}':       ['p(95)<3000'],  // XML schedule generation
        'http_req_duration{scenario:preview_encoding}':          ['p(95)<8000'],  // ffmpeg transcode on cache miss
        'http_req_duration{scenario:playlist_dynamic_sections}': ['p(95)<3000'],  // dynamic resolve is N queries
        'http_req_duration{scenario:bulk_metadata_edit}':        ['p(95)<30000'], // Rob reported 30-60s for 50-100 items

        // Per-scenario error rate thresholds
        'http_req_failed{scenario:media_upload}':                ['rate<0.01'],
        'http_req_failed{scenario:playlist_creation}':           ['rate<0.01'],
        'http_req_failed{scenario:scheduling}':                  ['rate<0.05'],   // collisions may cause some failures
        'http_req_failed{scenario:media_availability}':          ['rate<0.01'],
        'http_req_failed{scenario:playout_device_sync}':         ['rate<0.01'],
        'http_req_failed{scenario:preview_encoding}':            ['rate<0.05'],   // transcode races may fail some
        'http_req_failed{scenario:playlist_dynamic_sections}':   ['rate<0.01'],
        'http_req_failed{scenario:bulk_metadata_edit}':          ['rate<0.05'],   // lock contention possible
    },

    // Teardown needs extra time to clean up test data via API calls.
    teardownTimeout: '120s',
};

// ---------------------------------------------------------------------------
// Setup: runs once before all VUs start
// ---------------------------------------------------------------------------
export function setup() {
    console.log(`Load level: ${LOAD_LEVEL} | Duration: ${duration}`);
    console.log(`VUs: upload=${vus.media_upload} playlist=${vus.playlist_creation} schedule=${vus.scheduling} media_get=${vus.media_availability} sync=${vus.playout_device_sync}`);
    console.log(`     preview=${vus.preview_encoding} dynamic=${vus.playlist_dynamic_sections} bulk=${vus.bulk_metadata_edit}`);

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

    // 3. Create a playlist with many dynamic sections for the dynamic_sections scenario.
    //    Each section runs a simple-mode query on resolve, exposing the known
    //    perf issue where resolve time scales with (sections × library size).
    let dynamicPlaylistId = null;
    try {
        const dynamicItems = [];
        for (let i = 0; i < 10; i++) {
            dynamicItems.push({
                type:           'dynamic',
                name:           `k6-dyn-section-${i}`,
                num_items:      5,
                num_items_all:  false,
                image_duration: 15,
                crossfade:      0,
                crossfade_last: 0,
                query: JSON.stringify({
                    mode:   'simple',
                    string: '', // matches all approved media (artist/title LIKE '%%')
                }),
            });
        }

        const dynPlRes = apiCall(session, 'playlists', 'save', {
            name:        `k6-test-dynamic-${Date.now()}`,
            description: 'Load test playlist with 10 dynamic sections — safe to delete',
            status:      'private',
            type:        'standard',
            items:       dynamicItems,
        });

        if (checkResponse(dynPlRes, 'setup')) {
            dynamicPlaylistId = String(dynPlRes.json().data);
            console.log(`Dynamic-sections playlist created (id: ${dynamicPlaylistId}, 10 sections)`);
        }
    } catch (e) {
        console.warn(`Could not create dynamic playlist: ${e.message}`);
    }

    // 4. Gather existing media IDs for the bulk_metadata_edit scenario.
    //    Prefer the current user's own media so the update path doesn't hit the
    //    manage_media permission check. Target up to 50 items (Rob's reported
    //    slow threshold).
    let bulkMediaIds = [];
    try {
        const searchRes = apiCall(session, 'media', 'search', {
            q:  { mode: 'simple', string: '' },
            l:  50,
            o:  0,
            my: true,
        });

        if (checkResponse(searchRes, 'setup')) {
            const body = searchRes.json();
            if (body.data && Array.isArray(body.data.media)) {
                bulkMediaIds = body.data.media.map((m) => ({
                    id:                 m.id,
                    artist:             m.artist,
                    title:              m.title,
                    album:              m.album,
                    year:               m.year,
                    category_id:        m.category_id,
                    country:            m.country,
                    language:           m.language,
                    genre_id:           m.genre_id,
                    status:             m.status,
                    type:               m.type,
                    is_copyright_owner: m.is_copyright_owner,
                    is_approved:        m.is_approved,
                }));
            }
        }

        console.log(`Bulk-edit pool: ${bulkMediaIds.length} media items`);
        if (bulkMediaIds.length < 50) {
            console.warn(`  (pool <50 — to reproduce the reported 30-60s case, seed more media first)`);
        }
    } catch (e) {
        console.warn(`Could not fetch bulk-edit media pool: ${e.message}`);
    }

    // Return session credentials + all test data for VUs.
    return { session, mediaId, dynamicPlaylistId, bulkMediaIds };
}

// ---------------------------------------------------------------------------
// Scenario executor functions (thin wrappers around imported modules)
// ---------------------------------------------------------------------------
export function mediaUploadScenario(data)              { mediaUpload(data); }
export function playlistCreationScenario(data)          { playlistCreation(data); }
export function schedulingScenario(data)                { scheduling(data); }
export function mediaAvailabilityScenario(data)         { mediaAvailability(data); }
export function playoutDeviceSyncScenario(data)         { playoutDeviceSync(data); }
export function previewEncodingScenario(data)           { previewEncoding(data); }
export function playlistDynamicSectionsScenario(data)   { playlistDynamicSections(data); }
export function bulkMetadataEditScenario(data)          { bulkMetadataEdit(data); }

// ---------------------------------------------------------------------------
// Teardown: clean up test data created during the run
// ---------------------------------------------------------------------------
export function teardown(data) {
    const { session } = data;
    let deleted = { media: 0, playlists: 0, timeslots: 0 };

    // Helper: safely parse JSON response (may be null if server is busy).
    const safeJson = (res) => {
        try { return res && res.body ? res.json() : null; }
        catch (e) { return null; }
    };

    // Brief pause to let the server finish processing final VU requests.
    sleep(2);

    // 1. Delete media items created by k6 (artist = 'k6 Load Test' or 'k6 Setup')
    try {
        const mediaRes = apiCall(session, 'media', 'search', {
            q: { mode: 'simple', string: 'k6 Load Test' },
            l: 1000,
            o: 0,
            my: true,
        });
        const mediaBody = safeJson(mediaRes);
        if (mediaBody && mediaBody.status && mediaBody.data && mediaBody.data.media) {
            const ids = mediaBody.data.media
                .filter(m => m.artist && m.artist.startsWith('k6'))
                .map(m => m.id);
            if (ids.length > 0) {
                apiCall(session, 'media', 'delete', { id: ids });
                deleted.media = ids.length;
            }
        }
    } catch (e) {
        console.warn(`Teardown: media cleanup failed: ${e.message}`);
    }

    // 2. Delete playlists created by k6 (name starts with 'k6-test-')
    try {
        const plRes = apiCall(session, 'playlists', 'search', {
            q: 'k6-test',
            l: 1000,
            o: 0,
            my: true,
        });
        const plBody = safeJson(plRes);
        if (plBody && plBody.status && plBody.data && plBody.data.playlists) {
            const ids = plBody.data.playlists
                .filter(p => p.name && p.name.startsWith('k6-test-'))
                .map(p => p.id);
            if (ids.length > 0) {
                apiCall(session, 'playlists', 'delete', { id: ids });
                deleted.playlists = ids.length;
            }
        }
    } catch (e) {
        console.warn(`Teardown: playlist cleanup failed: ${e.message}`);
    }

    // 3. Delete timeslots created by k6 (description starts with 'k6-load-test')
    //    The timeslots API deletes one at a time by ID, and there's no search-by-description.
    //    We search the far-future time range where k6 creates slots.
    try {
        const now = Math.floor(Date.now() / 1000);
        const futureStart = now + 365 * 24 * 3600; // 1 year from now
        const futureEnd   = now + 10 * 365 * 24 * 3600; // 10 years from now
        const tsRes = apiCall(session, 'timeslots', 'search', {
            start:  futureStart,
            end:    futureEnd,
            player: __ENV.OB_PLAYER_ID || '1',
        });
        const tsBody = safeJson(tsRes);
        if (tsBody && tsBody.status && tsBody.data) {
            const slots = tsBody.data
                .filter(t => t.description && t.description.startsWith('k6-load-test'))
                .slice(0, 50); // limit to avoid timeout
            for (const slot of slots) {
                apiCall(session, 'timeslots', 'delete', { id: slot.id });
                deleted.timeslots++;
            }
        }
    } catch (e) {
        console.warn(`Teardown: timeslot cleanup failed: ${e.message}`);
    }

    console.log(`Teardown: deleted ${deleted.media} media, ${deleted.playlists} playlists, ${deleted.timeslots} timeslots`);
}

// ---------------------------------------------------------------------------
// Custom summary: write structured JSON for baseline comparison
// ---------------------------------------------------------------------------
export function handleSummary(data) {
    const scenarios = [
        'media_upload', 'playlist_creation', 'scheduling',
        'media_availability', 'playout_device_sync',
        'preview_encoding', 'playlist_dynamic_sections', 'bulk_metadata_edit',
    ];

    const summary = {
        timestamp:  new Date().toISOString(),
        load_level: LOAD_LEVEL,
        git_commit: __ENV.GIT_COMMIT || 'unknown',
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

        summary.scenarios[name] = {
            p95_ms:     data.metrics[durKey]  ? data.metrics[durKey].values['p(95)'] : null,
            avg_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.avg : null,
            med_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.med : null,
            min_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.min : null,
            max_ms:     data.metrics[durKey]  ? data.metrics[durKey].values.max : null,
            error_rate: data.metrics[failKey] ? data.metrics[failKey].values.rate : null,
            // http_req_failed is a Rate metric — its passes + fails = total request count.
            requests:   data.metrics[failKey] ? (data.metrics[failKey].values.passes + data.metrics[failKey].values.fails) : null,
        };
    }

    // Threshold pass/fail status — k6 embeds this in each metric, not in data.thresholds.
    for (const [metricName, metric] of Object.entries(data.metrics)) {
        if (metric.thresholds) {
            for (const [thresholdExpr, result] of Object.entries(metric.thresholds)) {
                summary.thresholds[`${metricName}: ${thresholdExpr}`] = result.ok;
            }
        }
    }

    // Write timestamped + latest JSON for baseline comparison.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonFile = `outputs/report-${ts}-${LOAD_LEVEL}vus.json`;

    return {
        [jsonFile]:            JSON.stringify(summary, null, 2),
        'outputs/latest.json': JSON.stringify(summary, null, 2),
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
    };
}
