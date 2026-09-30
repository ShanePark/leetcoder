use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::models::JavaTypeMembers;

use super::helpers::{JAVA_HELPER, JAVA_TYPE_MEMBERS_HELPER};
use super::process::{
    create_private_temp_dir, format_process_failure, java_executable_name, run_bounded,
    write_private_file,
};
use super::types::PsMethod;

pub(super) const JAVA_HELPER_NAME: &str = "LeetcoderPsMetadata.java";
pub(super) const JAVA_TYPE_MEMBERS_HELPER_NAME: &str = "LeetcoderJavaTypeMembers.java";
pub(super) const JAVA_HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HelperResult {
    methods: Vec<PsMethod>,
}

#[derive(Deserialize)]
struct TypeMembersHelperResult {
    types: Vec<JavaTypeMembers>,
}

pub(super) fn inspect_classpath(
    java_home: &Path,
    classpath: &[PathBuf],
) -> Result<Vec<PsMethod>, String> {
    let temp = create_private_temp_dir("leetcoder-ps-inspect")?;
    let source = temp.path().join(JAVA_HELPER_NAME);
    write_private_file(&source, JAVA_HELPER.as_bytes(), "Java metadata helper")?;
    let java = java_home.join("bin").join(java_executable_name());
    if !java.is_file() {
        return Err(format!(
            "The selected JDK Java executable was not found: {}",
            java.display()
        ));
    }
    let classpath = std::env::join_paths(classpath).map_err(|error| {
        format!("Unable to construct the Java classpath for Ps inspection: {error}")
    })?;

    let mut command = Command::new(&java);
    command
        .arg("--class-path")
        .arg(classpath)
        .arg(&source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(&mut command, JAVA_HELPER_TIMEOUT, "Ps metadata inspection")?;
    if !output.success {
        return Err(format_process_failure(
            "Unable to inspect public Ps methods",
            &output,
        ));
    }
    let result: HelperResult = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "The Java metadata helper returned invalid Ps metadata: {error}. Output: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })?;
    Ok(result.methods)
}

pub(super) fn inspect_type_members_on_classpath(
    java_home: &Path,
    classpath: &[PathBuf],
    type_names: &[String],
) -> Result<Vec<JavaTypeMembers>, String> {
    let temp = create_private_temp_dir("leetcoder-java-type-members")?;
    let source = temp.path().join(JAVA_TYPE_MEMBERS_HELPER_NAME);
    write_private_file(
        &source,
        JAVA_TYPE_MEMBERS_HELPER.as_bytes(),
        "Java type metadata helper",
    )?;
    let java = java_home.join("bin").join(java_executable_name());
    if !java.is_file() {
        return Err(format!(
            "The selected JDK Java executable was not found: {}",
            java.display()
        ));
    }
    let classpath = std::env::join_paths(classpath).map_err(|error| {
        format!("Unable to construct the Java classpath for type inspection: {error}")
    })?;

    let mut command = Command::new(java);
    command
        .arg("--class-path")
        .arg(classpath)
        .arg(source)
        .args(type_names)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(
        &mut command,
        JAVA_HELPER_TIMEOUT,
        "Java type member inspection",
    )?;
    if !output.success {
        return Err(format_process_failure(
            "Unable to inspect public Java type members",
            &output,
        ));
    }
    let result: TypeMembersHelperResult =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            format!(
                "The Java type metadata helper returned invalid metadata: {error}. Output: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })?;
    if result.types.len() != type_names.len()
        || result
            .types
            .iter()
            .zip(type_names)
            .any(|(member, requested)| member.type_name != *requested)
    {
        return Err("The Java type metadata helper returned an unexpected type list.".to_string());
    }
    Ok(result.types)
}
