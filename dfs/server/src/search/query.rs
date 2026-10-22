use std::{collections::HashSet, fmt};

use chrono::NaiveDate;
use dfs_protocol::{
    NAME_MAX_BYTES, ObjectId,
    rpc::{ObjectKind, SearchField, SearchFilter, SearchRequest, SearchScope, SearchXattr},
};
use elasticsearch_dsl::{BoolQuery, DisMaxQuery, Operator, Query};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::lexer::{self, Clause, Modifier};

const DEFAULT_RESULT_LIMIT: u32 = 20;
const MAX_RESULT_LIMIT: u32 = 100;
const MAX_MIME_FILTERS: usize = 32;
const MAX_MIME_BYTES: usize = 255;
const MAX_XATTR_FILTERS: usize = 64;
const MAX_XATTR_NAME_BYTES: usize = 255;
const MAX_XATTR_BYTES: usize = 32 * 1024;
const XATTR_HASH_DOMAIN: &[u8] = b"dfs.xattr_pair.v1\0";

#[derive(Debug)]
pub enum Error {
    Syntax(lexer::Error),
    Invalid(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(error) => error.fmt(f),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Syntax(error) => Some(error),
            Self::Invalid(_) => None,
        }
    }
}

pub struct Plan {
    query: Query,
    required_versions: VersionRequirements,
    pub include_excerpt: bool,
    pub limit: usize,
    pub scope: Option<SearchScope>,
    pub xattrs: Vec<SearchXattr>,
}

#[derive(Default)]
struct VersionRequirements {
    positive_clauses: Vec<usize>,
    attributes: bool,
    content: bool,
}

impl Plan {
    /**
     * @cc [owner:flvndvd,label:api] search-query-meaning
     * Every positive text clause MUST match. Each clause MAY match any selected logical field.
     * Quotes MUST use neutral phrase queries with zero slop, without stemming or prefix expansion.
     * Unquoted words MUST include neutral and English/French matches. Only the active word MAY
     * add a neutral prefix match. User input MUST NOT select arbitrary fields or Elasticsearch DSL.
     */
    pub fn compile(request: SearchRequest) -> Result<Self, Error> {
        let limit = request.limit.unwrap_or(DEFAULT_RESULT_LIMIT);
        if !(1..=MAX_RESULT_LIMIT).contains(&limit) {
            return Err(Error::Invalid("invalid search limit"));
        }

        let fields: HashSet<_> = if request.fields.is_empty() {
            [
                SearchField::Name,
                SearchField::Content,
                SearchField::Attributes,
            ]
            .into()
        } else {
            request
                .fields
                .iter()
                .map(|&field| {
                    SearchField::try_from(field).map_err(|_| Error::Invalid("invalid search field"))
                })
                .collect::<Result<_, _>>()?
        };

        if let Some(scope) = &request.scope {
            scope
                .directory_id
                .validate()
                .map_err(|_| Error::Invalid("invalid scope ID"))?;
        }

        let clauses = lexer::lex(&request.query, request.as_you_type.unwrap_or(false))
            .map_err(Error::Syntax)?;
        let structured = request.filter.unwrap_or_default();
        let filters = structured_filters(&structured)?;
        let content_only = fields.len() == 1 && fields.contains(&SearchField::Content);
        let empty_query = clauses.is_empty() && filters.is_empty() && !content_only;

        let mut required_versions = VersionRequirements {
            attributes: !filters.is_empty(),
            ..Default::default()
        };
        let mut query = Query::bool().filter(filters);

        for (index, clause) in clauses.iter().enumerate() {
            if let Some(modifier) = clause.modifier {
                let predicate = modifier_query(modifier, &clause.value)?;
                query = if clause.negative {
                    query.must_not(predicate)
                } else {
                    query.filter(predicate)
                };

                required_versions.attributes = true;
            } else {
                let predicate = text_query(clause, &fields, index);
                if clause.negative {
                    query = query.must_not(predicate);
                    required_versions.attributes |= fields.contains(&SearchField::Name)
                        || fields.contains(&SearchField::Attributes);
                    required_versions.content |= fields.contains(&SearchField::Content);
                } else {
                    query = query.must(predicate);
                    required_versions.positive_clauses.push(index);
                }
            }
        }

        if content_only {
            query = query.filter(Query::term("kind", "file"));
        }

        Ok(Self {
            query: if empty_query {
                // The DSL would drop an empty bool query and change its score.
                Query::match_all().into()
            } else {
                query.into()
            },
            include_excerpt: !required_versions.positive_clauses.is_empty()
                && fields.contains(&SearchField::Content),
            required_versions,
            limit: limit as usize,
            scope: request.scope,
            xattrs: structured.xattrs,
        })
    }

