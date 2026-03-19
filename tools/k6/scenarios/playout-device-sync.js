/**
 * Scenario: Playout Device Sync
 *
 * Simulates OBPlayer hitting remote.php to fetch its schedule.
 * Uses device auth (player ID + password) instead of user Bearer tokens.
 * The response is XML wrapped in <obconnect>.
 *
 * Endpoint: POST /remote.php
 * Auth: form-encoded id + pw (device auth, see remote.php:97-124)
 * Body: id=PLAYER_ID&pw=PLAYER_PASSWORD&action=schedule&buffer=7
 * Response: XML with <obconnect> root element
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, PLAYER_ID, PLAYER_PASSWORD } from '../lib/config.js';
import { checkXml } from '../lib/checks.js';

const SCENARIO = 'playout_device_sync';

export default function (_data) {
    const res = http.post(
        `${BASE_URL}/remote.php`,
        {
            id:     PLAYER_ID,
            pw:     PLAYER_PASSWORD,
            action: 'schedule',
            buffer: '7',
        },
        {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            tags: { scenario: SCENARIO },
        }
    );

    checkXml(res, SCENARIO);

    sleep(1);
}
