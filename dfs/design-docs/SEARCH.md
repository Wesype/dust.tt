# dfs:// search proposal

## Targets

| Concern | Requirement |
| --- | --- |
| Latency | First useful result batch: p95 ≤350 ms, p99 <500 ms, including authorization and enabled rescoring under concurrent ingestion. Measure 20-hit completion separately. |
| Freshness | With healthy dependencies and backlog within capacity, ten seconds without another relevant change, then indexing within 30 minutes, including imports and fan-out. Continuously changing objects have no completion bound. Expose lag during outages and recovery; include ES refresh in measurements. |
| Delivery | Stream bounded result batches with backpressure, cancellation, and final completion status. |
| Outages | Continue filesystem writes during Temporal or ES outages. Retain durable pending work in FDB and drain after recovery. Serve existing index when ES is available. |
| Backlog | Alert on pending objects, backlog bytes/age, Temporal failures, and source-to-searchable lag. Bound background dispatch and processing; Temporal outages alone must not reject filesystem writes. |

## Architecture

Source mutations and object-ID events commit together in `with_idempotent_transaction`. Events are
partitioned by tenant. The relay polls FDB for tenants with work and wakes their stage workflows. The
router resolves MIME type and object-local exclusion, writes extract/index dirty keys, and deletes
the events it routed in the same transaction.

Each tenant has separate router, extract, and index workflows. Index activities handle up to 100
objects and send approximately 1 MB encoded bulks. Dirty keys remain until work completes.
Extraction atomically stores its output and marks index dirty, then wakes the index workflow.
[Transactional outbound](TRANSACTIONAL_OUTBOUND.md) defines the keys, relay, and stage workflows.

Debounce relevant `Apply` mutations per object with a 10-second buffer. Workers derive eligibility
from current source-change timestamps; event delivery and duplicate signals do not extend the wait.

## Authorization

- Resolve accessible `root_ids` from direct user/group read grants in FDB before querying ES.
- Store one `root_id` per ES document: highest accessible parent. Read `DENY` stops inherited access.
- Store all strict `ancestor_ids`, including ancestors above a `DENY`. Folder scope is always recursive.
- Filter tenant, roots, scope, and metadata in ES. Check current permissions before returning each hit.
- Write-only grants confer no search visibility.
- Optional root cache: invalidate on grants, group membership, and relevant hierarchy changes.
- Ordinary grant changes require no descendant ES rewrites. Moves and read `DENY` changes do.

```text
foo              ALLOW g:engineering read
└── bar          DENY read
    └── reports  ALLOW g:finance read
        └── budget.pdf

budget.pdf: root_id = reports_id
            ancestor_ids = [foo_id, bar_id, reports_id]
```

- Finance can find `budget.pdf`, including under `foo`; engineering cannot inherit access through `bar`.
- Working assumption: fewer than 65k accessible roots per subject. Validate against tenant statistics.

## Elasticsearch documents

- One document per ordinary object; globally unique `_id` encodes `(tenant_id, object_id)` unambiguously.
- Aggregate native content or current extracted text into `text`. Extraction creates no separate ES document.
- Directories and files without available indexable text retain metadata-only documents.
- Explicit mappings; disable dynamic mapping.

| Field | Representation |
| --- | --- |
| `tenant_id`, `object_id` | Exact keywords. |
| `name` | Analyzed text plus exact keyword. |
| `kind`, `mime_type` | Keywords; normalize MIME type/subtype, e.g. `Text/Plain; charset=UTF-8` to `text/plain`. |
| `ancestor_ids` | Strict ancestor keyword array. |
| `root_id` | Single highest accessible parent keyword. |
| `size` | `unsigned_long`, in bytes. |
| `atime`, `mtime`, `ctime`, `created` | Optional `unsigned_long`, in milliseconds. |
| `xattrs` | Keyword array; encoding below. |
| `text` | Aggregate text with language-aware indexing as described below; empty for metadata-only objects. |
| `schema_version` | Rebuild compatibility. |

### Language-aware indexing

- Detect language from native or extracted text before ES publication. A Google language-detection library is a candidate; confirm the exact library, supported languages, and Rust integration before implementation.
- Support English and French language-specific fields/analyzers initially, with a neutral fallback for unsupported, uncertain, short, or mixed-language content. Final field names, confidence thresholds, and mixed-language handling belong in the mapping proposal.
- Query the supported language fields and fallback without requiring users to select a language. Define scoring and excerpt selection across fields in the mapping proposal; preserve the existing `NAME`/`CONTENT` distinction.
- Validate detection and relevance on representative English, French, mixed-language, and code-heavy files. Analyzer or mapping changes require a versioned index rebuild. Measure the French share of the corpus before using it for sizing.

