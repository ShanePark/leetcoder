use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsLibraryMetadata {
    pub(crate) fingerprint: String,
    pub(crate) methods: Vec<PsMethod>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsMethod {
    pub(crate) name: String,
    pub(crate) return_type: String,
    pub(crate) parameters: Vec<PsParameter>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsParameter {
    pub(crate) name: Option<String>,
    pub(crate) type_name: String,
}
