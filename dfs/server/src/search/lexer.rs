use std::{fmt, ops::Range};

pub const MAX_QUERY_BYTES: usize = 4_096;
pub const MAX_QUERY_CLAUSES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier {
    Type,
    Mime,
    Extension,
    Tag,
    Owner,
    Source,
    Before,
    After,
    Filename,
}

impl Modifier {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "type" => Some(Self::Type),
            "mime" => Some(Self::Mime),
            "ext" => Some(Self::Extension),
            "tag" => Some(Self::Tag),
            "owner" => Some(Self::Owner),
            "source" => Some(Self::Source),
            "before" => Some(Self::Before),
            "after" => Some(Self::After),
            "filename" => Some(Self::Filename),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clause {
    pub value: String,
    pub modifier: Option<Modifier>,
    pub quoted: bool,
    pub negative: bool,
    pub prefix: bool,
    pub span: Range<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    TooLong,
    TooManyClauses,
    Nul,
    MissingValue(usize),
    UnclosedQuote(usize),
    TrailingEscape(usize),
    UnexpectedQuote(usize),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong => write!(f, "search query exceeds {MAX_QUERY_BYTES} bytes"),
            Self::TooManyClauses => write!(f, "search query exceeds {MAX_QUERY_CLAUSES} clauses"),
            Self::Nul => f.write_str("search query contains a NUL character"),
            Self::MissingValue(offset) => write!(f, "missing search value at byte {offset}"),
            Self::UnclosedQuote(offset) => write!(f, "unclosed search quote at byte {offset}"),
            Self::TrailingEscape(offset) => write!(f, "unfinished search escape at byte {offset}"),
            Self::UnexpectedQuote(offset) => write!(f, "unexpected search quote at byte {offset}"),
        }
    }
}

impl std::error::Error for Error {}

/**
 * @cc [owner:flvndvd,label:api] search-lexer-syntax
 * Quotes and backslash escapes MUST preserve their contents. A leading unescaped minus MUST
 * negate one clause. Only known, unescaped modifier names followed by a colon select filters.
 * Unknown prefixes, including URL schemes, MUST remain ordinary text. Empty values, dangling
 * escapes, NUL, and over-budget queries MUST fail before any backend request.
 */
/**
 * @cc [owner:flvndvd,label:api] search-lexer-typing
 * Only the final positive, unquoted text clause MAY receive prefix matching, and only when
 * as_you_type is true and no whitespace follows it. Quoted values and modifiers MUST NOT gain
 * prefix matching. An open quote MAY end at EOF while typing, but submitted queries MUST reject it.
 */
pub fn lex(input: &str, as_you_type: bool) -> Result<Vec<Clause>, Error> {
    if input.len() > MAX_QUERY_BYTES {
        return Err(Error::TooLong);
    }
    if input.contains('\0') {
        return Err(Error::Nul);
    }

    let mut chars = input.char_indices().peekable();
    let mut clauses = Vec::new();

    loop {
        while chars.peek().is_some_and(|(_, ch)| ch.is_whitespace()) {
            chars.next();
        }

        let Some(&(start, first)) = chars.peek() else {
            break;
        };
        if clauses.len() == MAX_QUERY_CLAUSES {
            return Err(Error::TooManyClauses);
        }

        let negative = first == '-';
        if negative {
            chars.next();
        }

        let offset = chars.peek().map_or(input.len(), |(offset, _)| *offset);
        let modifier = match parse_modifier(&input[offset..]) {
            Some((modifier, consumed_chars)) => {
                for _ in 0..consumed_chars {
                    chars.next();
                }
                Some(modifier)
            }
            None => None,
        };

        let quoted = chars.peek().is_some_and(|(_, ch)| *ch == '"');
        if quoted {
            chars.next();
        }

        let mut value = String::new();
        let mut closed = !quoted;

        while let Some(&(offset, ch)) = chars.peek() {
            if !quoted && ch.is_whitespace() {
                break;
            }

            chars.next();
            match ch {
                '\\' => {
                    let (_, escaped) = chars.next().ok_or(Error::TrailingEscape(offset))?;
                    value.push(escaped);
                }
                '"' if quoted => {
                    closed = true;
                    break;
                }
                '"' => return Err(Error::UnexpectedQuote(offset)),
                ch => value.push(ch),
            }
        }

        if !closed && !as_you_type {
            return Err(Error::UnclosedQuote(start));
        }
        if value.trim().is_empty() {
            return Err(Error::MissingValue(start));
        }
        if quoted && chars.peek().is_some_and(|(_, ch)| !ch.is_whitespace()) {
            return Err(Error::UnexpectedQuote(
                chars.peek().map_or(start, |(offset, _)| *offset),
            ));
        }

        let end = chars.peek().map_or(input.len(), |(offset, _)| *offset);
        clauses.push(Clause {
            value,
            modifier,
            quoted,
            negative,
            prefix: as_you_type && !negative && !quoted && modifier.is_none() && end == input.len(),
            span: start..end,
        });
    }

    Ok(clauses)
}

fn parse_modifier(input: &str) -> Option<(Modifier, usize)> {
    let (name, _) = input.split_once(':')?;
    let modifier = Modifier::parse(name)?;
    Some((modifier, name.chars().count() + 1))
}
