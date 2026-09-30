mod edits;
mod lexer;
mod references;
mod syntax;
mod transform;

#[cfg(test)]
mod tests;

pub(super) fn reset_java_implementation(source: &str) -> String {
    transform::reset_java_implementation(source)
}