### Xattr

- `K`: key with backslashes and `=` escaped. `V`: UTF-8 value with the same escaping.
- Every xattr emits `k:<K>` for existence. UTF-8 values also emit `v:<K>=<V>` for equality.
- Empty values emit `v:<K>=`. Binary values support existence only.
- Truncate `V` at a UTF-8 boundary to keep the complete token within 32,766 bytes. Apply identical query encoding.
- Truncated prefixes compare equal. No hash fallback or post-search equality check.
- FDB retains full values; retrieve through `Stat` with `include_metadata=true`.
- [Elasticsearch keyword limit](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/keyword).

## Index eligibility and updates

- Presence of `dfs.search.exclude`, including an empty value, excludes the object from all search.
- Exclusion is not inherited. On a directory, it excludes only the directory itself; descendants retain their own eligibility.
- Setting exclusion removes that object from search. Removing it re-evaluates that object for indexing. Neither change creates descendant work.
- MIME policy controls text indexing independently of exclusion. Only `text/*` MIME types are indexed natively; preserve their text without transformation.
- Eligibility follows the declared MIME type, not the filename extension. JSON, JavaScript, or TSX files are not exceptions: `application/json` is not indexed natively.

| MIME range | Text policy |
| --- | --- |
| `text/*` | Aggregate native content. |
| Binary MIME with configured extractor | Mark extract dirty. Successful extraction hands off to index. |
| Other MIME types | Metadata only: name and metadata, no text. |

| Change | Indexing work |
| --- | --- |
| File bytes, attributes, xattrs | Rewrite current content and metadata. Extract again only when extractor input/configuration changes. Drop obsolete extracted text. |
| Extraction completed | Extract activity atomically marks the original object index dirty, then wakes the tenant index workflow. |
| User/group read grant | Update FDB grants and forward index; invalidate root cache. |
| File move | Recompute root and ancestry. |
| Read `DENY` insertion/removal | Recompute affected roots on object and descendants. |
| Directory move | Recompute roots and ancestry throughout subtree. |
| Directory rename | Rewrite its name only; paths are not indexed. |
| Directory metadata and xattrs | Reconcile the directory itself, including its own exclusion flag. |
| Object removal/replacement | Tombstone removed document; schedule parent metadata and replacement separately. |
| Current extraction removed | Clear current generation and rebuild without extracted text. |

## Tenant workflows and activity stages

