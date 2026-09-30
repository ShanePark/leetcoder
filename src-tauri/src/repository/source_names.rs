use std::path::Path;

pub(super) fn source_name_parts(path: &Path) -> Result<(String, String), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Source file name is not valid UTF-8: {}", path.display()))?;
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Source file name has no usable stem: {file_name}"))?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .ok_or_else(|| format!("Source file has no usable extension: {file_name}"))?;
    Ok((stem.to_string(), format!(".{extension}")))
}

pub(super) fn replace_source_identifiers(source: &str, old: &str, new: &str) -> String {
    if old == new || !is_java_identifier(old) || !is_java_identifier(new) {
        return source.to_string();
    }

    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len() + new.len().saturating_sub(old.len()));
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            let end = source[index..]
                .find('\n')
                .map(|offset| index + offset)
                .unwrap_or(source.len());
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            let end = source[index + 2..]
                .find("*/")
                .map(|offset| index + 2 + offset + 2)
                .unwrap_or(source.len());
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'"' {
            let end = skip_quoted_literal(source, index, b'"');
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'\'' {
            let end = skip_quoted_literal(source, index, b'\'');
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }

        let Some(character) = source[index..].chars().next() else {
            break;
        };
        if is_java_identifier_start(character) {
            let start = index;
            index += character.len_utf8();
            while index < source.len() {
                let Some(next) = source[index..].chars().next() else {
                    break;
                };
                if !is_java_identifier_part(next) {
                    break;
                }
                index += next.len_utf8();
            }
            let token = &source[start..index];
            if token == old {
                output.push_str(new);
            } else {
                output.push_str(token);
            }
            continue;
        }

        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn skip_quoted_literal(source: &str, start: usize, delimiter: u8) -> usize {
    let bytes = source.as_bytes();
    let text_block = delimiter == b'"'
        && start + 2 < bytes.len()
        && bytes[start + 1] == b'"'
        && bytes[start + 2] == b'"';
    let mut index = if text_block { start + 3 } else { start + 1 };
    while index < bytes.len() {
        if text_block {
            if index + 2 < bytes.len()
                && bytes[index] == b'"'
                && bytes[index + 1] == b'"'
                && bytes[index + 2] == b'"'
            {
                return index + 3;
            }
            index += source[index..]
                .chars()
                .next()
                .map(|character| character.len_utf8())
                .unwrap_or(1);
            continue;
        }
        if bytes[index] == b'\\' {
            index += 1;
            if index < bytes.len() {
                index += source[index..]
                    .chars()
                    .next()
                    .map(|character| character.len_utf8())
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
            .map(|character| character.len_utf8())
            .unwrap_or(1);
    }
    source.len()
}

fn is_java_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    is_java_identifier_start(first) && characters.all(is_java_identifier_part)
}

fn is_java_identifier_start(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphabetic()
}

fn is_java_identifier_part(character: char) -> bool {
    is_java_identifier_start(character) || character.is_numeric()
}
