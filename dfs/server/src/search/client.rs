//! Search Elasticsearch using a point in time (PIT).
//!
//! A PIT keeps the same view of indexed data across result pages. The endpoint may
//! need several pages because current DB checks can reject some candidates.
//! Each page renews its lifetime, and the endpoint closes it after the search.

use std::{
    collections::{BTreeMap, HashMap},
    fmt,
    time::Duration,
};

use anyhow::{Result, ensure};
use elasticsearch::{
    Elasticsearch, OpenPointInTimeParts, SearchParts,
    auth::Credentials,
    http::{
        response::Response,
        transport::{SingleNodeConnectionPool, TransportBuilder},
    },
};
use elasticsearch_dsl::{FieldSort, PointInTime, Query, Search, Time};
use serde::Deserialize;
use serde_json::{Value, json};

use super::OBJECTS_INDEX_ALIAS;

const PIT_KEEP_ALIVE: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_HIGHLIGHT_FRAGMENTS: usize = 1;
const MAX_HIGHLIGHT_OFFSET_CHARS: usize = 100_000;
pub const MAX_EXCERPT_CHARS: usize = 512;

#[derive(clap::Args, Default)]
pub struct ConnectionConfig {
    #[arg(
        long = "elasticsearch-url",
        alias = "url",
        env = "ELASTICSEARCH_URL",
        hide_env_values = true
    )]
    pub url: Option<String>,
    #[arg(
        long = "elasticsearch-username",
        alias = "username",
        env = "ELASTICSEARCH_USERNAME",
        hide_env_values = true,
        requires = "password"
    )]
    pub username: Option<String>,
    #[arg(
        long = "elasticsearch-password",
        alias = "password",
        env = "ELASTICSEARCH_PASSWORD",
        hide_env_values = true,
        requires = "username"
    )]
    pub password: Option<String>,
}

impl ConnectionConfig {
    pub fn build(self, timeout: Duration) -> Result<Option<Elasticsearch>> {
        let Some(url) = self.url else {
            ensure!(
                self.username.is_none() && self.password.is_none(),
                "Elasticsearch credentials require ELASTICSEARCH_URL"
            );
            return Ok(None);
        };
        let pool = SingleNodeConnectionPool::new(url.parse()?);
        // TODO(DFS 2026-10-22 FLAV): Add support for a custom Elasticsearch CA certificate.
        let mut transport = TransportBuilder::new(pool).disable_proxy().timeout(timeout);
        match (self.username, self.password) {
            (Some(username), Some(password)) => {
                transport = transport.auth(Credentials::Basic(username, password))
            }
            (None, None) => {}
            _ => anyhow::bail!("Elasticsearch username and password must be supplied together"),
        }
        Ok(Some(Elasticsearch::new(transport.build()?)))
    }
}

#[derive(Debug)]
pub enum Error {
    Transport(elasticsearch::Error),
    Http(u16),
    InvalidResponse(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(_) => f.write_str("elasticsearch request or decoding failed"),
            Self::Http(code) => write!(f, "elasticsearch returned HTTP {code}"),
            Self::InvalidResponse(message) => {
                write!(f, "invalid elasticsearch response: {message}")
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<elasticsearch::Error> for Error {
    fn from(error: elasticsearch::Error) -> Self {
        Self::Transport(error)
    }
}

pub struct Page {
    pub pit_id: String,
    pub hits: Vec<Candidate>,
}

/// Keep the latest usable PIT ID so the caller can close it after a failed page.
#[derive(Debug)]
pub struct PageError {
    pub pit_id: String,
    pub error: Error,
}

impl fmt::Display for PageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.error)
    }
}

impl std::error::Error for PageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

#[derive(Clone)]
pub struct Client {
    elasticsearch: Elasticsearch,
}

#[derive(Deserialize)]
struct Shards {
    failed: usize,
}

#[derive(Deserialize)]
struct OpenPitResponse {
    id: String,
    #[serde(rename = "_shards")]
    shards: Option<Shards>,
}

#[derive(Deserialize)]
struct SearchResponse {
    pit_id: Option<String>,
    timed_out: bool,
    #[serde(rename = "_shards")]
    shards: Shards,
    hits: Hits,
}

#[derive(Deserialize)]
struct Hits {
    hits: Vec<Candidate>,
}

#[derive(Deserialize)]
pub struct Candidate {
    #[serde(rename = "_source")]
    pub source: Source,
    pub sort: Vec<Value>,
    #[serde(default)]
    pub matched_queries: Vec<String>,
    #[serde(default)]
    highlight: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
pub struct Source {
    pub tenant_id: String,
    pub object_id: String,
    pub attr_version: Option<u64>,
    pub content_version: Option<u64>,
}

impl Candidate {
    pub fn excerpt(&self) -> Option<String> {
        [
            "content_text",
            "stemmed.en.content_text",
            "stemmed.fr.content_text",
        ]
        .into_iter()
        .find_map(|field| {
            self.highlight
                .get(field)
                .and_then(|fragments| fragments.first())
        })
        .map(|fragment| fragment.chars().take(MAX_EXCERPT_CHARS).collect())
        .filter(|fragment: &String| !fragment.is_empty())
    }
}

impl Client {
    pub fn new(elasticsearch: Elasticsearch) -> Self {
        Self { elasticsearch }
    }