`dfs/router/<tenant_id>` routes object events to `dfs/extract/<tenant_id>` and
`dfs/index/<tenant_id>`. The `wake` signal has no payload. Tenant identity is a workflow start
argument. Activities discover work from FDB. See [stage workflows](TRANSACTIONAL_OUTBOUND.md#stage-workflows).

| Stage | Input | Completion |
| --- | --- | --- |
| `extract` | Up to 10 extract-dirty objects per batch. | Atomically store output, clear matching extract keys, and mark index dirty. Then wake index. |
| `index` | Up to 100 index-dirty objects per batch. | Publish approximately 1 MB bulks or tombstones. Clear only successful objects with matching dirty stamps. |

Bound per-tenant in-flight batches and shared worker concurrency. The relay scans dirty ranges and
wakes stage workflows even when no events remain. Temporal outages pause dispatch and processing.
Filesystem writes retain events until recovery. Monitor relay progress, event backlog, dirty age,
failed ranges, activity failures, and index pressure.

### Wait and retry

- Debounce relevant `Apply` mutations per object: activities select eligible dirty objects, and the corresponding stage workflow uses a timer for the next eligible work when needed. Processing starts no earlier than the latest source-change timestamp +10 seconds; duplicate signals do not extend it.
- For example, relevant Applies at 0s, 4s, and 9s produce one processing pass no earlier than 19s, using the latest committed state. The extract-to-index handoff does not add another 10-second buffer unless a newer source mutation requires it.
- Recheck FDB revision before work. Newer changes restart the wait, including changes whose signal has not arrived.
- Count from nondecreasing server timestamps, never signal arrival. Clock skew limits timing accuracy.
- Ten seconds of silence does not prove upload completion. Clients need no publish marker; later writes trigger another pass.
- If input changes during processing, abandon the obsolete result and process current input after its wait.
- Workflow code stays deterministic. FDB, extractor, and ES calls run in activities.
- Configure activity timeouts and exponential retries with a cap on the delay. Heartbeat long extraction/traversal activities; honor cancellation.
- Retry transient failures without requiring another file change. Invalid input moves to the stage's failed range, visible for repair.
- Keep only stage state, IDs, versions, counts, and cursors in workflow history. Stream bytes inside activities; use Continue-As-New to bound long histories.
- Drain signals before completion/Continue-As-New; carry pending revision and traversal state forward. Reconciliation covers closing-run races.
- [Temporal activity retries and idempotency](https://docs.temporal.io/activity-definition), [Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new).

## Extraction and storage

- One extractor per MIME type. Configuration: `dfs-v1-{env}/extractors/<mimeType>`, including version.
- Trusted activities read source storage and invoke the extractor. Stream whole files with bounded buffers and backpressure.
- Call extractors such as Tika directly, or a dedicated extractor endpoint for application-specific formats. Use conversion services such as Gotenberg where needed. Front must not orchestrate each extraction step.
- Run extraction locally or await/poll an existing extractor job. The activity returns only after complete text is durably stored.
- Use a stable operation ID across activity retries. Recover an existing extractor job/output after ambiguous success.
- Validate source version across reads and before accepting output. Reuse extraction only when source and extractor versions match.
- Metadata-only changes reuse valid text. Configuration changes mark affected sources through bounded rescans.
- Only index activities publish to ES. Extract activities atomically store completed extraction, clear matching extract-dirty keys, and mark index dirty through `with_idempotent_transaction`. They then wake index. A failed wake is left to the relay.

### Frames and extractor interface

- Define a versioned extractor interface for MIME-based dispatch: source references and versions, extractor configuration, complete text output, and retryable versus terminal errors. A manifest may declare this interface. Its exact shape is a follow-up.
- Frames can contain a manifest and multiple files. Define the logical source object and input dependencies so a change to any extractor input invalidates the extraction and restarts the 10-second debounce for that logical object.
- The frame extractor interprets application-specific structure. DFS owns dispatch, durability, and storage. Decide which frame object owns the search hit and whether implementation files remain independently searchable, using the existing MIME and exclusion rules.
- Validate all input versions before accepting a compound result; retry if dependencies changed during extraction. The 10-second buffer does not prove a frame upload is complete, so later input writes must trigger another pass.

### Extracted-text storage

Tenant keys below omit `dfs-v1-{env}/tenant/<tenantId>/`:

| Key | State |
| --- | --- |
| `extraction/<objectId>/state` | Current complete generation and active extraction operation. |
| `extraction/<objectId>/generation/<generation>/metadata` | Operation ID, source/configuration versions, status, byte length, expiry. |
| `extraction/<objectId>/generation/<generation>/block/<blockIndex>` | Extracted text, up to 64 KiB per stored block. |

- Activities use existing FDB helpers. Each extraction attempt stages a private generation in bounded transactions; bytes never enter workflow history.
- The final `with_idempotent_transaction` validates source/configuration and active operation, marks output complete, switches current generation, clears matching extract-dirty state, and marks index dirty. Rollback publishes neither output nor handoff. Retries reuse accepted output. Temporal unavailability cannot prevent this FDB commit.
- The extract activity then wakes the tenant index workflow. A subsequent index batch publishes the output. Recovery after text storage retries index work without extracting again.
- Incomplete or superseded attempts cannot publish. Complete generations are immutable and have no ordinary DFS objects, paths, xattrs, or grants.
- Indexer reads one fixed generation; validate current/input versions during reads and before preparing ES output. Restart on change.
- Cleanup runs in worker maintenance batches: mark unreferenced or expired incomplete generations deleting, then clear blocks and metadata.
- Preserve current complete output and active unexpired attempts. Fence expired attempts before deletion; late activity retries must restart safely.
- Reader losing a generation restarts; no reader pins. Source removal clears references after scheduling the ES tombstone.

## Indexing and backpressure

1. Read original metadata, current ancestry, permissions, and native/extracted text. Use bounded transactions; persist continuation.
2. Validate input versions across reads. Changed input follows the workflow's fresh-wait rule.
3. Allocate a monotonically increasing target publication revision after validating input. Persist immutable document bytes before sending.
4. Write to ES. Reject older revisions, including writes arriving after removal; retain revision-bearing tombstones.
5. Check every bulk-item result. Fail the activity on unsuccessful items; retry identical body/revision after ambiguous success. Release saved bytes after completion/abandonment.

- Bound activity concurrency, reads, aggregate buffered bytes, and in-flight ES requests. Size extraction and indexing worker capacity independently.
- Index activities handle at most 100 objects and flush index operations in approximately 1 MB encoded bulks (initial target: 1,000,000 bytes including bulk metadata). Flush smaller final bulks. Define explicit handling for oversized individual documents. Measure index pressure and freshness, including refresh, under load.
- Reduce active workers on 429s or rising search latency. Increase gradually when ES has capacity and indexing lags.
- Track dirty age by stage, tenant-partitioned event backlog, activity failures, bulk item failures, and source-to-searchable lag. Router acceptance never clears object dirty work.

## Query path

1. Authenticate tenant/session; authorize requested scope.
2. Resolve accessible roots; select tenant index placement and routing.
3. Apply tenant, root, recursive ancestry, and metadata filters. Retrieve BM25 candidates; optionally rescore a bounded set.
4. Check current permissions before exposing titles or excerpts.
5. Stream authorized batches within [API limits](API.md#search). Report backend failure explicitly; stale index candidates remain possible.

API follow-up: align the extractor contract and multilingual mapping with the search API. Resolve the freshness policy explicitly: the current [API proposal](API.md#search) suppresses stale indexed content and metadata, while this document currently specifies permission checks without the full freshness-validation mechanism.

## Implementation follow-ups

- Finalize the detector and multilingual mapping proposal, including query scoring and excerpts.
- Implement `OutboxEvent`, the relay, and per-tenant router/extract/index stage workflows. Validate atomic dirty writes, wake-up recovery, fair activity concurrency, and the 10-second debounce.
- Define extractor/manifest and frame contracts, then reconcile API documentation in the follow-up.
- Validate extraction retries, worker loss and relay failures, Temporal and ES outages, rollback without dispatch, lost acknowledgements, stale compound inputs, duplicate/reordered GCS events, and backfill racing with live writes/deletes.

## Tenant routing and shard layout

- Enable routing from the first document. Set `_routing.required=true`; pass `routing=tenant_id` for writes, reads, deletes, searches, and every bulk item.
- Persist tenant routing with workflow inputs and tombstones. Tenant filtering remains mandatory; routing does not isolate tenants.
- Start with a shared alias. Later resolve tenant index placement from cached FDB metadata and use its routing mode.
- Leave shared-alias routing unset. Data-stream use requires review and `allow_custom_routing`.
- `routing_partition_size=1`: single-shard routing. Otherwise require `1 < routing_partition_size < primary_count`; no `join` mappings.
- Example: 16 primaries, partition size 4; tenant spans four shards, `_id` selects each document's shard.
- [Routing](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/mapping-routing-field), [aliases](https://www.elastic.co/docs/manage-data/data-store/aliases).

### Measurements and benchmarks

- Collect per-tenant object counts by MIME type, bytes, and average/peak read/write rates. Budget collection time and GCS rate limits.
- Working load: interactive search over mostly stable files, mixed with imports, extraction completions, and subtree rewrites. Read/write ratio remains unmeasured.
- Benchmark 10, 25, 50, 100 GiB primaries using the same corpus and concurrent search/indexing load.
- Independently test primary counts, including 64/128 where volume supports them, and routing partition sizes 4/8.
- These are experiments, not startup settings. Elastic's 10–50 GB guidance is a starting point, not a hard limit.
- Large shards reduce overhead but can slow search/recovery; many small shards consume heap and coordination capacity.
- Whole-document replacement makes large-file updates expensive. Measure aggregated document throughput.
- [Shard sizing](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/size-shards), [concurrency tradeoffs](https://www.elastic.co/blog/how-many-shards-should-i-have-in-my-elasticsearch-cluster).

| Workload | Benchmark hypothesis |
| --- | --- |
| Many concurrent searches | Low per-query shard fan-out. |
| Expensive queries on large tenants | Bounded shard parallelism may lower latency at throughput cost. |
| Heavy ingestion/replacement | Enough primaries for node parallelism; avoid splitting indexing buffers too far. |
