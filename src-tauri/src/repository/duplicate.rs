#[derive(Clone, Copy)]
struct Token {
    start: usize,
    end: usize,
}

struct Edit {
    start: usize,
    end: usize,
    replacement: String,
}

#[derive(Clone, Copy)]
struct MethodHeader {
    is_constructor: bool,
    keep_body: bool,
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

enum MemberKind {
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

struct Member {
    end: usize,
    kind: MemberKind,
}

fn find_member_end(
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

fn collect_harness_identifiers(
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
        is_constructor,
        keep_body,
        return_type,
    })
}

fn method_stub(header: MethodHeader) -> String {
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

fn enum_separator(source: &str, tokens: &[Token], start: usize, limit: usize) -> Option<usize> {
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

fn type_body(source: &str, tokens: &[Token], type_index: usize) -> Option<(usize, usize)> {
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

fn is_type_keyword(source: &str, tokens: &[Token], index: usize) -> bool {
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

fn matching_brace(source: &str, tokens: &[Token], open: usize, limit: usize) -> Option<usize> {
    matching_pair(source, tokens, open, limit, "{", "}")
}

fn matching_angle(source: &str, tokens: &[Token], open: usize, limit: usize) -> Option<usize> {
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

fn matching_pair(
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

fn tokenize(source: &str) -> Vec<Token> {
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

fn skip_quoted(source: &str, start: usize, delimiter: u8) -> usize {
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

fn remove_performance_comments(source: &str) -> String {
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

fn apply_edits(source: &str, mut edits: Vec<Edit>) -> String {
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

fn line_indent(source: &str, position: usize) -> String {
    let line_start = source[..position].rfind('\n').map_or(0, |index| index + 1);
    source[line_start..position]
        .chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect()
}

fn newline_before(source: &str) -> &'static str {
    if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn is_identifier(source: &str, token: Token) -> bool {
    let text = token_text(source, token);
    let mut characters = text.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_alphabetic())
        && characters
            .all(|character| character == '_' || character == '$' || character.is_alphanumeric())
}

fn token_is(source: &str, token: Token, value: &str) -> bool {
    token_text(source, token) == value
}

fn token_text(source: &str, token: Token) -> &str {
    &source[token.start..token.end]
}

#[cfg(test)]
mod tests {
    use super::reset_java_implementation;

    #[test]
    fn preserves_tests_and_nested_signatures_while_resetting_implementations() {
        let source = r#"package sample;
import org.junit.jupiter.api.Test;
/** Runtime 15 ms Beats 72.46%
 * Memory 43.1 MB Beats 85.67%
 */
class Q1 {
    int[] field = new int[][]{{1}};

    @Test
    void test() {
        String content = """
                first


                second
                """;
        assertEquals(1, solve(content));
    }

    public int solve(String input) { return 1; }
    private void helper() { System.out.println("{not code}"); }

    class Nested {
        Nested(int value) { this.value = value; }
        private int value;
        public boolean check() { return true; }
        public String text() { return "ok"; }
    }
}
"#;
        let result = reset_java_implementation(source);
        assert!(result.contains("first\n\n\n                second"));
        assert!(result.contains("import org.junit.jupiter.api.Test;"));
        assert!(result.contains("void test() {"));
        assert!(result.contains("public int solve(String input) {\n        return -1;\n    }"));
        assert!(result.contains("private void helper() {\n    }"));
        assert!(result.contains("Nested(int value) {\n        }"));
        assert!(result.contains("public boolean check() {\n            return false;\n        }"));
        assert!(result.contains("public String text() {\n            return null;\n        }"));
        assert!(!result.contains("int[] field"));
        assert!(!result.contains("Runtime"));
        assert!(!result.contains("Memory"));
    }

    #[test]
    fn keeps_main_interfaces_and_enum_constants() {
        let source = r#"interface Reader { int read(); }
enum State {
    READY(1), DONE(2);
    State(int value) {}
    int code() { return 1; }
}
class Q2 { public static void main(String[] args) { System.out.println("ok"); }
    private char marker() { return 'x'; }
    private long total() { return 3; }
}
"#;
        let result = reset_java_implementation(source);
        assert!(result.contains("int read();"));
        assert!(result.contains("READY(1), DONE(2);"));
        assert!(result.contains("State(int value) {\n    }"));
        assert!(result
            .contains("public static void main(String[] args) { System.out.println(\"ok\"); }"));
        assert!(result.contains("private char marker() {\n        return '\\0';\n    }"));
        assert!(result.contains("private long total() {\n        return -1;\n    }"));
    }

    #[test]
    fn keeps_test_used_fields_and_stubs_primitive_arrays_correctly() {
        let source = r#"import org.junit.jupiter.api.Test;
import java.util.ArrayList;
class Q3 {
    @Test void test() {
        Node node = new Node();
        node.children = new ArrayList<>();
        assertThat(read()).isEqualTo("Runtime 5 ms");
    }
    String read() { return "Runtime 5 ms"; }
    int[] values() { return new int[]{1}; }
    int count() { return 5; }
}
class Node {
    public int val;
    public List<Node> children;
    public int unused;
}
"#;
        let source = format!("/** Runtime: 5 ms */\n{source}");
        let result = reset_java_implementation(&source);
        assert!(result.contains("Node node = new Node();"));
        assert!(result.contains("node.children = new ArrayList<>();"));
        assert!(result.contains("@Test void test() {"));
        assert!(result.contains("String read() {\n        return null;\n    }"));
        assert!(result.contains("int[] values() {\n        return null;\n    }"));
        assert!(result.contains("int count() {\n        return -1;\n    }"));
        assert!(result.contains("public List<Node> children;"));
        assert!(!result.contains("public int val;"));
        assert!(!result.contains("public int unused;"));
        assert!(!result.contains("Runtime: 5 ms"));
        assert!(result.contains("Runtime 5 ms"));
    }

    #[test]
    fn removes_metric_comments_without_touching_literal_text() {
        let source = r#"class Q4 {
    String value() { return "Runtime 5 ms"; }
    // Memory Usage 2 MB
    int run() { return 4; }
}
"#;
        let result = reset_java_implementation(source);
        assert!(result.contains("String value() {\n        return null;\n    }"));
        assert!(!result.contains("Memory Usage"));
        assert!(result.contains("int run() {\n        return -1;\n    }"));
    }

    #[test]
    fn removes_inline_metric_comments_without_joining_signature_tokens() {
        let source = "class Q4 { int /* Runtime 1 ms */ solve() { return 4; } }";
        let result = reset_java_implementation(source);
        assert!(result.contains("int   solve() {\n    return -1;\n}"));
        assert!(!result.contains("Runtime 1 ms"));
    }

    #[test]
    fn preserves_qualified_lifecycle_methods_and_their_fixture_fields() {
        let source = r#"class Q4 {
    int fixture;
    int implementationState = 3;

    @org.junit.jupiter.api.BeforeEach
    void setup() { fixture = 1; }

    @org.junit.jupiter.api.AfterAll
    static void teardown() { System.clearProperty("fixture"); }

    @org.junit.BeforeClass
    static void classSetup() { System.setProperty("fixture", "ready"); }

    int solve() { return implementationState; }
}
"#;
        let result = reset_java_implementation(source);
        assert!(
            result.contains("@org.junit.jupiter.api.BeforeEach\n    void setup() { fixture = 1; }")
        );
        assert!(result.contains(
            "@org.junit.jupiter.api.AfterAll\n    static void teardown() { System.clearProperty(\"fixture\"); }"
        ));
        assert!(result.contains(
            "@org.junit.BeforeClass\n    static void classSetup() { System.setProperty(\"fixture\", \"ready\"); }"
        ));
        assert!(result.contains("int fixture;"));
        assert!(!result.contains("implementationState"));
        assert!(result.contains("int solve() {\n        return -1;\n    }"));
    }

    #[test]
    fn methods_named_like_the_class_are_not_treated_as_constructors() {
        let source = "class Same { int Same() { return 2; } }";
        let result = reset_java_implementation(source);
        assert!(result.contains("int Same() {\n    return -1;\n}"));
    }

    #[test]
    fn ignores_method_calls_and_array_length_when_preserving_test_fields() {
        let source = r#"import org.junit.jupiter.api.Test;
class Q5 {
    @Test void test() {
        Stack stack = new Stack();
        stack.increment(1, 1);
        int[] arr = new int[0];
        Holder holder = new Holder();
        holder.arr = arr;
        assertEquals(0, arr.length);
    }
}
class Stack { final int[] increment = new int[1]; }
class SortedArray { final int length; }
class Holder { int[] arr; }
"#;
        let result = reset_java_implementation(source);
        assert!(!result.contains("final int[] increment"));
        assert!(!result.contains("final int length"));
        assert!(result.contains("stack.increment(1, 1);"));
        assert!(result.contains("holder.arr = arr;"));
        assert!(result.contains("int[] arr;"));
        assert!(result.contains("assertEquals(0, arr.length);"));
    }

    #[test]
    fn removes_failed_result_comments_and_keeps_main_harness() {
        let source = r#"/** Wrong Answer
 * Input
 * "01"
 * Expected
 * "1"
 */
class Q6 {
    public static void main(String[] args) { System.out.println("try again"); }
    int solve() { return 1; }
}
"#;
        let result = reset_java_implementation(source);
        assert!(!result.contains("Wrong Answer"));
        assert!(!result.contains("Expected"));
        assert!(result.contains(
            "public static void main(String[] args) { System.out.println(\"try again\"); }"
        ));
        assert!(result.contains("int solve() {\n        return -1;\n    }"));
    }
}
