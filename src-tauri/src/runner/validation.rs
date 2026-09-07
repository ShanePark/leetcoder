use std::path::PathBuf;

pub(crate) fn validate_fully_qualified_class_name(class_name: &str) -> Result<(), String> {
    let name = class_name.trim();
    if name.is_empty() {
        return Err("fullyQualifiedClassName must not be empty".to_string());
    }
    for segment in name.split('.') {
        if segment.is_empty() {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
        let mut characters = segment.chars();
        let first = characters.next().expect("non-empty segment");
        if !(first == '_' || first == '$' || first.is_ascii_alphabetic())
            || !characters.all(|character| {
                character == '_' || character == '$' || character.is_ascii_alphanumeric()
            })
        {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
    }
    Ok(())
}

pub(crate) fn java_source_relative_path(class_name: &str) -> PathBuf {
    let mut path = PathBuf::from("src/main/java");
    for segment in class_name.split('.') {
        path.push(segment);
    }
    path.set_extension("java");
    path
}

pub(crate) fn validate_test_method(test_method: Option<&str>) -> Result<(), String> {
    let Some(method) = test_method else {
        return Ok(());
    };
    if method.is_empty() {
        return Err("testMethod must not be empty".to_string());
    }
    if method.trim() != method || !is_java_identifier(method) {
        return Err(format!(
            "Invalid test method name: {method}. Use a Java identifier without dots, spaces, or wildcards."
        ));
    }
    Ok(())
}

pub(crate) fn is_java_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_ascii_alphabetic())
        && characters.all(|character| {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        })
}
