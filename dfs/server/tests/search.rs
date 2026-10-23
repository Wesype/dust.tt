use std::{collections::VecDeque, time::Duration};

use anyhow::{Context, Result, ensure};
use dfs_api::search::{
    IndexCell, client::Client, create_objects_index, objects_index_body, query::Plan,
};
use dfs_protocol::rpc::SearchRequest;
use elasticsearch::{
    Elasticsearch,
    http::transport::{SingleNodeConnectionPool, TransportBuilder},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};

const TEST_TIMEOUT_SECONDS: u64 = 5;
const MAX_REQUEST_SIZE_BYTES: usize = 64 * 1024;

struct Request {
    method: String,
    path: String,
    body: Value,
}

struct MockElasticsearch {
    client: Elasticsearch,
    stop: oneshot::Sender<()>,
    server: JoinHandle<Result<Vec<Request>>>,
}

impl MockElasticsearch {
    async fn start(replies: Vec<(u16, Value)>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let pool =
            SingleNodeConnectionPool::new(format!("http://{}", listener.local_addr()?).parse()?);
        let client = Elasticsearch::new(
            TransportBuilder::new(pool)
                .disable_proxy()
                .timeout(Duration::from_secs(TEST_TIMEOUT_SECONDS))
                .build()?,
        );
        let (stop, mut stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut replies = VecDeque::from(replies);
            let mut requests = Vec::new();
            loop {
                let (mut stream, _) = tokio::select! {
                    connection = listener.accept() => connection?,
                    _ = &mut stopped => break,
                };
                let request = timeout(
                    Duration::from_secs(TEST_TIMEOUT_SECONDS),
                    read_request(&mut stream),
                )
                .await??;
                let (status, body) = replies
                    .pop_front()
                    .unwrap_or((500, json!({ "error": "unexpected request" })));
                let body = if request.method == "HEAD" {
                    Vec::new()
                } else {
                    serde_json::to_vec(&body)?
                };
                let headers = format!(
                    "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\n\
                     X-Elastic-Product: Elasticsearch\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).await?;
                stream.write_all(&body).await?;
                stream.shutdown().await?;
                requests.push(request);
            }
            Ok(requests)
        });
        Ok(Self {
            client,
            stop,
            server,
        })
    }

    async fn finish(self) -> Result<Vec<Request>> {
        let _ = self.stop.send(());
        self.server.await?
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let mut parts = line.split_whitespace();
    let method = parts.next().context("missing HTTP method")?.to_owned();
    let path = parts.next().context("missing HTTP path")?.to_owned();
    let mut content_length = 0;
    loop {
        line.clear();
        ensure!(
            reader.read_line(&mut line).await? > 0,
            "incomplete HTTP headers"
        );
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            content_length = value.trim().parse()?;
        }
    }
    ensure!(
        content_length <= MAX_REQUEST_SIZE_BYTES,
        "oversized mock request"
    );
    let mut bytes = vec![0; content_length];
    reader.read_exact(&mut bytes).await?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok(Request { method, path, body })
}

#[tokio::test]
async fn bootstrap_creates_the_index_and_write_alias_in_one_request() -> Result<()> {
    let server = MockElasticsearch::start(vec![
        (404, Value::Null),
        (404, Value::Null),
        (
            200,
            json!({ "acknowledged": true, "shards_acknowledged": true }),
        ),
    ])
    .await?;
    create_objects_index(&server.client, IndexCell::Local).await?;
    let requests = server.finish().await?;
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].method, "HEAD");
    assert_eq!(requests[0].path, "/dfs.objects_1");
    assert_eq!(requests[1].method, "HEAD");
    assert_eq!(requests[1].path, "/_alias/dfs.objects");
    assert_eq!(requests[2].method, "PUT");
    assert_eq!(requests[2].path, "/dfs.objects_1");
    assert_eq!(
        requests[2].body["aliases"]["dfs.objects"]["is_write_index"],
        true
    );
    Ok(())
}

#[tokio::test]
async fn bootstrap_does_not_mutate_after_an_existing_name_or_failed_preflight() -> Result<()> {
    for statuses in [
        vec![200],
        vec![403],
        vec![503],
        vec![404, 200],
        vec![404, 403],
    ] {
        let expected_requests = statuses.len();
        let server = MockElasticsearch::start(
            statuses
                .into_iter()
                .map(|status| (status, Value::Null))
                .collect(),
        )
        .await?;
        assert!(
            create_objects_index(&server.client, IndexCell::Local)
                .await
                .is_err()
        );
        let requests = server.finish().await?;
        assert_eq!(requests.len(), expected_requests);
        assert!(requests.iter().all(|request| request.method == "HEAD"));
    }
    Ok(())
}

