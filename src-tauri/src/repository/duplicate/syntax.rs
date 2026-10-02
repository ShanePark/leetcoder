use super::lexer::{
    is_identifier, matching_angle, matching_brace, matching_pair, token_is, token_text, Token,
};

#[derive(Clone, Copy)]
pub(super) struct MethodHeader {
    pub(super) name: Token,
    pub(super) is_private: bool,
    pub(super) is_constructor: bool,
    pub(super) keep_body: bool,
    pub(super) has_method_source: bool,
    return_type: ReturnType,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReturnType {
    Void,
    Boolean,
    Char,
    Number,
    Reference,
}

pub(super) enum MemberKind {
    Method {
        header: MethodHeader,
        body: Option<(usize, usize)>,
    },
    NestedType {
        open: usize,
        close: usize,
        name: Token,
        is_enum: bool,
    },
    Remove {
        field_names: Vec<String>,
    },
}

pub(super) struct Member {
    pub(super) end: usize,
    pub(super) kind: MemberKind,
}

pub(super) fn find_member_end(
    source: &str,
    tokens: &[Token],
    start: usize,
    limit: usize,
    type_name: &str,
) -> Option<Member> {
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut index = start;

    while index < limit {
        let token = tokens[index];
        if token_is(source, token, "(") {
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        } else if parentheses == 0 && brackets == 0 && token_is(source, token, ";") {
            let header = method_header(source, tokens, start, index, type_name);
            return Some(Member {
                end: index + 1,
                kind: header.map_or_else(
                    || MemberKind::Remove {
                        field_names: field_names(source, tokens, start, index),
                    },
                    |header| MemberKind::Method { header, body: None },
                ),
            });
        } else if parentheses == 0 && brackets == 0 && token_is(source, token, "{") {
            if let Some((nested_name, nested_enum)) =
                nested_type_header(source, tokens, start, index)
            {
                let nested_close = matching_brace(source, tokens, index, limit)?;
                return Some(Member {
                    end: nested_close + 1,
                    kind: MemberKind::NestedType {
                        open: index,
                        close: nested_close,
                        name: nested_name,
                        is_enum: nested_enum,
                    },
                });
            }
            if let Some(header) = method_header(source, tokens, start, index, type_name) {
                let body_close = matching_brace(source, tokens, index, limit)?;
                return Some(Member {
                    end: body_close + 1,
                    kind: MemberKind::Method {
                        header,
                        body: Some((index, body_close)),
                    },
                });
            }
            let body_close = matching_brace(source, tokens, index, limit)?;
            if has_top_level_assignment(source, tokens, start, index)
                || has_top_level_arrow(source, tokens, start, index)
            {
                index = body_close + 1;
                continue;
            }
            return Some(Member {
                end: body_close + 1,
                kind: MemberKind::Remove {
                    field_names: Vec::new(),
                },
            });
        }
        index += 1;
    }
    None
}

fn field_names(source: &str, tokens: &[Token], start: usize, end: usize) -> Vec<String> {
    let mut names = Vec::new();
    let mut segment_start = start;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    let mut angles = 0usize;
    let mut in_initializer = false;

    for index in start..=end {
        let at_end = index == end;
        let is_separator = !at_end
            && parentheses == 0
            && brackets == 0
            && braces == 0
            && angles == 0
            && token_is(source, tokens[index], ",");
        if at_end || is_separator {
            if let Some(name) = field_name_in_segment(source, tokens, segment_start, index) {
                names.push(name.to_string());
            }
            segment_start = index + 1;
            in_initializer = false;
            continue;
        }

        let token = tokens[index];
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && angles == 0
            && token_is(source, token, "=")
        {
            in_initializer = true;
        } else if token_is(source, token, "(") {
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        } else if token_is(source, token, "{") {
            braces += 1;
        } else if token_is(source, token, "}") {
            braces = braces.saturating_sub(1);
        } else if !in_initializer && token_is(source, token, "<") {
            angles += 1;
        } else if !in_initializer && token_is(source, token, ">") {
            angles = angles.saturating_sub(1);
        }
    }
    names
}

fn field_name_in_segment<'a>(
    source: &'a str,
    tokens: &'a [Token],
    start: usize,
    end: usize,
) -> Option<&'a str> {
    let mut declaration_end = end;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    let mut angles = 0usize;
    for index in start..end {
        let token = tokens[index];
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && angles == 0
            && token_is(source, token, "=")
        {
            declaration_end = index;
            break;
        }
        if token_is(source, token, "(") {
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        } else if token_is(source, token, "{") {
            braces += 1;
        } else if token_is(source, token, "}") {
            braces = braces.saturating_sub(1);
        } else if token_is(source, token, "<") {
            angles += 1;
        } else if token_is(source, token, ">") {
            angles = angles.saturating_sub(1);
        }
    }
    tokens[start..declaration_end]
        .iter()
        .rev()
        .find(|token| is_identifier(source, **token))
        .map(|token| token_text(source, *token))
}

