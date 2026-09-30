use super::edits::{apply_edits, line_indent, newline_before, remove_performance_comments, Edit};
use super::lexer::{token_is, token_text, tokenize, Token};
use super::references::collect_harness_identifiers;
use super::syntax::{
    enum_separator, find_member_end, is_type_keyword, method_stub, type_body, MemberKind,
};

pub(super) fn reset_java_implementation(source: &str) -> String {
    let source = remove_performance_comments(source);
    let tokens = tokenize(&source);
    let mut roots = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        if !is_type_keyword(&source, &tokens, index) {
            index += 1;
            continue;
        }
        let Some((open, close)) = type_body(&source, &tokens, index) else {
            index += 1;
            continue;
        };
        let name = tokens[index + 1];
        let is_enum = token_is(&source, tokens[index], "enum");
        roots.push((open, close, name, is_enum));
        index = close + 1;
    }

    let mut harness_identifiers = std::collections::HashSet::new();
    for (open, close, name, is_enum) in &roots {
        collect_harness_identifiers(
            &source,
            &tokens,
            *open,
            *close,
            token_text(&source, *name),
            *is_enum,
            &mut harness_identifiers,
        );
    }

    let mut edits = Vec::new();
    for (open, close, name, is_enum) in roots {
        process_type_body(
            &source,
            &tokens,
            open,
            close,
            token_text(&source, name),
            is_enum,
            &harness_identifiers,
            &mut edits,
        );
    }

    apply_edits(&source, edits)
}

fn process_type_body(
    source: &str,
    tokens: &[Token],
    open: usize,
    close: usize,
    type_name: &str,
    is_enum: bool,
    harness_identifiers: &std::collections::HashSet<String>,
    edits: &mut Vec<Edit>,
) {
    let mut index = open + 1;
    let mut cursor = tokens[open].end;

    if is_enum {
        if let Some(separator) = enum_separator(source, tokens, index, close) {
            index = separator + 1;
            cursor = tokens[separator].end;
        } else {
            return;
        }
    }

    while index < close {
        let member_start = index;
        let Some(member) = find_member_end(source, tokens, member_start, close, type_name) else {
            break;
        };
        let member_end = tokens[member.end - 1].end;

        match member.kind {
            MemberKind::Method {
                header,
                body: Some((_, _)),
            } if header.keep_body => {}
            MemberKind::Method {
                header,
                body: Some((body_open, body_close)),
            } => {
                let indent = line_indent(source, tokens[member_start].start);
                let newline = newline_before(source);
                let body_indent = format!("{indent}    ");
                let stub = method_stub(header);
                let replacement = if stub.is_empty() {
                    format!("{newline}{indent}")
                } else {
                    format!("{newline}{body_indent}{stub}{newline}{indent}")
                };
                edits.push(Edit {
                    start: tokens[body_open].end,
                    end: tokens[body_close].start,
                    replacement,
                });
            }
            MemberKind::NestedType {
                open: nested_open,
                close: nested_close,
                name: nested_name,
                is_enum: nested_enum,
            } => process_type_body(
                source,
                tokens,
                nested_open,
                nested_close,
                token_text(source, nested_name),
                nested_enum,
                harness_identifiers,
                edits,
            ),
            MemberKind::Method { body: None, .. } => {}
            MemberKind::Remove { field_names } => {
                if field_names
                    .iter()
                    .all(|field| !harness_identifiers.contains(field))
                {
                    edits.push(Edit {
                        start: cursor,
                        end: member_end,
                        replacement: String::new(),
                    });
                }
            }
        }

        cursor = member_end;
        index = member.end;
    }
}
