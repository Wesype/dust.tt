use dfs_api::search::query::{Plan, canonical_mime_type, xattr_pair_hash};
use dfs_protocol::{
    ObjectId,
    rpc::{ObjectKind, SearchField, SearchFilter, SearchRequest, SearchXattr},
};
use serde_json::{json, to_value};

#[test]
fn every_access_mode_keeps_the_tenant_base_query() -> anyhow::Result<()> {
    let grant = ObjectId::new_v7();
    let grants = [grant];

    for text in ["", "report", "-draft", "type:pdf"] {
        let plan = Plan::compile(SearchRequest {
            query: text.into(),
            ..Default::default()
        })?;

        for access in [None, Some([].as_slice()), Some(grants.as_slice())] {
            let query = to_value(plan.candidate_query("tenant", access)?)?;
            let filters = &query["bool"]["filter"];

            assert_eq!(
                filters[0],
                json!({"term": {"tenant_id": {"value": "tenant"}}})
            );
            assert_eq!(
                filters[1],
                json!({"term": {"is_deleted": {"value": false}}})
            );

            match access {
                None => assert!(filters[2].is_null()),
                Some([]) => assert_eq!(filters[2], json!({"match_none": {}})),
                Some(_) => assert_eq!(
                    filters[2],
                    json!({"bool": {
                        "should": [
                            {"terms": {"object_id": [grant.to_string()]}},
                            {"terms": {"read_grant_ancestor_ids": [grant.to_string()]}}
                        ],
                        "minimum_should_match": "1"
                    }})
                ),
            }

            assert!(plan.candidate_query("", access).is_err());
        }
    }

    Ok(())
}

#[test]
fn empty_search_keeps_match_all_scoring() -> anyhow::Result<()> {
    let plan = Plan::compile(SearchRequest::default())?;
    let query = to_value(plan.candidate_query("tenant", None)?)?;

    assert_eq!(query["bool"]["must"], json!([{"match_all": {}}]));

    Ok(())
}

#[test]
fn empty_basename_filters_are_preserved_and_require_current_attributes() -> anyhow::Result<()> {
    for (filter, expected) in [
        (
            SearchFilter {
                name: Some(String::new()),
                ..Default::default()
            },
            json!({"term": {"name.keyword": ""}}),
        ),
        (
            SearchFilter {
                name_prefix: Some(String::new()),
                ..Default::default()
            },
            json!({"prefix": {"name.keyword": ""}}),
        ),
    ] {
        let plan = Plan::compile(SearchRequest {
            filter: Some(filter),
            ..Default::default()
        })?;
        let query = to_value(plan.candidate_query("tenant", None)?)?;

        assert_eq!(
            query["bool"]["must"][0]["bool"]["filter"],
            json!([expected])
        );
        assert!(!plan.matches_current_versions(&[], false, true, ObjectKind::File));
        assert!(plan.matches_current_versions(&[], true, true, ObjectKind::File));
    }

    Ok(())
}

#[test]
fn range_filters_keep_zero_and_large_integer_bounds() -> anyhow::Result<()> {
    let plan = Plan::compile(SearchRequest {
        filter: Some(SearchFilter {
            min_size: Some(0),
            max_size: Some(u64::MAX),
            ..Default::default()
        }),
        ..Default::default()
    })?;
    let query = to_value(plan.candidate_query("tenant", None)?)?;

    assert_eq!(
        query["bool"]["must"][0]["bool"]["filter"][1],
        json!({"range": {"size_bytes": {"gte": 0, "lte": u64::MAX}}})
    );

    Ok(())
}

#[test]
fn freshness_is_checked_for_each_required_word_and_each_source() -> anyhow::Result<()> {
    let plan = Plan::compile(SearchRequest {
        query: "report budget".into(),
        ..Default::default()
    })?;
    let matches = vec!["c0a".into(), "c1c".into()];
    assert!(plan.include_excerpt);

    let names = Plan::compile(SearchRequest {
        query: "report".into(),
        fields: vec![SearchField::Name.into()],
        ..Default::default()
    })?;
    assert!(!names.include_excerpt);
    assert!(!Plan::compile(SearchRequest::default())?.include_excerpt);
    assert!(plan.matches_current_versions(&matches, true, true, ObjectKind::File));
    assert!(!plan.matches_current_versions(&matches, true, false, ObjectKind::File));
    assert!(!plan.matches_current_versions(&matches, false, true, ObjectKind::File));
    assert!(!plan.matches_current_versions(&matches, true, true, ObjectKind::Directory));

    let alternatives = vec!["c0a".into(), "c1a".into(), "c1c".into()];
    assert!(plan.matches_current_versions(&alternatives, true, false, ObjectKind::File));

    let negative = Plan::compile(SearchRequest {
        query: "report -secret".into(),
        ..Default::default()
    })?;
    assert!(!negative.matches_current_versions(&["c0a".into()], true, false, ObjectKind::File));
    assert!(negative.matches_current_versions(&["c0a".into()], true, false, ObjectKind::Directory));

    let filter = Plan::compile(SearchRequest {
        query: "type:pdf budget".into(),
        ..Default::default()
    })?;
    assert!(!filter.matches_current_versions(&["c1c".into()], false, true, ObjectKind::File));

    Ok(())
}

#[test]
fn rejects_bad_filters_before_using_elasticsearch() {
    for query in [
        "type:unknown",
        "before:2026-02-30",
        "after:2026-2-3",
        "after:1969-12-31",
        "mime:pdf",
        "ext:*",
    ] {
        assert!(
            Plan::compile(SearchRequest {
                query: query.into(),
                ..Default::default()
            })
            .is_err(),
            "{query}"
        );
    }

    for filter in [
        SearchFilter {
            min_size: Some(2),
            max_size: Some(1),
            ..Default::default()
        },
        SearchFilter {
            kind: Some(ObjectKind::Directory.into()),
            mime_types: vec!["application/pdf".into()],
            ..Default::default()
        },
        SearchFilter {
            xattrs: vec![SearchXattr {
                name: "".into(),
                value: None,
            }],
            ..Default::default()
        },
    ] {
        assert!(
            Plan::compile(SearchRequest {
                filter: Some(filter),
                ..Default::default()
            })
            .is_err()
        );
    }

    assert!(
        Plan::compile(SearchRequest {
            fields: vec![99],
            ..Default::default()
        })
        .is_err()
    );

    assert!(
        Plan::compile(SearchRequest {
            limit: Some(0),
            ..Default::default()
        })
        .is_err()
    );
}

#[test]
fn binary_xattr_hashes_do_not_lose_boundaries_or_empty_values() {
    assert_ne!(xattr_pair_hash("ab", b"c"), xattr_pair_hash("a", b"bc"));
    assert_ne!(xattr_pair_hash("tag", b""), xattr_pair_hash("tag", b"\0"));
    assert_ne!(
        xattr_pair_hash("TAG", b"\xff"),
        xattr_pair_hash("tag", b"\xff")
    );
    assert_eq!(xattr_pair_hash("tag", b"\xff").len(), 64);
}

#[test]
fn mime_filters_use_the_same_media_type_as_the_projection() -> anyhow::Result<()> {
    assert_eq!(
        canonical_mime_type("Text/Plain; charset=utf-8")?,
        "text/plain"
    );
    assert!(canonical_mime_type("image/*").is_err());

    Ok(())
}