fn method_header(
    source: &str,
    tokens: &[Token],
    start: usize,
    end: usize,
    type_name: &str,
) -> Option<MethodHeader> {
    let mut index = start;
    let mut annotations = Vec::new();
    while index < end {
        if token_is(source, tokens[index], "@") {
            let (next, simple_name) = skip_annotation(source, tokens, index, end);
            if let Some(name) = simple_name {
                annotations.push(name);
            }
            index = next;
            continue;
        }
        if is_modifier(source, tokens[index]) {
            index += 1;
            continue;
        }
        break;
    }

    // Generic method parameters precede the return type and may contain bounds.
    if index < end && token_is(source, tokens[index], "<") {
        index = matching_angle(source, tokens, index, end)? + 1;
    }
    let return_start = index;

    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut candidate = None;
    for at in index..end {
        let token = tokens[at];
        if parentheses == 0 && brackets == 0 && token_is(source, token, "=") {
            return None;
        }
        if parentheses == 0 && brackets == 0 && token_is(source, token, "->") {
            return None;
        }
        if token_is(source, token, "(") {
            if parentheses == 0 && brackets == 0 {
                let previous = at.checked_sub(1)?;
                if !token_is(source, tokens[previous], "@")
                    && is_identifier(source, tokens[previous])
                    && !is_annotation_invocation(source, tokens, start, previous)
                {
                    candidate = Some((previous, at));
                    break;
                }
            }
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        }
    }
    let (name, parameters) = candidate?;
    let parameter_close = matching_pair(source, tokens, parameters, end, "(", ")")?;
    let method_name = token_text(source, tokens[name]);
    let is_constructor = method_name == type_name && name == return_start;
    if !is_constructor && name == start {
        return None;
    }
    if !is_constructor
        && !tokens[start..name]
            .iter()
            .any(|token| is_identifier(source, *token))
    {
        return None;
    }

    let return_type = method_return_type(source, tokens, return_start, name, parameter_close, end);
    let mut keep_body = annotations.iter().any(|name| {
        matches!(
            *name,
            "Test"
                | "ParameterizedTest"
                | "RepeatedTest"
                | "TestFactory"
                | "TestTemplate"
                | "BeforeEach"
                | "AfterEach"
                | "BeforeAll"
                | "AfterAll"
                | "Before"
                | "After"
                | "BeforeClass"
                | "AfterClass"
        )
    });
    if method_name == "main"
        && has_modifier(source, tokens, start, name, "static")
        && return_type == ReturnType::Void
        && is_main_signature(source, tokens, parameters, parameter_close)
    {
        keep_body = true;
    }
    Some(MethodHeader {
        name: tokens[name],
        is_private: has_modifier(source, tokens, start, name, "private"),
        is_constructor,
        keep_body,
        has_method_source: annotations.contains(&"MethodSource"),
        return_type,
    })
}

pub(super) fn method_stub(header: MethodHeader) -> String {
    if header.is_constructor {
        return String::new();
    }
    match header.return_type {
        ReturnType::Void => String::new(),
        ReturnType::Boolean => "return false;".to_string(),
        ReturnType::Char => "return '\\0';".to_string(),
        ReturnType::Number => "return -1;".to_string(),
        ReturnType::Reference => "return null;".to_string(),
    }
}

fn method_return_type(
    source: &str,
    tokens: &[Token],
    start: usize,
    name: usize,
    parameter_close: usize,
    header_end: usize,
) -> ReturnType {
    if tokens[start..name]
        .iter()
        .chain(tokens[parameter_close + 1..header_end].iter())
        .any(|token| token_is(source, *token, "[") || token_is(source, *token, "..."))
    {
        return ReturnType::Reference;
    }
    let Some(type_token) = tokens[start..name]
        .iter()
        .rev()
        .find(|token| is_identifier(source, **token))
    else {
        return ReturnType::Reference;
    };
    match token_text(source, *type_token) {
        "void" => ReturnType::Void,
        "boolean" => ReturnType::Boolean,
        "char" => ReturnType::Char,
        "byte" | "short" | "int" | "long" | "float" | "double" => ReturnType::Number,
        _ => ReturnType::Reference,
    }
}

fn is_main_signature(source: &str, tokens: &[Token], open: usize, close: usize) -> bool {
    let parameters = &tokens[open + 1..close];
    let has_string_type = parameters
        .iter()
        .any(|token| token_is(source, *token, "String"));
    let has_array_type = parameters
        .windows(2)
        .any(|pair| token_is(source, pair[0], "[") && token_is(source, pair[1], "]"))
        || parameters
            .iter()
            .any(|token| token_is(source, *token, "..."));
    let single_parameter = !parameters.iter().any(|token| token_is(source, *token, ","));
    has_string_type && has_array_type && single_parameter
}