#[tokio::test]
async fn bootstrap_reports_creation_failures_without_retry_or_cleanup() -> Result<()> {
    for (status, body) in [
        (
            200,
            json!({ "acknowledged": false, "shards_acknowledged": false }),
        ),
        (
            200,
            json!({ "acknowledged": true, "shards_acknowledged": false }),
        ),
        (200, json!({ "acknowledged": true })),
        (400, json!({ "error": "invalid index settings" })),
    ] {
        let server =
            MockElasticsearch::start(vec![(404, Value::Null), (404, Value::Null), (status, body)])
                .await?;
        assert!(
            create_objects_index(&server.client, IndexCell::Local)
                .await
                .is_err()
        );
        let requests = server.finish().await?;
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[2].method, "PUT");
    }
    Ok(())
}

#[test]
fn cell_settings_preserve_shared_analysis_and_target_the_available_nodes() -> Result<()> {
    let reference = objects_index_body(IndexCell::Local)?;
    for cell in [IndexCell::Cell00000, IndexCell::Cell00001] {
        let body = objects_index_body(cell)?;
        assert_eq!(body["mappings"], reference["mappings"]);
        assert_eq!(
            body["settings"]["analysis"],
            reference["settings"]["analysis"]
        );
        assert_eq!(
            body["settings"]["routing.allocation.require.workload"],
            "filesystem"
        );
    }
    let shared = objects_index_body(IndexCell::Cell00002)?;
    assert_eq!(shared["mappings"], reference["mappings"]);
    assert_eq!(
        shared["settings"]["analysis"],
        reference["settings"]["analysis"]
    );
    for body in [&reference, &shared] {
        assert!(
            body["settings"]
                .as_object()
                .context("missing settings")?
                .keys()
                .all(|key| { !key.starts_with("routing.allocation.") })
        );
    }
    Ok(())
}

#[tokio::test]
async fn search_pagination_keeps_routing_and_uses_the_latest_pit() -> Result<()> {
    let server = MockElasticsearch::start(vec![
        (200, json!({"id": "first"})),
        (200, json!({"pit_id": "second", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": [{
            "_source": {"tenant_id": "tenant", "object_id": "object", "attr_version": 1, "content_version": 2},
            "sort": [1.5, "object", 42], "matched_queries": ["c0c"],
            "highlight": {"content_text": ["é".repeat(600)]}
        }]}})),
        (200, json!({"pit_id": "third", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": []}})),
        (200, json!({"succeeded": true})),
    ]).await?;
    let client = Client::new(server.client.clone());
    let pit = client.open("tenant").await?;
    let query = Plan::compile(SearchRequest::default())?.candidate_query("tenant", None)?;
    let page = client.page(&pit, &query, 1, None, true).await?;
    assert_eq!(
        page.hits[0]
            .excerpt()
            .context("missing excerpt")?
            .chars()
            .count(),
        512
    );
    let next_page = client
        .page(&page.pit_id, &query, 1, Some(&page.hits[0].sort), false)
        .await?;
    assert!(next_page.hits.is_empty());
    client.close(&next_page.pit_id).await?;
    let requests = server.finish().await?;
    assert!(requests[0].path.starts_with("/dfs.objects/_pit?"));
    assert!(requests[0].path.contains("routing=tenant"));
    assert!(requests[0].path.contains("keep_alive=30s"));
    for request in &requests[1..3] {
        assert!(request.path.starts_with("/_search?"));
        assert!(!request.path.contains("routing="));
        assert_eq!(request.body["query"], serde_json::to_value(&query)?);
        assert_eq!(request.body["pit"]["keep_alive"], "30s");
        assert_eq!(request.body["size"], 1);
        assert_eq!(request.body["track_total_hits"], false);
        assert_eq!(
            request.body["_source"],
            json!(["tenant_id", "object_id", "attr_version", "content_version"])
        );
        assert_eq!(
            request.body["sort"],
            json!([
                {"_score": {"order": "desc"}},
                {"object_id": {"order": "asc"}},
                {"_shard_doc": {"order": "asc"}},
            ])
        );
    }
    assert_eq!(requests[1].body["pit"]["id"], "first");
    assert!(requests[1].body["highlight"].is_object());
    assert_eq!(requests[1].body["highlight"]["number_of_fragments"], 1);
    assert_eq!(
        requests[1].body["highlight"]["max_analyzed_offset"],
        100_000
    );
    assert!(requests[2].body["highlight"].is_null());
    assert_eq!(requests[2].body["pit"]["id"], "second");
    assert_eq!(requests[2].body["search_after"], json!([1.5, "object", 42]));
    assert_eq!(requests[3].body["id"], "third");
    Ok(())
}

