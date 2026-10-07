# Fair Shifts — לידים הדורשים אימות (run-1)

רשומות אלה מבוססות מקור ואינן ממצאים מאושרים. אין להן חומרה. הן ממתינות לעובדה שאינה נראית במאגר. אין לשלוח לסביבה חיה תעבורת עומס או קבצים מנופחים; הבדיקה בפריסה היא תצפית של הבעלים בלבד.

## 1. XLSX pre-check trusts declared ZIP sizes, so a manager upload can inflate far past the 50 MiB limit in the shared app process

`import-workbook:validateArchive-declared-size-not-enforced-on-inflate`

**תיאור.** POST /api/v1/imports caps the upload at 5 MiB of compressed bytes (route.ts:14-47, checked again in validateArchive at import-workbook.ts:138). validateArchive then caps only the sum of the ZIP central-directory DECLARED uncompressed sizes at 50 MiB (import-workbook.ts:168-181) and inflates nothing. ExcelJS 4.4.0 (xlsx.js:279-308) next calls JSZip.loadAsync and inflates every entry in full via entry.async('string') (or 'nodebuffer' for xl/media and xl/theme entries). JSZip uses the same central-directory sizes (zipEntry.js:112). It compares the real inflated length with the declared value only in the DataLengthProbe 'end' handler (compressedObject.js:36-40), after accumulate (StreamHelper.js:79-107) has already kept every inflated chunk. A workbook whose entries understate their sizes passes the pre-check, so peak memory depends on the DEFLATE ratio of a body of at most 5 MiB, not on the 50 MiB declared-size cap. For an understated entry the mismatch listener runs before the downstream 'end' listeners, so the chunks are never joined. The worker emits an error instead, and the ExcelJS load rejection is caught and returned as invalid_workbook, but only after the whole entry has been kept in memory. The parse runs in the shared Next.js app process (route handler -> parseImportWorkbook, before executeAction). If memory runs out there, every user is affected until the container restarts (restart: unless-stopped). Only an authenticated manager can send the upload.

**שורש משוער.** validateArchive (src/server/import-workbook.ts:176) adds up uploader-controlled declared uncompressed sizes (buffer.readUInt32LE(offset + 24)) and never limits actual inflation. ExcelJS 4.4.0 (xlsx.js:279-308) inflates entries in full, and JSZip 3.10.2 checks the size only after the whole entry has been inflated and its chunks kept (compressedObject.js:36-40, stream/StreamHelper.js:79-107). No inflated-byte budget exists anywhere on the path.

### מסלול במקור

1. `entrypoint` — `src/app/api/v1/imports/route.ts:48` (POST): A manager-uploaded file of up to 5 MiB (compressed) is passed to parseImportWorkbook; verifyOrigin + getActor + manager() ran at lines 10-13
2. `propagation` — `src/server/import-workbook.ts:176` (validateArchive): Adds up the declared uncompressed sizes from the central directory and compares the running sum with 50 MiB (line 178); nothing is inflated and the declared values are uploader-controlled
3. `propagation` — `src/server/import-workbook.ts:246` (parseImportWorkbook): workbook.xlsx.load is called on the uploaded buffer in the shared app process
4. `propagation` — `node_modules/exceljs/lib/xlsx/xlsx.js:308` (XLSX.load): JSZip.loadAsync, then entry.async('string') (or 'nodebuffer' for xl/media and xl/theme) inflates each entry in full
5. `sink` — `node_modules/.pnpm/jszip@3.10.2/node_modules/jszip/lib/compressedObject.js:37` (getContentWorker): The real inflated length is compared with the declared size only on 'end', after accumulate() has already kept every inflated chunk of the entry

### ראיות

- `src/server/import-workbook.ts:176` — total += buffer.readUInt32LE(offset + 24): the running limit uses the declared central-directory size, which the uploader controls; line 178 caps the declared sum at 50 MiB and nothing is ever inflated here
- `src/server/import-workbook.ts:138` — validateArchive only checks again that buffer.length <= 5 MiB, so the bound applies to compressed bytes and the inflation ratio is left unbounded
- `node_modules/.pnpm/jszip@3.10.2/node_modules/jszip/lib/stream/StreamHelper.js:87` — accumulate() pushes every inflated chunk into dataArray before any size check runs
- `node_modules/exceljs/lib/xlsx/xlsx.js:308` — content = await entry.async('string') (line 294 uses 'nodebuffer' for xl/media and xl/theme) fully inflates each entry into memory before parsing
- `src/server/import-workbook.ts:256` — The rowCount <= 501 and columnCount checks run only after workbook.xlsx.load has built the whole sheet model, so they do not limit memory during parsing
- `src/app/api/v1/imports/route.ts:13` — manager() gate: an authenticated manager session is required to reach the parser

### חסמים