    /**
     * @cc [owner:flvndvd,label:security,label:backend] search-pit-routing
     * Open each PIT on dfs.objects with the authenticated tenant ID as routing. Subsequent
     * searches MUST inherit routing from that PIT and retain the explicit tenant query filter.
     * Pagination MUST use the latest PIT ID and the complete last-hit sort tuple. A partial
     * shard failure or Elasticsearch timeout MUST fail the search, not return silent omissions.
     */
    pub async fn open(&self, tenant_id: &str) -> Result<String, Error> {
        let response = self
            .elasticsearch
            .open_point_in_time(OpenPointInTimeParts::Index(&[OBJECTS_INDEX_ALIAS]))
            .routing(tenant_id)
            .keep_alive(&format!("{}s", PIT_KEEP_ALIVE.as_secs()))
            .send()
            .await?;
        let pit: OpenPitResponse = success(response)?.json().await?;
        if pit.id.is_empty() || pit.shards.is_some_and(|shards| shards.failed != 0) {
            if !pit.id.is_empty() {
                let _ = self.close(&pit.id).await;
            }
            return Err(Error::InvalidResponse("incomplete point in time"));
        }
        Ok(pit.id)
    }

    /// Read a page from the same PIT, starting after the previous page's last hit.
    /**
     * @cc [owner:flvndvd,label:backend,label:error-handling] search-page-state
     * Page reads MUST leave the supplied PIT ID unchanged. Success and failure MUST return
     * the latest nonempty PIT ID decoded from ES, or the supplied ID if none was decoded.
     * An empty returned ID MUST reject the page without losing the supplied ID for cleanup.
     * Callers MUST retain the returned ID before handling hits or errors.
     */
    pub async fn page(
        &self,
        pit: &str,
        query: &Query,
        size: usize,
        after: Option<&[Value]>,
        include_excerpt: bool,
    ) -> Result<Page, PageError> {
        let search = Search::new()
            .pit(PointInTime::new(
                pit,
                Time::Seconds(PIT_KEEP_ALIVE.as_secs()),
            ))
            .query(query.clone())
            .size(size as u64)
            .track_total_hits(false)
            .sort([
                FieldSort::descending("_score"),
                FieldSort::ascending("object_id"),
                FieldSort::ascending("_shard_doc"),
            ])
            .source(["tenant_id", "object_id", "attr_version", "content_version"]);

        let mut extra = BTreeMap::new();
        if include_excerpt {
            // The DSL highlighter does not expose max_analyzed_offset.
            extra.insert(
                "highlight".to_owned(),
                json!({
                    "type": "unified", "pre_tags": [""], "post_tags": [""],
                    "number_of_fragments": MAX_HIGHLIGHT_FRAGMENTS,
                    "fragment_size": MAX_EXCERPT_CHARS,
                    "max_analyzed_offset": MAX_HIGHLIGHT_OFFSET_CHARS,
                    "fields": {
                        "content_text": {}, "stemmed.en.content_text": {}, "stemmed.fr.content_text": {}
                    }
                }),
            );
        }

        if let Some(after) = after {
            // Keep the exact cursor. The DSL's Terms cannot preserve null or empty values.
            extra.insert("search_after".to_owned(), json!(after));
        }

        let mut pit_id = pit.to_owned();
        let result = async {
            let response = self
                .elasticsearch
                .search(SearchParts::None)
                .allow_partial_search_results(false)
                .body(search.extra(extra))
                .send()
                .await?;
            let response: SearchResponse = success(response)?.json().await?;

            // ES can return a new ID even when the page fails validation below.
            if let Some(id) = response.pit_id {
                if id.is_empty() {
                    return Err(Error::InvalidResponse("incomplete search"));
                }
                pit_id = id;
            }

            if pit_id.is_empty() || response.timed_out || response.shards.failed != 0 {
                return Err(Error::InvalidResponse("incomplete search"));
            }
            if response.hits.hits.len() > size
                || response.hits.hits.iter().any(|hit| hit.sort.is_empty())
            {
                return Err(Error::InvalidResponse("invalid search page"));
            }

            Ok(response.hits.hits)
        }
        .await;

        match result {
            Ok(hits) => Ok(Page { pit_id, hits }),
            Err(error) => Err(PageError { pit_id, error }),
        }
    }

    pub async fn close(&self, pit: &str) -> Result<(), Error> {
        let response = self
            .elasticsearch
            .close_point_in_time()
            .request_timeout(CLOSE_TIMEOUT)
            .body(json!({"id": pit}))
            .send()
            .await?;
        success(response)?;
        Ok(())
    }
}

fn success(response: Response) -> Result<Response, Error> {
    if response.status_code().is_success() {
        Ok(response)
    } else {
        Err(Error::Http(response.status_code().as_u16()))
    }
}