#[tokio::test]
async fn search_preserves_null_empty_and_large_cursor_values() -> Result<()> {
    let server = MockElasticsearch::start(vec![(
        200,
        json!({"timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": []}}),
    )])
    .await?;
    let client = Client::new(server.client.clone());
    let query = Plan::compile(SearchRequest::default())?.candidate_query("tenant", None)?;
    let cursor = [Value::Null, json!(""), json!(u64::MAX)];

    client.page("pit", &query, 1, Some(&cursor), false).await?;

    let requests = server.finish().await?;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].body["search_after"], json!(cursor));
    Ok(())
}

#[tokio::test]
async fn search_errors_preserve_the_latest_usable_pit_for_cleanup() -> Result<()> {
    let query = Plan::compile(SearchRequest::default())?.candidate_query("tenant", None)?;
    let hit = json!({
        "_source": {"tenant_id": "tenant", "object_id": "object"},
        "sort": [1.5, "object", 42],
    });

    for (status, body, expected_pit) in [
        (
            200,
            json!({"pit_id": "latest", "timed_out": false, "_shards": {"failed": 1}, "hits": {"hits": []}}),
            "latest",
        ),
        (
            200,
            json!({"pit_id": "latest", "timed_out": true, "_shards": {"failed": 0}, "hits": {"hits": []}}),
            "latest",
        ),
        (
            200,
            json!({"pit_id": "latest", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": [{"_source": hit["_source"], "sort": []}]}}),
            "latest",
        ),
        (
            200,
            json!({"pit_id": "latest", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": [hit.clone(), hit.clone()]}}),
            "latest",
        ),
        (
            200,
            json!({"pit_id": "", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": []}}),
            "original",
        ),
        (
            200,
            json!({"pit_id": "latest", "timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": [{"sort": []}]}}),
            "original",
        ),
        (503, json!({"error": "unavailable"}), "original"),
    ] {
        let server =
            MockElasticsearch::start(vec![(status, body), (200, json!({"succeeded": true}))])
                .await?;
        let client = Client::new(server.client.clone());
        let error = client
            .page("original", &query, 1, None, false)
            .await
            .err()
            .context("expected a page error")?;
        assert_eq!(error.pit_id, expected_pit);
        client.close(&error.pit_id).await?;

        let requests = server.finish().await?;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].method, "DELETE");
        assert_eq!(requests[1].body["id"], expected_pit);
    }
    Ok(())
}

#[tokio::test]
async fn search_keeps_the_pit_when_elasticsearch_omits_a_replacement() -> Result<()> {
    let server = MockElasticsearch::start(vec![
        (
            200,
            json!({"timed_out": false, "_shards": {"failed": 0}, "hits": {"hits": []}}),
        ),
        (200, json!({"succeeded": true})),
    ])
    .await?;
    let client = Client::new(server.client.clone());
    let query = Plan::compile(SearchRequest::default())?.candidate_query("tenant", None)?;
    let page = client.page("original", &query, 1, None, false).await?;
    assert_eq!(page.pit_id, "original");
    assert!(page.hits.is_empty());
    client.close(&page.pit_id).await?;

    let requests = server.finish().await?;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].body["id"], "original");
    Ok(())
}

#[test]
fn preview_uses_cell_ids_and_rejects_regional_selectors() -> Result<()> {
    let preview = |args: &[&str], cell: Option<&str>| {
        let mut command =
            std::process::Command::new(env!("CARGO_BIN_EXE_elasticsearch_create_index"));
        command
            .env_remove("CELL")
            .env_remove("REGION")
            .env_remove("ELASTICSEARCH_USERNAME")
            .env_remove("ELASTICSEARCH_PASSWORD");
        if let Some(cell) = cell {
            command.env("CELL", cell);
        }
        command.args(args).output()
    };
    let output = preview(
        &["--cell", "cell-00002", "--url", "http://127.0.0.1:1"],
        None,
    )?;
    assert!(output.status.success());
    let body: Value = serde_json::from_slice(&output.stdout)?;
    assert!(
        body["settings"]
            .get("routing.allocation.require.workload")
            .is_none()
    );
    let from_env = preview(&[], Some("cell-00001"))?;
    assert!(from_env.status.success());
    let body: Value = serde_json::from_slice(&from_env.stdout)?;
    assert_eq!(
        body["settings"]["routing.allocation.require.workload"],
        "filesystem"
    );
    for args in [
        ["--cell", "europe-west1"],
        ["--cell", "us-central1"],
        ["--cell", "cell-99999"],
        ["--region", "europe-west1"],
    ] {
        assert!(!preview(&args, None)?.status.success());
    }
    Ok(())
}