- The decisive effect is a crash of the shared process, not just a large allocation, and that depends on runtime memory limits that the source does not show. For an entry with an understated size, the code rules out a catchable max-string/Buffer-length RangeError. JSZip's size-mismatch listener is registered first on the DataLengthProbe, and GenericWorker.end turns its throw into an 'error' event, so accumulate never joins the chunks. The load rejection is then caught as invalid_workbook at import-workbook.ts:245-252. The outcome therefore depends only on whether the effective V8 old-space limit (for 'string' entries, whose chunks are V8 strings) or the container/host memory (for nodebuffer entries, whose chunks are off-heap) is smaller than the up to about 1032 x 5 MiB that one entry can inflate to. If it is smaller, the process dies from fatal heap exhaustion or an OOM kill. If it is larger, the result is a transient spike and a graceful error. compose.production.yaml sets no mem_limit or deploy.resources, and the Dockerfile sets no NODE_OPTIONS or --max-old-space-size, so neither the effective heap limit nor the memory limit can be observed from source.

### צעד מקומי מוגבל

A bounded, non-destructive proof that runs only inside the offline sandbox (/Users/admin/security-audit-skill/fair-shifts/run-1/sandbox.sh v8-r2 with WITH_DB=0). The sandbox already caps --memory 3g, --cpus 2, --pids-limit 512 and timeout 540, and a crash there affects only the disposable container, never the read-only target. Step 1 (the declared-size cap does not hold, at a modest size): build a valid template workbook. Add one extra deflate entry whose central-directory and local declared uncompressed size is a few bytes but whose real inflated size is a bounded ~150 MiB, well under the 3g cap. Assert that validateArchive() returns without throwing, and that resident-set or heap growth during parseImportWorkbook() is far above the 50 MiB declared-size cap before it rejects with invalid_workbook. Step 2 (fatal proxy): run parseImportWorkbook again on the same fixture under a deliberately low heap (NODE_OPTIONS=--max-old-space-size=128). Record whether the run aborts with 'JavaScript heap out of memory' (fatal, ends the process) or completes with a catchable invalid_workbook. Keep inflation bounded, and do not run repeated or saturation loads. Save the output to agents/v8-r2/artifacts/v8-inflate-bound.log.

### בדיקה בפריסה (תצפית בעלים)

An owner check that sends no oversized input to production. Record the app container's effective memory limit (docker inspect of the fair-shifts app service) and the Node old-space heap limit in the running production image: NODE_OPTIONS / --max-old-space-size if set, otherwise v8.getHeapStatistics().heap_size_limit at the image's default for the host's RAM. If the heap limit or the container/host memory is below the roughly 5 GiB that a 5 MiB DEFLATE entry can inflate to, the buffered inflation exhausts memory, and the shared app process crashes for all users until it restarts. Remediation: enforce a running inflated-byte budget in the parser instead of trusting declared central-directory sizes. Either inflate entries through a streaming inflater that aborts once a total inflated-byte cap is exceeded, or check each entry's real inflated length against a cap before handing its content to ExcelJS. Optionally, move import parsing off the request-serving process and set an explicit container memory limit.

## 2. POST /api/v1/actions reads and parses a JSON body of any size for any signed-in user

`src/app/api/v1/actions/route.ts:POST:unbounded-request-json`

**תיאור.** Any signed-in account, including the lowest-privilege soldier role, can send a JSON body of any size to POST /api/v1/actions. The only checks before the body is read are verifyOrigin, which needs an exact Origin header that a non-browser client sets trivially, and getActor. route.ts:11 then reads the whole body with request.json(). commandSchema accepts any nested JSON under payload, and executeAction (actions.ts:107-116) parses it and runs JSON.stringify over it for the idempotency hash. All of this happens before the transaction, the actor re-check and any handler role or shape check. The repository sets no cap anywhere on this path. next.config.ts has no body limit. There is no middleware.ts or proxy.ts. Next.js 16.3.6 applies proxyClientMaxBodySize only when it clones a body for middleware or a proxy (next/dist/server/body-streams.js cloneBodyStream), so no framework cap applies to this route handler. compose.production.yaml sets no memory limit and no NODE_OPTIONS heap limit for the app service. By contrast, the same codebase's POST /api/v1/imports route reads its body through a bounded streamed reader (Content-Length check plus a running byte count, 5 MiB), so a fix pattern already exists in the repo. Two local measurements agree that the cost grows linearly, not superlinearly. The hunter measured heap growth of about 14x the body size including short-lived memory. This verifier's own run drove the real route handler with a soldier actor and stopped at unitTransaction. It found the memory still in use when the transaction starts at about 4x the body size for 1, 4 and 8 MiB bodies, and every body was accepted as type notification.read and reached the transaction (artifact agents/v9-r2/artifacts/v9-body-route.log, test agents/v9-r2/artifacts/v9-body-route.test.ts). One Next.js process serves every user, and restart: unless-stopped brings it back after a crash. So the realistic effect is a temporary site-wide outage plus restart churn while the attacker keeps sending. Persistent damage is not expected. Whether one request, or a few concurrent ones, can reach the heap limit depends on the production upstream body cap and the heap and memory limits, which are not in the repository.

