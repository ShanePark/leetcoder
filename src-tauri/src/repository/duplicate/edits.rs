use super::lexer::skip_quoted;

pub(super) struct Edit {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) replacement: String,
}

pub(super) fn remove_performance_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut edits = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'"' || bytes[index] == b'\'' {
            index = skip_quoted(source, index, bytes[index]);
            continue;
        }
        let (end, comment) = if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            let mut end = index + 2;
            while end < bytes.len() && bytes[end] != b'\n' {
                end += 1;
            }
            (Some(end), &source[index + 2..end])
        } else if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let mut end = index + 2;
            while end + 1 < bytes.len() && !(bytes[end] == b'*' && bytes[end + 1] == b'/') {
                end += 1;
            }
            end = (end + 2).min(bytes.len());
            (Some(end), &source[index + 2..end.saturating_sub(2)])
        } else {
            (None, "")
        };
        let Some(end) = end else {
            let character = source[index..].chars().next().unwrap();
            index += character.len_utf8();
            continue;
        };
        if is_performance_comment(comment) {
            let line_start = source[..index].rfind('\n').map_or(0, |line| line + 1);
            let mut line_end = end;
            while line_end < bytes.len() && matches!(bytes[line_end], b' ' | b'\t' | b'\r') {
                line_end += 1;
            }
            let standalone = source[line_start..index].trim().is_empty()
                && source[end..line_end].trim().is_empty()
                && (line_end == bytes.len() || bytes[line_end] == b'\n');
            edits.push(Edit {
                start: if standalone { line_start } else { index },
                end: if standalone && line_end < bytes.len() {
                    line_end + 1
                } else if standalone {
                    line_end
                } else {
                    end
                },
                replacement: if standalone {
                    String::new()
                } else {
                    " ".to_string()
                },
            });
        }
        index = end;
    }
    apply_edits(source, edits)
}

fn is_performance_comment(comment: &str) -> bool {
    comment.lines().any(|line| {
        let line = line.trim().trim_start_matches('*').trim_start();
        let line = line.to_ascii_lowercase();
        line.starts_with("runtime")
            || line.starts_with("memory")
            || line.starts_with("wrong answer")
            || line.starts_with("tle")
            || line.starts_with("time limit exceeded")
    })
}

pub(super) fn apply_edits(source: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|edit| edit.start);
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for edit in edits {
        if edit.start < cursor || edit.end < edit.start {
            continue;
        }
        output.push_str(&source[cursor..edit.start]);
        output.push_str(&edit.replacement);
        cursor = edit.end;
    }
    output.push_str(&source[cursor..]);
    output
}

pub(super) fn line_indent(source: &str, position: usize) -> String {
    let line_start = source[..position].rfind('\n').map_or(0, |index| index + 1);
    source[line_start..position]
        .chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect()
}

pub(super) fn newline_before(source: &str) -> &'static str {
    if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}