fn is_annotation_invocation(source: &str, tokens: &[Token], start: usize, name: usize) -> bool {
    let mut index = name;
    while index >= start + 2
        && token_is(source, tokens[index - 1], ".")
        && is_identifier(source, tokens[index - 2])
    {
        index -= 2;
    }
    index > start && token_is(source, tokens[index - 1], "@")
}

fn has_modifier(source: &str, tokens: &[Token], start: usize, end: usize, modifier: &str) -> bool {
    tokens[start..end]
        .iter()
        .any(|token| token_is(source, *token, modifier))
}

fn is_modifier(source: &str, token: Token) -> bool {
    matches!(
        token_text(source, token),
        "public"
            | "protected"
            | "private"
            | "abstract"
            | "static"
            | "final"
            | "synchronized"
            | "native"
            | "strictfp"
            | "default"
    )
}

fn skip_annotation<'a>(
    source: &'a str,
    tokens: &[Token],
    start: usize,
    limit: usize,
) -> (usize, Option<&'a str>) {
    let mut index = start + 1;
    let mut simple_name = None;
    if index < limit && is_identifier(source, tokens[index]) {
        simple_name = Some(token_text(source, tokens[index]));
        index += 1;
        while index + 1 < limit
            && token_is(source, tokens[index], ".")
            && is_identifier(source, tokens[index + 1])
        {
            simple_name = Some(token_text(source, tokens[index + 1]));
            index += 2;
        }
    }
    if index < limit && token_is(source, tokens[index], "(") {
        if let Some(close) = matching_pair(source, tokens, index, limit, "(", ")") {
            index = close + 1;
        }
    }
    (index.max(start + 1), simple_name)
}

fn nested_type_header(
    source: &str,
    tokens: &[Token],
    start: usize,
    open: usize,
) -> Option<(Token, bool)> {
    for index in start..open {
        if !is_type_keyword(source, tokens, index) {
            continue;
        }
        let name = tokens.get(index + 1)?;
        if !is_identifier(source, *name) {
            continue;
        }
        return Some((*name, token_is(source, tokens[index], "enum")));
    }
    None
}

pub(super) fn enum_separator(
    source: &str,
    tokens: &[Token],
    start: usize,
    limit: usize,
) -> Option<usize> {
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut index = start;
    while index < limit {
        let token = tokens[index];
        if token_is(source, token, "(") {
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        } else if token_is(source, token, "{") && parentheses == 0 && brackets == 0 {
            index = matching_brace(source, tokens, index, limit)? + 1;
            continue;
        } else if token_is(source, token, ";") && parentheses == 0 && brackets == 0 {
            return Some(index);
        }
        index += 1;
    }
    None
}

pub(super) fn type_body(
    source: &str,
    tokens: &[Token],
    type_index: usize,
) -> Option<(usize, usize)> {
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    for index in type_index + 1..tokens.len() {
        let token = tokens[index];
        if token_is(source, token, "(") {
            parentheses += 1;
        } else if token_is(source, token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, token, "[") {
            brackets += 1;
        } else if token_is(source, token, "]") {
            brackets = brackets.saturating_sub(1);
        } else if token_is(source, token, "{") && parentheses == 0 && brackets == 0 {
            let close = matching_brace(source, tokens, index, tokens.len())?;
            return Some((index, close));
        }
    }
    None
}

pub(super) fn is_type_keyword(source: &str, tokens: &[Token], index: usize) -> bool {
    let Some(token) = tokens.get(index).copied() else {
        return false;
    };
    if !matches!(
        token_text(source, token),
        "class" | "interface" | "enum" | "record"
    ) {
        return false;
    }
    tokens
        .get(index + 1)
        .is_some_and(|next| is_identifier(source, *next))
}

fn has_top_level_assignment(source: &str, tokens: &[Token], start: usize, end: usize) -> bool {
    top_level_contains(source, tokens, start, end, "=")
}

fn has_top_level_arrow(source: &str, tokens: &[Token], start: usize, end: usize) -> bool {
    top_level_contains(source, tokens, start, end, "->")
}

fn top_level_contains(
    source: &str,
    tokens: &[Token],
    start: usize,
    end: usize,
    sought: &str,
) -> bool {
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    for token in &tokens[start..end] {
        if parentheses == 0 && brackets == 0 && token_is(source, *token, sought) {
            return true;
        }
        if token_is(source, *token, "(") {
            parentheses += 1;
        } else if token_is(source, *token, ")") {
            parentheses = parentheses.saturating_sub(1);
        } else if token_is(source, *token, "[") {
            brackets += 1;
        } else if token_is(source, *token, "]") {
            brackets = brackets.saturating_sub(1);
        }
    }
    false
}