**שורש משוער.** src/app/api/v1/actions/route.ts:11 calls request.json() with no Content-Length check and no streamed byte limit. src/server/validation.ts:14 types payload as z.record(z.string(), z.unknown()) with no size or depth bound. src/server/actions.ts:107-116 parses the command and runs JSON.stringify over the full payload for the hash before unitTransaction and before any handler. Neither next.config.ts nor compose.production.yaml sets a body, heap or memory limit.

### מסלול במקור

1. `entrypoint` — `src/app/api/v1/actions/route.ts:5` (POST): Public route handler. verifyOrigin (exact Origin header match, which a scripted client sets trivially) and getActor; any authenticated role, including soldier, passes.
2. `propagation` — `src/app/api/v1/actions/route.ts:11` (POST): await request.json() reads the whole body and parses it, with no Content-Length or streamed size check, unlike the bounded reader in src/app/api/v1/imports/route.ts.
3. `propagation` — `src/server/validation.ts:14` (commandSchema): payload is z.record(z.string(), z.unknown()).default({}), so any nested JSON of any size or depth is accepted.
4. `sink` — `src/server/actions.ts:107` (executeAction): commandSchema.parse(value) copies the record, and lines 108-116 run JSON.stringify over the full payload for the SHA-256 idempotency hash. Both happen before unitTransaction (line 117), assertActorCurrent and any handler guard, in the single shared Next.js process.

### ראיות

- `next.config.ts:3` — The config has no body-size option. The repo has no middleware.ts or proxy.ts. Next.js 16.3.6 applies proxyClientMaxBodySize only when cloning a body for middleware or a proxy, so this route handler has no framework cap.
- `compose.production.yaml:14` — The x-app anchor shared by app and worker sets restart: unless-stopped but no mem_limit, deploy.resources or NODE_OPTIONS/--max-old-space-size. The app service (lines 46-73) runs a single `next start` process, and ingress is only through cloudflared.
- `src/app/api/v1/imports/route.ts:14` — Comparable route in the same codebase that checks Content-Length and streams the body with a 5 MiB byte limit (lines 14-30). This shows the missing control on /api/v1/actions.
- `src/server/validation.ts:14` — The payload record has no size or depth bound.

### חסמים

- Effective maximum request body size that Cloudflare enforces for the tunnel hostname under the production zone plan. Not in the repository; 100 MB is typical on Free/Pro.
- Production Node.js heap_size_limit for the app container, and the host or container memory available to it. compose.production.yaml sets none, but app.env in FAIR_SHIFTS_CONFIG_DIR, which is outside the repo, could set NODE_OPTIONS. These decide whether one body near the upstream cap, or a few concurrent ones, exhausts the heap.
- Under the domain rules, no fatal-path test or availability test was run. Local measurements go up to 8 MiB bodies only and show linear amplification (about 4x memory still held at dispatch, about 14x heap growth including short-lived memory).

### צעד מקומי מוגבל

Inside the offline sandbox only, reuse agents/v9-r2/artifacts/v9-body-route.test.ts, which runs the real route with a mocked soldier actor and a stub unitTransaction. Run it under NODE_OPTIONS=--max-old-space-size=128 with a single body of about 32 MiB (about 4-14x of 32 MiB, so it brackets 128 MiB). Record whether the vitest worker ends with 'JavaScript heap out of memory', which shows the fatal path at that heap-to-body ratio. Then apply the fix in a scratch copy: before request.json(), reject a Content-Length over 64 KiB and stream the body with a running byte count, as in src/app/api/v1/imports/route.ts. Confirm a 413 response for an oversized body, with and without Content-Length, and confirm unitTransaction is never reached.

### בדיקה בפריסה (תצפית בעלים)

Owner checks only, with no load or availability test. (1) In the Cloudflare dashboard, confirm the zone plan's maximum upload or request body size for the tunnel hostname, and note any WAF or Transform rule that limits body size on /api/v1/actions. (2) In the running production app container, run `node -e "console.log(require('v8').getHeapStatistics().heap_size_limit)"`, then `env | grep NODE_OPTIONS`, and `docker inspect --format '{{.HostConfig.Memory}}' <app-container>` to read the memory limit, plus `free -b` on the host. (3) Treat the issue as confirmed if about 4x (memory still held) to 14x (peak) of the upstream body cap, multiplied by a few concurrent requests, reaches heap_size_limit or the container or host memory.
