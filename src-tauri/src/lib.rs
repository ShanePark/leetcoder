#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod leetcode;
mod models;
mod repository;
mod runner;
mod security;

use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

/// Starts the desktop application.
///
/// Feature modules and Tauri commands can be registered on this builder as
/// the editor grows, keeping the application entry point intentionally small.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::validate_project,
            commands::fetch_daily_problem,
            commands::list_problem_files,
            commands::read_problem_file,
            commands::create_problem_file,
            commands::save_problem_file,
            commands::run_problem_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running leetcoder");
}
