use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::parsing::truncate_chars;

const LOG_FILE: &str = "leetcode-requests.log";
const MAX_FIELD_CHARS: usize = 120;

pub(super) enum RequestOutcome {
    Ok,
    Failed(String),
    ParseError(String),
}

pub(super) struct RequestAttempt {
    /// `None` when no response arrived.
    pub(super) status: Option<u16>,
    /// The `cf-mitigated` response header, which names a bot challenge.
    pub(super) challenge: Option<String>,
    pub(super) elapsed_ms: u128,
    pub(super) outcome: RequestOutcome,
}

/// Appends one attempt to the log in `dir`. Without a directory nothing is logged,
/// and a failed write never reaches the lookup.
pub(super) fn record(dir: Option<&Path>, operation: &str, attempt: &RequestAttempt) {
    let Some(dir) = dir else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    if let Err(error) = append_line(dir, &format_line(now, operation, attempt)) {
        eprintln!("Could not write the LeetCode request log: {error}");
    }
}

fn append_line(dir: &Path, line: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(LOG_FILE))?;
    // A single write in append mode, so concurrent attempts cannot split a line.
    file.write_all(format!("{line}\n").as_bytes())
}

pub(super) fn format_line(unix_seconds: u64, operation: &str, attempt: &RequestAttempt) -> String {
    let status = match attempt.status {
        Some(status) => format!("http={status}"),
        None => "network-error".to_string(),
    };
    let (outcome, cause) = match &attempt.outcome {
        RequestOutcome::Ok => ("ok", ""),
        RequestOutcome::Failed(cause) => ("failed", cause.as_str()),
        RequestOutcome::ParseError(cause) => ("parse-error", cause.as_str()),
    };
    let mut line = format!(
        "{} {} {status} {outcome} {}ms",
        utc_timestamp(unix_seconds),
        one_line(operation),
        attempt.elapsed_ms
    );
    if let Some(challenge) = &attempt.challenge {
        line.push_str(" challenge=");
        line.push_str(&one_line(challenge));
    }
    let cause = one_line(cause);
    if !cause.is_empty() {
        line.push(' ');
        line.push_str(&cause);
    }
    line
}

/// Every field can hold text from the response, which must not break the
/// one-line format or make `grep` treat the file as binary.
fn one_line(value: &str) -> String {
    let collapsed = value
        .split(|character: char| character.is_whitespace() || character.is_control())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&collapsed, MAX_FIELD_CHARS)
}

pub(super) fn utc_timestamp(unix_seconds: u64) -> String {
    let (year, month, day) = civil_date(unix_seconds / 86_400);
    let second_of_day = unix_seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second_of_day / 3_600,
        second_of_day / 60 % 60,
        second_of_day % 60
    )
}

/// Converts days since 1970-01-01 to a Gregorian date. Years are counted from March
/// inside 400-year eras, which puts the leap day last.
fn civil_date(days_since_epoch: u64) -> (u64, u64, u64) {
    const DAYS_FROM_YEAR_ZERO_MARCH: u64 = 719_468;
    const DAYS_PER_ERA: u64 = 146_097;

    let days = days_since_epoch + DAYS_FROM_YEAR_ZERO_MARCH;
    let era = days / DAYS_PER_ERA;
    let day_of_era = days % DAYS_PER_ERA;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = era * 400 + year_of_era + u64::from(month <= 2);
    (year, month, day)
}
