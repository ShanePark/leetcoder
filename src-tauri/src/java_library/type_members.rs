use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::models::{JavaTypeMembers, JavaTypeMembersMetadata};

use super::classpath::resolve_project_classpath;
use super::fingerprint::{
    java_environment_fingerprint, java_identity, metadata_fingerprint, project_config_fingerprint,
};
use super::inspection::inspect_type_members_on_classpath;

pub(super) const MAX_REQUESTED_TYPES: usize = 16;
pub(super) const MAX_TYPE_NAME_BYTES: usize = 256;
const MAX_CACHED_TYPE_MEMBERS: usize = 512;
pub(super) const PROJECT_CLASSPATH_REVALIDATION: Duration = Duration::from_secs(30);
pub(super) const CLASSPATH_FAILURE_RETRY: Duration = Duration::from_secs(10);

static TYPE_MEMBERS_CACHE: OnceLock<Mutex<TypeMembersCache>> = OnceLock::new();

#[derive(Default)]
struct TypeMembersCache {
    java_environment_fingerprint: String,
    metadata_java: Option<(String, crate::runner::JavaInstallation)>,
    jdk_members: HashMap<(String, String), JavaTypeMembers>,
    jdk_unavailable: HashSet<(String, String)>,
    project_classpath: Option<CachedProjectClasspath>,
    project_members: HashMap<(String, String, String, String), JavaTypeMembers>,
}

#[derive(Clone)]
pub(super) struct CachedProjectClasspath {
    pub(super) root: PathBuf,
    pub(super) java_identity: String,
    pub(super) config_fingerprint: String,
    pub(super) checked_at: Instant,
    pub(super) result: Result<(Vec<PathBuf>, String), String>,
}

