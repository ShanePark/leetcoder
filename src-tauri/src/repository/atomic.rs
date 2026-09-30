use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;

pub(super) fn write_source_noclobber(
    destination: &Path,
    parent: &Path,
    content: &str,
    permissions: &fs::Permissions,
) -> io::Result<()> {
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.as_file().set_permissions(permissions.clone())?;
    temporary.write_all(content.as_bytes())?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| error.error)
        .map(|_| ())
}

pub(super) fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}
