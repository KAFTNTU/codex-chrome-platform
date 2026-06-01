const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SENSITIVE_DOMAINS = [
  'accounts.google.com',
  'mail.google.com',
  'gmail.com',
  'privat24.ua',
  'monobank.ua',
  'bank.gov.ua',
  'diia.gov.ua',
  'id.gov.ua',
  'paypal.com',
];

const DEFAULT_RUNTIME = {
  mode: 'safe',
  developerModeEnabled: false,
  localNetworkEnabled: false,
  token: '',
  sensitiveDomains: SENSITIVE_DOMAINS,
  blockedDomains: [],
  confirmations: {},
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function getDataDir() {
  return path.join(os.homedir(), '.chrome-bridge');
}

function getRuntimePath() {
  return path.join(getDataDir(), 'runtime.json');
}

function loadRuntime() {
  ensureDir(getDataDir());
  const runtimePath = getRuntimePath();
  let runtime = { ...DEFAULT_RUNTIME };
  if (fs.existsSync(runtimePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      runtime = {
        ...runtime,
        ...parsed,
      };
    } catch {
      runtime = { ...DEFAULT_RUNTIME };
    }
  }
  if (!runtime.token) {
    runtime.token = generateToken();
    saveRuntime(runtime);
  }
  return runtime;
}

function saveRuntime(runtime) {
  ensureDir(getDataDir());
  fs.writeFileSync(getRuntimePath(), JSON.stringify(runtime, null, 2), 'utf8');
}

function getPermissionsForMode(runtime) {
  const developer = runtime.mode === 'developer' && runtime.developerModeEnabled;
  return {
    cookies: developer,
    debugger: developer,
    runScript: developer,
    localNetwork: !!runtime.localNetworkEnabled,
  };
}

function isSensitiveUrl(rawUrl, runtime) {
  try {
    const url = new URL(rawUrl);
    return (runtime.sensitiveDomains || []).some((domain) => {
      return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    });
  } catch {
    return false;
  }
}

function normalizeActionName(action) {
  const map = {
    get_active_tab: 'getActiveTab',
    extract_text: 'extractText',
    extract_html: 'extractHtml',
    extract_tables: 'extractTables',
    screenshot: 'screenshot',
    full_page_screenshot: 'fullPageScreenshot',
    click: 'click',
    click_by_text: 'clickByText',
    click_nearest_match: 'clickNearestMatch',
    safe_click: 'safeClick',
    type_text: 'type',
    paste_text: 'pasteText',
    scroll: 'scroll',
    get_forms: 'getForms',
    macro_start_recording: 'startMacroRecording',
    macro_stop_recording: 'stopMacroRecording',
    macro_run: 'runRecipe',
    read_cookies: 'getCookies',
    run_script: 'runScript',
    debugger_attach: 'networkAttach',
    read_console_logs: 'getConsoleLog',
    read_response_body: 'readResponseBody',
    navigate_to: 'navigate',
    open_url: 'navigate',
    navigate_and_wait: 'navigateAndWait',
    wait_for_page_ready: 'waitForPageReady',
    open_ato_module: 'openAtoModule',
    open_ato_topic: 'openAtoTopicByTitle',
    open_ato_topic_by_title: 'openAtoTopicByTitle',
    ensure_ato_context: 'ensureAtoContext',
    reading_scroll_session: 'readingScrollSession',
    open_tab: 'openNewTab',
    wait_for_text: 'waitForText',
    wait_until_text: 'waitForText',
    element_screenshot: 'elementScreenshot',
    fill_login_form: 'fillLoginForm',
    submit_form: 'submitForm',
    submit: 'submitForm',
    upload_file: 'setFileInputFiles',
    upload_files: 'setFileInputFiles',
    upload_document: 'setFileInputFiles',
    upload_photo: 'setFileInputFiles',
    ato_prepare_dropbox_upload: 'atoPrepareDropboxUpload',
    download_file: 'downloadUrl',
    run_action_queue: 'runActionQueue',
  };
  return map[action] || action;
}

function errorPayload(code, message, extras = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extras,
    },
  };
}

function actionNeedsConfirmation(action) {
  return new Set([
    'submit_form',
    'submitForm',
    'type_password',
    'typePassword',
    'read_cookies',
    'getCookies',
    'run_script',
    'runScript',
    'debugger_attach',
    'networkAttach',
    'fill_form_confirmed',
    'fillFormConfirmed',
  ]).has(action);
}

function actionAllowedInSafeMode(action) {
  return !new Set([
    'getCookies',
    'runScript',
    'networkAttach',
    'networkDetach',
    'networkGetLog',
    'networkClearLog',
    'downloadUrl',
    'setFileInputFiles',
  ]).has(action);
}

module.exports = {
  SENSITIVE_DOMAINS,
  loadRuntime,
  saveRuntime,
  getRuntimePath,
  getDataDir,
  maskToken,
  getPermissionsForMode,
  isSensitiveUrl,
  normalizeActionName,
  errorPayload,
  actionNeedsConfirmation,
  actionAllowedInSafeMode,
};
