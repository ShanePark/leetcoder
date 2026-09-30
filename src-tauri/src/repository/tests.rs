use std::fs;

use crate::security::{PACKAGE_SEGMENTS, SOURCE_ROOT};

use super::validation::REQUIRED_FILES;

mod benchmark;
mod duplicate_file;
mod files;
mod rename;

fn fixture() -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("tempdir");
    for segment in PACKAGE_SEGMENTS {
        fs::create_dir_all(directory.path().join(SOURCE_ROOT).join(segment))
            .expect("package directory");
    }
    for file in REQUIRED_FILES {
        std::fs::File::create(directory.path().join(file)).expect("required file");
    }
    directory
}
