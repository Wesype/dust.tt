use dfs_api::search::lexer::{Error, Modifier, lex};

#[test]
fn keeps_phrases_modifiers_and_escaped_characters_together() -> Result<(), Error> {
    let clauses = lex(
        r#"type:pdf "annual reports" tag:"Réseau sécurité" -draft \-literal"#,
        false,
    )?;
    assert_eq!(clauses.len(), 5);
    assert_eq!(clauses[0].modifier, Some(Modifier::Type));
    assert_eq!(clauses[0].value, "pdf");
    assert!(clauses[1].quoted);
    assert_eq!(clauses[1].value, "annual reports");
    assert_eq!(clauses[2].modifier, Some(Modifier::Tag));
    assert_eq!(clauses[2].value, "Réseau sécurité");
    assert!(clauses[3].negative);
    assert!(!clauses[4].negative);
    assert_eq!(clauses[4].value, "-literal");
    assert_eq!(
        lex(r#""a \"quote\" and \\slash""#, false)?[0].value,
        "a \"quote\" and \\slash"
    );
    Ok(())
}

#[test]
fn only_the_active_positive_word_gets_prefix_matching() -> Result<(), Error> {
    let clauses = lex("report année", true)?;
    assert!(!clauses[0].prefix);
    assert!(clauses[1].prefix);
    assert_eq!(clauses[1].span, 7..13);
    for query in [
        "report année ",
        "report -année",
        "report tag:année",
        "report \"année\"",
    ] {
        assert!(
            lex(query, true)?.iter().all(|clause| !clause.prefix),
            "{query}"
        );
    }
    assert!(
        lex("report année", false)?
            .iter()
            .all(|clause| !clause.prefix)
    );
    Ok(())
}

#[test]
fn urls_unknown_modifiers_and_escaped_operators_remain_text() -> Result<(), Error> {
    for query in [
        "https://example.com/reports",
        "unknown:budget",
        r"type\:pdf",
        r"\-draft",
    ] {
        let clauses = lex(query, false)?;
        assert_eq!(clauses.len(), 1);
        assert_eq!(clauses[0].modifier, None, "{query}");
        assert!(!clauses[0].negative, "{query}");
    }
    assert_eq!(lex(r"annual\ report", false)?[0].value, "annual report");
    Ok(())
}

#[test]
fn rejects_invalid_or_unbounded_input_without_losing_clauses() -> Result<(), Error> {
    for query in [
        "type:",
        "-",
        "\"\"",
        "tag:\" \"",
        "unfinished\\",
        "word\"quote",
        "\"quote\"suffix",
    ] {
        assert!(lex(query, false).is_err(), "{query}");
    }
    assert_eq!(lex("\"annual", false), Err(Error::UnclosedQuote(0)));
    let partial = lex("\"annual", true)?;
    assert!(partial[0].quoted);
    assert!(!partial[0].prefix);
    assert_eq!(lex("a\0b", false), Err(Error::Nul));
    assert_eq!(lex(&"é".repeat(2_049), false), Err(Error::TooLong));
    assert_eq!(lex(&"a ".repeat(33), false), Err(Error::TooManyClauses));
    assert!(lex("\n\t \u{a0}", false)?.is_empty());
    Ok(())
}