    /**
     * @cc [owner:flvndvd,label:security] search-candidate-isolation
     * Queries MUST filter the authenticated tenant and exclude deleted projections.
     * An empty tenant ID MUST fail before any Elasticsearch request.
     * None for read_grants MUST be reserved for an authenticated superuser. Other sessions MUST
     * match a current direct READ grant on self or read_grant_ancestor_ids. An empty grant set
     * MUST match nothing. Scope MUST use physical ancestry, independently of grant ancestry.
     */
    pub fn candidate_query(
        &self,
        tenant_id: &str,
        read_grants: Option<&[ObjectId]>,
    ) -> Result<Query, Error> {
        let mut query = user_base_query(tenant_id, read_grants)?.must(self.query.clone());

        if let Some(scope) = &self.scope {
            query = query.filter(Query::term("ancestor_ids", scope.directory_id.to_string()));
        }

        Ok(query.into())
    }

    /**
     * @cc [owner:flvndvd,label:security] search-match-freshness
     * Every required text clause MUST have a match from a current representation. Name and
     * attribute matches require the indexed attr_version. Body matches require content_version.
     * Negative clauses MUST require current versions for every field they searched. Filters
     * derived from attributes MUST require current attr_version. A stale body MUST NOT prevent
     * an otherwise current name-only match and MUST NOT supply an excerpt.
     */
    pub fn matches_current_versions(
        &self,
        matched_queries: &[String],
        attributes_current: bool,
        content_current: bool,
        kind: ObjectKind,
    ) -> bool {
        if self.required_versions.attributes && !attributes_current
            || self.required_versions.content && kind == ObjectKind::File && !content_current
        {
            return false;
        }

        let matched_queries: HashSet<_> = matched_queries.iter().map(String::as_str).collect();

        self.required_versions.positive_clauses.iter().all(|index| {
            attributes_current && matched_queries.contains(format!("c{index}a").as_str())
                || kind == ObjectKind::File
                    && content_current
                    && matched_queries.contains(format!("c{index}c").as_str())
        })
    }
}

fn tenant_base_query(tenant_id: &str) -> Result<BoolQuery, Error> {
    if tenant_id.is_empty() {
        return Err(Error::Invalid("missing search tenant"));
    }

    Ok(Query::bool()
        .filter(Query::term("tenant_id", tenant_id))
        .filter(Query::term("is_deleted", false)))
}

fn user_base_query(tenant_id: &str, read_grants: Option<&[ObjectId]>) -> Result<BoolQuery, Error> {
    let query = tenant_base_query(tenant_id)?;

    Ok(match read_grants {
        None => query,
        // The DSL drops empty terms. No grants must match nothing instead.
        Some([]) => query.filter(Query::match_none()),
        Some(grants) => {
            let ids: Vec<_> = grants.iter().map(ToString::to_string).collect();
            query.filter(
                Query::bool()
                    .should(Query::terms("object_id", &ids))
                    .should(Query::terms("read_grant_ancestor_ids", &ids))
                    .minimum_should_match(1),
            )
        }
    })
}

fn text_query(clause: &Clause, fields: &HashSet<SearchField>, index: usize) -> DisMaxQuery {
    let mut attributes = Query::dis_max();
    if fields.contains(&SearchField::Name) {
        attributes = attributes
            .query(field_query("name", "name", clause))
            .query(neutral_query("name.parts", clause));
    }

    if fields.contains(&SearchField::Attributes) {
        for field in [
            "attributes.title",
            "attributes.description",
            "attributes.tags",
        ] {
            let neutral = if field == "attributes.tags" {
                "attributes.tags.text"
            } else {
                field
            };
            attributes = attributes.query(field_query(neutral, field, clause));
        }
    }

    let mut groups = Query::dis_max();
    if fields.contains(&SearchField::Name) || fields.contains(&SearchField::Attributes) {
        groups = groups.query(attributes.name(format!("c{index}a")));
    }
    if fields.contains(&SearchField::Content) {
        groups = groups.query(
            Query::dis_max()
                .query(field_query("content_text", "content_text", clause))
                .name(format!("c{index}c")),
        );
    }

    groups
}

