# k6 Load Testing Tool

Load testing tool for the Observer API using [k6](https://k6.io). Tests 5 scenarios at 10, 100, or 1000 concurrent users with threshold alerts and baseline comparison.

## Scenarios

| Scenario | What it tests | Endpoint |
|---|---|---|
| **media_upload** | File upload + media record creation | `upload.php` → `api.php` |
| **playlist_creation** | Create playlists | `api.php` (playlists/save) |
| **scheduling** | Create schedule timeslots | `api.php` (timeslots/save) |
| **media_availability** | Fetch media by ID (read-only) | `api.php` (media/get) |
| **playout_device_sync** | OBPlayer schedule fetch | `remote.php` |

## Quick Start

```bash
# Prerequisites: k6, PHP 8.x, MySQL
brew install k6      # macOS
# or: https://k6.io/docs/get-started/installation/

# Setup
cp config.example.env config.env
# Edit config.env with your Observer URL and credentials

# Run
./run.sh 10          # 10 concurrent users (smoke test)
./run.sh 100         # 100 concurrent users
./run.sh 1000        # 1000 concurrent users (needs Apache/Nginx)
```

## Baseline Comparison

Save a reference run, then compare future runs against it to catch regressions:

```bash
./run.sh 100 --baseline-save      # save current results as baseline
# ... make code changes ...
./run.sh 100 --baseline-compare   # diff against saved baseline
```

The comparison flags any metric that degraded by more than 10% with `[WARN]`.

## Outputs

Each run generates:
- **Terminal**: pass/fail summary with all metrics
- **HTML report**: `outputs/report-{timestamp}-{vus}vus.html` — persistent dashboard, works offline
- **JSON data**: `outputs/report-{timestamp}-{vus}vus.json` — machine-readable for comparison

## Thresholds

Threshold alerts are set for production servers (Apache/Nginx). The PHP built-in dev server is single-threaded and will exceed duration thresholds at any load level — this is expected.

| Metric | Threshold |
|---|---|
| Error rate (all scenarios) | < 1% |
| media_upload p95 | < 5s |
| playlist_creation p95 | < 2s |
| scheduling p95 | < 2s |
| media_availability p95 | < 1s |
| playout_device_sync p95 | < 3s |

## Cleanup

The tool automatically cleans up test data (media, playlists, timeslots) after each run via `teardown()`. Items are identified by their `k6` prefix in artist/name/description fields.

## File Structure

```
tools/k6/
├── run.sh                  # Entry point — handles server, env, and k6
├── main.js                 # k6 config, setup, teardown, and summary
├── config.example.env      # Template for config.env (gitignored)
├── lib/
│   ├── config.js           # Environment variable loader
│   ├── auth.js             # Login + authenticated API call helpers
│   └── checks.js           # Reusable check functions with debug logging
├── scenarios/
│   ├── media-upload.js     # File upload + media save
│   ├── playlist-creation.js
│   ├── scheduling.js       # Timeslot creation with collision avoidance
│   ├── media-availability.js
│   └── playout-device-sync.js
├── baseline/
│   └── compare.sh          # Baseline diff tool (requires jq)
├── testdata/
│   └── sample.mp3          # Sample file for upload tests
├── outputs/                # Generated reports (gitignored)
└── baselines/              # Saved baselines (gitignored)
```