/// Inspect public methods and fields for a bounded set of Java types.
/// JDK types are resolved without invoking Gradle; project types use the
/// selected repository's main compile classpath when it can be resolved.
pub(crate) fn inspect_java_type_members(
    repo_path: String,
    type_names: Vec<String>,
) -> Result<JavaTypeMembersMetadata, String> {
    let type_names = validate_type_names(type_names)?;
    let root = fs::canonicalize(&repo_path).map_err(|error| {
        format!(
            "Unable to resolve Java project root '{}': {error}",
            repo_path
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Java project root is not a directory: {}",
            root.display()
        ));
    }
    let config_fingerprint = project_config_fingerprint(&root)?;
    let environment_fingerprint = java_environment_fingerprint();
    let cache = TYPE_MEMBERS_CACHE.get_or_init(|| Mutex::new(TypeMembersCache::default()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if cache.java_environment_fingerprint != environment_fingerprint {
        cache.java_environment_fingerprint = environment_fingerprint;
        cache.metadata_java = None;
        cache.jdk_members.clear();
        cache.jdk_unavailable.clear();
        cache.project_classpath = None;
        cache.project_members.clear();
    }

    let (java_identity, metadata_java) = match cache.metadata_java.clone() {
        Some((identity, java)) => (identity, java),
        None => {
            let java = crate::runner::discover_metadata_java()?;
            let identity = java_identity(&java);
            cache.metadata_java = Some((identity.clone(), java.clone()));
            (identity, java)
        }
    };

    if let Some(project_classpath) = cache.project_classpath.as_ref() {
        if project_classpath.root != root
            || project_classpath.java_identity != java_identity
            || project_classpath.config_fingerprint != config_fingerprint
        {
            cache.project_classpath = None;
            cache.project_members.clear();
        }
    }

    let jdk_missing = type_names
        .iter()
        .filter(|type_name| {
            !cache
                .jdk_members
                .contains_key(&(java_identity.clone(), (*type_name).clone()))
                && !cache
                    .jdk_unavailable
                    .contains(&(java_identity.clone(), (*type_name).clone()))
        })
        .cloned()
        .collect::<Vec<_>>();
    if !jdk_missing.is_empty() {
        let inspected = inspect_type_members_on_classpath(&metadata_java.home, &[], &jdk_missing)?;
        for member in inspected {
            let key = (java_identity.clone(), member.type_name.clone());
            if member.available {
                cache.jdk_members.insert(key, member);
            } else {
                cache.jdk_unavailable.insert(key);
            }
        }
        let protected = type_names
            .iter()
            .map(|type_name| (java_identity.clone(), type_name.clone()))
            .collect::<HashSet<_>>();
        bound_type_member_cache(&mut cache, &protected, &HashSet::new());
    }

    let project_requested = type_names
        .iter()
        .filter(|type_name| {
            !cache
                .jdk_members
                .contains_key(&(java_identity.clone(), (*type_name).clone()))
        })
        .cloned()
        .collect::<Vec<_>>();

    if !project_requested.is_empty() {
        let cached_classpath = cache.project_classpath.clone();
        let cached_fingerprint = cached_classpath.as_ref().and_then(|state| {
            state
                .result
                .as_ref()
                .ok()
                .map(|(_, fingerprint)| fingerprint.clone())
        });
        let now = Instant::now();
        let should_resolve = cached_classpath
            .as_ref()
            .is_none_or(|state| project_classpath_needs_refresh(state, now));
        if should_resolve {
            let result = resolve_project_classpath(&root);
            if result.as_ref().is_ok_and(|(_, fingerprint)| {
                cached_fingerprint
                    .as_ref()
                    .is_some_and(|cached| cached != fingerprint)
            }) {
                cache.project_members.clear();
            }
            cache.project_classpath = Some(CachedProjectClasspath {
                root: root.clone(),
                java_identity: java_identity.clone(),
                config_fingerprint: config_fingerprint.clone(),
                checked_at: now,
                result,
            });
        }

        if let Some(Ok((classpath, fingerprint))) = cache
            .project_classpath
            .as_ref()
            .map(|state| state.result.clone())
        {
            let root_key = root.to_string_lossy().into_owned();
            let types_to_inspect = project_requested
                .iter()
                .filter(|type_name| {
                    !cache.project_members.contains_key(&(
                        root_key.clone(),
                        java_identity.clone(),
                        fingerprint.clone(),
                        (*type_name).clone(),
                    ))
                })
                .cloned()
                .collect::<Vec<_>>();
            if !types_to_inspect.is_empty() {
                if let Ok(inspected) = inspect_type_members_on_classpath(
                    &metadata_java.home,
                    &classpath,
                    &types_to_inspect,
                ) {
                    for member in inspected {
                        cache.project_members.insert(
                            (
                                root_key.clone(),
                                java_identity.clone(),
                                fingerprint.clone(),
                                member.type_name.clone(),
                            ),
                            member,
                        );
                    }
                    let protected = project_requested
                        .iter()
                        .map(|type_name| {
                            (
                                root_key.clone(),
                                java_identity.clone(),
                                fingerprint.clone(),
                                type_name.clone(),
                            )
                        })
                        .collect::<HashSet<_>>();
                    bound_type_member_cache(&mut cache, &HashSet::new(), &protected);
                }
            }
        }
    }

    let root_key = root.to_string_lossy().into_owned();
    let types = type_names
        .into_iter()
        .map(|type_name| {
            cache
                .jdk_members
                .get(&(java_identity.clone(), type_name.clone()))
                .cloned()
                .or_else(|| {
                    let fingerprint = cache
                        .project_classpath
                        .as_ref()
                        .and_then(|state| state.result.as_ref().ok())
                        .map(|(_, fingerprint)| fingerprint)?;
                    cache
                        .project_members
                        .get(&(
                            root_key.clone(),
                            java_identity.clone(),
                            fingerprint.clone(),
                            type_name.clone(),
                        ))
                        .cloned()
                })
                .unwrap_or_else(|| unavailable_type(type_name))
        })
        .collect();

    let project_classpath_fingerprint = cache.project_classpath.as_ref().map(|state| {
        state
            .result
            .as_ref()
            .map(|(_, fingerprint)| fingerprint.as_str())
            .unwrap_or("unavailable")
    });

    Ok(JavaTypeMembersMetadata {
        fingerprint: metadata_fingerprint(
            &root,
            &config_fingerprint,
            &java_identity,
            project_classpath_fingerprint,
        ),
        types,
    })
}

pub(super) fn validate_type_names(type_names: Vec<String>) -> Result<Vec<String>, String> {
    if type_names.len() > MAX_REQUESTED_TYPES {
        return Err(format!(
            "At most {MAX_REQUESTED_TYPES} Java types can be inspected at once."
        ));
    }
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(type_names.len());
    for type_name in type_names {
        if type_name.len() > MAX_TYPE_NAME_BYTES || !is_valid_binary_type_name(&type_name) {
            return Err(format!("Invalid Java type name: {type_name}"));
        }
        if seen.insert(type_name.clone()) {
            unique.push(type_name);
        }
    }
    Ok(unique)
}

fn is_valid_binary_type_name(type_name: &str) -> bool {
    if type_name.is_empty()
        || matches!(
            type_name,
            "boolean" | "byte" | "char" | "short" | "int" | "long" | "float" | "double" | "void"
        )
    {
        return false;
    }
    let mut at_segment_start = true;
    for character in type_name.chars() {
        if character == '.' {
            if at_segment_start {
                return false;
            }
            at_segment_start = true;
        } else if at_segment_start {
            if !(character == '$' || character == '_' || character.is_alphabetic()) {
                return false;
            }
            at_segment_start = false;
        } else if !(character == '$' || character == '_' || character.is_alphanumeric()) {
            return false;
        }
    }
    !at_segment_start
}

fn unavailable_type(type_name: String) -> JavaTypeMembers {
    JavaTypeMembers {
        type_name,
        available: false,
        methods: Vec::new(),
        fields: Vec::new(),
    }
}

fn bound_type_member_cache(
    cache: &mut TypeMembersCache,
    protected_jdk: &HashSet<(String, String)>,
    protected_project: &HashSet<(String, String, String, String)>,
) {
    while cache.jdk_members.len() > MAX_CACHED_TYPE_MEMBERS {
        let Some(key) = cache
            .jdk_members
            .keys()
            .find(|key| !protected_jdk.contains(*key))
            .cloned()
        else {
            break;
        };
        cache.jdk_members.remove(&key);
    }
    while cache.jdk_unavailable.len() > MAX_CACHED_TYPE_MEMBERS {
        let Some(key) = cache
            .jdk_unavailable
            .iter()
            .find(|key| !protected_jdk.contains(*key))
            .cloned()
        else {
            break;
        };
        cache.jdk_unavailable.remove(&key);
    }
    while cache.project_members.len() > MAX_CACHED_TYPE_MEMBERS {
        let Some(key) = cache
            .project_members
            .keys()
            .find(|key| !protected_project.contains(*key))
            .cloned()
        else {
            break;
        };
        cache.project_members.remove(&key);
    }
}

pub(super) fn project_classpath_needs_refresh(
    state: &CachedProjectClasspath,
    now: Instant,
) -> bool {
    let ttl = if state.result.is_ok() {
        PROJECT_CLASSPATH_REVALIDATION
    } else {
        CLASSPATH_FAILURE_RETRY
    };
    now.duration_since(state.checked_at) >= ttl
}