fn field_query(neutral: &str, stemmed: &str, clause: &Clause) -> Query {
    let query = neutral_query(neutral, clause);
    if clause.quoted {
        return query;
    }

    let languages = ["en", "fr"].map(|language| {
        Query::r#match(
            format!("stemmed.{language}.{stemmed}"),
            clause.value.as_str(),
        )
        .operator(Operator::And)
    });

    Query::dis_max().query(query).query(languages).into()
}

fn neutral_query(field: &str, clause: &Clause) -> Query {
    if clause.quoted {
        Query::match_phrase(field, clause.value.as_str())
            .slop(0)
            .into()
    } else if clause.prefix {
        Query::match_bool_prefix(field, clause.value.as_str())
            .operator(Operator::And)
            .into()
    } else {
        Query::r#match(field, clause.value.as_str())
            .operator(Operator::And)
            .into()
    }
}

fn modifier_query(modifier: Modifier, value: &str) -> Result<Query, Error> {
    let query = match modifier {
        Modifier::Type => type_query(value)?,

        Modifier::Mime => Query::bool()
            .filter(Query::term("kind", "file"))
            .filter(Query::term("mime_type", canonical_mime_type(value)?))
            .into(),

        Modifier::Extension => {
            let extension = value.strip_prefix('.').unwrap_or(value);

            if extension.is_empty() || !extension.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err(Error::Invalid("invalid extension filter"));
            }

            Query::term("extension", extension.to_ascii_lowercase()).into()
        }

        Modifier::Tag => Query::term("attributes.tags", value).into(),

        Modifier::Owner => Query::term("attributes.owner_ids", value).into(),

        Modifier::Source => Query::term("attributes.source", value).into(),

        Modifier::Filename => Query::term("name.folded", value).into(),

        Modifier::Before | Modifier::After => {
            let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| Error::Invalid("invalid date filter"))?;

            if date.format("%Y-%m-%d").to_string() != value {
                return Err(Error::Invalid("invalid date filter"));
            }

            let time = date
                .and_hms_opt(0, 0, 0)
                .ok_or(Error::Invalid("invalid date filter"))?;
            let millis = u64::try_from(time.and_utc().timestamp_millis())
                .map_err(|_| Error::Invalid("date filter precedes the Unix epoch"))?;

            let range = Query::range("mtime_ms");

            if modifier == Modifier::Before {
                range.lt(millis).into()
            } else {
                range.gte(millis).into()
            }
        }
    };

    Ok(query)
}

fn type_query(value: &str) -> Result<Query, Error> {
    let value = value.to_ascii_lowercase();
    let mimes: &[&str] = match value.as_str() {
        "file" => return Ok(Query::term("kind", "file").into()),
        "folder" | "directory" => return Ok(Query::term("kind", "directory").into()),
        "pdf" => &["application/pdf"],
        "document" => &[
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
            "application/vnd.google-apps.document",
        ],
        "spreadsheet" => &[
            "text/csv",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.oasis.opendocument.spreadsheet",
            "application/vnd.google-apps.spreadsheet",
        ],
        "presentation" => &[
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.oasis.opendocument.presentation",
            "application/vnd.google-apps.presentation",
        ],
        "image" | "audio" | "video" | "text" => {
            return Ok(Query::bool()
                .filter(Query::term("kind", "file"))
                .filter(Query::prefix("mime_type", format!("{value}/")))
                .into());
        }
        _ => return Err(Error::Invalid("unknown type filter")),
    };

    Ok(Query::bool()
        .filter(Query::term("kind", "file"))
        .filter(Query::terms("mime_type", mimes))
        .into())
}

