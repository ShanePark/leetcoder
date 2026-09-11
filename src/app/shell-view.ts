import { shortcutLabel } from '../shortcuts'

export interface ShellViewOptions {
  appVersion: string
  macPlatform: boolean
  minSidebarWidth: number
  maxSidebarWidth: number
  minDailyDescriptionHeight: number
  maxDailyDescriptionHeight: number
  minBottomPanelHeight: number
  maxBottomPanelHeight: number
  minGitFileListWidth: number
  maxGitFileListWidth: number
}

export function renderShellView(root: HTMLElement, options: ShellViewOptions): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-leading">
          <button id="app-menu-button" class="icon-button app-menu-button" type="button" aria-label="Open application menu" aria-haspopup="menu" aria-expanded="false" title="Application menu"></button>
          <span class="wordmark">leetcoder</span>
        </div>
        <div class="app-header-actions">
          <button id="update-button" class="icon-button update-button" type="button" aria-label="Update leetcoder" title="Update available — build and restart" hidden></button>
          <button id="choose-repository" class="repo-chip" type="button">
            <span id="repo-path" class="repo-chip-label">Choose repository</span>
          </button>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar" aria-label="Problem files">
          <div class="sidebar-heading">
            <span class="micro-label">Problems</span>
            <span id="file-count" class="sidebar-count"></span>
            <button id="refresh-files" class="icon-button" type="button" aria-label="Refresh problem files" title="Refresh"></button>
          </div>
          <div class="file-search">
            <label class="sr-only" for="file-search">Search problems</label>
            <div class="file-search-field">
              <span id="file-search-icon" aria-hidden="true"></span>
              <input id="file-search" type="search" placeholder="Search" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div id="file-list" class="file-list"></div>
        </aside>

        <div
          id="sidebar-splitter"
          class="sidebar-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize problem files pane"
          aria-valuemin="${options.minSidebarWidth}"
          aria-valuemax="${options.maxSidebarWidth}"
          tabindex="0"
        ><span aria-hidden="true"></span></div>

        <section class="editor-column" aria-label="Code editor">
          <section class="daily-card" aria-label="Today's problem">
            <div id="daily-header" class="daily-header"></div>
            <div id="daily-description" class="daily-description" hidden></div>
            <div
              id="daily-description-resize-handle"
              class="daily-description-resize-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize problem description"
              aria-valuemin="${options.minDailyDescriptionHeight}"
              aria-valuemax="${options.maxDailyDescriptionHeight}"
              tabindex="0"
              hidden
            ><span aria-hidden="true"></span></div>
          </section>

          <section class="code-card">
            <div class="file-tabs-shell">
              <nav id="file-tabs" class="file-tabs" role="tablist" aria-label="Open files"></nav>
            </div>
            <div class="code-toolbar">
              <div class="file-heading">
                <span id="selected-file" class="selected-file"></span>
                <span id="save-status" class="save-status" aria-live="polite"></span>
              </div>
            </div>
            <div class="editor-host" id="editor-host" aria-label="Java source editor">
              <div id="editor" class="editor"></div>
              <div id="editor-empty" class="editor-empty"></div>
            </div>
          </section>
        </section>
      </main>

      <section id="bottom-panel" class="bottom-panel" aria-label="Run results and Git">
        <div
          id="bottom-panel-resize-handle"
          class="bottom-panel-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize bottom panel"
          aria-valuemin="${options.minBottomPanelHeight}"
          aria-valuemax="${options.maxBottomPanelHeight}"
          tabindex="0"
        ><span aria-hidden="true"></span></div>
        <div class="bottom-panel-tabs">
          <div class="bottom-panel-tab-list" role="tablist" aria-label="Bottom panel">
            <button id="tests-tab" class="bottom-panel-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="tests-panel" tabindex="0">Tests</button>
            <button id="git-tab" class="bottom-panel-tab" type="button" role="tab" aria-selected="false" aria-controls="git-panel" tabindex="-1">Git</button>
          </div>
          <div class="bottom-panel-actions" role="group" aria-label="Test actions">
            <span class="selected-test-shortcut-hint">Selected test <kbd id="run-selected-shortcut">${shortcutLabel('run-test-at-cursor', options.macPlatform)}</kbd></span>
            <button id="run-test" class="primary-button" type="button">Run <kbd id="run-shortcut">${shortcutLabel('run-test', options.macPlatform)}</kbd></button>
          </div>
        </div>
        <section id="tests-panel" class="tests-panel" role="tabpanel" aria-labelledby="tests-tab" aria-busy="false">
          <div id="test-status-row" class="test-status-row"></div>
          <div id="test-body" class="test-body"></div>
        </section>
        <section id="git-panel" class="git-panel" role="tabpanel" aria-labelledby="git-tab" hidden>
          <div class="git-toolbar">
            <div class="git-heading">
              <span id="git-branch-icon" class="git-branch-icon" aria-hidden="true"></span>
              <span class="git-heading-label">Changes</span>
              <span id="git-file-count" class="git-count"></span>
              <span id="git-branch" class="git-branch-name"></span>
            </div>
            <div class="git-actions">
              <button id="git-select-all" class="text-button" type="button">Select all</button>
              <button id="git-select-none" class="text-button" type="button">Clear</button>
            </div>
          </div>
          <div id="git-status" class="git-status" role="status" aria-live="polite" hidden></div>
          <div class="git-workspace">
            <div id="git-file-list" class="git-file-list" aria-label="Changed files"></div>
            <div
              id="git-splitter"
              class="git-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize changed files pane"
              aria-valuemin="${options.minGitFileListWidth}"
              aria-valuemax="${options.maxGitFileListWidth}"
              tabindex="0"
            ><span aria-hidden="true"></span></div>
            <div class="git-diff-pane">
              <div class="git-diff-heading">
                <span id="git-diff-file" class="git-diff-file">Select a file</span>
                <span id="git-diff-state" class="git-diff-state"></span>
              </div>
              <div id="git-diff" class="git-diff" aria-label="Unified diff"></div>
            </div>
          </div>
          <div class="git-commit-bar">
            <label class="sr-only" for="git-commit-message">Commit message</label>
            <input id="git-commit-message" type="text" autocomplete="off" spellcheck="false">
            <button id="git-commit" class="secondary-button" type="button">Commit</button>
            <button id="git-commit-push" class="primary-button" type="button">Commit &amp; Push</button>
          </div>
        </section>
      </section>
      <div id="toast-stack" class="toast-stack" role="status" aria-live="polite"></div>
      <div id="app-menu" class="app-menu" role="menu" aria-label="Application menu" hidden>
        <button id="update-menu-action" class="app-menu-item app-menu-item-update" type="button" role="menuitem" hidden>
          <span id="update-menu-icon" class="app-menu-icon" aria-hidden="true"></span>
          <span class="app-menu-item-label">Update leetcoder</span>
          <span class="app-menu-item-detail">Build and restart</span>
        </button>
        <button id="settings-menu-action" class="app-menu-item" type="button" role="menuitem">
          <span id="settings-menu-icon" class="app-menu-icon" aria-hidden="true"></span>
          <span class="app-menu-item-label">Settings</span>
          <span id="settings-menu-shortcut" class="app-menu-item-detail" aria-hidden="true"></span>
        </button>
        <button id="about-menu-action" class="app-menu-item" type="button" role="menuitem">
          <span id="about-menu-icon" class="app-menu-icon" aria-hidden="true"></span>
          <span class="app-menu-item-label">About leetcoder</span>
        </button>
        <div class="app-menu-divider" role="separator"></div>
        <button id="exit-menu-action" class="app-menu-item app-menu-item-danger" type="button" role="menuitem">
          <span id="exit-menu-icon" class="app-menu-icon" aria-hidden="true"></span>
          <span class="app-menu-item-label">Exit</span>
        </button>
      </div>
      <div id="file-context-menu" class="file-context-menu" role="menu" aria-label="File actions" hidden>
        <button id="duplicate-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
          <span id="duplicate-file-label">Duplicate</span>
        </button>
        <button id="rename-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
          <span id="rename-file-label">Rename</span>
        </button>
        <button id="delete-file-action" class="file-context-menu-item" type="button" role="menuitem">
          <span id="delete-file-label">Delete</span>
        </button>
      </div>
      <div id="git-context-menu" class="file-context-menu git-context-menu" role="menu" aria-label="Git file actions" hidden>
        <button id="git-discard-action" class="file-context-menu-item" type="button" role="menuitem">
          Discard Changes
        </button>
        <button id="git-show-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
          Show in File Manager
        </button>
      </div>
      <div id="rename-file-dialog" class="dialog-backdrop" hidden>
        <form id="rename-file-form" class="rename-file-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-file-title">
          <h2 id="rename-file-title" class="rename-file-title">Rename file</h2>
          <label class="rename-file-label" for="rename-file-input">New filename</label>
          <input id="rename-file-input" class="rename-file-input" type="text" autocomplete="off" spellcheck="false">
          <div class="rename-file-actions">
            <button id="cancel-rename-file" class="text-button" type="button">Cancel</button>
            <button id="confirm-rename-file" class="primary-button" type="submit">Rename</button>
          </div>
        </form>
      </div>
      <div id="settings-dialog" class="dialog-backdrop" hidden>
        <form id="settings-form" class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="settings-header">
            <div>
              <h2 id="settings-title" class="settings-title">Settings</h2>
              <p class="settings-subtitle">Configure your editor workspace.</p>
            </div>
          </div>
          <div class="settings-layout">
            <nav class="settings-nav" aria-label="Settings sections" role="tablist" aria-orientation="vertical">
              <button id="settings-appearance-nav" class="settings-nav-item" type="button" role="tab" aria-controls="settings-appearance-panel">Appearance</button>
              <button id="settings-keymap-nav" class="settings-nav-item" type="button" role="tab" aria-controls="settings-keymap-panel">Keymap</button>
            </nav>
            <div class="settings-content">
              <section id="settings-appearance-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-appearance-nav">
                <fieldset class="settings-theme-fieldset">
                  <legend class="settings-section-title">Appearance</legend>
                  <p class="settings-description">Choose how leetcoder follows your display theme.</p>
                  <div class="settings-theme-options">
                    <label class="settings-theme-option">
                      <input type="radio" name="theme-mode" value="system">
                      <span class="settings-theme-option-copy"><strong>System</strong><small>Follow your device</small></span>
                    </label>
                    <label class="settings-theme-option">
                      <input type="radio" name="theme-mode" value="dark">
                      <span class="settings-theme-option-copy"><strong>Dark</strong><small>Easy on the eyes</small></span>
                    </label>
                    <label class="settings-theme-option">
                      <input type="radio" name="theme-mode" value="light">
                      <span class="settings-theme-option-copy"><strong>Light</strong><small>Bright and clear</small></span>
                    </label>
                  </div>
                </fieldset>
              </section>
              <section id="settings-keymap-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-keymap-nav" hidden>
                <div class="settings-panel-heading">
                  <h3 class="settings-panel-title">Keyboard shortcuts</h3>
                  <p class="settings-description">Reference for the shortcuts available in leetcoder.</p>
                </div>
                <div class="shortcuts-platform-tabs" role="tablist" aria-label="Operating system">
                  <button id="shortcuts-linux-tab" class="shortcuts-platform-tab" type="button" role="tab" aria-controls="shortcuts-body">Linux</button>
                  <button id="shortcuts-macos-tab" class="shortcuts-platform-tab" type="button" role="tab" aria-controls="shortcuts-body">macOS</button>
                </div>
                <div id="shortcuts-body" class="shortcuts-body" role="tabpanel"></div>
                <p class="shortcuts-note">App commands use Alt on Linux and Cmd on macOS. Standard editor shortcuts such as Ctrl+C, Ctrl+V, and Ctrl+Z remain available on Linux.</p>
              </section>
            </div>
          </div>
          <div class="settings-actions">
            <button id="close-settings" class="text-button" type="button">Close</button>
          </div>
        </form>
      </div>
      <div id="about-dialog" class="dialog-backdrop" hidden>
        <div class="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <h2 id="about-title" class="about-title">About leetcoder</h2>
          <p class="about-name">leetcoder <span class="about-version">${options.appVersion}</span></p>
          <p class="about-description">A focused LeetCode Java practice editor.</p>
          <p class="about-note">Built for the daily problem-solving workflow.</p>
          <div class="about-actions">
            <button id="close-about" class="text-button" type="button">Close</button>
          </div>
        </div>
      </div>
      <div id="discard-git-dialog" class="dialog-backdrop" hidden>
        <form id="discard-git-form" class="discard-git-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-git-title" aria-describedby="discard-git-message">
          <h2 id="discard-git-title" class="discard-git-title">Discard changes?</h2>
          <code id="discard-git-path" class="discard-git-path"></code>
          <p id="discard-git-message" class="discard-git-message"></p>
          <div class="discard-git-actions">
            <button id="cancel-discard-git" class="text-button" type="button">Cancel</button>
            <button id="confirm-discard-git" class="primary-button discard-git-confirm" type="submit">Discard Changes</button>
          </div>
        </form>
      </div>
      <div id="delete-file-dialog" class="dialog-backdrop" hidden>
        <form id="delete-file-form" class="discard-git-dialog delete-file-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-file-title" aria-describedby="delete-file-message">
          <h2 id="delete-file-title" class="discard-git-title">Delete file?</h2>
          <code id="delete-file-name" class="discard-git-path"></code>
          <p id="delete-file-message" class="discard-git-message">This permanently deletes this file. This cannot be undone.</p>
          <div class="discard-git-actions">
            <button id="cancel-delete-file" class="text-button" type="button">Cancel</button>
            <button id="confirm-delete-file" class="primary-button discard-git-confirm" type="submit">Delete</button>
          </div>
        </form>
      </div>
    </div>
    <div id="modal-root"></div>
  `
}
