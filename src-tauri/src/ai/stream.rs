use serde_json::Value;
use std::mem;

use super::claude::{error_identifier, ApiError, MessageUsage};

/// One server-sent event. `name` is the `event:` field, if any.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct SseEvent {
    pub name: Option<String>,
    pub data: String,
}

/// Splits a server-sent event stream into events, however its chunks are cut.
/// A line ends at `\n`, which never occurs inside a multi-byte UTF-8 sequence,
/// so only finished lines are decoded.
#[derive(Debug, Default)]
pub(super) struct SseParser {
    line: Vec<u8>,
    name: Option<String>,
    data: Option<String>,
}

impl SseParser {
    pub(super) fn push(
        &mut self,
        bytes: &[u8],
        events: &mut Vec<SseEvent>,
    ) -> Result<(), ApiError> {
        let mut rest = bytes;
        while let Some(end) = rest.iter().position(|byte| *byte == b'\n') {
            self.line.extend_from_slice(&rest[..end]);
            let line = mem::take(&mut self.line);
            self.finish_line(line, events)?;
            rest = &rest[end + 1..];
        }
        self.line.extend_from_slice(rest);
        Ok(())
    }

    fn finish_line(
        &mut self,
        mut line: Vec<u8>,
        events: &mut Vec<SseEvent>,
    ) -> Result<(), ApiError> {
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let line = String::from_utf8(line).map_err(|_| ApiError::Malformed)?;
        if line.is_empty() {
            let name = self.name.take();
            if let Some(data) = self.data.take() {
                events.push(SseEvent { name, data });
            }
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line.as_str(), ""),
        };
        match field {
            "event" => self.name = Some(value.to_string()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            _ => {}
        }
        Ok(())
    }
}

/// What a stream reports as it arrives.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum StreamUpdate<'a> {
    Text(&'a str),
    /// The model is thinking. Carries the characters this piece added: zero
    /// when a thinking block starts, and zero throughout when the API omits
    /// the thinking text.
    Thinking(usize),
    /// A tool call began; its input follows in pieces. Carries the tool's name.
    ToolUseStarted(&'a str),
    /// The counts so far: once from `message_start`, then the final counts
    /// from `message_delta`, when `last` is set.
    Usage {
        usage: &'a MessageUsage,
        last: bool,
    },
}

/// A tool call in a streamed message. Its input arrives as JSON fragments and
/// is parsed, strictly, once the block stops.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ToolUse {
    index: Option<u64>,
    pub name: String,
    /// The input the block started with, used when no fragment follows.
    initial_input: Value,
    json: String,
    /// The block stopped.
    pub stopped: bool,
    /// Present once the block stopped with input that parses.
    pub input: Option<Value>,
}

/// What a streamed message has said so far.
#[derive(Debug, Default)]
pub(super) struct MessageStream {
    pub model: Option<String>,
    pub usage: MessageUsage,
    pub stop_reason: Option<String>,
    pub stop_category: Option<String>,
    pub text: String,
    /// The first tool call. A request allows at most one, so any other is ignored.
    pub tool_use: Option<ToolUse>,
    /// `message_stop` arrived, so nothing else follows.
    pub stopped: bool,
}