fn structured_filters(filter: &SearchFilter) -> Result<Vec<Query>, Error> {
    let mut queries = Vec::new();
    for name in filter.name.iter().chain(&filter.name_prefix) {
        if name.len() > NAME_MAX_BYTES || name.contains('\0') {
            return Err(Error::Invalid("invalid basename filter"));
        }
    }

    let kind = filter
        .kind
        .map(ObjectKind::try_from)
        .transpose()
        .map_err(|_| Error::Invalid("invalid kind filter"))?;
    if let Some(kind) = kind {
        let value = match kind {
            ObjectKind::File => "file",
            ObjectKind::Directory => "directory",
            ObjectKind::Symlink => return Err(Error::Invalid("unsupported kind filter")),
        };
        queries.push(Query::term("kind", value).into());
    }

    if let Some(name) = &filter.name {
        // The DSL drops empty strings, but an empty name is still an exact filter.
        queries.push(if name.is_empty() {
            Query::json(json!({"term": {"name.keyword": ""}})).into()
        } else {
            Query::term("name.keyword", name).into()
        });
    }
    if let Some(prefix) = &filter.name_prefix {
        queries.push(if prefix.is_empty() {
            Query::json(json!({"prefix": {"name.keyword": ""}})).into()
        } else {
            Query::prefix("name.keyword", prefix).into()
        });
    }

    if filter.mime_types.len() > MAX_MIME_FILTERS || filter.xattrs.len() > MAX_XATTR_FILTERS {
        return Err(Error::Invalid("too many search filters"));
    }

    let file_only =
        !filter.mime_types.is_empty() || filter.min_size.is_some() || filter.max_size.is_some();
    if file_only {
        if kind == Some(ObjectKind::Directory) {
            return Err(Error::Invalid("file filters cannot select directories"));
        }
        queries.push(Query::term("kind", "file").into());
    }

    if !filter.mime_types.is_empty() {
        let mimes = filter
            .mime_types
            .iter()
            .map(|value| canonical_mime_type(value))
            .collect::<Result<Vec<_>, _>>()?;
        queries.push(Query::terms("mime_type", mimes).into());
    }

    for (field, lower, upper) in [
        ("size_bytes", filter.min_size, filter.max_size),
        ("mtime_ms", filter.modified_after, filter.modified_before),
    ] {
        if let (Some(lower), Some(upper)) = (lower, upper)
            && lower > upper
        {
            return Err(Error::Invalid("inverted search bounds"));
        }

        if lower.is_some() || upper.is_some() {
            queries.push(Query::range(field).gte(lower).lte(upper).into());
        }
    }

    for xattr in &filter.xattrs {
        if xattr.name.is_empty()
            || xattr.name.len() > MAX_XATTR_NAME_BYTES
            || xattr.name.contains('\0')
        {
            return Err(Error::Invalid("invalid xattr name"));
        }

        if let Some(value) = &xattr.value {
            if xattr.name.len() + value.len() > MAX_XATTR_BYTES {
                return Err(Error::Invalid(
                    "xattr filter exceeds the stored value limit",
                ));
            }

            queries
                .push(Query::term("xattr_pair_hashes", xattr_pair_hash(&xattr.name, value)).into());
        } else {
            queries.push(Query::term("xattr_names", &xattr.name).into());
        }
    }

    Ok(queries)
}

/// The index stores MIME media types in lowercase, without parameters such as charset.
pub fn canonical_mime_type(value: &str) -> Result<String, Error> {
    if value.len() > MAX_MIME_BYTES {
        return Err(Error::Invalid("mime type exceeds the size limit"));
    }

    let mime = value
        .parse::<mime::Mime>()
        .map_err(|_| Error::Invalid("invalid MIME type"))?;
    if mime.type_() == mime::STAR || mime.subtype() == mime::STAR {
        return Err(Error::Invalid("wildcard MIME types are unsupported"));
    }

    Ok(mime.essence_str().to_ascii_lowercase())
}

/**
 * @cc [owner:flvndvd,label:backend] search-xattr-pair-encoding
 * Indexers and queries MUST hash the domain dfs.xattr_pair.v1 followed by NUL, the name's UTF-8
 * byte length as an unsigned 64-bit big-endian integer, the name bytes, and the complete raw value.
 * The output MUST be lowercase SHA-256 hex. No text normalization or truncation is allowed.
 * Search MUST also check the current raw value before returning the object.
 */
pub fn xattr_pair_hash(name: &str, value: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(XATTR_HASH_DOMAIN);
    hash.update((name.len() as u64).to_be_bytes());
    hash.update(name.as_bytes());
    hash.update(value);

    format!("{:x}", hash.finalize())
}
