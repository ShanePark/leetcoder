mod classpath;
mod fingerprint;
mod helpers;
mod inspection;
mod metadata;
mod process;
mod type_members;
mod types;

pub(crate) use metadata::inspect_ps_library;
pub(crate) use type_members::inspect_java_type_members;
pub(crate) use types::PsLibraryMetadata;
// Preserve existing metadata type paths.
#[allow(unused_imports)]
pub(crate) use types::{PsMethod, PsParameter};

#[cfg(test)]
mod tests;
