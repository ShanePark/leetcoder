use super::lexer::{is_identifier, token_is, token_text, Token};
use super::syntax::{enum_separator, find_member_end, MemberKind};

pub(super) fn collect_harness_identifiers(
    source: &str,
    tokens: &[Token],
    open: usize,
    close: usize,
    type_name: &str,
    is_enum: bool,
    identifiers: &mut std::collections::HashSet<String>,
) {
    let mut index = open + 1;
    if is_enum {
        let Some(separator) = enum_separator(source, tokens, index, close) else {
            return;
        };
        index = separator + 1;
    }
    while index < close {
        let Some(member) = find_member_end(source, tokens, index, close, type_name) else {
            break;
        };
        match member.kind {
            MemberKind::Method {
                header,
                body: Some((body_open, body_close)),
            } if header.keep_body => {
                let array_variables = array_variables(tokens, index, member.end, source);
                for token_index in body_open + 1..body_close {
                    let token = tokens[token_index];
                    if is_identifier(source, token)
                        && !is_unqualified_array_variable(
                            source,
                            tokens,
                            token_index,
                            &array_variables,
                        )
                        && !is_method_name(source, tokens, token_index, body_close)
                        && !is_array_length_property(source, tokens, token_index, &array_variables)
                    {
                        identifiers.insert(token_text(source, token).to_string());
                    }
                }
            }
            MemberKind::NestedType {
                open: nested_open,
                close: nested_close,
                name: nested_name,
                is_enum: nested_enum,
            } => collect_harness_identifiers(
                source,
                tokens,
                nested_open,
                nested_close,
                token_text(source, nested_name),
                nested_enum,
                identifiers,
            ),
            _ => {}
        }
        index = member.end;
    }
}

fn array_variables(
    tokens: &[Token],
    start: usize,
    end: usize,
    source: &str,
) -> std::collections::HashSet<String> {
    let mut variables = std::collections::HashSet::new();
    for index in start..end {
        if token_is(source, tokens[index], "[")
            && index + 2 < end
            && token_is(source, tokens[index + 1], "]")
            && is_identifier(source, tokens[index + 2])
        {
            variables.insert(token_text(source, tokens[index + 2]).to_string());
        }
        if token_is(source, tokens[index], "[")
            && index >= start + 1
            && token_is(source, tokens[index + 1], "]")
            && is_identifier(source, tokens[index - 1])
        {
            variables.insert(token_text(source, tokens[index - 1]).to_string());
        }
        if token_is(source, tokens[index], "...")
            && index + 1 < end
            && is_identifier(source, tokens[index + 1])
        {
            variables.insert(token_text(source, tokens[index + 1]).to_string());
        }
    }
    variables
}

fn is_method_name(source: &str, tokens: &[Token], index: usize, end: usize) -> bool {
    (index + 1 < end && token_is(source, tokens[index + 1], "("))
        || (index > 0 && token_is(source, tokens[index - 1], "::"))
        || (index > 1
            && token_is(source, tokens[index - 1], ":")
            && token_is(source, tokens[index - 2], ":"))
}

fn is_array_length_property(
    source: &str,
    tokens: &[Token],
    index: usize,
    array_variables: &std::collections::HashSet<String>,
) -> bool {
    index >= 2
        && token_is(source, tokens[index - 1], ".")
        && token_is(source, tokens[index], "length")
        && array_variables.contains(token_text(source, tokens[index - 2]))
        && (index < 3 || !token_is(source, tokens[index - 3], "."))
}

fn is_unqualified_array_variable(
    source: &str,
    tokens: &[Token],
    index: usize,
    array_variables: &std::collections::HashSet<String>,
) -> bool {
    array_variables.contains(token_text(source, tokens[index]))
        && (index == 0
            || (!token_is(source, tokens[index - 1], ".")
                && !token_is(source, tokens[index - 1], "::")))
}
