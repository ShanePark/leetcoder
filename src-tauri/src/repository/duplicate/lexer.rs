#[derive(Clone, Copy)]
pub(super) struct Token {
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) fn matching_brace(
    source: &str,
    tokens: &[Token],
    open: usize,
    limit: usize,
) -> Option<usize> {
    matching_pair(source, tokens, open, limit, "{", "}")
}

pub(super) fn matching_angle(
    source: &str,
    tokens: &[Token],
    open: usize,
    limit: usize,
) -> Option<usize> {
    let mut depth = 0usize;
    for index in open..limit {
        if token_is(source, tokens[index], "<") {
            depth += 1;
        } else if token_is(source, tokens[index], ">") {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

pub(super) fn matching_pair(
    source: &str,
    tokens: &[Token],
    open: usize,
    limit: usize,
    opening: &str,
    closing: &str,
) -> Option<usize> {
    let mut depth = 0usize;
    for index in open..limit {
        if token_is(source, tokens[index], opening) {
            depth += 1;
        } else if token_is(source, tokens[index], closing) {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

pub(super) fn tokenize(source: &str) -> Vec<Token> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let character = source[index..].chars().next().unwrap();
        if character.is_whitespace() {
            index += character.len_utf8();
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == b'"' || bytes[index] == b'\'' {
            let start = index;
            index = skip_quoted(source, index, bytes[index]);
            tokens.push(Token { start, end: index });
            continue;
        }
        if character == '_' || character == '$' || character.is_alphabetic() {
            let start = index;
            index += character.len_utf8();
            while index < bytes.len() {
                let next = source[index..].chars().next().unwrap();
                if next == '_' || next == '$' || next.is_alphanumeric() {
                    index += next.len_utf8();
                } else {
                    break;
                }
            }
            tokens.push(Token { start, end: index });
            continue;
        }
        if character.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len() {
                let next = source[index..].chars().next().unwrap();
                if next.is_alphanumeric() || next == '_' || next == '.' {
                    index += next.len_utf8();
                } else {
                    break;
                }
            }
            tokens.push(Token { start, end: index });
            continue;
        }
        let start = index;
        if source[index..].starts_with("->")
            || source[index..].starts_with("...")
            || source[index..].starts_with("::")
        {
            index += if source[index..].starts_with("->") || source[index..].starts_with("::") {
                2
            } else {
                3
            };
        } else {
            index += character.len_utf8();
        }
        tokens.push(Token { start, end: index });
    }
    tokens
}

pub(super) fn skip_quoted(source: &str, start: usize, delimiter: u8) -> usize {
    let bytes = source.as_bytes();
    let text_block = delimiter == b'"'
        && bytes.get(start + 1) == Some(&b'"')
        && bytes.get(start + 2) == Some(&b'"');
    let mut index = start + if text_block { 3 } else { 1 };
    while index < bytes.len() {
        if text_block {
            if bytes.get(index..index + 3) == Some(b"\"\"\"") {
                return index + 3;
            }
            if bytes[index] == b'\\' {
                index += 1;
                if index < bytes.len() {
                    index += source[index..]
                        .chars()
                        .next()
                        .map(char::len_utf8)
                        .unwrap_or(1);
                }
                continue;
            }
            index += source[index..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
            continue;
        }
        if bytes[index] == b'\\' {
            index += 1;
            if index < bytes.len() {
                index += source[index..]
                    .chars()
                    .next()
                    .map(char::len_utf8)
                    .unwrap_or(1);
            }
            continue;
        }
        if bytes[index] == delimiter {
            return index + 1;
        }
        index += source[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }
    source.len()
}

pub(super) fn is_identifier(source: &str, token: Token) -> bool {
    let text = token_text(source, token);
    let mut characters = text.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_alphabetic())
        && characters
            .all(|character| character == '_' || character == '$' || character.is_alphanumeric())
}

pub(super) fn token_is(source: &str, token: Token, value: &str) -> bool {
    token_text(source, token) == value
}

pub(super) fn token_text(source: &str, token: Token) -> &str {
    &source[token.start..token.end]
}