impl MessageStream {
    /// Text, thinking, the start of a tool call, and usage reach `on_update` as
    /// they arrive. Pings and unknown events are skipped.
    pub(super) fn apply(
        &mut self,
        event: &SseEvent,
        on_update: &dyn Fn(StreamUpdate<'_>),
    ) -> Result<(), ApiError> {
        let data: Value = serde_json::from_str(&event.data).map_err(|_| ApiError::Malformed)?;
        let kind = data
            .get("type")
            .and_then(Value::as_str)
            .or(event.name.as_deref())
            .unwrap_or_default();
        match kind {
            "message_start" => {
                let message = data.get("message");
                if let Some(model) = message
                    .and_then(|message| message.get("model"))
                    .and_then(Value::as_str)
                    .filter(|model| !model.is_empty())
                {
                    self.model = Some(model.to_string());
                }
                merge_usage(
                    &mut self.usage,
                    message.and_then(|message| message.get("usage")),
                );
                on_update(StreamUpdate::Usage {
                    usage: &self.usage,
                    last: false,
                });
            }
            "content_block_start" => {
                let block = data.get("content_block");
                let block_type = block
                    .and_then(|block| block.get("type"))
                    .and_then(Value::as_str);
                if matches!(block_type, Some("thinking" | "redacted_thinking")) {
                    let text = block
                        .and_then(|block| block.get("thinking"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    on_update(StreamUpdate::Thinking(text.chars().count()));
                }
                if block_type == Some("tool_use") && self.tool_use.is_none() {
                    let block = block.unwrap_or(&Value::Null);
                    let tool_use = ToolUse {
                        index: data.get("index").and_then(Value::as_u64),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        initial_input: block.get("input").cloned().unwrap_or(Value::Null),
                        json: String::new(),
                        stopped: false,
                        input: None,
                    };
                    on_update(StreamUpdate::ToolUseStarted(&tool_use.name));
                    self.tool_use = Some(tool_use);
                }
            }
            "content_block_delta" => {
                let delta = data.get("delta");
                match delta
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("text_delta") => {
                        let text = delta
                            .and_then(|delta| delta.get("text"))
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty());
                        if let Some(text) = text {
                            self.text.push_str(text);
                            on_update(StreamUpdate::Text(text));
                        }
                    }
                    Some("thinking_delta") => {
                        let text = delta
                            .and_then(|delta| delta.get("thinking"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        on_update(StreamUpdate::Thinking(text.chars().count()));
                    }
                    Some("input_json_delta") => {
                        let fragment = delta
                            .and_then(|delta| delta.get("partial_json"))
                            .and_then(Value::as_str);
                        if let (Some(tool_use), Some(fragment)) =
                            (self.open_tool_use(&data), fragment)
                        {
                            tool_use.json.push_str(fragment);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(tool_use) = self.open_tool_use(&data) {
                    tool_use.stopped = true;
                    // Fragments are not validated by the API, so a bad one leaves no input.
                    tool_use.input = if tool_use.json.trim().is_empty() {
                        Some(tool_use.initial_input.clone()).filter(Value::is_object)
                    } else {
                        serde_json::from_str(&tool_use.json).ok()
                    };
                }
            }
            "message_delta" => {
                let delta = data.get("delta");
                if let Some(stop_reason) = delta
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    self.stop_reason = Some(stop_reason.to_string());
                }
                if let Some(category) = delta
                    .and_then(|delta| delta.pointer("/stop_details/category"))
                    .and_then(Value::as_str)
                {
                    self.stop_category = Some(category.to_string());
                }
                if data.get("usage").is_some() {
                    merge_usage(&mut self.usage, data.get("usage"));
                    on_update(StreamUpdate::Usage {
                        usage: &self.usage,
                        last: true,
                    });
                }
            }
            "message_stop" => self.stopped = true,
            "error" => {
                return Err(ApiError::StreamFailed {
                    error_type: data
                        .pointer("/error/type")
                        .and_then(Value::as_str)
                        .and_then(error_identifier),
                })
            }
            _ => {}
        }
        Ok(())
    }

    /// The tool call an event's `index` names, while its block is still open.
    fn open_tool_use(&mut self, data: &Value) -> Option<&mut ToolUse> {
        let index = data.get("index").and_then(Value::as_u64);
        self.tool_use
            .as_mut()
            .filter(|tool_use| !tool_use.stopped && tool_use.index == index)
    }
}

/// `message_delta` counts are cumulative, so a field it carries replaces the one
/// from `message_start` and a field it leaves out keeps it.
fn merge_usage(usage: &mut MessageUsage, update: Option<&Value>) {
    let Some(update) = update else {
        return;
    };
    let count = |field: &str, current: &mut u64| {
        if let Some(value) = update.get(field).and_then(Value::as_u64) {
            *current = value;
        }
    };
    count("input_tokens", &mut usage.input_tokens);
    count("output_tokens", &mut usage.output_tokens);
    count("cache_read_input_tokens", &mut usage.cache_read_tokens);
    count("cache_creation_input_tokens", &mut usage.cache_write_tokens);
    let text = |field: &str, current: &mut Option<String>| {
        if let Some(value) = update.get(field).and_then(Value::as_str) {
            *current = Some(value.to_string());
        }
    };
    text("inference_geo", &mut usage.inference_geo);
    text("speed", &mut usage.speed);
    text("service_tier", &mut usage.service_tier);
}
