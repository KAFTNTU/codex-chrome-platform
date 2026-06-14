const DEFAULT_SERVER = 'http://127.0.0.1:17373';
const HIGHLIGHT_ID = '__codex_chrome_bridge_highlight__';
const MAX_COMMAND_LOG = 60;
const MAX_NETWORK_LOG = 120;
const MAX_CONSOLE_LOG = 120;
const MAX_SESSION_MEMORY = 80;
const MAX_RESPONSE_BODY = 200000;
const MAX_ASSISTANT_ATTACHMENT_TEXT = 12000;
const MAX_ASSISTANT_ATTACHMENT_ITEMS = 20;
const HEARTBEAT_ALARM = 'bridge-heartbeat';
const POLL_ALARM = 'bridge-poll';
const NATIVE_HOST_NAME = 'com.codex.bridge';

let state = {
  connected: false,
  clientId: null,
  lastError: null,
  serverUrl: DEFAULT_SERVER,
  bridgeToken: '',
  assistantApiEndpoint: '',
  assistantModel: '',
  assistantApiKey: '',
  assistantTask: '',
  assistantRememberApiKey: false,
  accessProfile: 'controlled',
  mode: 'safe',
  mouseCueEnabled: true,
  workspaceGroupId: null,
  workspaceGroupTitle: 'Codex Agent Workspace',
  workspaceGroupColor: 'blue',
};
let nativeBridgePort = null;
let nativeBridgeReconnectTimer = null;
let nativeBridgeBackoffMs = 1000;
let stateLoaded = false;
let warmupInFlight = null;
let lastHeartbeatAt = 0;
let lastPollAt = 0;
let commandLog = [];
let networkState = {
  attachedTabId: null,
  logsByTab: {},
  requestsByTab: {},
  responseBodiesByTab: {},
};
let consoleState = {
  attachedTabId: null,
  logsByTab: {},
};
let sessionMemory = {
  byTab: {},
  pageSnapshotsByTab: {},
  pageRegionsByTab: {},
};
let downloadMemory = {
  recent: [],
};
let macroState = {
  recording: false,
  name: null,
  actions: [],
  startedAt: null,
};
let namedRecipes = {};
let formProfiles = {};
let assistantChatLog = [];
let assistantDraftAttachments = [];
let assistantArchiveAttachments = [];
let assistantRunSerial = 0;

async function loadState() {
  const stored = await chrome.storage.local.get([
    'clientId',
    'serverUrl',
    'bridgeToken',
    'assistantApiEndpoint',
    'assistantModel',
    'assistantApiKey',
    'assistantTask',
    'assistantRememberApiKey',
    'assistantChatLog',
    'assistantDraftAttachments',
    'assistantArchiveAttachments',
    'namedRecipes',
    'formProfiles',
    'mouseCueEnabled',
    'workspaceGroupId',
    'workspaceGroupTitle',
    'workspaceGroupColor',
    'accessProfile',
  ]);
  state.clientId = stored.clientId || crypto.randomUUID();
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  state.bridgeToken = stored.bridgeToken || '';
  state.assistantApiEndpoint = stored.assistantApiEndpoint || '';
  state.assistantModel = stored.assistantModel || '';
  state.assistantApiKey = stored.assistantApiKey || '';
  state.assistantTask = stored.assistantTask || '';
  state.assistantRememberApiKey = stored.assistantRememberApiKey === true;
  state.accessProfile = stored.accessProfile || 'controlled';
  state.mouseCueEnabled = stored.mouseCueEnabled !== false;
  state.workspaceGroupId = Number.isFinite(Number(stored.workspaceGroupId)) ? Number(stored.workspaceGroupId) : null;
  state.workspaceGroupTitle = stored.workspaceGroupTitle || 'Codex Agent Workspace';
  state.workspaceGroupColor = stored.workspaceGroupColor || 'blue';
  namedRecipes = stored.namedRecipes || {};
  formProfiles = stored.formProfiles || {};
  assistantChatLog = Array.isArray(stored.assistantChatLog) ? stored.assistantChatLog.slice(0, 120) : [];
  assistantDraftAttachments = Array.isArray(stored.assistantDraftAttachments)
    ? stored.assistantDraftAttachments.map((item) => sanitizeAssistantAttachment(item)).filter(Boolean).slice(0, MAX_ASSISTANT_ATTACHMENT_ITEMS)
    : [];
  assistantArchiveAttachments = Array.isArray(stored.assistantArchiveAttachments)
    ? stored.assistantArchiveAttachments.map((item) => sanitizeAssistantAttachment(item)).filter(Boolean).slice(0, MAX_ASSISTANT_ATTACHMENT_ITEMS * 5)
    : [];
  await chrome.storage.local.set({
    clientId: state.clientId,
    serverUrl: state.serverUrl,
    bridgeToken: state.bridgeToken,
    assistantApiEndpoint: state.assistantApiEndpoint,
    assistantModel: state.assistantModel,
    assistantTask: state.assistantTask,
    assistantRememberApiKey: state.assistantRememberApiKey,
    assistantChatLog,
    assistantDraftAttachments,
    assistantArchiveAttachments,
    accessProfile: state.accessProfile,
    mouseCueEnabled: state.mouseCueEnabled,
    workspaceGroupId: state.workspaceGroupId,
    workspaceGroupTitle: state.workspaceGroupTitle,
    workspaceGroupColor: state.workspaceGroupColor,
    formProfiles,
  });
  stateLoaded = true;
}

async function ensureStateLoaded() {
  if (!stateLoaded) {
    await loadState();
  }
}

async function persistRecipes() {
  await chrome.storage.local.set({ namedRecipes });
}

async function persistFormProfiles() {
  await chrome.storage.local.set({ formProfiles });
}

async function persistBridgeState() {
  try {
    await chrome.storage.local.set({ bridgeState: state });
  } catch {
    // Ignore transient storage failures during service worker restarts.
  }
}

async function persistWorkspaceState() {
  try {
    await chrome.storage.local.set({
      workspaceGroupId: state.workspaceGroupId,
      workspaceGroupTitle: state.workspaceGroupTitle,
      workspaceGroupColor: state.workspaceGroupColor,
      accessProfile: state.accessProfile,
    });
  } catch {
    // Ignore transient storage failures.
  }
}

function buildAssistantSystemPrompt(context) {
  const activeTabText = context?.activeTab
    ? `Current active tab: ${context.activeTab.title || '(no title)'} | ${context.activeTab.url || '(no url)'}`
    : 'Current active tab: unavailable';
  const profileText = context?.accessProfile || 'controlled';
  const connectedText = context?.bridgeConnected ? 'connected' : 'not connected';
  const pageSummaryText = context?.pageSummary?.summaryText
    || context?.pageSummary?.summary?.join?.(' | ')
    || 'Page summary: unavailable';
  const pageOutlineText = context?.pageOutline?.summaryText
    || context?.pageOutline?.summary?.join?.(' | ')
    || 'DOM outline: unavailable';
  const pageInteractText = context?.pageInteract?.summaryText
    || context?.pageInteract?.interactMap?.slice?.(0, 10)?.map?.((item) => {
      const role = item?.kind || item?.role || item?.tag || 'control';
      const text = item?.text || item?.ariaLabel || item?.placeholder || item?.name || '';
      const intent = item?.intent ? ` intent=${item.intent}` : '';
      return `${item?.index ?? '?'}:${role}:${text}${intent}`;
    })?.join?.(' | ')
    || 'Interact map: unavailable';
  const pageTestText = context?.pageTestDigest?.summaryText
    || context?.pageTestDigest?.controls?.slice?.(0, 10)?.join?.(' | ')
    || 'Test digest: unavailable';
  const pageDigestText = context?.pageDigest?.text
    || context?.pageDigest?.summaryText
    || 'Page digest: unavailable';
  const questionMapText = context?.pageQuestionMap?.summaryText
    || context?.pageQuestionMap?.questions?.map?.((question) => {
      return `Q${question.number}:${question.kind}:${question.answered ? 'answered' : 'unanswered'}`;
    })?.join?.(' | ')
    || 'Question map: unavailable';
  const attachmentsText = buildAssistantAttachmentBlock(context?.draftAttachments || [], 'Attached draft files');
  const archiveText = buildAssistantAttachmentBlock(context?.archiveAttachments || [], 'Archived files');
  return [
    'You are Codex, a browser agent running inside a real Chrome/Edge session through Chrome Bridge.',
    'You can help the user with browser tasks in their personal browser session, including opening pages, reading page content, finding controls, filling forms, scrolling, clicking visible controls, focusing fields, hovering, and explaining what to do next.',
    'Always reply in Ukrainian by default unless the user explicitly asks for another language. Keep assistant_text in Ukrainian too.',
    'Do not greet the user or start with generic chat like "Hello". If the task is browser-related, immediately work on the page. If the task is unclear, ask one short clarifying question instead of chatting.',
    'The bridge can interact with real page elements. Treat visible inputs, text fields, buttons, links, selects, checkboxes, radios, tabs, dialogs, and other controls as actionable browser targets.',
    'When a page has forms or buttons, prefer the interact map, semantic click, and form assist tools to identify what can be clicked or typed into. If fields are visible, you can work with them directly through the bridge.',
    'When a page has repeated blocks, questions, cards, or sections with similar controls, first narrow the scope with scopeToSection or describeSection, then use listSectionControls, clickWithinSection, or fillWithinSection so you act only inside the matched container.',
    'When questionScopedMode is active, the page has already been divided into question:N regions. Do not request or inspect the full-page DOM, full interact map, or body text. Read the compact pageQuestionMap once, then request pageQuestionMap with questionNumber=N only when local details are needed.',
    'In questionScopedMode, every interaction must stay inside one named question container. Use sectionNeedle such as "Запитання 1" and a separate controlNeedle for the local control. Never fall back to a global click when a scoped action fails.',
    'Never use a positional guessing strategy such as choosing the first option, the same option, or a fixed option index across multiple questions. Do not say that you will choose the first option in every question.',
    'In questionScopedMode, inspect and handle at most one question per step. Before clickWithinSection, explain the local choice in assistant_text and include a specific params.rationale. A bare position such as "first option" is not a rationale. After the click, verify the selected state before moving to another question.',
    'If the page is large or repetitive, you may save a compact page region with pageRegionMemory or selectPageRegion and then refer to that short region instead of restating the whole page context. Prefer this when you want a tiny prompt footprint.',
    'For section-scoped tools, use params named sectionNeedle and controlNeedle. Avoid old names like sectionSelector or controlSelector when you generate new actions.',
    'For clickWithinSection, sectionNeedle must describe the container heading or question label, while controlNeedle must describe the option or local control inside that section. Never use the answer text as sectionNeedle.',
    'For question-like or option-like sections that contain radios, checkboxes, or labels, prefer clickWithinSection. Use fillWithinSection only for actual text/select/editable fields that need values typed or selected.',
    'Use pageDiffMemory after an action to check what really changed on the page, and use site memory to remember what you already inspected on this tab.',
    'Do not scroll aggressively by default. First use DOM context, interact maps, and section tools to understand the page. Only scroll when the needed element is not reachable from the current visible area or current DOM cues.',
    'When scrolling is needed, prefer small controlled steps. Use smoothScroll with modest values, for example totalY between 120 and 320 per step, instead of jumping half a page at once.',
    'Before searching the web, use the current page context, pageSummary, pageDomOutline, pageDomSnapshot, pageInteractMap, pageTestDigest, pageDigest, site memory, and your own knowledge. Do not leave the current page to search for information unless the user explicitly asks you to search the web or the answer truly requires external lookup.',
    'If the active page looks like a test/quiz/exam/attempt, never use searchWeb, openNewTab, navigate, navigateAndWait, switchTab, closeTab, or workspace-tab actions. Stay on the same tab. If a requested question is not present in the current DOM, say that it is not present instead of leaving the page.',
    'When browser actions are needed, return ONLY valid JSON with this shape: {"assistant_text":"...","actions":[{"action":"...","params":{}}],"done":false}. Do not add markdown, code fences, or extra prose around the JSON.',
    'The actions array should contain bridge commands such as searchWeb, openNewTab, navigate, pageInteractClick, semanticClick, universalFormAssist, type, pasteText, hover, moveCursor, waitForPageReady, and scroll or smoothScroll.',
    'For scrolling, use smoothScroll: negative totalY scrolls up, positive totalY scrolls down. Example: {"assistant_text":"Scrolling up a bit.","actions":[{"action":"smoothScroll","params":{"totalY":-800,"stepY":120,"delayMs":25}}]}',
    'For complex work, proceed in stages. After each assistant_text + actions response, wait for the execution results, then continue with the next step until done=true. If more work remains, keep done=false. Never repeat a greeting between steps.',
    'Always re-read the current page state after each browser action. Treat every next step as if the page may have changed after the previous click, scroll, input, or navigation.',
    'Before execution results arrive, describe actions tentatively, for example "Спробую натиснути" or "Пробую вибрати", not as completed facts. Only treat a click or selection as successful after the bridge confirms it.',
    'If the request is simple and does not require browser actions, answer directly with assistant_text and set done=true.',
    'Assume the bridge can act on the real browser when appropriate. If a step is sensitive, destructive, login-related, or submit-related, ask for confirmation before proceeding.',
    'Never click buttons or links that finalize, submit, finish, send, or complete a test/quiz/exam attempt. You may inspect the page and explain state, but do not finalize a test flow.',
    'Be concise and practical. If you need browser interaction, describe the next browser action clearly.',
    'Draft file attachments may include screenshots, DOCX/PDF text extracts, or archive previews. Use screenshot images as visual context, and use extracted text from documents and archives as direct evidence when answering.',
    'Available bridge skills include: pageSummary, pageQuestionMap, pageDomOutline, pageDomSnapshot, pageSectionReader, scopeToSection, listSectionControls, clickWithinSection, fillWithinSection, describeSection, pageInteractMap, pageInteractClick, semanticClick, findDomControl, universalFormAssist, OCR from screenshot, pageDiffMemory, siteMemorySnapshot, pageRegionMemory, workspace tabs, file upload assistant, and searchWeb.',
    'When a page is structured or test-like, use the structured data from pageDomSnapshot: controls, selects, radioGroups, checkboxGroups, tables, lists, textBlocks, forms, frames, and shadowHosts. Use this data to identify where every visible button, field, and grouped answer lives.',
    `Bridge connected: ${connectedText}. Access profile: ${profileText}.`,
    activeTabText,
    `Page summary: ${pageSummaryText}`,
    `DOM outline: ${pageOutlineText}`,
    `Interact map: ${pageInteractText}`,
    `Test digest: ${pageTestText}`,
    `Page digest: ${pageDigestText}`,
    `Question-scoped mode: ${context?.questionScopedMode ? 'active' : 'inactive'}`,
    `Question map: ${questionMapText}`,
    context?.pageDiff ? `Page diff: ${JSON.stringify(context.pageDiff).slice(0, 1800)}` : '',
    context?.siteMemory ? `Site memory: ${JSON.stringify(context.siteMemory).slice(0, 1800)}` : '',
    attachmentsText,
    archiveText,
  ].join('\n');
}

function inferAssistantModel(endpoint) {
  const value = String(endpoint || '').toLowerCase();
  if (value.includes('openrouter.ai')) return 'openrouter/auto';
  return 'gpt-4o-mini';
}

async function callAssistantApi({ endpoint, apiKey, model, task, context, messages = null }) {
  const selectedModel = String(model || '').trim() || inferAssistantModel(endpoint);
  const endpointText = String(endpoint || '').toLowerCase();
  const body = {
    model: selectedModel,
    messages: Array.isArray(messages) && messages.length
      ? messages
      : [
          {
            role: 'system',
            content: buildAssistantSystemPrompt(context),
          },
          {
            role: 'user',
            content: task,
          },
        ],
  };
  if (endpointText.includes('openrouter.ai') || endpointText.includes('openai.com')) {
    body.response_format = { type: 'json_object' };
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (endpointText.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/KAFTNTU/codex-chrome-platform';
    headers['X-Title'] = 'Bridge Companion';
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || rawText || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const candidateReply = data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.text
    ?? data?.output_text
    ?? data?.output?.text
    ?? data?.message?.content
    ?? data?.response
    ?? '';
  const reply = String(candidateReply || '').trim();
  return {
    reply,
    model: selectedModel,
    raw: data,
    rawText,
    hasTextReply: !!reply,
  };
}

function stripAssistantJsonFence(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return value;
}

function extractJsonObjectCandidates(text) {
  const raw = String(text || '');
  const candidates = [];
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push({
            prefix: raw.slice(0, start).trim(),
            json: raw.slice(start, index + 1).trim(),
          });
          break;
        }
      }
    }
  }
  return candidates;
}

function parseAssistantPlan(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [{ prefix: '', json: raw }];
  const fenced = stripAssistantJsonFence(raw);
  if (fenced && fenced !== raw) candidates.push({ prefix: '', json: fenced });
  candidates.push(...extractJsonObjectCandidates(raw));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.json);
      if (parsed && typeof parsed === 'object') {
        if (candidate.prefix && !parsed.assistant_text && !parsed.reply && !parsed.text) {
          parsed.assistant_text = candidate.prefix;
        }
        return parsed;
      }
    } catch {
      // ignore malformed candidates
    }
  }
  return null;
}

function normalizeAssistantPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const assistantText = String(plan.assistant_text || plan.reply || plan.text || '').trim();
  const actionsSource = Array.isArray(plan.actions)
    ? plan.actions
    : Array.isArray(plan.queue)
      ? plan.queue
      : [];
  const actions = actionsSource.map((step) => {
    if (!step || typeof step !== 'object') return null;
    const action = String(step.action || step.name || step.command || '').trim();
    if (!action) return null;
    const params = step.params && typeof step.params === 'object' ? step.params : {};
    return { action, params };
  }).filter(Boolean);
  const done = plan.done === true || plan.complete === true || plan.finished === true
    ? true
    : plan.done === false || plan.continue === true
      ? false
      : null;
  return {
    assistantText,
    actions,
    done,
  };
}

function extractAssistantTextFromCompletion(completion) {
  const reply = String(completion?.reply || '').trim();
  if (reply) return reply;
  const raw = completion?.raw;
  const candidates = [
    raw?.choices?.[0]?.message?.content,
    raw?.choices?.[0]?.text,
    raw?.output_text,
    raw?.output?.text,
    raw?.message?.content,
    raw?.response,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return '';
}

function buildAssistantStepPrompt(task, stepIndex, previousSummary, lastActionSummary) {
  return [
    `Original task: ${task}`,
    `Step: ${stepIndex}`,
    previousSummary ? `Previous summary: ${previousSummary}` : '',
    lastActionSummary ? `Last execution results:\n${lastActionSummary}` : '',
    'Prefer the current page, local browser context, and your own knowledge. Do not search the web unless the user explicitly asked for web search or the answer truly requires external lookup.',
    'Continue replying in Ukrainian unless the user asked for another language.',
    'Continue from the current browser state and return only JSON with assistant_text, actions, and done.',
    'If the task is finished, set done=true and return no further actions.',
  ].filter(Boolean).join('\n\n');
}

function buildAssistantRuntimeContext(browserContext) {
  return {
    activeTab: browserContext?.activeTab || null,
    accessProfile: state.accessProfile,
    bridgeConnected: state.connected,
    pageSummary: browserContext?.pageSummary || null,
    pageOutline: browserContext?.pageOutline || null,
    pageSnapshot: browserContext?.pageSnapshot || null,
    pageInteract: browserContext?.pageInteract || null,
    pageTestDigest: browserContext?.pageTestDigest || null,
    pageDigest: browserContext?.pageDigest || null,
    pageDiff: browserContext?.pageDiff || null,
    siteMemory: browserContext?.siteMemory || null,
    selectedRegion: browserContext?.selectedRegion || null,
    pageQuestionMap: browserContext?.pageQuestionMap || null,
    questionScopedMode: !!browserContext?.questionScopedMode,
    draftAttachments: assistantDraftAttachments.map((item) => ({ ...item })),
    archiveAttachments: assistantArchiveAttachments.map((item) => ({ ...item })),
  };
}

function buildAssistantLiveContextSnippet(browserContext) {
  const activeTab = browserContext?.activeTab || null;
  const pageSummaryText = browserContext?.pageSummary?.summary
    || browserContext?.pageSummary?.summaryText
    || browserContext?.pageSummary?.mainText
    || '';
  const interactMap = browserContext?.pageInteract?.interactMap
    || browserContext?.pageInteract?.controls
    || [];
  const interactText = Array.isArray(interactMap)
    ? interactMap.slice(0, 10).map((item) => {
        if (typeof item === 'string') return item;
        const role = item?.kind || item?.role || item?.tag || 'control';
        const text = item?.text || item?.ariaLabel || item?.placeholder || item?.name || '';
        return `${item?.index ?? '?'}:${role}:${text}`.trim();
      }).filter(Boolean).join(' | ')
    : '';
  const testText = browserContext?.pageTestDigest?.summaryText || '';
  const digestText = browserContext?.pageDigest?.text
    || browserContext?.pageDigest?.summaryText
    || '';
  const diffText = browserContext?.pageDiff?.diff
    || browserContext?.pageDiff?.summaryText
    || '';
  const regionText = browserContext?.selectedRegion
    ? `${browserContext.selectedRegion.regionId || browserContext.selectedRegion.selector || 'selected-region'}: ${browserContext.selectedRegion.label || browserContext.selectedRegion.text || ''}`
    : '';
  const questionMapText = browserContext?.pageQuestionMap?.summaryText || '';
  return [
    activeTab ? `Current page: ${activeTab.title || '(untitled)'} | ${activeTab.url || ''}` : 'Current page: unavailable',
    pageSummaryText ? `Fresh page summary: ${pageSummaryText}` : '',
    interactText ? `Fresh interact map: ${interactText}` : '',
    testText ? `Fresh test digest: ${testText}` : '',
    digestText ? `Fresh page digest: ${digestText}` : '',
    diffText ? `Fresh page diff: ${String(diffText).slice(0, 800)}` : '',
    regionText ? `Selected region: ${regionText.slice(0, 300)}` : '',
    questionMapText ? `Question containers: ${questionMapText.slice(0, 1200)}` : '',
  ].filter(Boolean).join('\n');
}

function buildAssistantActionFingerprint(actions = []) {
  if (!Array.isArray(actions) || !actions.length) return '';
  return JSON.stringify(actions.map((step) => ({
    action: normalizeCommandAction(step?.action || ''),
    params: step?.params || {},
  })));
}

function buildAssistantPageFingerprint(browserContext) {
  return JSON.stringify({
    url: browserContext?.activeTab?.url || '',
    title: browserContext?.activeTab?.title || '',
    summary: browserContext?.pageSummary?.summary
      || browserContext?.pageSummary?.summaryText
      || browserContext?.pageSummary?.mainText
      || '',
    interact: browserContext?.pageInteract?.interactMap?.slice?.(0, 8) || browserContext?.pageInteract?.controls?.slice?.(0, 8) || [],
    digest: browserContext?.pageDigest?.text || browserContext?.pageDigest?.summaryText || '',
    testDigest: browserContext?.pageTestDigest?.summaryText || '',
    questionMap: browserContext?.pageQuestionMap?.summaryText || '',
  });
}

function assistantContextLooksTestLike(browserContext) {
  if (browserContext?.questionScopedMode || browserContext?.pageQuestionMap?.questions?.length) return true;
  const text = [
    browserContext?.activeTab?.url || '',
    browserContext?.activeTab?.title || '',
    browserContext?.pageSummary?.summaryText || '',
    browserContext?.pageSummary?.mainText || '',
    browserContext?.pageDigest?.text || '',
    browserContext?.pageDigest?.summaryText || '',
    browserContext?.pageTestDigest?.summaryText || '',
  ].join(' ');
  return /test|quiz|exam|attempt|take_test|my_tests|пройти тест|тест|іспит|екзамен|контроль/i.test(text);
}

function isGlobalQuestionReadAction(action) {
  return [
    'pageDomOutline',
    'pageDomSnapshot',
    'pageInteractMap',
    'pageSectionReader',
  ].includes(action);
}

function isTabLeavingAction(action) {
  return [
    'openNewTab',
    'searchWeb',
    'navigate',
    'navigateAndWait',
    'switchTab',
    'closeTab',
    'openInCodexWorkspace',
    'createCodexTabGroup',
    'redditComposeDraft',
  ].includes(action);
}

function isUnsafeGlobalTestAction(action) {
  return [
    'pageInteractClick',
    'semanticClick',
    'universalFormAssist',
    'pageWizardNext',
    'pageWizardPrev',
  ].includes(action);
}

function questionChoiceGuardReason(actions = [], assistantText = '', browserContext = null) {
  if (!browserContext?.questionScopedMode) return '';
  const scopedClicks = actions.filter((step) => normalizeCommandAction(step?.action || '') === 'clickWithinSection');
  if (!scopedClicks.length) return '';
  const text = String(assistantText || '').toLowerCase();
  const positionalPattern = /(?:перш(?:ий|у|ого)\s+(?:варіант|відповід)|перш(?:ий|у)\s+у\s+(?:списку|кожному)|однаков(?:ий|у)\s+(?:варіант|відповід)|first\s+(?:option|answer)|same\s+(?:option|answer)|option\s*(?:number|#)?\s*1\b)/i;
  if (positionalPattern.test(text)) {
    return 'Blocked blind positional selection. Inspect one question and justify the specific local choice instead of choosing the first or same option.';
  }
  if (scopedClicks.length > 1) {
    return 'Blocked bulk question selection. Question-scoped mode allows only one clickWithinSection choice per step, followed by verification.';
  }
  const rationale = String(scopedClicks[0]?.params?.rationale || scopedClicks[0]?.params?.reason || '').trim();
  if (rationale.length < 20 || positionalPattern.test(rationale)) {
    return 'Blocked unsupported question choice. Add a specific params.rationale for this one local choice; an option position is not sufficient.';
  }
  return '';
}

function normalizeCommandAction(action) {
  const raw = String(action || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const aliasMap = {
    getactivetab: 'getActiveTab',
    listtabs: 'listTabs',
    switchtab: 'switchTab',
    opennetab: 'openNewTab',
    opennewtab: 'openNewTab',
    searchweb: 'searchWeb',
    redditcomposedraft: 'redditComposeDraft',
    universalformassist: 'universalFormAssist',
    createcodextabgroup: 'createCodexTabGroup',
    openincodexworkspace: 'openInCodexWorkspace',
    gettabworkspacestate: 'getTabWorkspaceState',
    addactivetabtoworkspace: 'addActiveTabToWorkspace',
    closetab: 'closeTab',
    navigateandwait: 'navigateAndWait',
    waitforpageready: 'waitForPageReady',
    openatomodule: 'openAtoModule',
    openatotopicbytitle: 'openAtoTopicByTitle',
    ensureatocontext: 'ensureAtoContext',
    readingscrollsession: 'readingScrollSession',
    smoothscroll: 'smoothScroll',
    scrolltoselector: 'scrollToSelector',
    movemouse: 'moveCursor',
    mousemove: 'moveCursor',
    movecursor: 'moveCursor',
    pagesummary: 'pageSummary',
    pagedigest: 'pageSummary',
    pagedomoutline: 'pageDomOutline',
    pagedomsnapshot: 'pageDomSnapshot',
    pagesectionreader: 'pageSectionReader',
    pagequestionmap: 'pageQuestionMap',
    questioncontainermap: 'pageQuestionMap',
    readquestionregion: 'pageQuestionMap',
    scopetosection: 'scopeToSection',
    listsectioncontrols: 'listSectionControls',
    clickwithinsection: 'clickWithinSection',
    fillwithinsection: 'fillWithinSection',
    describesection: 'describeSection',
    pageintentmap: 'pageIntentMap',
    pageinteractmap: 'pageInteractMap',
    pageinteractclick: 'pageInteractClick',
    semanticclick: 'semanticClick',
    semanticsearch: 'semanticClick',
    semanticaction: 'semanticClick',
    semanticid: 'semanticClick',
    finddomcontrol: 'findDomControl',
    pagediffmemory: 'pageDiffMemory',
    pagediff: 'pageDiffMemory',
    sitememory: 'siteMemorySnapshot',
    sitememorysnapshot: 'siteMemorySnapshot',
    getsitememory: 'siteMemorySnapshot',
    pageregionmemory: 'pageRegionMemory',
    pageareamemory: 'pageRegionMemory',
    selectpageregion: 'pageRegionMemory',
    selectpagearea: 'pageRegionMemory',
    rememberpageregion: 'pageRegionMemory',
    pageinteracttype: 'pageInteractType',
    pageinteracthover: 'pageInteractHover',
    pageinteractfocus: 'pageInteractFocus',
    pagewizardnext: 'pageWizardNext',
    pagewizardprev: 'pageWizardPrev',
  };
  return aliasMap[compact] || aliasMap[lower] || raw;
}

function summarizeAssistantActions(results = []) {
  if (!Array.isArray(results) || !results.length) return 'No browser actions executed.';
  return results.map((entry, index) => {
    const action = entry?.action || 'action';
    const ok = entry?.result?.ok !== false;
    const stateText = ok ? 'ok' : 'error';
    const selected = entry?.result?.verification?.sectionSelection;
    const clicked = entry?.result?.clicked;
    const selectionDetail = selected?.label
      ? `selected=${selected.label}`
      : selected?.selector
        ? `selected=${selected.selector}`
        : '';
    const clickedDetail = clicked?.label || clicked?.ariaLabel || clicked?.text || '';
    const detail = entry?.result?.error
      || entry?.result?.message
      || entry?.result?.reason
      || entry?.result?.status
      || selectionDetail
      || (clickedDetail ? `clicked=${clickedDetail}` : '')
      || '';
    return `${index + 1}. ${action}: ${stateText}${detail ? ` (${detail})` : ''}`;
  }).join('\n');
}

async function runAssistantActionPlan(actions = [], tabId = null, completedActionFingerprints = null, browserContext = null, assistantText = '') {
  const results = [];
  const testLikeContext = assistantContextLooksTestLike(browserContext);
  const questionGuardReason = questionChoiceGuardReason(actions, assistantText, browserContext);
  if (questionGuardReason) {
    return actions.map((step) => ({
      action: step?.action || 'action',
      result: {
        ok: false,
        blocked: true,
        reason: questionGuardReason,
      },
    }));
  }
  for (const step of actions.slice(0, 12)) {
    try {
      const normalizedAction = normalizeCommandAction(step?.action || '');
      if (testLikeContext && isTabLeavingAction(normalizedAction)) {
        results.push({
          action: step.action,
          result: {
            ok: false,
            blocked: true,
            reason: 'Blocked navigation/search/tab-changing action while the active page looks like a test. Stay on the current page and use local page-reading or section-scoped tools only.',
          },
        });
        continue;
      }
      if (testLikeContext && isUnsafeGlobalTestAction(normalizedAction)) {
        results.push({
          action: step.action,
          result: {
            ok: false,
            blocked: true,
            reason: 'Blocked global click/form action on a test-like page. Use scopeToSection, listSectionControls, describeSection, or clickWithinSection so the action stays inside one local question block.',
          },
        });
        continue;
      }
      if (browserContext?.questionScopedMode && isGlobalQuestionReadAction(normalizedAction)) {
        results.push({
          action: step.action,
          result: {
            ok: false,
            blocked: true,
            reason: 'Blocked full-page inspection because question-scoped mode is active. Use pageQuestionMap with questionNumber, then use section-scoped tools inside that question only.',
          },
        });
        continue;
      }
      const actionFingerprint = JSON.stringify({
        action: normalizedAction,
        params: {
          ...(step.params || {}),
          tabId: undefined,
        },
      });
      if (completedActionFingerprints?.has(actionFingerprint)) {
        results.push({
          action: step.action,
          result: {
            ok: false,
            blocked: true,
            reason: 'This exact action was already confirmed. Move to the next section/control instead of repeating it.',
          },
        });
        continue;
      }
      const result = await handleCommand({
        action: step.action,
        params: {
          ...(step.params || {}),
          ...(tabId != null && step.params?.tabId == null ? { tabId } : {}),
        },
      });
      results.push({ action: step.action, result });
      if (
        completedActionFingerprints
        && normalizedAction === 'clickWithinSection'
        && result?.ok !== false
        && result?.verification?.sectionSelection
      ) {
        completedActionFingerprints.add(actionFingerprint);
      }
    } catch (error) {
      results.push({
        action: step.action,
        result: {
          ok: false,
          error: error?.message || String(error),
        },
      });
    }
  }
  return results;
}

async function collectAssistantPageContext() {
  const active = await safeActiveTab();
  let pageQuestionMap = null;
  let questionScopedMode = false;
  let pageSummary = null;
  let pageOutline = null;
  let pageSnapshot = null;
  let pageInteract = null;
  let pageTestDigest = null;
  let pageDigest = null;
  let pageDiff = null;
  let siteMemory = null;
  let selectedRegion = null;
  try {
    const response = await post('/api/action', {
      action: 'pageQuestionMap',
      params: { tabId: active?.id ?? null, maxQuestions: 100, includeOptions: false },
    });
    pageQuestionMap = response?.result || response || null;
    questionScopedMode = !!pageQuestionMap?.questions?.length;
  } catch {
    // Ordinary pages do not need question-scoped mode.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageSummary',
      params: { tabId: active?.id ?? null, maxItems: 10 },
    });
    pageSummary = response?.result || response || null;
  } catch {
    // Ignore pageSummary failures.
  }
  if (questionScopedMode) {
    return {
      activeTab: active,
      pageSummary,
      pageOutline: null,
      pageSnapshot: null,
      pageInteract: null,
      pageTestDigest: null,
      pageDigest: null,
      pageDiff: null,
      siteMemory: null,
      selectedRegion: null,
      pageQuestionMap,
      questionScopedMode: true,
    };
  }
  try {
    const response = await post('/api/action', {
      action: 'pageDomOutline',
      params: { tabId: active?.id ?? null, maxItems: 10 },
    });
    pageOutline = response?.result || response || null;
  } catch {
    // Ignore pageDomOutline failures.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageDomSnapshot',
      params: { tabId: active?.id ?? null, maxItems: 8 },
    });
    pageSnapshot = response?.result || response || null;
  } catch {
    // Ignore pageDomSnapshot failures.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageInteractMap',
      params: { tabId: active?.id ?? null, kind: 'all', maxItems: 60 },
    });
    pageInteract = response?.result || response || null;
  } catch {
    // Ignore pageInteractMap failures.
  }
  if (active?.id != null) {
    try {
      pageTestDigest = await executeInTab(() => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el?.id) {
            for (const label of Array.from(document.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el?.closest?.('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          const ariaLabelledBy = el?.getAttribute?.('aria-labelledby');
          if (ariaLabelledBy) {
            for (const id of ariaLabelledBy.split(/\s+/).filter(Boolean)) {
              const node = document.getElementById(id);
              if (node) parts.push(node.innerText || node.textContent || '');
            }
          }
          return norm(parts.join(' '));
        };
        const questionTexts = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, legend, .question, .prompt, .item-title'))
          .filter(visible)
          .slice(0, 20)
          .map((el) => norm(el.innerText || el.textContent || '').slice(0, 220))
          .filter(Boolean);
        const controls = Array.from(document.querySelectorAll('input, select, textarea, button, [role="button"], [role="radio"], [role="checkbox"], label'))
          .filter(visible)
          .slice(0, 80)
          .map((el, index) => {
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const role = el.getAttribute('role') || '';
            const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 160);
            const label = tag === 'label' ? text : labelTextFor(el);
            const checked = 'checked' in el ? !!el.checked : null;
            const selected = 'selected' in el ? !!el.selected : null;
            const value = 'value' in el ? norm(el.value || '').slice(0, 120) : '';
            return [
              `${index}`,
              tag,
              type,
              role,
              label ? `label=${label}` : '',
              text ? `text=${text}` : '',
              value ? `value=${value}` : '',
              checked != null ? `checked=${checked}` : '',
              selected != null ? `selected=${selected}` : '',
              el.getAttribute('name') ? `name=${el.getAttribute('name')}` : '',
              el.id ? `id=${el.id}` : '',
              el.getAttribute('placeholder') ? `placeholder=${el.getAttribute('placeholder')}` : '',
            ].filter(Boolean).join(' | ');
          });
        const radioGroups = Array.from(document.querySelectorAll('input[type="radio"]'))
          .filter(visible)
          .slice(0, 40)
          .map((el) => {
            const name = el.getAttribute('name') || '';
            const label = labelTextFor(el) || norm(el.getAttribute('aria-label') || '');
            return `${name || '(no-group)'} => ${label || '(no-label)'}${el.checked ? ' [selected]' : ''}`;
          });
        const selectOptions = Array.from(document.querySelectorAll('select'))
          .filter(visible)
          .slice(0, 20)
          .map((select) => {
            const label = labelTextFor(select) || norm(select.getAttribute('aria-label') || select.getAttribute('placeholder') || '');
            const options = Array.from(select.options || []).slice(0, 20).map((opt) => {
              const text = norm(opt.textContent || opt.label || '');
              return `${opt.selected ? '*' : '-'} ${text}`;
            }).filter(Boolean);
            return `${label || select.id || select.name || 'select'} => ${options.join(' | ')}`;
          });
        const tableSummaries = Array.from(document.querySelectorAll('table'))
          .filter(visible)
          .slice(0, 12)
          .map((table, index) => {
            const caption = norm(table.querySelector('caption')?.innerText || table.querySelector('caption')?.textContent || '');
            const headers = Array.from(table.querySelectorAll('thead th, tr th'))
              .map((th) => norm(th.innerText || th.textContent || '').slice(0, 90))
              .filter(Boolean)
              .slice(0, 8);
            const firstRow = Array.from(table.querySelectorAll('tbody tr, tr'))
              .find((row) => visible(row));
            const cells = firstRow ? Array.from(firstRow.querySelectorAll('th, td'))
              .map((cell) => norm(cell.innerText || cell.textContent || '').slice(0, 90))
              .filter(Boolean)
              .slice(0, 8) : [];
            return `${index}: ${caption || table.id || table.className || 'table'}${headers.length ? ` [${headers.join(' | ')}]` : ''}${cells.length ? ` => ${cells.join(' | ')}` : ''}`;
          });
        const listSummaries = Array.from(document.querySelectorAll('ul, ol, dl, menu'))
          .filter(visible)
          .slice(0, 12)
          .map((list, index) => {
            const items = Array.from(list.querySelectorAll('li, dt, dd'))
              .filter(visible)
              .slice(0, 6)
              .map((node) => norm(node.innerText || node.textContent || '').slice(0, 90))
              .filter(Boolean);
            return `${index}: ${list.tagName.toLowerCase()} ${items.join(' | ')}`;
          });
        const formFields = Array.from(document.querySelectorAll('input, select, textarea'))
          .filter(visible)
          .slice(0, 40)
          .map((field, index) => {
            const tag = field.tagName.toLowerCase();
            const type = field.getAttribute('type') || '';
            return `${index}: ${tag}${type ? `:${type}` : ''}${labelTextFor(field) ? ` => ${labelTextFor(field)}` : ''}${field.getAttribute('placeholder') ? ` [${field.getAttribute('placeholder')}]` : ''}`;
          });
        return {
          title: document.title || '',
          url: location.href,
          questionTexts,
          controls,
          radioGroups,
          selectOptions,
          tableSummaries,
          listSummaries,
          formFields,
          summaryText: [
            `Questions: ${questionTexts.slice(0, 5).join(' || ') || '(none)'}`,
            `Controls: ${controls.slice(0, 10).join(' || ') || '(none)'}`,
            `Radio groups: ${radioGroups.slice(0, 10).join(' || ') || '(none)'}`,
            `Selects: ${selectOptions.slice(0, 5).join(' || ') || '(none)'}`,
            `Tables: ${tableSummaries.slice(0, 5).join(' || ') || '(none)'}`,
            `Lists: ${listSummaries.slice(0, 5).join(' || ') || '(none)'}`,
            `Fields: ${formFields.slice(0, 10).join(' || ') || '(none)'}`,
          ].join(' | '),
        };
      }, [], active.id);
    } catch {
      // Ignore test digest failures.
    }
  }
  if (active?.id != null) {
  try {
    pageDigest = await executeInTab(() => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, 10)
          .map((el) => norm(el.innerText || el.textContent || '').slice(0, 160))
          .filter(Boolean);
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible)
          .slice(0, 16)
          .map((el) => {
            const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 120);
            return [
              el.tagName.toLowerCase(),
              el.getAttribute('type') || '',
              el.getAttribute('role') || '',
              text,
              el.getAttribute('placeholder') || '',
              el.getAttribute('aria-label') || '',
            ].filter(Boolean).join(' | ');
          });
        const text = norm(document.body?.innerText || document.body?.textContent || '').slice(0, 2000);
        return {
          title: document.title || '',
          url: location.href,
          headings,
          controls,
          text,
          summaryText: [
            `Title: ${document.title || '(untitled)'}`,
            `URL: ${location.href}`,
            `Headings: ${headings.slice(0, 5).join(' || ') || '(none)'}`,
            `Controls: ${controls.slice(0, 8).join(' || ') || '(none)'}`,
            `Text preview: ${text.slice(0, 800) || '(none)'}`,
          ].join(' | '),
        };
      }, [], active.id);
    } catch {
      // Ignore direct digest failures.
    }
  }
  if (active?.id != null) {
    try {
      pageDiff = await post('/api/action', {
        action: 'pageDiffMemory',
        params: { tabId: active.id },
      }).then((response) => response?.result || response || null);
    } catch {
      // Ignore pageDiffMemory failures.
    }
  }
  if (active?.id != null) {
    try {
      siteMemory = await post('/api/action', {
        action: 'siteMemorySnapshot',
        params: { tabId: active.id },
      }).then((response) => response?.result || response || null);
      selectedRegion = siteMemory?.selectedRegion || null;
    } catch {
      // Ignore siteMemorySnapshot failures.
    }
  }
  return {
    activeTab: active,
    pageSummary,
    pageOutline,
    pageSnapshot,
    pageInteract,
    pageTestDigest,
    pageDigest,
    pageDiff,
    siteMemory,
    selectedRegion,
    pageQuestionMap,
    questionScopedMode,
  };
}

function scheduleNativeBridgeReconnect() {
  if (nativeBridgeReconnectTimer) return;
  nativeBridgeReconnectTimer = setTimeout(() => {
    nativeBridgeReconnectTimer = null;
    void connectNativeBridge().catch(() => {});
  }, nativeBridgeBackoffMs);
  nativeBridgeBackoffMs = Math.min(Math.max(1000, nativeBridgeBackoffMs * 2), 30000);
}

async function connectNativeBridge() {
  await ensureStateLoaded();
  if (nativeBridgePort) return nativeBridgePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativeBridgePort = port;
    nativeBridgeBackoffMs = 1000;
    port.onMessage.addListener((message) => {
      if (message?.ok) {
        state.connected = true;
        state.lastError = null;
        void persistBridgeState();
      }
      if (message?.type === 'bootstrap-ack' && message?.bridgeStarted) {
        state.connected = true;
        state.lastError = null;
        void persistBridgeState();
      }
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native messaging host disconnected';
      nativeBridgePort = null;
      state.connected = false;
      state.lastError = error;
      void persistBridgeState();
      scheduleNativeBridgeReconnect();
    });
    port.postMessage({
      type: 'bootstrap',
      clientId: state.clientId,
      serverUrl: state.serverUrl,
      mode: state.mode,
      workspaceGroupId: state.workspaceGroupId,
    });
    return port;
  } catch (error) {
    nativeBridgePort = null;
    state.connected = false;
    state.lastError = error?.message || String(error);
    void persistBridgeState();
    scheduleNativeBridgeReconnect();
    return null;
  }
}

function normalizeTabGroupColor(color) {
  const allowed = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  const value = String(color || '').trim().toLowerCase();
  return allowed.has(value) ? value : 'blue';
}

async function getValidatedWorkspaceGroup() {
  if (state.workspaceGroupId == null) return null;
  try {
    const group = await chrome.tabGroups.get(Number(state.workspaceGroupId));
    if (!group) return null;
    return group;
  } catch {
    state.workspaceGroupId = null;
    await persistWorkspaceState();
    return null;
  }
}

async function updateWorkspaceGroup(groupId, options = {}) {
  const title = String(options.title || state.workspaceGroupTitle || 'Codex Agent Workspace').trim() || 'Codex Agent Workspace';
  const color = normalizeTabGroupColor(options.color || state.workspaceGroupColor || 'blue');
  const collapsed = options.collapsed != null ? !!options.collapsed : false;
  const updated = await chrome.tabGroups.update(Number(groupId), { title, color, collapsed });
  state.workspaceGroupId = Number(groupId);
  state.workspaceGroupTitle = title;
  state.workspaceGroupColor = color;
  await persistWorkspaceState();
  return updated;
}

async function createWorkspaceGroupForTab(tabId, options = {}) {
  const groupId = await chrome.tabs.group({ tabIds: Number(tabId) });
  await updateWorkspaceGroup(groupId, options);
  return groupId;
}

async function ensureWorkspaceGroup(tabId, options = {}) {
  const existing = await getValidatedWorkspaceGroup();
  if (existing) return existing;
  if (tabId == null) return null;
  const groupId = await createWorkspaceGroupForTab(tabId, options);
  return await chrome.tabGroups.get(groupId);
}

function scheduleBridgeAlarms() {
  if (!chrome.alarms) return;
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
}

async function warmBridge(force = false) {
  await ensureStateLoaded();
  const now = Date.now();
  if (force || now - lastHeartbeatAt > 25000) {
    await heartbeat();
  }
  if (force || now - lastPollAt > 1200) {
    await pollOnce();
  }
}

async function bootstrapBridge() {
  if (warmupInFlight) return warmupInFlight;
  warmupInFlight = (async () => {
    await ensureStateLoaded();
    await connectNativeBridge();
    await ensureOffscreenDocument();
    scheduleBridgeAlarms();
    await warmBridge(true);
    await syncAccessProfileToBridge();
  })().catch((error) => {
    state.connected = false;
    state.lastError = error.message || String(error);
    void persistBridgeState();
  }).finally(() => {
    warmupInFlight = null;
  });
  return warmupInFlight;
}

function pushCommandLog(entry) {
  commandLog = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...commandLog].slice(0, MAX_COMMAND_LOG);
}

function pushAssistantChat(entry) {
  assistantChatLog = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...assistantChatLog].slice(0, 120);
}

function truncateText(value, limit = MAX_ASSISTANT_ATTACHMENT_TEXT) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeAssistantAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || crypto.randomUUID());
  const name = String(item.name || 'attachment').trim();
  if (!name) return null;
  const size = Number(item.size) || 0;
  const type = String(item.type || '').trim();
  const lastModified = Number(item.lastModified) || Date.now();
  const kind = String(item.kind || '').trim() || (type.startsWith('image/') ? 'image' : (type.startsWith('text/') ? 'text' : 'binary'));
  const text = typeof item.text === 'string' ? truncateText(item.text) : '';
  const preview = typeof item.preview === 'string' ? truncateText(item.preview, 2000) : '';
  const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
  const source = String(item.source || 'chat').trim() === 'archive' ? 'archive' : 'chat';
  return {
    id,
    name,
    size,
    type,
    lastModified,
    kind,
    text,
    preview,
    dataUrl,
    source,
    addedAt: item.addedAt || new Date().toISOString(),
  };
}

function describeAssistantAttachment(attachment) {
  const meta = `${attachment.name} (${formatBytes(attachment.size)}${attachment.type ? `, ${attachment.type}` : ''})`;
  const text = String(attachment.text || attachment.preview || '').trim();
  if (!text) return meta;
  return `${meta}\n${truncateText(text, 2500)}`;
}

function buildAssistantAttachmentBlock(items, label) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return `${label}: none`;
  const lines = list.map((item, index) => `${index + 1}. ${describeAssistantAttachment(item)}`);
  return `${label}:\n${lines.join('\n\n')}`;
}

function buildAssistantTaskMessage(task, attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const textParts = [String(task || '').trim()];
  const imageParts = [];
  const attachmentNotes = [];
  for (const item of list) {
    const meta = `${item.name || 'attachment'} (${formatBytes(item.size)}${item.type ? `, ${item.type}` : ''})`;
    const isImage = String(item.type || '').startsWith('image/') && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/');
    const contentText = String(item.text || item.preview || '').trim();
    if (isImage) {
      imageParts.push({ type: 'image_url', image_url: { url: item.dataUrl } });
      attachmentNotes.push(`${meta} [image attached]`);
    } else if (contentText) {
      attachmentNotes.push(`${meta}\n${truncateText(contentText, 4000)}`);
    } else {
      attachmentNotes.push(`${meta} [no text preview]`);
    }
  }
  if (attachmentNotes.length) {
    textParts.push(`Attached files:\n${attachmentNotes.join('\n\n')}`);
  }
  const textMessage = textParts.filter(Boolean).join('\n\n').trim();
  if (!imageParts.length) return textMessage;
  return [
    { type: 'text', text: textMessage },
    ...imageParts,
  ];
}

function recordSessionEvent(tabId, action, details = {}) {
  if (tabId == null) return;
  const key = String(tabId);
  sessionMemory.byTab[key] ||= [];
  sessionMemory.byTab[key] = [{
    at: new Date().toISOString(),
    action,
    ...details,
  }, ...sessionMemory.byTab[key]].slice(0, MAX_SESSION_MEMORY);
}

function getSessionMemory(tabId = null) {
  if (tabId != null) {
    return {
      tabId: Number(tabId),
      events: sessionMemory.byTab[String(tabId)] || [],
    };
  }
  return {
    tabs: Object.entries(sessionMemory.byTab).map(([key, events]) => ({
      tabId: Number(key),
      events,
    })),
  };
}

function clearSessionMemory(tabId = null) {
  if (tabId != null) {
    delete sessionMemory.byTab[String(tabId)];
    delete sessionMemory.pageSnapshotsByTab[String(tabId)];
    delete sessionMemory.pageRegionsByTab[String(tabId)];
    return { cleared: true, tabId: Number(tabId) };
  }
  sessionMemory.byTab = {};
  sessionMemory.pageSnapshotsByTab = {};
  sessionMemory.pageRegionsByTab = {};
  return { cleared: true, allTabs: true };
}

function getPageSnapshotMemory(tabId = null) {
  if (tabId != null) {
    return sessionMemory.pageSnapshotsByTab[String(tabId)] || null;
  }
  return sessionMemory.pageSnapshotsByTab;
}

function setPageSnapshotMemory(tabId, snapshot) {
  if (tabId == null) return;
  sessionMemory.pageSnapshotsByTab[String(tabId)] = snapshot;
}

function getPageRegionMemory(tabId = null) {
  if (tabId != null) {
    return sessionMemory.pageRegionsByTab[String(tabId)] || null;
  }
  return sessionMemory.pageRegionsByTab;
}

function setPageRegionMemory(tabId, region) {
  if (tabId == null) return null;
  const key = String(tabId);
  if (!region) {
    delete sessionMemory.pageRegionsByTab[key];
    return null;
  }
  sessionMemory.pageRegionsByTab[key] = region;
  return region;
}

function clearPageRegionMemory(tabId = null) {
  if (tabId != null) {
    delete sessionMemory.pageRegionsByTab[String(tabId)];
    return { cleared: true, tabId: Number(tabId) };
  }
  sessionMemory.pageRegionsByTab = {};
  return { cleared: true, allTabs: true };
}

function compactSiteMemory(tabId = null) {
  const tabKey = tabId != null ? String(tabId) : null;
  const events = tabKey ? (sessionMemory.byTab[tabKey] || []) : [];
  const snapshot = tabKey ? (sessionMemory.pageSnapshotsByTab[tabKey] || null) : null;
  const region = tabKey ? (sessionMemory.pageRegionsByTab[tabKey] || null) : null;
  const compactSnapshot = snapshot ? {
    title: snapshot.title || null,
    url: snapshot.url || null,
    headingTexts: Array.isArray(snapshot.headingTexts) ? snapshot.headingTexts.slice(0, 8) : [],
    controlSignatures: Array.isArray(snapshot.controlSignatures) ? snapshot.controlSignatures.slice(0, 12) : [],
    modalSignatures: Array.isArray(snapshot.modalSignatures) ? snapshot.modalSignatures.slice(0, 6) : [],
    activeElement: snapshot.activeElement || null,
  } : null;
  return {
    tabId: tabKey != null ? Number(tabKey) : null,
    recentEvents: events.slice(0, 12),
    pageSnapshot: compactSnapshot,
    selectedRegion: region || null,
  };
}

function getFormProfiles() {
  return formProfiles || {};
}

function setFormProfile(name, profile) {
  const key = String(name || '').trim();
  if (!key) throw new Error('name is required');
  formProfiles[key] = profile;
  return key;
}

function compactDownloadItem(item) {
  return {
    id: item.id,
    url: item.url || '',
    finalUrl: item.finalUrl || null,
    filename: item.filename || '',
    danger: item.danger || null,
    mime: item.mime || item.mimeType || null,
    state: item.state || null,
    error: item.error || null,
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    byExtensionId: item.byExtensionId || null,
    exists: item.exists !== false,
  };
}

async function queryDownloadsSnapshot(filter = {}) {
  const items = await chrome.downloads.search({
    ...filter,
  });
  return items.map(compactDownloadItem);
}

async function waitForDownloadMatch(needle = '', options = {}) {
  const target = String(needle || '').trim().toLowerCase();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000));
  const startedAt = Date.now();
  let lastMatch = null;
  while (Date.now() - startedAt < timeoutMs) {
    const items = await queryDownloadsSnapshot(options.filter || {});
    const matches = items.filter((item) => {
      const hay = `${item.filename || ''} ${item.url || ''} ${item.finalUrl || ''}`.toLowerCase();
      if (!target) return true;
      return hay.includes(target);
    });
    if (matches.length) {
      lastMatch = matches[0];
      if (!options.waitForComplete) {
        return {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          download: lastMatch,
          matches,
        };
      }
      const complete = matches.find((item) => item.state === 'complete') || null;
      if (complete) {
        return {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          download: complete,
          matches,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(150, Number(options.pollMs || 500))));
  }
  throw new Error(`Timed out waiting for download: ${needle || 'any download'}`);
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function ensureTabBuckets(tabId) {
  const key = String(tabId);
  networkState.logsByTab[key] ||= [];
  networkState.requestsByTab[key] ||= {};
  networkState.responseBodiesByTab[key] ||= {};
  consoleState.logsByTab[key] ||= [];
  return key;
}

function appendConsoleEntry(tabId, entry) {
  const key = ensureTabBuckets(tabId);
  consoleState.logsByTab[key] = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...consoleState.logsByTab[key]].slice(0, MAX_CONSOLE_LOG);
}

function getConsoleSnapshot(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : consoleState.attachedTabId;
  const key = resolvedTabId != null ? String(resolvedTabId) : null;
  return {
    attachedTabId: consoleState.attachedTabId,
    tabId: resolvedTabId,
    logs: key ? (consoleState.logsByTab[key] || []) : [],
  };
}

function clearConsoleLog(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : consoleState.attachedTabId;
  if (resolvedTabId == null) return { cleared: true, tabId: null };
  consoleState.logsByTab[String(resolvedTabId)] = [];
  return { cleared: true, tabId: resolvedTabId };
}

function normalizeResponseBody(body, base64Encoded, mimeType = '') {
  if (!body) {
    return { body: '', base64Encoded: !!base64Encoded, preview: '' };
  }
  const isTextLike = /json|javascript|xml|html|text|svg|x-www-form-urlencoded/i.test(mimeType || '');
  if (base64Encoded && !isTextLike) {
    return {
      body: String(body).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: true,
      preview: '[binary]',
    };
  }
  try {
    const rawBody = base64Encoded ? atob(body) : body;
    return {
      body: String(rawBody).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: false,
      preview: previewText(rawBody),
    };
  } catch {
    return {
      body: String(body).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: !!base64Encoded,
      preview: previewText(body),
    };
  }
}

function getRecordedResponseBody(tabId, requestId) {
  const key = String(tabId);
  return networkState.responseBodiesByTab[key]?.[requestId] || null;
}

function shouldRecordMacroAction(action) {
  return !new Set([
    'startMacroRecording',
    'stopMacroRecording',
    'getMacroState',
    'saveRecipe',
    'listRecipes',
    'deleteRecipe',
    'runRecipe',
  ]).has(action);
}

function recordMacroAction(action, params) {
  if (!macroState.recording || !shouldRecordMacroAction(action)) return;
  macroState.actions.push({
    action,
    params: JSON.parse(JSON.stringify(params || {})),
  });
}

function getMacroState() {
  return {
    ...macroState,
    actionCount: macroState.actions.length,
  };
}

function previewText(value, maxLength = 400) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function appendNetworkEntry(tabId, entry) {
  const key = ensureTabBuckets(tabId);
  networkState.logsByTab[key] = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...networkState.logsByTab[key]].slice(0, MAX_NETWORK_LOG);
}

async function attachNetworkMonitor(tabId) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  if (networkState.attachedTabId === resolvedTabId) {
    return { attached: true, tabId: resolvedTabId, alreadyAttached: true };
  }
  if (networkState.attachedTabId != null) {
    await detachNetworkMonitor(networkState.attachedTabId);
  }
  await chrome.debugger.attach(debuggerTarget(resolvedTabId), '1.3');
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Network.enable');
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Runtime.enable');
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Log.enable');
  ensureTabBuckets(resolvedTabId);
  networkState.attachedTabId = resolvedTabId;
  consoleState.attachedTabId = resolvedTabId;
  appendNetworkEntry(resolvedTabId, { kind: 'system', message: 'Network monitor attached' });
  appendConsoleEntry(resolvedTabId, { kind: 'system', level: 'info', text: 'Console monitor attached' });
  return { attached: true, tabId: resolvedTabId };
}

async function detachNetworkMonitor(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  if (resolvedTabId == null) return { detached: true, tabId: null, alreadyDetached: true };
  try {
    await chrome.debugger.detach(debuggerTarget(resolvedTabId));
  } catch {
    // Ignore detach errors if the tab was closed or already detached.
  }
  if (networkState.attachedTabId === resolvedTabId) {
    appendNetworkEntry(resolvedTabId, { kind: 'system', message: 'Network monitor detached' });
    networkState.attachedTabId = null;
  }
  if (consoleState.attachedTabId === resolvedTabId) {
    appendConsoleEntry(resolvedTabId, { kind: 'system', level: 'info', text: 'Console monitor detached' });
    consoleState.attachedTabId = null;
  }
  return { detached: true, tabId: resolvedTabId };
}

function getNetworkSnapshot(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  const key = resolvedTabId != null ? String(resolvedTabId) : null;
  return {
    attachedTabId: networkState.attachedTabId,
    tabId: resolvedTabId,
    logs: key ? (networkState.logsByTab[key] || []) : [],
  };
}

function clearNetworkLog(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  if (resolvedTabId == null) return { cleared: true, tabId: null };
  const key = ensureTabBuckets(resolvedTabId);
  networkState.logsByTab[key] = [];
  networkState.requestsByTab[key] = {};
  networkState.responseBodiesByTab[key] = {};
  return { cleared: true, tabId: resolvedTabId };
}

async function queryTabs(query = {}) {
  return await chrome.tabs.query(query);
}

async function activeTab() {
  const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab) return null;
  return serializeTab(tab);
}

async function safeActiveTab() {
  try {
    return await activeTab();
  } catch {
    return null;
  }
}

function serializeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: !!tab.active,
    title: tab.title || '',
    url: tab.url || '',
  };
}

async function post(path, payload) {
  const response = await fetch(state.serverUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.bridgeToken ? { 'X-Bridge-Token': state.bridgeToken } : {}),
    },
    body: JSON.stringify({
      ...(payload || {}),
      ...(state.bridgeToken ? { token: state.bridgeToken } : {}),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function get(path) {
  const separator = path.includes('?') ? '&' : '?';
  const tokenParam = state.bridgeToken ? `${separator}token=${encodeURIComponent(state.bridgeToken)}` : '';
  const response = await fetch(state.serverUrl + path + tokenParam, {
    headers: state.bridgeToken ? { 'X-Bridge-Token': state.bridgeToken } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function getModeForAccessProfile(accessProfile) {
  return accessProfile === 'expanded' ? 'expanded' : 'safe';
}

async function syncAccessProfileToBridge() {
  try {
    const response = await post('/api/mode', { mode: getModeForAccessProfile(state.accessProfile) });
    state.mode = response.mode || state.mode;
    state.connected = true;
    state.lastError = null;
    await persistBridgeState();
    return { ok: true, mode: state.mode };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function resolveTargetTabId(requestedTabId = null) {
  if (requestedTabId != null) {
    const tab = await chrome.tabs.get(Number(requestedTabId));
    if (!tab?.id) throw new Error(`Unknown tab: ${requestedTabId}`);
    return tab.id;
  }
  const tab = await activeTab();
  if (!tab?.id) throw new Error('No active tab');
  return tab.id;
}

async function executeInTab(func, args = [], tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    func,
    args,
  });
  return result;
}

async function runAndRemember(action, func, args = [], tabId = null, detailBuilder = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const result = await executeInTab(func, args, resolvedTabId);
  try {
    const details = typeof detailBuilder === 'function' ? (detailBuilder(result) || {}) : {};
    recordSessionEvent(resolvedTabId, action, details);
  } catch {
    // Ignore memory builder failures.
  }
  return result;
}

async function waitForPageReady(tabId = null, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < Math.max(1000, Number(timeoutMs || 15000))) {
    const state = await executeInTab(() => {
      return {
        readyState: document.readyState,
        title: document.title || '',
        url: location.href,
      };
    }, [], tabId);
    if (state?.readyState === 'complete' || state?.readyState === 'interactive') {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        readyState: state.readyState,
        title: state.title,
        url: state.url,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  throw new Error('Timed out waiting for page ready state');
}

async function navigateAndWait(url, options = {}, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  await chrome.tabs.update(resolvedTabId, { url });
  const ready = await waitForPageReady(resolvedTabId, options.timeoutMs || 15000);
  const titleNeedle = String(options.titleContains || '').trim().toLowerCase();
  const urlNeedle = String(options.urlContains || '').trim().toLowerCase();
  if (titleNeedle || urlNeedle) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
    while (Date.now() - startedAt < timeoutMs) {
      const snap = await activeTab();
      const titleOk = !titleNeedle || (snap?.title || '').toLowerCase().includes(titleNeedle);
      const urlOk = !urlNeedle || (snap?.url || '').toLowerCase().includes(urlNeedle);
      if (titleOk && urlOk) {
        return { ok: true, tabId: resolvedTabId, url: snap.url, title: snap.title, ready };
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    throw new Error(`Navigation finished but condition not met: title~"${options.titleContains || ''}" url~"${options.urlContains || ''}"`);
  }
  const tab = await chrome.tabs.get(resolvedTabId);
  return { ok: true, tabId: resolvedTabId, url: tab.url || url, title: tab.title || '', ready };
}

function resolveAtoModulePath(moduleKey) {
  const key = String(moduleKey || '').trim().toLowerCase();
  const map = {
    home: '/ATutor/bounce.php?course=1',
    file_storage: '/ATutor/mods/_standard/file_storage/index.php',
    files: '/ATutor/mods/_standard/file_storage/index.php',
    assignment_dropbox: '/ATutor/mods/_standard/assignment_dropbox/index.php',
    dropbox: '/ATutor/mods/_standard/assignment_dropbox/index.php',
    tests: '/ATutor/mods/_standard/tests/my_tests.php',
    glossary: '/ATutor/mods/_core/glossary/index.php',
    chat: '/ATutor/mods/_standard/chat/index.php',
    directory: '/ATutor/mods/_standard/directory/directory.php',
  };
  return map[key] || null;
}

async function openAtoModule(moduleKey, options = {}, tabId = null) {
  const current = await activeTab();
  const baseUrl = String(options.baseUrl || current?.url || '').trim();
  if (!baseUrl) throw new Error('Unable to resolve ATutor base URL');
  const modulePath = resolveAtoModulePath(moduleKey);
  if (!modulePath) throw new Error(`Unknown ATutor module key: ${moduleKey}`);
  const base = new URL(baseUrl);
  const finalUrl = `${base.protocol}//${base.host}${modulePath}`;
  const titleHint = options.titleContains || null;
  return await navigateAndWait(finalUrl, {
    timeoutMs: options.timeoutMs || 18000,
    titleContains: titleHint || null,
    urlContains: options.urlContains || modulePath,
  }, tabId);
}

async function openAtoTopicByTitle(title, options = {}, tabId = null) {
  const query = String(title || '').trim();
  if (!query) throw new Error('title is required');
  const resolvedTabId = await resolveTargetTabId(tabId);
  const scan = await executeInTab((needle) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(needle);
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const links = Array.from(document.querySelectorAll('a[href]')).filter(visible).map((el) => {
      const text = norm(el.textContent || el.innerText || '');
      if (!text) return null;
      let score = -1;
      if (text === target) score = 1000;
      else if (text.includes(target)) score = 700 - Math.max(0, text.length - target.length);
      else {
        const overlap = target.split(' ').filter((part) => part && text.includes(part)).length;
        if (overlap > 0) score = 200 + overlap;
      }
      if (score < 0) return null;
      return {
        href: el.href,
        text: text.slice(0, 220),
        score,
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return {
      best: links[0] || null,
      alternatives: links.slice(1, 6),
      currentUrl: location.href,
      title: document.title,
    };
  }, [query], resolvedTabId);
  if (!scan?.best?.href) {
    throw new Error(`Topic not found by title: ${query}`);
  }
  const nav = await navigateAndWait(scan.best.href, {
    timeoutMs: options.timeoutMs || 18000,
    titleContains: options.titleContains || null,
  }, resolvedTabId);
  return { ok: true, query, chosen: scan.best, alternatives: scan.alternatives || [], navigation: nav };
}

async function ensureAtoContext(options = {}, tabId = null) {
  return await executeInTab((expectedCourse, expectedModule) => {
    const href = location.href;
    const title = document.title || '';
    const checks = [];
    if (expectedCourse) {
      const ok = href.toLowerCase().includes(String(expectedCourse).toLowerCase()) ||
        title.toLowerCase().includes(String(expectedCourse).toLowerCase());
      checks.push({ key: 'course', expected: expectedCourse, ok });
    }
    if (expectedModule) {
      const ok = href.toLowerCase().includes(String(expectedModule).toLowerCase()) ||
        title.toLowerCase().includes(String(expectedModule).toLowerCase());
      checks.push({ key: 'module', expected: expectedModule, ok });
    }
    return {
      ok: checks.every((x) => x.ok),
      url: href,
      title,
      checks,
    };
  }, [options.expectedCourse || null, options.expectedModule || null], tabId);
}

async function atoPrepareDropboxUpload(params = {}, tabId = null) {
  const files = Array.isArray(params.files) ? params.files : [];
  if (!files.length) throw new Error('files is required');
  const selector = params.fileSelector || 'input[type="file"]';
  const uploadResult = await setFileInputFiles(selector, files, tabId);
  const postCheck = await executeInTab(() => {
    const fileInput = document.querySelector('input[type="file"]');
    const selectedCount = fileInput?.files?.length || 0;
    const submitButtons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter((el) => {
        const text = String(el.innerText || el.textContent || el.value || '').toLowerCase();
        return /відправ|submit|upload|завантаж/i.test(text);
      })
      .slice(0, 4)
      .map((el) => ({
        text: String(el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        tag: el.tagName.toLowerCase(),
      }));
    return { selectedCount, submitButtons };
  }, [], tabId);
  return {
    ok: true,
    upload: uploadResult,
    selectedCount: postCheck?.selectedCount || 0,
    submitButtons: postCheck?.submitButtons || [],
    readyForManualSubmit: (postCheck?.selectedCount || 0) > 0,
  };
}

async function readingScrollSession(params = {}, tabId = null) {
  const totalMinutes = Math.max(1, Number(params.minutes || 3));
  const stepY = Math.max(40, Number(params.stepY || 120));
  const delayMs = Math.max(200, Number(params.delayMs || 900));
  const upRatio = Math.min(0.6, Math.max(0, Number(params.upRatio || 0.22)));
  const totalMs = totalMinutes * 60 * 1000;
  const startedAt = Date.now();
  let downMoves = 0;
  let upMoves = 0;
  while (Date.now() - startedAt < totalMs) {
    const down = await executeInTab((step) => {
      const before = window.scrollY;
      window.scrollBy(0, step);
      const after = window.scrollY;
      const bottom = (window.innerHeight + Math.ceil(after)) >= Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      return { before, after, moved: after - before, bottom };
    }, [stepY], tabId);
    downMoves += 1;
    if (down?.bottom) {
      await executeInTab((step) => window.scrollBy(0, -Math.max(80, Math.round(step * 3.2))), [stepY], tabId);
      upMoves += 1;
    } else if (Math.random() < upRatio) {
      await executeInTab((step) => window.scrollBy(0, -Math.max(50, Math.round(step * 1.5))), [stepY], tabId);
      upMoves += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return {
    ok: true,
    minutes: totalMinutes,
    elapsedMs: Date.now() - startedAt,
    downMoves,
    upMoves,
  };
}

async function showMouseCue(selector, tabId = null, label = 'Agent') {
  if (!state.mouseCueEnabled || !selector) return { shown: false, disabled: true };
  return await executeInTab((targetSelector, targetLabel) => {
    const el = document.querySelector(targetSelector);
    if (!el) return { shown: false, reason: `Selector not found: ${targetSelector}` };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const id = '__codex_bridge_mouse_cue__';
    let cue = document.getElementById(id);
    if (!cue) {
      cue = document.createElement('div');
      cue.id = id;
      cue.style.position = 'fixed';
      cue.style.left = '0';
      cue.style.top = '0';
      cue.style.width = '20px';
      cue.style.height = '20px';
      cue.style.border = '2px solid rgba(255, 120, 120, 0.95)';
      cue.style.borderRadius = '999px';
      cue.style.background = 'rgba(255, 120, 120, 0.2)';
      cue.style.boxShadow = '0 0 0 6px rgba(255, 120, 120, 0.14)';
      cue.style.zIndex = '2147483647';
      cue.style.pointerEvents = 'none';
      cue.style.transition = 'transform 0.18s ease, opacity 0.22s ease';
      document.documentElement.appendChild(cue);
    }
    cue.style.opacity = '1';
    cue.style.transform = `translate(${Math.round(x - 10)}px, ${Math.round(y - 10)}px)`;
    cue.setAttribute('title', targetLabel || 'Agent');
    setTimeout(() => {
      const stillThere = document.getElementById(id);
      if (stillThere) stillThere.style.opacity = '0.35';
    }, 900);
    return { shown: true, selector: targetSelector, x: Math.round(x), y: Math.round(y) };
  }, [selector, label], tabId);
}

async function safeClickWithRetries(selector, options = {}, tabId = null) {
  return await executeInTab(async (targetSelector, opts) => {
    const queryAllDeep = (selectorQuery) => {
      const results = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        if (root.querySelectorAll) {
          results.push(...root.querySelectorAll(selectorQuery));
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return results;
    };
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const maxAttempts = Math.max(1, Number(opts.maxAttempts || 3));
    const settleMs = Math.max(40, Number(opts.settleMs || 90));
    const allowForce = opts.allowForce === true;
    const preferHumanEvents = opts.preferHumanEvents !== false;

    const candidate = queryAllDeep(targetSelector)[0] || null;
    if (!candidate) throw new Error(`Selector not found: ${targetSelector}`);
    if (!visible(candidate)) throw new Error(`Element not visible: ${targetSelector}`);
    const clickOnce = (node, x, y) => {
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
      if (preferHumanEvents) {
        node.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        node.dispatchEvent(new MouseEvent('mousedown', eventInit));
        node.dispatchEvent(new PointerEvent('pointerup', eventInit));
        node.dispatchEvent(new MouseEvent('mouseup', eventInit));
      }
      node.dispatchEvent(new MouseEvent('click', eventInit));
    };

    const attempts = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      candidate.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      await sleep(settleMs);
      const before = candidate.getBoundingClientRect();
      await sleep(40);
      const after = candidate.getBoundingClientRect();
      const stable = Math.abs(before.left - after.left) < 1 && Math.abs(before.top - after.top) < 1;
      const rect = after;
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + rect.width * 0.3, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.7, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.3],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.7],
      ];
      let chosen = null;
      for (const [x, y] of points) {
        const top = document.elementFromPoint(x, y);
        if (top && (candidate === top || candidate.contains(top))) {
          chosen = { x, y, top };
          break;
        }
      }
      if (!chosen && allowForce) {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        chosen = { x, y, top: candidate };
      }
      if (!chosen) {
        attempts.push({ attempt, ok: false, stable, reason: 'covered_by_other_element' });
        continue;
      }
      candidate.focus?.();
      clickOnce(chosen.top || candidate, chosen.x, chosen.y);
      attempts.push({ attempt, ok: true, stable, x: Math.round(chosen.x), y: Math.round(chosen.y) });
      return {
        clicked: true,
        selector: targetSelector,
        attempts,
        usedAttempt: attempt,
      };
    }
    throw new Error(`safeClick failed after ${maxAttempts} attempts`);
  }, [selector, options], tabId);
}

async function executeStructuredDomActions(actions, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (items) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const queryAllDeep = (selector) => {
      const matches = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        if (root.querySelectorAll) {
          matches.push(...root.querySelectorAll(selector));
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return matches;
    };
    const queryDeep = (selector) => queryAllDeep(selector)[0] || null;
    const findByText = (text, selector) => {
      const needle = norm(text).toLowerCase();
      if (!needle) return null;
      const nodes = queryAllDeep(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"], div, span');
      return nodes.find((node) => isVisible(node) && norm(node.innerText || node.textContent || node.value || '').toLowerCase().includes(needle)) || null;
    };
    const results = [];
    for (const item of items || []) {
      const action = item?.action || '';
      try {
        if (action === 'clearBlocklyWorkspace') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          ws.clear();
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'blocklyLoadXml') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly || !Blockly.Xml) throw new Error('Blockly XML API not available');
          ws.clear();
          const dom = Blockly.Xml.textToDom(String(item.xml || ''));
          Blockly.Xml.domToWorkspace(dom, ws);
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyCreateChain') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          let previous = null;
          let first = null;
          let y = Number(item.y || 60);
          for (const spec of item.blocks || []) {
            const block = ws.newBlock(spec.type);
            block.initSvg && block.initSvg();
            block.render && block.render();
            if (Array.isArray(spec.fields)) {
              for (const field of spec.fields) {
                if (field?.name && block.getField(field.name)) {
                  block.setFieldValue(String(field.value), field.name);
                }
              }
            }
            if (typeof block.moveBy === 'function') {
              block.moveBy(Number(item.x || 80), y);
              y += 96;
            }
            if (!first) first = block;
            if (previous?.nextConnection && block.previousConnection) {
              previous.nextConnection.connect(block.previousConnection);
            }
            previous = block;
          }
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length, firstType: first?.type || null });
          continue;
        }
        if (action === 'blocklyListCapabilities') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          const blockTypes = Object.keys((window.Blockly && Blockly.Blocks) || {}).sort();
          results.push({
            action,
            ok: true,
            workspacePresent: !!ws,
            blockTypes,
          });
          continue;
        }
        if (action === 'blocklyExportXml') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly || !Blockly.Xml) throw new Error('Blockly XML API not available');
          const xmlDom = Blockly.Xml.workspaceToDom(ws);
          const xmlText = Blockly.Xml.domToText(xmlDom);
          results.push({ action, ok: true, xml: xmlText, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyInspectBlocks') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          const blocks = ws.getAllBlocks(false).map((block) => ({
            id: block.id,
            type: block.type,
            fields: block.inputList.flatMap((input) => input.fieldRow.map((field) => ({
              name: field.name || null,
              value: field.getValue ? field.getValue() : null,
              text: field.getText ? field.getText() : null,
            }))).filter((field) => field.name),
            inputs: block.inputList.map((input) => ({
              name: input.name || null,
              type: input.type,
            })),
          }));
          results.push({ action, ok: true, blocks });
          continue;
        }
        if (action === 'blocklyMutateBlock') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly) throw new Error('Blockly workspace not found');
          const target = item.blockId
            ? ws.getBlockById(String(item.blockId))
            : ws.getAllBlocks(false).find((block) => block.type === item.blockType) || null;
          if (!target) throw new Error('Target block not found');
          if (typeof target.domToMutation !== 'function') throw new Error('Target block does not support mutations');
          const mutation = document.createElement('mutation');
          for (const [key, value] of Object.entries(item.mutation || {})) {
            mutation.setAttribute(key, String(value));
          }
          target.domToMutation(mutation);
          target.initSvg && target.initSvg();
          target.render && target.render();
          results.push({ action, ok: true, blockId: target.id, blockType: target.type });
          continue;
        }
        if (action === 'blocklySetField') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          const target = item.blockId
            ? ws.getBlockById(String(item.blockId))
            : ws.getAllBlocks(false).find((block) => block.type === item.blockType) || null;
          if (!target) throw new Error('Target block not found');
          if (!target.getField(item.field)) throw new Error(`Field not found: ${item.field}`);
          target.setFieldValue(String(item.value ?? ''), item.field);
          target.render && target.render();
          results.push({ action, ok: true, blockId: target.id, field: item.field, value: item.value });
          continue;
        }
        if (action === 'blocklyAutoLayout') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyUndo') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || typeof ws.undo !== 'function') throw new Error('Blockly undo not available');
          ws.undo(false);
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'blocklyRedo') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || typeof ws.undo !== 'function') throw new Error('Blockly redo not available');
          ws.undo(true);
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'clickSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.click();
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'clickText') {
          const el = findByText(item.text, item.selector);
          if (!el) throw new Error(`Text match not found: ${item.text}`);
          el.click();
          results.push({ action, ok: true, text: item.text });
          continue;
        }
        if (action === 'typeSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.focus();
          if ('value' in el) {
            el.value = String(item.text || '');
          } else if (el.isContentEditable) {
            el.textContent = String(item.text || '');
          } else {
            throw new Error('Element is not typable');
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ action, ok: true, selector: item.selector, textLength: String(item.text || '').length });
          continue;
        }
        if (action === 'setTextContent') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.textContent = String(item.text || '');
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'setAttribute') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.setAttribute(String(item.name || ''), String(item.value || ''));
          results.push({ action, ok: true, selector: item.selector, name: item.name });
          continue;
        }
        if (action === 'focusSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.focus();
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'note') {
          const noteId = item.id || '__codex_note';
          let note = document.getElementById(noteId);
          if (!note) {
            note = document.createElement('div');
            note.id = noteId;
            note.style.position = 'fixed';
            note.style.right = '14px';
            note.style.bottom = '14px';
            note.style.zIndex = '999999';
            note.style.background = 'rgba(37,99,235,.95)';
            note.style.color = 'white';
            note.style.padding = '10px 14px';
            note.style.borderRadius = '12px';
            note.style.font = '700 13px Segoe UI, sans-serif';
            note.style.boxShadow = '0 10px 28px rgba(0,0,0,.35)';
            document.body.appendChild(note);
          }
          note.textContent = String(item.text || '');
          results.push({ action, ok: true, id: noteId });
          continue;
        }
        throw new Error(`Unsupported dom action: ${action}`);
      } catch (error) {
        results.push({ action, ok: false, error: error.message || String(error) });
      }
    }
    return { ok: results.every((entry) => entry.ok), results };
    },
    args: [actions || []],
  });
  recordSessionEvent(resolvedTabId, 'domActions', {
    actionCount: result?.results?.length || 0,
  });
  return result;
}

async function listTabs(currentWindowOnly = false) {
  const tabs = await queryTabs(currentWindowOnly ? { currentWindow: true } : {});
  return tabs.map(serializeTab);
}

async function recentTabs(maxItems = 20) {
  const tabs = await queryTabs({});
  return tabs
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, maxItems)
    .map((tab) => ({
      ...serializeTab(tab),
      lastAccessed: tab.lastAccessed || null,
    }));
}

async function switchTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id) throw new Error(`Unknown tab: ${tabId}`);
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return serializeTab(await chrome.tabs.get(tab.id));
}

async function openNewTab(url = 'about:blank', active = true) {
  const tab = await chrome.tabs.create({ url, active });
  return serializeTab(tab);
}

function looksLikeUrl(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /[.]/.test(value) && /[a-z0-9-]+\.[a-z]{2,}/i.test(value);
}

function buildSearchUrl(query, engine = 'bing') {
  const q = encodeURIComponent(String(query || '').trim());
  const normalizedEngine = String(engine || 'bing').trim().toLowerCase();
  const map = {
    bing: `https://www.bing.com/search?q=${q}`,
    google: `https://www.google.com/search?q=${q}`,
    duckduckgo: `https://duckduckgo.com/?q=${q}`,
    ddg: `https://duckduckgo.com/?q=${q}`,
    yahoo: `https://search.yahoo.com/search?p=${q}`,
    brave: `https://search.brave.com/search?q=${q}`,
  };
  return map[normalizedEngine] || map.bing;
}

async function searchWeb(query, options = {}, tabId = null) {
  const term = String(query || '').trim();
  if (!term) throw new Error('query is required');
  const url = looksLikeUrl(term) ? (term.startsWith('http://') || term.startsWith('https://') ? term : `https://${term}`) : buildSearchUrl(term, options.engine || 'bing');
  if (options.newTab !== false) {
    return await openNewTab(url, options.active !== false);
  }
  return await navigateAndWait(url, {
    timeoutMs: options.timeoutMs || 15000,
    titleContains: options.titleContains || null,
    urlContains: options.urlContains || null,
  }, tabId);
}

async function redditComposeDraft(params = {}, tabId = null) {
  const subreddit = String(params.subreddit || '').trim().replace(/^r\//i, '').replace(/^\/+/g, '');
  const draftUrl = subreddit ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/submit` : 'https://www.reddit.com/submit';
  const nav = await navigateAndWait(draftUrl, {
    timeoutMs: params.timeoutMs || 20000,
    titleContains: params.titleContains || 'Reddit',
    urlContains: '/submit',
  }, tabId);
  let fillResult = null;
  if (params.title || params.body) {
    fillResult = await executeInTab((draft) => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const setNativeValue = (el, value) => {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return true;
      };
      const titleNeedle = norm('title');
      const bodyNeedle = norm('body');
      const titleCandidates = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter(isVisible)
        .filter((el) => {
          const hint = norm(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''} ${el.closest('label')?.innerText || ''}`);
          return hint.includes(titleNeedle) || el.name === 'title' || el.id === 'title';
        });
      const bodyCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input'))
        .filter(isVisible)
        .filter((el) => {
          const hint = norm(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''} ${el.closest('label')?.innerText || ''}`);
          return hint.includes(bodyNeedle) || hint.includes('text') || hint.includes('post');
        });
      const titleEl = titleCandidates[0] || Array.from(document.querySelectorAll('input, textarea')).find((el) => isVisible(el) && el.type === 'text');
      const bodyEl = bodyCandidates.find((el) => el !== titleEl) || Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).find((el) => isVisible(el) && el !== titleEl);
      const result = {
        titleFound: !!titleEl,
        bodyFound: !!bodyEl,
      };
      if (draft.title && titleEl) {
        titleEl.focus();
        result.titleFilled = setNativeValue(titleEl, draft.title);
      }
      if (draft.body && bodyEl) {
        bodyEl.focus();
        if (bodyEl.isContentEditable) {
          bodyEl.innerText = draft.body;
          bodyEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: draft.body }));
          result.bodyFilled = true;
        } else {
          result.bodyFilled = setNativeValue(bodyEl, draft.body);
        }
      }
      return result;
    }, [{ title: params.title || '', body: params.body || '' }], tabId);
  }
  return {
    ok: true,
    subreddit: subreddit || null,
    url: draftUrl,
    navigation: nav,
    filled: fillResult,
  };
}

async function universalFormAssist(params = {}, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  return await runAndRemember('universalFormAssist', (payload) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const deepQueryOne = (selector) => {
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        const found = root.querySelector?.(selector);
        if (found) return found;
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return null;
    };
    const deepQueryAll = (selector) => {
      const items = [];
      const seen = new Set();
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
        for (const node of nodes) {
          if (seen.has(node)) continue;
          seen.add(node);
          items.push(node);
        }
        const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of all) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return items;
    };
    const setNativeValue = (el, value) => {
      const next = value == null ? '' : String(value);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    };
    const setContentEditableValue = (el, value) => {
      const next = value == null ? '' : String(value);
      el.focus();
      el.textContent = next;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: next }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    };
    const getLabelText = (el) => {
      const parts = [];
      if (el.id) {
        for (const label of Array.from(document.querySelectorAll('label'))) {
          if (label.htmlFor === el.id) {
            parts.push(label.innerText || label.textContent || '');
          }
        }
        const ariaIds = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        for (const id of ariaIds) {
          const node = deepQueryOne(`#${CSS.escape(id)}`);
          if (node) parts.push(node.innerText || node.textContent || '');
        }
      }
      const closestLabel = el.closest('label');
      if (closestLabel) parts.push(closestLabel.innerText || closestLabel.textContent || '');
      const parentText = el.parentElement?.innerText || '';
      if (parentText) parts.push(parentText);
      return normalize(parts.join(' '));
    };
    const getControlHint = (el) => {
      return normalize([
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.id,
        el.getAttribute('title'),
        el.getAttribute('autocomplete'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-test'),
        el.getAttribute('role'),
        getLabelText(el),
      ].filter(Boolean).join(' '));
    };
    const aliasHints = {
      name: ['name', 'full name', 'your name', 'ім', 'ім’я', 'імя', 'фио', 'fio'],
      firstName: ['first name', 'given name', 'ім’я', 'імя', 'firstname', 'name'],
      lastName: ['last name', 'surname', 'family name', 'прізвище', 'фамилия'],
      middleName: ['middle name', 'patronymic', 'по батькові'],
      age: ['age', 'years', 'вік', 'лет'],
      birthDate: ['birth date', 'date of birth', 'dob', 'birthday', 'дата народження', 'birthdate'],
      email: ['email', 'e-mail', 'mail', 'пошта', 'email address'],
      phone: ['phone', 'mobile', 'tel', 'telephone', 'телефон', 'номер'],
      city: ['city', 'town', 'місто'],
      country: ['country', 'nation', 'країна'],
      address: ['address', 'street', 'адреса', 'вулиця'],
      university: ['university', 'institution', 'college', 'виш', 'університет'],
      group: ['group', 'class', 'section', 'group number', 'група'],
      login: ['login', 'username', 'user', 'account', 'username or email'],
      password: ['password', 'pass', 'пароль'],
      search: ['search', 'query', 'find', 'пошук', 'запит'],
      message: ['message', 'text', 'body', 'повідомлення', 'текст'],
    };
    const typeHints = {
      name: ['text', 'search'],
      firstName: ['text', 'search'],
      lastName: ['text', 'search'],
      middleName: ['text', 'search'],
      age: ['number', 'text'],
      birthDate: ['date', 'text'],
      email: ['email', 'text'],
      phone: ['tel', 'text'],
      city: ['text', 'search'],
      country: ['text', 'search'],
      address: ['text', 'search'],
      university: ['text', 'search'],
      group: ['text', 'search', 'number'],
      login: ['text', 'email', 'search'],
      password: ['password', 'text'],
      search: ['search', 'text'],
      message: ['text', 'textarea'],
    };
    const deepControls = deepQueryAll('input, textarea, select, [contenteditable="true"], button, [role="button"]')
      .filter(isVisible)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const labelText = getLabelText(el);
        const hint = getControlHint(el);
        return {
          el,
          tag,
          type,
          labelText,
          hint,
          valuePreview: normalize('value' in el ? el.value : el.textContent || '').slice(0, 120),
        };
      });
    const fieldEntries = [];
    if (Array.isArray(payload.entries)) {
      fieldEntries.push(...payload.entries);
    }
    if (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)) {
      for (const [key, value] of Object.entries(payload.fields)) {
        fieldEntries.push({ key, value });
      }
    }
    if (Array.isArray(payload.fields)) {
      fieldEntries.push(...payload.fields);
    }
    if (!fieldEntries.length && payload.key != null) {
      fieldEntries.push({ key: payload.key, value: payload.value });
    }
    const hintSetFromEntry = (entry) => {
      const rawKey = normalize(entry.key ?? entry.name ?? entry.label ?? entry.field ?? entry.selector ?? '');
      const manualHints = [];
      if (rawKey) manualHints.push(rawKey);
      if (entry.hint) manualHints.push(normalize(entry.hint));
      if (entry.label) manualHints.push(normalize(entry.label));
      if (entry.name) manualHints.push(normalize(entry.name));
      const aliasKey = lower(rawKey).replace(/\s+/g, '');
      const alias = aliasHints[aliasKey] || aliasHints[rawKey] || aliasHints[lower(rawKey)] || [];
      manualHints.push(...alias);
      return [...new Set(manualHints.filter(Boolean).map((item) => normalize(item)))];
    };
    const typeMatches = (control, entry) => {
      const desired = normalize(entry.type || entry.kind || entry.inputType || '');
      if (!desired) return true;
      const desiredList = desired.split(/[|,]/).map((item) => lower(item).trim()).filter(Boolean);
      const candidate = lower(control.type || control.tag);
      return desiredList.some((item) => candidate === item || candidate.includes(item));
    };
    const scoreControl = (control, entry, needles) => {
      let score = 0;
      const candidate = lower(control.hint);
      const label = lower(control.labelText);
      const combined = `${candidate} ${label}`;
      const controlType = lower(control.type || control.tag);
      const key = lower(entry.key ?? entry.name ?? entry.label ?? entry.field ?? '');
      if (entry.selector) {
        return 10000;
      }
      if (!typeMatches(control, entry)) {
        return -1;
      }
      for (const needle of needles) {
        const n = lower(needle);
        if (!n) continue;
        if (combined === n) score += 700;
        if (candidate === n) score += 650;
        if (label === n) score += 650;
        if (combined.includes(n)) score += 300;
        if (candidate.includes(n)) score += 260;
        if (label.includes(n)) score += 260;
        if (combined.startsWith(n)) score += 140;
        if (candidate.startsWith(n)) score += 120;
        if (label.startsWith(n)) score += 120;
      }
      if (key) {
        if (control.id && lower(control.id) === key) score += 280;
        if (control.el.getAttribute('name') && lower(control.el.getAttribute('name')) === key) score += 260;
        if (control.el.getAttribute('autocomplete') && lower(control.el.getAttribute('autocomplete')).includes(key)) score += 120;
      }
      if (control.el.getAttribute('required') !== null) score += 8;
      if (controlType === 'text' || controlType === 'search' || controlType === 'email' || controlType === 'tel' || controlType === 'number' || controlType === 'date' || controlType === 'textarea') {
        score += 20;
      }
      if (entry.type && typeHints[lower(entry.key ?? entry.name ?? entry.label ?? '')]?.includes(controlType)) {
        score += 140;
      }
      return score;
    };
    const selectOption = (el, entry) => {
      const raw = entry.selectValue ?? entry.optionValue ?? entry.value ?? '';
      const labelNeedle = normalize(entry.optionText ?? entry.optionLabel ?? '');
      const options = Array.from(el.options || []);
      let chosen = null;
      if (raw !== '') {
        chosen = options.find((option) => option.value === String(raw)) || null;
      }
      if (!chosen && labelNeedle) {
        const needle = lower(labelNeedle);
        chosen = options.find((option) => lower(option.label || option.textContent || '').includes(needle)) || null;
      }
      if (!chosen && raw !== '') {
        const needle = lower(raw);
        chosen = options.find((option) => lower(option.textContent || '').includes(needle)) || null;
      }
      if (!chosen && raw !== '') {
        chosen = options.find((option) => lower(option.textContent || '') === lower(raw)) || null;
      }
      if (!chosen) {
        throw new Error(`No matching option found for ${entry.key || entry.name || entry.label || 'select field'}`);
      }
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return chosen;
    };
    const fillControl = (control, entry) => {
      const el = control.el;
      const rawValue = entry.value;
      const wantChecked = typeof entry.checked === 'boolean'
        ? entry.checked
        : typeof rawValue === 'boolean'
          ? rawValue
          : null;
      if (el instanceof HTMLInputElement) {
        const type = lower(el.type);
        if (type === 'checkbox' || type === 'radio') {
          if (wantChecked == null) {
            if (rawValue == null) return { kind: type, skipped: true };
            el.checked = !!rawValue;
          } else {
            el.checked = wantChecked;
          }
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          return { kind: type, checked: el.checked };
        }
        if (type === 'file') {
          throw new Error('File inputs are not handled by universal form assist');
        }
        setNativeValue(el, rawValue);
        return { kind: type || 'text', value: String(rawValue ?? '') };
      }
      if (el instanceof HTMLTextAreaElement) {
        setNativeValue(el, rawValue);
        return { kind: 'textarea', value: String(rawValue ?? '') };
      }
      if (el instanceof HTMLSelectElement) {
        const chosen = selectOption(el, entry);
        return { kind: 'select', value: chosen.value, label: chosen.label || chosen.textContent || '' };
      }
      if (el.isContentEditable) {
        setContentEditableValue(el, rawValue);
        return { kind: 'contenteditable', value: String(rawValue ?? '') };
      }
      throw new Error(`Element is not fillable: ${control.tag}`);
    };
    const findBestControl = (entry) => {
      const selector = normalize(entry.selector || entry.fieldSelector || '');
      if (selector) {
        const direct = deepQueryOne(selector);
        if (!direct) return null;
        const rect = direct.getBoundingClientRect();
        return {
          el: direct,
          tag: direct.tagName.toLowerCase(),
          type: (direct.getAttribute('type') || '').toLowerCase(),
          labelText: getLabelText(direct),
          hint: getControlHint(direct),
          valuePreview: normalize('value' in direct ? direct.value : direct.textContent || '').slice(0, 120),
          rect,
        };
      }
      const needles = hintSetFromEntry(entry);
      const ranked = deepControls
        .map((control) => ({
          ...control,
          score: scoreControl(control, entry, needles),
        }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score);
      return {
        best: ranked[0] || null,
        alternatives: ranked.slice(1, 5).map((item) => ({
          tag: item.tag,
          type: item.type || null,
          labelText: item.labelText || '',
          hint: item.hint.slice(0, 140),
          score: item.score,
        })),
      };
    };
    const buttonLikeNeedles = ['submit', 'send', 'save', 'continue', 'next', 'login', 'sign in', 'sign up', 'register', 'finish', 'upload', 'відправ', 'надісл', 'зберегти', 'далі', 'продовж', 'увійти', 'зареєстр', 'ок', 'apply'];
    const isSubmitLike = (text) => {
      const value = lower(text);
      return buttonLikeNeedles.some((needle) => value.includes(lower(needle)));
    };
    const findAndClickButton = (request) => {
      const selector = normalize(request.buttonSelector || request.selector || '');
      let button = null;
      if (selector) {
        button = deepQueryOne(selector);
        if (!button) throw new Error(`Button not found: ${selector}`);
      } else {
        const needles = [request.buttonText, request.text, request.label, request.value, request.key].map((item) => normalize(item)).filter(Boolean);
        const candidates = deepQueryAll('button, input[type="button"], input[type="submit"], a[role="button"], [role="button"], [onclick]')
          .filter(isVisible)
          .map((el) => ({
            el,
            text: normalize([
              el.innerText,
              el.textContent,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('value'),
            ].filter(Boolean).join(' ')),
          }))
          .filter((item) => item.text);
        const ranked = candidates
          .map((item) => {
            let score = 0;
            for (const needle of needles) {
              const n = lower(needle);
              if (!n) continue;
              if (lower(item.text) === n) score += 1000;
              if (lower(item.text).startsWith(n)) score += 700;
              if (lower(item.text).includes(n)) score += 500;
            }
            if (request.exactButton) {
              score += needles.some((needle) => lower(item.text) === lower(needle)) ? 40 : 0;
            }
            return { ...item, score };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        button = ranked[0]?.el || null;
        if (!button && request.allowFallback) {
          button = candidates[0]?.el || null;
        }
        if (!button) return { clicked: false, reason: 'Button not found', buttonText: request.buttonText || null };
        if (!ranked[0] && !request.allowFallback) {
          return { clicked: false, reason: 'Button not matched', buttonText: request.buttonText || null };
        }
        const matchedText = ranked[0]?.text || candidates[0]?.text || '';
        const submitLike = isSubmitLike(matchedText);
        if (submitLike && !request.confirmSubmit) {
          return {
            clicked: false,
            blocked: true,
            reason: 'CONFIRMATION_REQUIRED',
            matchedText,
          };
        }
        button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
        button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        button.dispatchEvent(new MouseEvent('mousedown', eventInit));
        button.dispatchEvent(new PointerEvent('pointerup', eventInit));
        button.dispatchEvent(new MouseEvent('mouseup', eventInit));
        button.dispatchEvent(new MouseEvent('click', eventInit));
        if (typeof button.click === 'function') button.click();
        return {
          clicked: true,
          selector: selector || null,
          matchedText,
          submitLike,
        };
      }
      const text = normalize([
        button.innerText,
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('value'),
      ].filter(Boolean).join(' '));
      const submitLike = isSubmitLike(text);
      if (submitLike && !request.confirmSubmit) {
        return {
          clicked: false,
          blocked: true,
          reason: 'CONFIRMATION_REQUIRED',
          matchedText: text,
        };
      }
      button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
      button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      button.dispatchEvent(new MouseEvent('mousedown', eventInit));
      button.dispatchEvent(new PointerEvent('pointerup', eventInit));
      button.dispatchEvent(new MouseEvent('mouseup', eventInit));
      button.dispatchEvent(new MouseEvent('click', eventInit));
      if (typeof button.click === 'function') button.click();
      return {
        clicked: true,
        selector: selector || null,
        matchedText: text,
        submitLike,
      };
    };
    const report = {
      ok: true,
      title: document.title,
      url: location.href,
      fields: [],
      unmatched: [],
      button: null,
    };
    for (const entry of fieldEntries) {
      const key = normalize(entry.key ?? entry.name ?? entry.label ?? entry.field ?? entry.selector ?? '');
      const value = entry.value;
      try {
        const match = findBestControl(entry);
        const control = match?.best || (match?.el ? match : null);
        if (!control?.el) {
          report.unmatched.push({
            key: key || null,
            valuePreview: String(value ?? '').slice(0, 120),
            reason: 'FIELD_NOT_FOUND',
            alternatives: match?.alternatives || [],
          });
          continue;
        }
        control.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        control.el.focus();
        const filled = fillControl(control, entry);
        report.fields.push({
          key: key || null,
          matchedTag: control.tag,
          matchedType: control.type || null,
          matchedHint: control.hint.slice(0, 180),
          valuePreview: String(value ?? '').slice(0, 120),
          ...filled,
        });
      } catch (error) {
        report.ok = false;
        report.fields.push({
          key: key || null,
          valuePreview: String(value ?? '').slice(0, 120),
          ok: false,
          error: error.message || String(error),
        });
      }
    }
    if (payload.clickButton || payload.buttonText || payload.buttonSelector) {
      try {
        const buttonResult = findAndClickButton(payload);
        report.button = buttonResult;
        if (buttonResult?.blocked) {
          report.ok = false;
        }
      } catch (error) {
        report.ok = false;
        report.button = {
          clicked: false,
          error: error.message || String(error),
        };
      }
    }
    return report;
  }, [{
    fields: params.fields || null,
    entries: params.entries || null,
    key: params.key || null,
    value: params.value,
    clickButton: !!params.clickButton,
    confirmSubmit: !!params.confirmSubmit,
    buttonText: params.buttonText || null,
    buttonSelector: params.buttonSelector || null,
    exactButton: !!params.exactButton,
    allowFallback: params.allowFallback === true,
  }], resolvedTabId, () => ({
    fieldCount: Array.isArray(params.entries) ? params.entries.length : (params.fields && typeof params.fields === 'object' ? Object.keys(params.fields).length : 0),
    clickButton: !!params.clickButton,
  }));
}

async function createCodexTabGroup(url = 'about:blank', options = {}) {
  const tab = await chrome.tabs.create({ url, active: options.active !== false });
  const groupId = await createWorkspaceGroupForTab(tab.id, options);
  return {
    tab: serializeTab(tab),
    groupId,
    workspace: {
      groupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
    },
  };
}

async function openInCodexWorkspace(url = 'about:blank', options = {}) {
  const tab = await chrome.tabs.create({ url, active: options.active !== false });
  const groupOptions = {
    title: options.title || state.workspaceGroupTitle || 'Codex Agent Workspace',
    color: options.color || state.workspaceGroupColor || 'blue',
    collapsed: options.collapsed,
  };
  const existingGroup = await getValidatedWorkspaceGroup();
  if (existingGroup && state.workspaceGroupId != null) {
    await chrome.tabs.group({ groupId: Number(state.workspaceGroupId), tabIds: tab.id });
    await updateWorkspaceGroup(Number(state.workspaceGroupId), groupOptions);
  } else {
    await createWorkspaceGroupForTab(tab.id, groupOptions);
  }
  return {
    tab: serializeTab(tab),
    workspace: {
      groupId: state.workspaceGroupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
      collapsed: !!existingGroup?.collapsed,
    },
  };
}

async function getTabWorkspaceState() {
  const group = await getValidatedWorkspaceGroup();
  if (!group) {
    return {
      ok: true,
      workspace: null,
    };
  }
  const tabs = await chrome.tabs.query({ groupId: Number(state.workspaceGroupId) });
  return {
    ok: true,
    workspace: {
      groupId: Number(state.workspaceGroupId),
      title: group.title || state.workspaceGroupTitle,
      color: group.color || state.workspaceGroupColor,
      collapsed: !!group.collapsed,
      tabCount: tabs.length,
      tabs: tabs.map(serializeTab),
    },
  };
}

async function addActiveTabToWorkspace(tabId = null, options = {}) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const groupOptions = {
    title: options.title || state.workspaceGroupTitle || 'Codex Agent Workspace',
    color: options.color || state.workspaceGroupColor || 'blue',
    collapsed: options.collapsed,
  };
  const group = await ensureWorkspaceGroup(resolvedTabId, groupOptions);
  if (group && state.workspaceGroupId != null) {
    await chrome.tabs.group({ groupId: Number(state.workspaceGroupId), tabIds: resolvedTabId });
    await updateWorkspaceGroup(Number(state.workspaceGroupId), groupOptions);
  }
  return {
    ok: true,
    tabId: resolvedTabId,
    workspace: {
      groupId: state.workspaceGroupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
    },
  };
}

async function closeTab(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  await chrome.tabs.remove(resolvedTabId);
  return { closed: true, tab: serializeTab(tab) };
}

async function captureScreenshot(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return {
    tab: serializeTab(tab),
    format: 'png',
    dataUrl,
  };
}

async function withDebugger(tabId, fn) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const wasNetworkAttached = networkState.attachedTabId === resolvedTabId;
  if (!wasNetworkAttached) {
    await chrome.debugger.attach(debuggerTarget(resolvedTabId), '1.3');
  }
  try {
    return await fn(resolvedTabId);
  } finally {
    if (!wasNetworkAttached) {
      try {
        await chrome.debugger.detach(debuggerTarget(resolvedTabId));
      } catch {
        // Ignore transient detach failures.
      }
    }
  }
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.offscreen?.hasDocument) {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copy extracted page content to the system clipboard.',
  });
}

async function writeClipboardText(text) {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'clipboard-write-text', text });
}

async function getPageUrl(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  return tab.url || '';
}

function normalizeCopyMode(mode) {
  return mode === 'html' ? 'html' : 'text';
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function captureElementScreenshot(selector, tabId = null, padding = 10) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const elementInfo = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (inputSelector, extraPadding) => {
      const queryDeep = (selector) => {
        const roots = [document];
        while (roots.length) {
          const root = roots.shift();
          const found = root.querySelector?.(selector);
          if (found) return found;
          const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const node of nodes) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = queryDeep(inputSelector);
      if (!el) throw new Error(`Selector not found: ${inputSelector}`);
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        title: document.title,
        url: location.href,
        devicePixelRatio: window.devicePixelRatio || 1,
        rect: {
          left: Math.max(0, rect.left - extraPadding),
          top: Math.max(0, rect.top - extraPadding),
          width: rect.width + extraPadding * 2,
          height: rect.height + extraPadding * 2,
        },
      };
    },
    args: [selector, Math.max(0, Number(padding || 0))],
  });
  const meta = elementInfo?.[0]?.result;
  if (!meta?.rect) throw new Error('Could not measure element for screenshot');
  const shot = await captureScreenshot(resolvedTabId);
  const response = await fetch(shot.dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = meta.devicePixelRatio || 1;
  const srcX = Math.max(0, Math.round(meta.rect.left * scale));
  const srcY = Math.max(0, Math.round(meta.rect.top * scale));
  const srcW = Math.max(1, Math.min(bitmap.width - srcX, Math.round(meta.rect.width * scale)));
  const srcH = Math.max(1, Math.min(bitmap.height - srcY, Math.round(meta.rect.height * scale)));
  const canvas = new OffscreenCanvas(srcW, srcH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const outBuffer = await outBlob.arrayBuffer();
  return {
    tab: shot.tab,
    title: meta.title,
    url: meta.url,
    selector,
    format: 'png',
    width: srcW,
    height: srcH,
    dataUrl: `data:image/png;base64,${arrayBufferToBase64(outBuffer)}`,
  };
}

async function setFileInputFiles(selector, files, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const marker = `codex-file-target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marked = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (inputSelector, markerName) => {
      const queryDeep = (selector) => {
        const roots = [document];
        while (roots.length) {
          const root = roots.shift();
          const found = root.querySelector?.(selector);
          if (found) return found;
          const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const node of nodes) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = queryDeep(inputSelector);
      if (!el) throw new Error(`Selector not found: ${inputSelector}`);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        throw new Error('Target is not an input[type="file"]');
      }
      el.setAttribute('data-codex-file-target', markerName);
      return { marked: true };
    },
    args: [selector, marker],
  });
  if (!marked?.[0]?.result?.marked) throw new Error('Failed to mark file input');
  return await withDebugger(resolvedTabId, async (debugTabId) => {
    await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.enable');
    const root = await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.getDocument', { depth: -1, pierce: true });
    const node = await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: `[data-codex-file-target="${marker}"]`,
    });
    if (!node?.nodeId) throw new Error('Could not resolve file input in DOM');
    await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.setFileInputFiles', {
      nodeId: node.nodeId,
      files: (files || []).map((file) => String(file)),
    });
    await chrome.scripting.executeScript({
      target: { tabId: debugTabId },
      world: 'MAIN',
      func: (markerName) => {
        const el = document.querySelector(`[data-codex-file-target="${markerName}"]`);
        if (!el) return;
        el.removeAttribute('data-codex-file-target');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      args: [marker],
    });
    return { ok: true, selector, fileCount: (files || []).length };
  });
}

async function inspectCanvas(maxItems = 5, includeDataUrl = false, tabId = null) {
  return await chrome.scripting.executeScript({
    target: { tabId: await resolveTargetTabId(tabId) },
    world: 'MAIN',
    func: (limit, withData) => {
      const canvases = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node instanceof HTMLCanvasElement) canvases.push(node);
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return {
        title: document.title,
        url: location.href,
        canvases: canvases.slice(0, limit).map((canvas, index) => {
          const rect = canvas.getBoundingClientRect();
          return {
            index,
            width: canvas.width,
            height: canvas.height,
            clientWidth: Math.round(rect.width),
            clientHeight: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            dataUrl: withData ? canvas.toDataURL('image/png') : undefined,
          };
        }),
      };
    },
    args: [Math.max(1, Number(maxItems || 5)), !!includeDataUrl],
  }).then((items) => items?.[0]?.result);
}

async function handleCommand(command) {
  const params = command.params || {};
  const normalizedAction = normalizeCommandAction(command.action);
  pushCommandLog({
    action: normalizedAction,
    rawAction: command.action,
    paramsPreview: previewText(JSON.stringify(params)),
  });
  recordMacroAction(normalizedAction, params);
  switch (normalizedAction) {
    case 'getActiveTab':
      return await activeTab();
    case 'listTabs':
      return { tabs: await listTabs(!!params.currentWindowOnly) };
    case 'switchTab':
      return await switchTab(params.tabId);
    case 'openNewTab':
      return await openNewTab(params.url || 'about:blank', params.active !== false);
    case 'searchWeb':
      return await searchWeb(params.query || params.text || params.search || params.url || '', {
        engine: params.engine || 'bing',
        newTab: params.newTab !== false,
        active: params.active !== false,
        timeoutMs: params.timeoutMs || 15000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
      }, params.tabId ?? null);
    case 'redditComposeDraft':
      return await redditComposeDraft({
        subreddit: params.subreddit || null,
        title: params.title || '',
        body: params.body || '',
        timeoutMs: params.timeoutMs || 20000,
        titleContains: params.titleContains || 'Reddit',
      }, params.tabId ?? null);
    case 'universalFormAssist':
      return await universalFormAssist({
        fields: params.fields || null,
        entries: params.entries || null,
        key: params.key || null,
        value: params.value,
        clickButton: !!params.clickButton,
        confirmSubmit: !!params.confirmSubmit,
        buttonText: params.buttonText || null,
        buttonSelector: params.buttonSelector || null,
        exactButton: !!params.exactButton,
        allowFallback: params.allowFallback === true,
      }, params.tabId ?? null);
    case 'createCodexTabGroup':
      return await createCodexTabGroup(params.url || 'about:blank', params);
    case 'openInCodexWorkspace':
      return await openInCodexWorkspace(params.url || 'about:blank', params);
    case 'getTabWorkspaceState':
      return await getTabWorkspaceState();
    case 'addActiveTabToWorkspace':
      return await addActiveTabToWorkspace(params.tabId ?? null, params);
    case 'closeTab':
      return await closeTab(params.tabId ?? null);
    case 'navigate': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.update(resolvedTabId, { url: params.url });
      return { ok: true, tabId: resolvedTabId, url: params.url };
    }
    case 'navigateAndWait':
      return await navigateAndWait(params.url, {
        timeoutMs: params.timeoutMs || 15000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
      }, params.tabId ?? null);
    case 'waitForPageReady':
      return await waitForPageReady(params.tabId ?? null, params.timeoutMs || 15000);
    case 'openAtoModule':
      return await openAtoModule(params.moduleKey || params.module || '', {
        timeoutMs: params.timeoutMs || 18000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
        baseUrl: params.baseUrl || null,
      }, params.tabId ?? null);
    case 'openAtoTopicByTitle':
      return await openAtoTopicByTitle(params.title || params.text || '', {
        timeoutMs: params.timeoutMs || 18000,
        titleContains: params.titleContains || null,
      }, params.tabId ?? null);
    case 'ensureAtoContext':
      return await ensureAtoContext({
        expectedCourse: params.expectedCourse || null,
        expectedModule: params.expectedModule || null,
      }, params.tabId ?? null);
    case 'readingScrollSession':
      return await readingScrollSession({
        minutes: params.minutes || 3,
        stepY: params.stepY || 120,
        delayMs: params.delayMs || 900,
        upRatio: params.upRatio ?? 0.22,
      }, params.tabId ?? null);
    case 'back': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.goBack(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'forward': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.goForward(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'reload': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.reload(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'scroll':
      return await executeInTab((deltaX, deltaY) => {
        window.scrollBy(deltaX, deltaY);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      }, [params.deltaX || 0, params.deltaY || 0], params.tabId ?? null);
    case 'smoothScroll':
      return await runAndRemember('smoothScroll', async (totalY, stepY, delayMs) => {
        const target = Number(totalY || 0);
        const step = Math.max(20, Math.abs(stepY || 140));
        const direction = target >= 0 ? 1 : -1;
        let moved = 0;
        while (Math.abs(moved) < Math.abs(target)) {
          const remaining = Math.abs(target) - Math.abs(moved);
          const chunk = Math.min(step, remaining) * direction;
          window.scrollBy(0, chunk);
          moved += chunk;
          await new Promise((resolve) => setTimeout(resolve, Math.max(10, delayMs || 35)));
        }
        return { ok: true, movedY: moved, scrollX: window.scrollX, scrollY: window.scrollY };
      }, [params.totalY || 0, params.stepY || 140, params.delayMs || 35], params.tabId ?? null, (result) => ({
        movedY: result?.movedY || 0,
      }));
    case 'infiniteScroll':
      return await runAndRemember('infiniteScroll', async (maxPasses, stepY, delayMs, stablePasses) => {
        const passes = Math.max(1, maxPasses || 8);
        let stable = 0;
        let lastHeight = document.body?.scrollHeight || 0;
        const snapshots = [];
        for (let i = 0; i < passes; i += 1) {
          window.scrollBy(0, stepY || window.innerHeight);
          await new Promise((resolve) => setTimeout(resolve, Math.max(80, delayMs || 350)));
          const height = document.body?.scrollHeight || 0;
          const itemCount = document.querySelectorAll('a, article, li, .card, .item, [data-testid]').length;
          snapshots.push({ pass: i + 1, scrollHeight: height, itemCount });
          if (height === lastHeight) {
            stable += 1;
          } else {
            stable = 0;
            lastHeight = height;
          }
          if (stable >= Math.max(1, stablePasses || 2)) break;
        }
        return {
          ok: true,
          passesRun: snapshots.length,
          snapshots,
          finalScrollHeight: lastHeight,
          finalY: window.scrollY,
        };
      }, [params.maxPasses || 8, params.stepY || 0, params.delayMs || 350, params.stablePasses || 2], params.tabId ?? null, (result) => ({
        passesRun: result?.passesRun || 0,
      }));
    case 'scrollToSelector':
      return await executeInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return { scrolled: true, selector };
      }, [params.selector], params.tabId ?? null);
    case 'extractText':
      return await executeInTab((maxLength) => ({
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText.slice(0, maxLength) : '',
      }), [params.maxLength || 12000], params.tabId ?? null);
    case 'extractHtml':
      return await executeInTab((maxLength) => ({
        title: document.title,
        url: location.href,
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, maxLength) : '',
      }), [params.maxLength || 120000], params.tabId ?? null);
    case 'extractVisibleDom':
      return await executeInTab((maxItems) => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const describe = (el, index) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          const id = el.id ? `#${el.id}` : '';
          const classes = Array.from(el.classList || []).slice(0, 3).map((x) => `.${x}`).join('');
          return {
            nodeIndex: index,
            tag: el.tagName.toLowerCase(),
            selector: `${el.tagName.toLowerCase()}${id}${classes}`,
            text,
            href: el.href || null,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            role: el.getAttribute('role'),
          };
        };
        const nodes = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [contenteditable="true"]'))
          .filter(isVisible)
          .slice(0, maxItems)
          .map(describe);
        return { title: document.title, url: location.href, nodes };
      }, [params.maxItems || 200], params.tabId ?? null);
    case 'findByText':
      return await executeInTab((needle, exact, maxItems) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        if (!target) return { matches: [] };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const selectorFor = (el) => {
          if (el.id) return `#${el.id}`;
          const cls = Array.from(el.classList || []).slice(0, 2).map((x) => `.${x}`).join('');
          return `${el.tagName.toLowerCase()}${cls}`;
        };
        const elements = Array.from(document.querySelectorAll('a, button, input, select, textarea, label, summary, [role], [contenteditable="true"], p, h1, h2, h3, h4, h5, h6, span, div'));
        const matches = [];
        for (const el of elements) {
          if (!isVisible(el)) continue;
          const text = norm(el.innerText || el.textContent || el.value || '');
          if (!text) continue;
          const ok = exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
          if (!ok) continue;
          matches.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 200),
            selector: selectorFor(el),
            href: el.href || null,
            role: el.getAttribute('role'),
          });
          if (matches.length >= maxItems) break;
        }
        return { title: document.title, url: location.href, needle: target, exact, matches };
      }, [params.text || '', !!params.exact, params.maxItems || 25], params.tabId ?? null);
    case 'clickByText':
      return await runAndRemember('clickByText', (needle, exact, selector, showCue) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        if (!target) throw new Error('text is required');
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"]'));
        const candidate = elements.find((el) => {
          if (!isVisible(el)) return false;
          const text = norm(el.innerText || el.textContent || el.value || '');
          if (!text) return false;
          return exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
        });
        if (!candidate) throw new Error(`No visible element found for text: ${target}`);
        candidate.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        if (showCue) {
          const rect = candidate.getBoundingClientRect();
          const id = '__codex_bridge_mouse_cue__';
          let cue = document.getElementById(id);
          if (!cue) {
            cue = document.createElement('div');
            cue.id = id;
            cue.style.position = 'fixed';
            cue.style.left = '0';
            cue.style.top = '0';
            cue.style.width = '20px';
            cue.style.height = '20px';
            cue.style.border = '2px solid rgba(255, 120, 120, 0.95)';
            cue.style.borderRadius = '999px';
            cue.style.background = 'rgba(255, 120, 120, 0.2)';
            cue.style.boxShadow = '0 0 0 6px rgba(255, 120, 120, 0.14)';
            cue.style.zIndex = '2147483647';
            cue.style.pointerEvents = 'none';
            cue.style.transition = 'transform 0.18s ease, opacity 0.22s ease';
            document.documentElement.appendChild(cue);
          }
          cue.style.opacity = '1';
          cue.style.transform = `translate(${Math.round(rect.left + rect.width / 2 - 10)}px, ${Math.round(rect.top + rect.height / 2 - 10)}px)`;
          setTimeout(() => {
            const stillThere = document.getElementById(id);
            if (stillThere) stillThere.style.opacity = '0.35';
          }, 900);
        }
        candidate.click();
        return {
          clicked: true,
          text: target,
          exact: !!exact,
          tag: candidate.tagName.toLowerCase(),
          matchedText: norm(candidate.innerText || candidate.textContent || candidate.value || '').slice(0, 200),
        };
      }, [params.text || '', !!params.exact, params.selector || null, state.mouseCueEnabled], params.tabId ?? null, (result) => ({
        text: result?.matchedText || params.text || '',
      }));
    case 'clickNearestMatch':
      return await runAndRemember('clickNearestMatch', (needle, selector, maxItems) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle).toLowerCase();
        if (!target) throw new Error('text is required');
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const scoreText = (text) => {
          const candidate = norm(text).toLowerCase();
          if (!candidate) return -1;
          if (candidate === target) return 1000;
          if (candidate.startsWith(target)) return 800 - Math.max(0, candidate.length - target.length);
          if (candidate.includes(target)) return 600 - Math.abs(candidate.length - target.length);
          const overlap = target.split(' ').filter((part) => part && candidate.includes(part)).length;
          return overlap > 0 ? 200 + overlap : -1;
        };
        const elements = Array.from(document.querySelectorAll(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"]'))
          .filter(isVisible)
          .map((el) => {
            const text = norm(el.innerText || el.textContent || el.value || '');
            return { el, text, score: scoreText(text) };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, maxItems || 5));
        const best = elements[0];
        if (!best) throw new Error(`No visible element found for text: ${needle}`);
        best.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const rect = best.el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const targetNode = top && (best.el === top || best.el.contains(top)) ? top : best.el;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
        targetNode.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        targetNode.dispatchEvent(new MouseEvent('mousedown', eventInit));
        targetNode.dispatchEvent(new PointerEvent('pointerup', eventInit));
        targetNode.dispatchEvent(new MouseEvent('mouseup', eventInit));
        targetNode.dispatchEvent(new MouseEvent('click', eventInit));
        return {
          clicked: true,
          matchedText: best.text,
          score: best.score,
          alternatives: elements.slice(1).map((item) => ({ text: item.text.slice(0, 120), score: item.score })),
        };
      }, [params.text || '', params.selector || null, params.maxItems || 5], params.tabId ?? null, (result) => ({
        text: result?.matchedText || params.text || '',
        score: result?.score || null,
      }));
    case 'listFrames':
      return await executeInTab(() => {
        const frames = Array.from(document.querySelectorAll('iframe, frame')).map((frame, index) => ({
          index,
          tag: frame.tagName.toLowerCase(),
          id: frame.id || null,
          name: frame.getAttribute('name'),
          src: frame.getAttribute('src'),
          title: frame.getAttribute('title'),
        }));
        return { title: document.title, url: location.href, frames };
      }, [], params.tabId ?? null);
    case 'getForms':
      return await executeInTab((maxForms) => {
        const forms = Array.from(document.forms)
          .slice(0, maxForms)
          .map((form, index) => ({
            index,
            id: form.id || null,
            name: form.getAttribute('name'),
            action: form.getAttribute('action'),
            method: form.getAttribute('method') || 'get',
            fields: Array.from(form.elements).slice(0, 40).map((field) => ({
              tag: field.tagName.toLowerCase(),
              type: field.getAttribute('type'),
              name: field.getAttribute('name'),
              id: field.id || null,
              placeholder: field.getAttribute('placeholder'),
              valuePreview: String(field.value || '').slice(0, 120),
            })),
          }));
        return { title: document.title, url: location.href, forms };
      }, [params.maxForms || 20], params.tabId ?? null);
    case 'inspectUploadField':
      return await executeInTab((selector) => {
        const targetSelector = selector || 'input[type="file"]';
        const list = Array.from(document.querySelectorAll(targetSelector));
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const first = list[0] || null;
        const chosen = list.find(visible) || first;
        if (!chosen) {
          return { found: false, selector: targetSelector, totalMatches: 0, visibleMatches: 0 };
        }
        const rect = chosen.getBoundingClientRect();
        return {
          found: true,
          selector: targetSelector,
          totalMatches: list.length,
          visibleMatches: list.filter(visible).length,
          tag: chosen.tagName.toLowerCase(),
          id: chosen.id || null,
          name: chosen.getAttribute('name') || null,
          accept: chosen.getAttribute('accept') || null,
          multiple: !!chosen.multiple,
          disabled: !!chosen.disabled,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }, [params.selector || null], params.tabId ?? null);
    case 'fillFields':
      return await executeInTab((entries) => {
        const results = [];
        for (const entry of entries) {
          const selector = entry.selector || null;
          const text = entry.value ?? '';
          const checked = entry.checked;
          const el = selector ? document.querySelector(selector) : null;
          if (!el) {
            results.push({ selector, ok: false, error: 'Selector not found' });
            continue;
          }
          try {
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && typeof checked === 'boolean') {
              el.checked = checked;
            } else if (el instanceof HTMLSelectElement && entry.selectValue != null) {
              el.value = entry.selectValue;
            } else if ('value' in el) {
              el.value = text;
            } else if (el.isContentEditable) {
              el.textContent = text;
            } else {
              throw new Error('Element is not fillable');
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ selector, ok: true });
          } catch (error) {
            results.push({ selector, ok: false, error: error.message || String(error) });
          }
        }
        return { filled: results };
      }, [params.entries || []], params.tabId ?? null);
    case 'fillLoginForm':
      return await runAndRemember('fillLoginForm', (username, password, autoSubmit) => {
        const norm = (value) => String(value || '').toLowerCase();
        const bySelector = (selector) => document.querySelector(selector);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll('input, textarea')).filter(visible);
        const findUser = () => {
          const direct = bySelector('input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i]');
          if (direct && visible(direct)) return direct;
          return candidates.find((el) => {
            const t = norm(el.type);
            if (!['text', 'email', 'tel', 'search'].includes(t) && t !== '') return false;
            const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
            return /user|login|email|ім.?я|логін|пошта/i.test(hint);
          }) || candidates.find((el) => ['text', 'email', 'tel', 'search', ''].includes(norm(el.type))) || null;
        };
        const findPass = () => {
          const direct = bySelector('input[type="password"]');
          if (direct && visible(direct)) return direct;
          return candidates.find((el) => /pass|парол/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`)) || null;
        };
        const userEl = findUser();
        const passEl = findPass();
        if (!userEl) throw new Error('Username field not found');
        if (!passEl) throw new Error('Password field not found');
        userEl.focus();
        userEl.value = String(username ?? '');
        userEl.dispatchEvent(new Event('input', { bubbles: true }));
        userEl.dispatchEvent(new Event('change', { bubbles: true }));
        passEl.focus();
        passEl.value = String(password ?? '');
        passEl.dispatchEvent(new Event('input', { bubbles: true }));
        passEl.dispatchEvent(new Event('change', { bubbles: true }));
        let submitted = false;
        if (autoSubmit) {
          const form = passEl.form || userEl.form || null;
          const submitBtn = form
            ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type]), [role="button"]')
            : document.querySelector('button[type="submit"], input[type="submit"]');
          if (submitBtn && visible(submitBtn)) {
            submitBtn.click();
            submitted = true;
          } else if (form) {
            form.requestSubmit ? form.requestSubmit() : form.submit();
            submitted = true;
          }
        }
        return {
          ok: true,
          filled: true,
          submitted,
          userSelector: `${userEl.tagName.toLowerCase()}#${userEl.id || ''}.${userEl.className || ''}`.replace(/\.$/, ''),
          passSelector: `${passEl.tagName.toLowerCase()}#${passEl.id || ''}.${passEl.className || ''}`.replace(/\.$/, ''),
        };
      }, [params.username ?? '', params.password ?? '', !!params.autoSubmit], params.tabId ?? null, () => ({
        autoSubmit: !!params.autoSubmit,
      }));
    case 'submitForm':
      return await runAndRemember('submitForm', (selector) => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const pageLooksLikeTest = () => /test|quiz|exam|attempt|пройти тест|тест|іспит|екзамен|контроль/i.test([
          document.title,
          location.href,
          document.body?.innerText?.slice(0, 3000),
        ].filter(Boolean).join(' '));
        if (pageLooksLikeTest()) {
          return {
            ok: false,
            submitted: false,
            blocked: true,
            reason: 'Blocked submitForm on a test-like page. Manual confirmation in the page is required.',
          };
        }
        let target = null;
        if (selector) {
          target = document.querySelector(selector);
        } else {
          target = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type])');
        }
        if (target && visible(target)) {
          target.click();
          return { submitted: true, method: 'click', selector: selector || null };
        }
        const active = document.activeElement;
        const form = active?.form || document.querySelector('form');
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return { submitted: true, method: 'formSubmit' };
        }
        throw new Error('No submit target found');
      }, [params.selector || null], params.tabId ?? null);
    case 'getElements':
      return await executeInTab((kind, maxItems) => {
        const selectorByKind = {
          all: 'a, button, input, select, textarea',
          links: 'a[href]',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          inputs: 'input, select, textarea, [contenteditable="true"]',
        };
        const selector = selectorByKind[kind] || selectorByKind.all;
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const items = Array.from(document.querySelectorAll(selector))
          .filter(isVisible)
          .slice(0, maxItems)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            id: el.id || null,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            href: el.href || null,
            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
          }));
        return { title: document.title, url: location.href, kind, items };
      }, [params.kind || 'all', params.maxItems || 200], params.tabId ?? null);
    case 'click':
      await showMouseCue(params.selector, params.tabId ?? null, 'Click');
      {
        const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
        const result = await safeClickWithRetries(params.selector, {
          maxAttempts: params.maxAttempts || 3,
          settleMs: params.settleMs || 90,
          allowForce: params.allowForce === true,
          preferHumanEvents: params.preferHumanEvents !== false,
        }, resolvedTabId);
        recordSessionEvent(resolvedTabId, 'click', { selector: params.selector });
        return result;
      }
    case 'safeClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Safe click');
      return await runAndRemember('safeClick', async () => {
        return await safeClickWithRetries(params.selector, {
          maxAttempts: params.maxAttempts || 3,
          settleMs: params.settleMs || 90,
          allowForce: params.allowForce === true,
          preferHumanEvents: params.preferHumanEvents !== false,
        }, params.tabId ?? null);
      }, [], params.tabId ?? null, () => ({
        selector: params.selector,
        maxAttempts: params.maxAttempts || 3,
      }));
    case 'moveCursor':
      return await runAndRemember('moveCursor', (selector, steps, durationMs) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const cursorId = '__codex_bridge_cursor__';
        let cursor = document.getElementById(cursorId);
        if (!cursor) {
          cursor = document.createElement('div');
          cursor.id = cursorId;
          cursor.style.position = 'fixed';
          cursor.style.width = '12px';
          cursor.style.height = '12px';
          cursor.style.borderRadius = '999px';
          cursor.style.background = '#ff5a36';
          cursor.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.85), 0 0 18px rgba(255,90,54,0.45)';
          cursor.style.zIndex = '2147483647';
          cursor.style.pointerEvents = 'none';
          document.body.appendChild(cursor);
        }
        const startX = 18;
        const startY = 18;
        const endX = rect.left + rect.width / 2;
        const endY = rect.top + rect.height / 2;
        const frames = Math.max(3, steps || 12);
        for (let i = 0; i <= frames; i += 1) {
          const t = i / frames;
          const eased = 1 - Math.pow(1 - t, 3);
          const x = startX + (endX - startX) * eased;
          const y = startY + (endY - startY) * eased + Math.sin(t * Math.PI) * 12;
          cursor.style.transform = `translate(${x}px, ${y}px)`;
        }
        el.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: endX,
          clientY: endY,
          view: window,
        }));
        return { moved: true, selector, durationMs: durationMs || 400, steps: frames };
      }, [params.selector, params.steps || 12, params.durationMs || 400], params.tabId ?? null, () => ({
        selector: params.selector,
      }));
    case 'humanClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Click');
      return await runAndRemember('humanClick', (selector, steps, button) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const cursorId = '__codex_bridge_cursor__';
        let cursor = document.getElementById(cursorId);
        if (!cursor) {
          cursor = document.createElement('div');
          cursor.id = cursorId;
          cursor.style.position = 'fixed';
          cursor.style.width = '12px';
          cursor.style.height = '12px';
          cursor.style.borderRadius = '999px';
          cursor.style.background = '#ff5a36';
          cursor.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.85), 0 0 18px rgba(255,90,54,0.45)';
          cursor.style.zIndex = '2147483647';
          cursor.style.pointerEvents = 'none';
          document.body.appendChild(cursor);
        }
        cursor.style.transform = `translate(${x}px, ${y}px)`;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: button || 0, buttons: 1, view: window };
        el.dispatchEvent(new MouseEvent('pointerdown', eventInit));
        el.dispatchEvent(new MouseEvent('mousedown', eventInit));
        el.dispatchEvent(new MouseEvent('pointerup', eventInit));
        el.dispatchEvent(new MouseEvent('mouseup', eventInit));
        el.dispatchEvent(new MouseEvent('click', eventInit));
        return { clicked: true, selector, steps: Math.max(3, steps || 12) };
      }, [params.selector, params.steps || 12, params.button || 0], params.tabId ?? null, () => ({
        selector: params.selector,
      }));
    case 'doubleClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Double click');
      return await runAndRemember('doubleClick', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          detail: 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('dblclick', eventInit));
        if (typeof el.click === 'function') {
          el.click();
          el.click();
        }
        return { doubleClicked: true, selector };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'rightClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Right click');
      return await runAndRemember('rightClick', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 2,
          buttons: 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('contextmenu', eventInit));
        return { rightClicked: true, selector };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'hover':
      await showMouseCue(params.selector, params.tabId ?? null, 'Hover');
      return await runAndRemember('hover', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(rect.width / 2, Math.max(rect.width - 1, 1)),
          clientY: rect.top + Math.min(rect.height / 2, Math.max(rect.height - 1, 1)),
          view: window,
        };
        el.dispatchEvent(new MouseEvent('pointerover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        return { hovered: true, selector, tag: el.tagName.toLowerCase() };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'hoverInspect':
      return await runAndRemember('hoverInspect', async (selector, waitMs) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('pointerover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (node) => {
          const style = window.getComputedStyle(node);
          const bounds = node.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && bounds.height > 0;
        };
        const surfaced = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], dialog, .dropdown-menu, .menu, .popover, .tooltip'))
          .filter(isVisible)
          .slice(0, 12)
          .map((node) => ({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute('role'),
            text: norm(node.innerText || node.textContent || '').slice(0, 220),
          }));
        return { hovered: true, selector, surfaced };
      }, [params.selector, params.waitMs || 300], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'dragAndDrop':
      return await runAndRemember('dragAndDrop', (sourceSelector, targetSelector) => {
        const source = document.querySelector(sourceSelector);
        const target = document.querySelector(targetSelector);
        if (!source) throw new Error(`Source not found: ${sourceSelector}`);
        if (!target) throw new Error(`Target not found: ${targetSelector}`);
        const dataTransfer = new DataTransfer();
        const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(source, 'dragstart');
        fire(target, 'dragenter');
        fire(target, 'dragover');
        fire(target, 'drop');
        fire(source, 'dragend');
        return { moved: true, sourceSelector, targetSelector };
      }, [params.sourceSelector, params.targetSelector], params.tabId ?? null, () => ({
        sourceSelector: params.sourceSelector,
        targetSelector: params.targetSelector,
      }));
    case 'type':
      await showMouseCue(params.selector, params.tabId ?? null, 'Type');
      return await runAndRemember('type', (selector, text) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.focus();
        if ('value' in el) {
          el.value = text;
        } else if (el.isContentEditable) {
          el.textContent = text;
        } else {
          throw new Error(`Element is not typable: ${selector}`);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, selector, textLength: text.length };
      }, [params.selector, params.text], params.tabId ?? null, () => ({
        selector: params.selector,
        textLength: String(params.text || '').length,
      }));
    case 'pasteText':
      await showMouseCue(params.selector, params.tabId ?? null, 'Paste');
      return await runAndRemember('pasteText', (selector, text) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.focus();
        const normalized = String(text ?? '');
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', normalized);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
        el.dispatchEvent(pasteEvent);
        if ('value' in el) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? start;
          const before = el.value.slice(0, start);
          const after = el.value.slice(end);
          el.value = `${before}${normalized}${after}`;
        } else if (el.isContentEditable) {
          document.execCommand('insertText', false, normalized);
          if (!el.textContent?.includes(normalized)) {
            el.textContent = `${el.textContent || ''}${normalized}`;
          }
        }
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: normalized, inputType: 'insertFromPaste' }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: normalized, inputType: 'insertFromPaste' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { pasted: true, selector, textLength: normalized.length };
      }, [params.selector, params.text || ''], params.tabId ?? null, () => ({
        selector: params.selector,
        textLength: String(params.text || '').length,
      }));
    case 'typeIntoEditor':
      return await runAndRemember('typeIntoEditor', (selector, text, append) => {
        const el = selector ? document.querySelector(selector) : (document.activeElement || null);
        if (!el) throw new Error('Editor target not found');
        const normalized = String(text ?? '');
        const applyToMonaco = () => {
          const maybeEditor = el.closest('.monaco-editor');
          if (!maybeEditor) return false;
          const textarea = maybeEditor.querySelector('textarea');
          if (!textarea) return false;
          textarea.focus();
          textarea.value = append ? `${textarea.value || ''}${normalized}` : normalized;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        };
        const applyToCodeMirror = () => {
          const maybeEditor = el.closest('.CodeMirror, .cm-editor');
          if (!maybeEditor) return false;
          const content = maybeEditor.querySelector('[contenteditable=\"true\"], textarea');
          if (!content) return false;
          content.focus();
          if ('value' in content) {
            content.value = append ? `${content.value || ''}${normalized}` : normalized;
          } else {
            content.textContent = append ? `${content.textContent || ''}${normalized}` : normalized;
          }
          content.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        };
        if (!applyToMonaco() && !applyToCodeMirror()) {
          el.focus();
          if ('value' in el) {
            el.value = append ? `${el.value || ''}${normalized}` : normalized;
          } else if (el.isContentEditable) {
            el.textContent = append ? `${el.textContent || ''}${normalized}` : normalized;
          } else {
            throw new Error('Element is not editor-compatible');
          }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, selector: selector || null, textLength: normalized.length, append: !!append };
      }, [params.selector || null, params.text || '', !!params.append], params.tabId ?? null, () => ({
        selector: params.selector || null,
        textLength: String(params.text || '').length,
      }));
    case 'pressKey':
      return await executeInTab((key, ctrlKey, altKey, shiftKey, metaKey) => {
        const target = document.activeElement || document.body || document.documentElement;
        const eventInit = { key, ctrlKey, altKey, shiftKey, metaKey, bubbles: true };
        target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
        target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        if (key === 'Enter' && typeof target.click === 'function' && target.tagName === 'BUTTON') {
          target.click();
        }
        return { pressed: true, key, ctrlKey, altKey, shiftKey, metaKey };
      }, [
        params.key,
        !!params.ctrlKey,
        !!params.altKey,
        !!params.shiftKey,
        !!params.metaKey,
      ], params.tabId ?? null);
    case 'waitForSelector':
      return await executeInTab(async (selector, timeoutMs) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const el = document.querySelector(selector);
          if (el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
              return { found: true, selector, elapsedMs: Date.now() - startedAt };
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out waiting for selector: ${selector}`);
      }, [params.selector, params.timeoutMs || 10000], params.tabId ?? null);
    case 'waitForText':
      return await executeInTab(async (needle, timeoutMs, exact, selector) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const roots = selector ? Array.from(document.querySelectorAll(selector)) : [document.body];
          for (const root of roots) {
            const text = norm(root?.innerText || root?.textContent || '');
            if (!text) continue;
            const ok = exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
            if (ok) {
              return { found: true, text: target, elapsedMs: Date.now() - startedAt };
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out waiting for text: ${target}`);
      }, [params.text || '', params.timeoutMs || 10000, !!params.exact, params.selector || null], params.tabId ?? null);
    case 'selectOption':
      return await executeInTab((selector, value, label, index) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        if (!(el instanceof HTMLSelectElement)) throw new Error(`Element is not a <select>: ${selector}`);
        let matched = false;
        if (value != null) {
          el.value = value;
          matched = el.value === value;
        } else if (label != null) {
          const option = Array.from(el.options).find((opt) => opt.label === label || opt.text === label);
          if (option) {
            el.value = option.value;
            matched = true;
          }
        } else if (index != null && el.options[index]) {
          el.selectedIndex = index;
          matched = true;
        }
        if (!matched) throw new Error(`No matching option for selector: ${selector}`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: true, selector, value: el.value };
      }, [params.selector, params.value ?? null, params.label ?? null, params.index ?? null], params.tabId ?? null);
    case 'highlightElement':
      return await executeInTab((selector, color, durationMs, highlightId) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const existing = document.getElementById(highlightId);
        if (existing) existing.remove();
        const rect = el.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = highlightId;
        overlay.style.position = 'fixed';
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        overlay.style.border = `3px solid ${color}`;
        overlay.style.background = 'rgba(255,255,0,0.08)';
        overlay.style.zIndex = '2147483647';
        overlay.style.pointerEvents = 'none';
        document.body.appendChild(overlay);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        window.setTimeout(() => overlay.remove(), durationMs);
        return { highlighted: true, selector, color, durationMs };
      }, [params.selector, params.color || '#ffcc00', params.durationMs || 2000, HIGHLIGHT_ID], params.tabId ?? null);
    case 'screenshot':
      return await captureScreenshot(params.tabId ?? null);
    case 'elementScreenshot':
      return await captureElementScreenshot(params.selector, params.tabId ?? null, params.padding ?? 10);
    case 'fullPageScreenshot': {
      const data = await withDebugger(params.tabId ?? null, async (resolvedTabId) => {
        await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Page.enable');
        const shot = await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
        });
        return {
          tab: serializeTab(await chrome.tabs.get(resolvedTabId)),
          format: 'png',
          dataUrl: `data:image/png;base64,${shot.data}`,
        };
      });
      return data;
    }
    case 'copyPageContent': {
      const mode = normalizeCopyMode(params.mode);
      const extracted = await executeInTab((copyMode, maxLength) => {
        const text = document.body ? document.body.innerText.slice(0, maxLength) : '';
        const html = document.documentElement ? document.documentElement.outerHTML.slice(0, maxLength) : '';
        return {
          title: document.title,
          url: location.href,
          text,
          html,
          selected: copyMode === 'html' ? html : text,
        };
      }, [mode, params.maxLength || 250000], params.tabId ?? null);
      await writeClipboardText(extracted.selected);
      return {
        copied: true,
        mode,
        title: extracted.title,
        url: extracted.url,
        textLength: extracted.text.length,
        htmlLength: extracted.html.length,
      };
    }
    case 'selectText':
      return await executeInTab((selector, textNeedle) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        let el = null;
        if (selector) {
          el = document.querySelector(selector);
        } else if (textNeedle) {
          const needle = norm(textNeedle).toLowerCase();
          el = Array.from(document.querySelectorAll('body *')).find((node) => {
            const text = norm(node.innerText || node.textContent || '');
            if (!text) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0 &&
              text.toLowerCase().includes(needle);
          }) || null;
        }
        if (!el) throw new Error('No matching element to select text from');
        const selection = window.getSelection();
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
        const text = selection.toString();
        return { selected: true, textLength: text.length, text: text.slice(0, 500) };
      }, [params.selector || null, params.text || null], params.tabId ?? null);
    case 'selectTextByDrag':
      return await runAndRemember('selectTextByDrag', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const selection = window.getSelection();
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
        const rect = el.getBoundingClientRect();
        const start = { x: rect.left + 4, y: rect.top + 4 };
        const end = { x: rect.right - 4, y: rect.bottom - 4 };
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: start.x, clientY: start.y, view: window }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: end.x, clientY: end.y, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: end.x, clientY: end.y, view: window }));
        return { selected: true, selector, text: selection.toString().slice(0, 500), textLength: selection.toString().length };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'copySelectedText': {
      const selected = await executeInTab(() => {
        const text = window.getSelection ? window.getSelection().toString() : '';
        return { text };
      }, [], params.tabId ?? null);
      await writeClipboardText(selected.text || '');
      return { copied: true, textLength: (selected.text || '').length, text: (selected.text || '').slice(0, 500) };
    }
    case 'getStorage':
      return await executeInTab((which) => {
        const fromStorage = (storage) => {
          const data = {};
          for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i);
            data[key] = storage.getItem(key);
          }
          return data;
        };
        const mode = which === 'session' ? 'session' : which === 'all' ? 'all' : 'local';
        return {
          title: document.title,
          url: location.href,
          mode,
          localStorage: mode === 'session' ? undefined : fromStorage(window.localStorage),
          sessionStorage: mode === 'local' ? undefined : fromStorage(window.sessionStorage),
        };
      }, [params.storage || 'all'], params.tabId ?? null);
    case 'extractTables':
      return await executeInTab((maxTables, maxRows) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const tables = Array.from(document.querySelectorAll('table'))
          .slice(0, maxTables)
          .map((table, index) => {
            const rows = Array.from(table.querySelectorAll('tr'));
            const headers = Array.from(table.querySelectorAll('th'))
              .slice(0, 40)
              .map((cell) => norm(cell.innerText || cell.textContent || ''))
              .filter(Boolean);
            const bodyRows = rows
              .slice(0, maxRows)
              .map((row) => Array.from(row.cells).map((cell) => norm(cell.innerText || cell.textContent || '')).slice(0, 20))
              .filter((cells) => cells.some(Boolean));
            return {
              index,
              caption: norm(table.caption?.innerText || table.caption?.textContent || ''),
              headers,
              rowCount: rows.length,
              rows: bodyRows,
            };
          });
        return { title: document.title, url: location.href, tables };
      }, [params.maxTables || 10, params.maxRows || 20], params.tabId ?? null);
    case 'canvasInspect':
      return await inspectCanvas(params.maxItems || 5, !!params.includeDataUrl, params.tabId ?? null);
    case 'pageOverview':
      return await executeInTab(() => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 20)
          .map((el) => ({
            level: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 200),
          }))
          .filter((item) => item.text);
        const landmarks = ['header', 'nav', 'main', 'aside', 'footer', '[role="dialog"]', '[role="main"]', '[role="navigation"]']
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => ({
            selector,
            tag: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 120),
          })))
          .slice(0, 20);
        return {
          title: document.title,
          url: location.href,
          lang: document.documentElement?.lang || null,
          headingCount: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
          linkCount: document.links.length,
          formCount: document.forms.length,
          frameCount: document.querySelectorAll('iframe, frame').length,
          buttonCount: document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length,
          headings,
          landmarks,
        };
      }, [], params.tabId ?? null);
    case 'pageSummary':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 14)));
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 14)))
          .map((el) => ({ level: el.tagName.toLowerCase(), text: norm(el.innerText || el.textContent || '').slice(0, 180) }))
          .filter((item) => item.text);
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], .modal, .dialog, .popover, .toast'))
          .filter(visible)
          .slice(0, 8)
          .map((el) => norm(el.innerText || el.textContent || '').slice(0, 180))
          .filter(Boolean);
        const summary = [
          `Title: ${document.title || '(untitled)'}`,
          `URL: ${location.href}`,
          `Headings: ${headings.length}`,
          `Controls: ${controls.length}`,
          `Forms: ${document.forms.length}`,
          `Modals: ${modals.length}`,
        ];
        return {
          title: document.title,
          url: location.href,
          summary,
          summaryText: summary.join(' | '),
          headings,
          controls: controls.map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 120),
            placeholder: el.getAttribute('placeholder') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
          })),
          modals,
        };
      }, [{ maxItems: params.maxItems || 14 }], params.tabId ?? null);
    case 'pageQuestionMap':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const labelFor = (el, root) => {
          const parts = [];
          if (el?.id) {
            for (const label of Array.from(root.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el?.closest?.('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' ') || el?.getAttribute?.('aria-label') || el?.value || '');
        };
        const requestedNumber = Number.isFinite(Number(options.questionNumber))
          ? Number(options.questionNumber)
          : null;
        const maxQuestions = Math.max(1, Number(options.maxQuestions || 100));
        const includeOptions = options.includeOptions !== false || requestedNumber != null;
        const instructionCandidates = Array.from(document.querySelectorAll('.test_instruction, .question, .prompt, .item-title'))
          .filter(visible)
          .map((instruction) => {
            const heading = instruction.querySelector('h1, h2, h3, h4, h5, h6, legend') || instruction;
            const headingText = norm(heading.innerText || heading.textContent || '');
            const match = headingText.match(/(?:Запитання|Question)\s*(\d{1,3})/i);
            return match ? { instruction, heading, headingText, number: Number(match[1]) } : null;
          })
          .filter(Boolean)
          .filter((item) => requestedNumber == null || item.number === requestedNumber);
        const instructions = Array.from(new Map(
          instructionCandidates.map((item) => [item.number, item]),
        ).values()).slice(0, maxQuestions);
        const questions = instructions.map((item) => {
          const scopes = [];
          let sibling = item.instruction.nextElementSibling;
          let guard = 0;
          while (sibling && guard < 8) {
            guard += 1;
            if (sibling.matches?.('.test_instruction, .question, .prompt, .item-title')) break;
            if (visible(sibling)) scopes.push(sibling);
            sibling = sibling.nextElementSibling;
          }
          const roots = scopes.length ? scopes : [item.instruction];
          const controls = roots.flatMap((root) => Array.from(root.querySelectorAll('input, select, textarea, button, [contenteditable="true"], [role="radio"], [role="checkbox"]')))
            .filter((el, index, list) => visible(el) && list.indexOf(el) === index);
          const prompts = roots.flatMap((root) => Array.from(root.querySelectorAll('p, legend, [role="radiogroup"], [role="group"]')))
            .map((el) => norm(el.getAttribute('aria-label') || el.innerText || el.textContent || ''))
            .filter(Boolean);
          const choiceControls = controls.filter((el) => {
            const type = String(el.getAttribute('type') || '').toLowerCase();
            const role = String(el.getAttribute('role') || '').toLowerCase();
            return type === 'radio' || type === 'checkbox' || role === 'radio' || role === 'checkbox';
          });
          const selected = choiceControls.filter((el) => ('checked' in el ? !!el.checked : el.getAttribute('aria-checked') === 'true'));
          const optionsList = includeOptions ? choiceControls.map((el, index) => {
            const localRoot = roots.find((root) => root.contains(el)) || roots[0];
            return {
            index,
            label: labelFor(el, localRoot).slice(0, 180),
            name: el.getAttribute('name') || null,
            type: el.getAttribute('type') || el.getAttribute('role') || null,
            checked: 'checked' in el ? !!el.checked : el.getAttribute('aria-checked') === 'true',
            unanswered: String(el.getAttribute('value') || '') === '-1' || /залишити без відповіді|leave unanswered/i.test(labelFor(el, localRoot)),
            };
          }) : [];
          const groupNames = Array.from(new Set(choiceControls.map((el) => el.getAttribute('name')).filter(Boolean)));
          const kind = choiceControls.some((el) => String(el.getAttribute('type') || '').toLowerCase() === 'checkbox')
            ? 'checkbox'
            : choiceControls.length
              ? 'radio'
              : controls.some((el) => ['select', 'textarea'].includes(el.tagName.toLowerCase()) || ['text', 'number'].includes(String(el.getAttribute('type') || '').toLowerCase()))
                ? 'field'
                : 'unknown';
          return {
            regionId: `question:${item.number}`,
            number: item.number,
            heading: item.headingText.slice(0, 180),
            prompt: (prompts[0] || norm(roots.map((root) => root.innerText || root.textContent || '').join(' '))).slice(0, requestedNumber != null ? 600 : 220),
            kind,
            groupNames,
            controlCount: controls.length,
            optionCount: choiceControls.length,
            selected: selected.map((el) => labelFor(el, roots.find((root) => root.contains(el)) || roots[0]).slice(0, 180)),
            answered: selected.some((el) => String(el.getAttribute('value') || '') !== '-1'),
            options: optionsList,
          };
        });
        return {
          ok: questions.length > 0,
          scoped: questions.length > 0,
          title: document.title,
          url: location.href,
          questionCount: questions.length,
          availableNumbers: questions.map((question) => question.number),
          questions,
          example: {
            inspect: { action: 'pageQuestionMap', params: { questionNumber: questions[0]?.number || 1 } },
            click: { action: 'clickWithinSection', params: { sectionNeedle: `Запитання ${questions[0]?.number || 1}`, controlNeedle: '<local control label>' } },
          },
          summaryText: questions.map((question) => `Q${question.number}:${question.kind}:${question.answered ? 'answered' : 'unanswered'}`).join(' | '),
        };
      }, [{
        questionNumber: params.questionNumber ?? params.question_number ?? params.number ?? null,
        maxQuestions: params.maxQuestions || 100,
        includeOptions: params.includeOptions !== false,
      }], params.tabId ?? null);
    case 'pageSectionReader':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const sectionSelector = 'main, article, section, nav, aside, dialog, form, header, footer';
        const sections = Array.from(document.querySelectorAll(sectionSelector))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 20)))
          .map((el, index) => {
            const heading = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))
              .find((node) => visible(node));
            const buttons = el.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length;
            const inputs = el.querySelectorAll('input, select, textarea, [contenteditable="true"]').length;
            const text = norm(el.innerText || el.textContent || '').slice(0, 320);
            const rect = el.getBoundingClientRect();
            return {
              index,
              kind: el.tagName.toLowerCase(),
              heading: heading ? norm(heading.innerText || heading.textContent || '').slice(0, 140) : (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 140),
              selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
              text,
              buttons,
              inputs,
              links: el.querySelectorAll('a[href]').length,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const byHeading = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 20)))
          .map((el) => ({
            heading: norm(el.innerText || el.textContent || '').slice(0, 140),
            level: el.tagName.toLowerCase(),
            selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
          }))
          .filter((item) => item.heading);
        return {
          title: document.title,
          url: location.href,
          sections,
          headings: byHeading,
        };
      }, [{ maxItems: params.maxItems || 20 }], params.tabId ?? null);
    case 'scopeToSection':
    case 'listSectionControls':
    case 'describeSection':
    case 'clickWithinSection':
    case 'fillWithinSection':
      return await executeInTab((payload) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const CANONICAL_CHAR_MAP = {
          'а': 'a', 'a': 'a',
          'е': 'e', 'e': 'e',
          'о': 'o', 'o': 'o',
          'р': 'p', 'p': 'p',
          'с': 'c', 'c': 'c',
          'у': 'y', 'y': 'y',
          'х': 'x', 'x': 'x',
          'і': 'i', 'i': 'i', 'ї': 'i', 'ï': 'i',
          'к': 'k', 'k': 'k',
          'м': 'm', 'm': 'm',
          'т': 't', 't': 't',
          'в': 'b', 'b': 'b',
          'н': 'h', 'h': 'h',
        };
        const canonical = (value) => {
          const source = lower(value);
          let result = '';
          for (const char of source) {
            result += CANONICAL_CHAR_MAP[char] || char;
          }
          return result;
        };
        const tokenize = (value) => canonical(value)
          .replace(/[^a-z0-9а-яіїєґ]+/gi, ' ')
          .split(/\s+/)
          .map((part) => part.trim())
          .filter(Boolean);
        const tokenOverlapScore = (haystackText, needleText) => {
          const hayTokens = tokenize(haystackText);
          const needleTokens = tokenize(needleText);
          if (!hayTokens.length || !needleTokens.length) return 0;
          let score = 0;
          for (const token of needleTokens) {
            if (hayTokens.includes(token)) {
              score += 180;
            } else if (hayTokens.some((part) => part.startsWith(token) || token.startsWith(part))) {
              score += 110;
            } else if (hayTokens.some((part) => part.includes(token) || token.includes(part))) {
              score += 70;
            }
          }
          if (needleTokens.length > 1) {
            const joinedNeedle = needleTokens.join(' ');
            const joinedHay = hayTokens.join(' ');
            if (joinedHay.includes(joinedNeedle)) score += 260;
          }
          return score;
        };
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const resolveToggleTarget = (el) => {
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          if ((tag === 'input' && (type === 'radio' || type === 'checkbox')) || role === 'radio' || role === 'checkbox') {
            return el;
          }
          if (tag === 'label') {
            if (el.htmlFor) {
              const linked = document.getElementById(el.htmlFor);
              if (linked) return linked;
            }
            const nested = el.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
            if (nested) return nested;
          }
          return null;
        };
        const readToggleState = (el) => {
          if (!el) return null;
          if ('checked' in el) return !!el.checked;
          const ariaChecked = el.getAttribute?.('aria-checked');
          if (ariaChecked === 'true') return true;
          if (ariaChecked === 'false') return false;
          return null;
        };
        const dispatchVerifiedClick = (el) => {
          const rect = el.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          el.focus?.();
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.click?.();
        };
        const clickWithVerification = (el) => {
          const toggleTarget = resolveToggleTarget(el);
          const before = readToggleState(toggleTarget);
          dispatchVerifiedClick(el);
          if (toggleTarget && readToggleState(toggleTarget) !== true && toggleTarget !== el) {
            dispatchVerifiedClick(toggleTarget);
          }
          const after = readToggleState(toggleTarget);
          if (toggleTarget) {
            const verified = after === true || (before !== null && after !== null && before !== after);
            return {
              ok: verified,
              verification: {
                kind: 'toggle',
                before,
                after,
                selector: selectorFor(toggleTarget),
              },
              reason: verified ? '' : 'Click was dispatched, but the radio/checkbox state did not change as expected.',
            };
          }
          return {
            ok: true,
            verification: {
              kind: 'click',
              before: null,
              after: null,
              selector: selectorFor(el),
            },
            reason: '',
          };
        };
        const labelTextFor = (el, root = document) => {
          const parts = [];
          if (el?.id) {
            for (const label of Array.from(root.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el?.closest?.('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          const ariaLabelledBy = el?.getAttribute?.('aria-labelledby');
          if (ariaLabelledBy) {
            for (const id of ariaLabelledBy.split(/\s+/).filter(Boolean)) {
              const node = document.getElementById(id);
              if (node) parts.push(node.innerText || node.textContent || '');
            }
          }
          return norm(parts.join(' '));
        };
        const summarizeControl = (el, index, root) => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || null;
          const role = el.getAttribute('role') || null;
          const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 160);
          const label = labelTextFor(el, root).slice(0, 160);
          const ariaLabel = norm(el.getAttribute('aria-label') || '').slice(0, 160);
          const rowText = norm(el.closest('li, tr, .row, .multichoice-question, fieldset, section, article')?.innerText || '').slice(0, 220);
          const groupText = norm(el.closest('[role="radiogroup"], [role="group"], ul, ol')?.getAttribute?.('aria-label') || '').slice(0, 180);
          const rect = el.getBoundingClientRect();
          return {
            index,
            tag,
            type,
            role,
            selector: selectorFor(el),
            text,
            label,
            ariaLabel,
            rowText,
            groupText,
            id: el.id || null,
            name: el.getAttribute('name') || null,
            placeholder: el.getAttribute('placeholder') || null,
            checked: 'checked' in el ? !!el.checked : null,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const controlQuery = 'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="radio"], [role="checkbox"], summary, label';
        const anchorQuery = 'h1, h2, h3, h4, h5, h6, legend, summary, label, .question, .prompt, .item-title, p, li, td, th, span, div';
        const sectionNeedle = lower(payload.sectionNeedle || payload.needle || payload.section || payload.heading || '');
        const exact = payload.exact === true;
        const maxItems = Math.max(1, Number(payload.maxItems || 30));
        const containerSelectors = [
          'fieldset',
          'section',
          'article',
          'form',
          'li',
          'tr',
          'div',
          'main',
        ];
        const visibleControlsIn = (container) => Array.from(container.querySelectorAll(controlQuery)).filter(visible);
        const domDepth = (node) => {
          let depth = 0;
          let current = node;
          while (current && current.parentElement) {
            depth += 1;
            current = current.parentElement;
          }
          return depth;
        };
        const expandSectionScopes = (anchor, container) => {
          const scopes = [];
          const addScope = (node) => {
            if (!node || !visible(node) || scopes.includes(node)) return;
            scopes.push(node);
          };
          addScope(container);
          const containerControls = visibleControlsIn(container);
          const anchorTag = anchor.tagName?.toLowerCase?.() || '';
          const shouldExpandToSibling = containerControls.length === 0
            || container.classList?.contains?.('test_instruction')
            || /^h[1-6]$/.test(anchorTag)
            || container.querySelector('.test_instruction');
          if (!shouldExpandToSibling) return scopes;
          let sibling = container.nextElementSibling;
          let safety = 0;
          while (sibling && safety < 6) {
            safety += 1;
            if (!visible(sibling)) {
              sibling = sibling.nextElementSibling;
              continue;
            }
            if (sibling.classList?.contains?.('test_instruction')) break;
            addScope(sibling);
            if (visibleControlsIn(sibling).length > 0) break;
            sibling = sibling.nextElementSibling;
          }
          return scopes;
        };
        const findSection = () => {
          if (!sectionNeedle) return null;
          const sectionNeedleCanonical = canonical(sectionNeedle);
          const extractQuestionNumber = (text) => {
            const match = String(text || '').match(/\b(\d{1,3})\b/);
            return match ? Number(match[1]) : null;
          };
          const sectionQuestionNumber = extractQuestionNumber(sectionNeedle);
          const anchors = Array.from(document.querySelectorAll(anchorQuery)).filter(visible);
          const candidates = [];
          for (const anchor of anchors) {
            const anchorText = lower(anchor.innerText || anchor.textContent || '');
            const anchorCanonical = canonical(anchorText);
            const anchorQuestionNumber = extractQuestionNumber(anchorText);
            if (!anchorText) continue;
            let score = 0;
            if (sectionQuestionNumber != null && anchorQuestionNumber != null) {
              if (sectionQuestionNumber !== anchorQuestionNumber) continue;
              score += 7000;
            }
            if (anchorText === sectionNeedle) score += 5000;
            if (anchorText.startsWith(sectionNeedle)) score += 2500;
            if (anchorText.includes(sectionNeedle)) score += 1500;
            if (anchorCanonical === sectionNeedleCanonical) score += 4500;
            if (anchorCanonical.startsWith(sectionNeedleCanonical)) score += 2200;
            if (anchorCanonical.includes(sectionNeedleCanonical)) score += 1300;
            if (exact && anchorText !== sectionNeedle) continue;
            if (score <= 0) continue;
            let container = anchor.closest('.test_instruction, .question, .prompt, .item-title');
            if (!container || !visible(container)) {
              const nearestContainers = containerSelectors
                .map((selector) => anchor.closest(selector))
                .filter((match, index, list) => match && visible(match) && list.indexOf(match) === index)
                .sort((a, b) => domDepth(b) - domDepth(a));
              container = nearestContainers[0] || null;
            }
            container = container || anchor.parentElement || anchor;
            if (!container || !visible(container)) continue;
            const scopes = expandSectionScopes(anchor, container);
            const controls = scopes.flatMap((scope) => visibleControlsIn(scope)).filter((el, idx, list) => list.indexOf(el) === idx);
            score += Math.min(controls.length, 15) * 40;
            if (controls.length > 0) score += 500;
            if (/^h[1-6]$/.test(anchor.tagName.toLowerCase()) || anchor.tagName.toLowerCase() === 'legend') score += 600;
            candidates.push({ anchor, container, primaryScope: scopes[0] || container, scopes, score, controls });
          }
          candidates.sort((a, b) => b.score - a.score);
          return candidates[0] || null;
        };
        const sectionMatch = findSection();
        if (!sectionMatch) {
          return {
            ok: false,
            reason: sectionNeedle ? `No visible section found for: ${sectionNeedle}` : 'Missing section needle',
          };
        }
        const sectionEl = sectionMatch.container;
        const sectionScopes = sectionMatch.scopes?.length ? sectionMatch.scopes : [sectionEl];
        const primarySectionEl = sectionMatch.primaryScope || sectionEl;
        const sectionControls = sectionMatch.controls.slice(0, maxItems);
        const getSectionSelectionState = (clickedElement = null) => {
          const clickedToggle = resolveToggleTarget(clickedElement);
          const clickedName = clickedToggle?.getAttribute?.('name') || '';
          const clickedGroup = clickedToggle?.closest?.('[role="radiogroup"], [role="group"], ul, ol, fieldset') || null;
          let radios = [];
          if (clickedName) {
            radios = sectionScopes.flatMap((scope) => Array.from(scope.querySelectorAll(`input[name="${CSS.escape(clickedName)}"]`)));
            if (!radios.length && clickedGroup) {
              radios = Array.from(clickedGroup.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
            }
          } else if (clickedGroup) {
            radios = Array.from(clickedGroup.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
          } else {
            radios = sectionScopes.flatMap((scope) => Array.from(scope.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')));
          }
          radios = radios
            .filter((el, idx, list) => list.indexOf(el) === idx);
          const selected = radios.find((el) => {
            if ('checked' in el) return !!el.checked;
            return el.getAttribute?.('aria-checked') === 'true';
          });
          if (!selected) {
            return {
              hasSelectableControls: radios.length > 0,
              selected: null,
            };
          }
          const label = labelTextFor(selected, primarySectionEl)
            || norm(selected.closest('label')?.innerText || selected.closest('li, tr, .row, .multichoice-question')?.innerText || '')
            || norm(selected.getAttribute('aria-label') || '');
          return {
            hasSelectableControls: radios.length > 0,
            selected: {
              selector: selectorFor(selected),
              id: selected.id || null,
              name: selected.getAttribute('name') || null,
              value: selected.getAttribute('value') || null,
              label: label.slice(0, 220),
              isUnanswered: (selected.getAttribute('value') || '') === '-1' || canonical(label).includes(canonical('залишити без відповіді')),
            },
          };
        };
        const sectionSummary = {
          ok: true,
          section: {
            heading: norm(sectionMatch.anchor.innerText || sectionMatch.anchor.textContent || '').slice(0, 180),
            selector: selectorFor(primarySectionEl),
            anchorSelector: selectorFor(sectionMatch.anchor),
            kind: primarySectionEl.tagName.toLowerCase(),
            text: norm(sectionScopes.map((scope) => scope.innerText || scope.textContent || '').join(' ')).slice(0, 500),
            controls: sectionControls.length,
            scopeCount: sectionScopes.length,
            links: sectionScopes.reduce((sum, scope) => sum + scope.querySelectorAll('a[href]').length, 0),
            buttons: sectionScopes.reduce((sum, scope) => sum + scope.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length, 0),
            inputs: sectionScopes.reduce((sum, scope) => sum + scope.querySelectorAll('input, select, textarea, [contenteditable="true"]').length, 0),
          },
          controls: sectionControls.map((el, index) => summarizeControl(el, index, sectionEl)),
        };
        if (payload.mode === 'scope' || payload.commandName === 'scopeToSection') {
          return sectionSummary;
        }
        if (payload.mode === 'describe' || payload.commandName === 'describeSection') {
          return {
            ...sectionSummary,
            summaryText: sectionControls
              .slice(0, 12)
              .map((el, index) => {
                const control = summarizeControl(el, index, sectionEl);
                return `${control.index}: ${control.tag}${control.type ? `:${control.type}` : ''} ${control.label || control.text || control.selector}`;
              })
              .join(' | '),
          };
        }
        if (payload.mode === 'list' || payload.commandName === 'listSectionControls') {
          return sectionSummary;
        }
        if (payload.mode === 'click' || payload.commandName === 'clickWithinSection') {
          const controlNeedle = lower(payload.controlNeedle || payload.control || payload.intent || payload.needle || '');
          const sectionNeedleForClick = lower(payload.sectionNeedle || '');
          const controlNeedleCanonical = canonical(controlNeedle);
          const sectionNeedleCanonical = canonical(sectionNeedleForClick);
          const controlIndex = Number.isFinite(Number(payload.controlIndex ?? payload.index)) ? Number(payload.controlIndex ?? payload.index) : null;
          const pageLooksLikeTestForSectionClick = () => /test|quiz|exam|attempt|пройти тест|тест|іспит|екзамен|контроль/i.test([
            document.title,
            location.href,
            norm(document.body?.innerText || '').slice(0, 4000),
          ].join(' '));
          const finalizeNeedle = [sectionNeedleForClick, controlNeedle].filter(Boolean).join(' ');
          if (
            pageLooksLikeTestForSectionClick()
            && /(submit|send|finish|final|complete|turn in|відправ|надісл|заверш|закінч|здати|зберегти відповід|пройти тест|завершити тест)/i.test(finalizeNeedle)
          ) {
            return {
              ok: false,
              blocked: true,
              reason: 'Blocked finalize/submit click on a test-like page.',
              section: sectionSummary.section,
              controls: sectionSummary.controls,
            };
          }
          if (!sectionNeedleForClick) {
            return {
              ok: false,
              reason: 'clickWithinSection requires sectionNeedle so the action stays inside a specific visible section.',
              controls: sectionSummary.controls,
            };
          }
          if (controlNeedle && sectionNeedleCanonical === controlNeedleCanonical) {
            return {
              ok: false,
              reason: 'sectionNeedle matches controlNeedle. sectionNeedle should name the section or question, while controlNeedle should name the local option to click.',
              section: sectionSummary.section,
              controls: sectionSummary.controls,
            };
          }
          const scored = sectionControls.map((el, idx) => {
            const summary = summarizeControl(el, idx, sectionEl);
            const hay = lower([
              summary.text,
              summary.label,
              summary.ariaLabel,
              summary.rowText,
              summary.groupText,
              summary.selector,
              summary.id,
              summary.name,
              summary.placeholder,
            ].filter(Boolean).join(' '));
            const hayCanonical = canonical(hay);
            let score = 0;
            if (controlIndex != null && idx === controlIndex) score += 4000;
            if (controlNeedle) {
              if (hay === controlNeedle) score += 2000;
              if (hay.startsWith(controlNeedle)) score += 1200;
              if (hay.includes(controlNeedle)) score += 800;
              if (hayCanonical === controlNeedleCanonical) score += 1900;
              if (hayCanonical.startsWith(controlNeedleCanonical)) score += 1100;
              if (hayCanonical.includes(controlNeedleCanonical)) score += 750;
              score += tokenOverlapScore(hay, controlNeedle);
            }
            return { el, idx, score, summary };
          }).filter((item) => item.score > 0 || (controlIndex != null && item.idx === controlIndex)).sort((a, b) => b.score - a.score);
          const chosen = scored[0]?.el || (controlIndex != null ? sectionControls[controlIndex] : null);
          if (!chosen) {
            return {
              ok: false,
              reason: controlNeedle ? `No matching control found inside section: ${controlNeedle}` : 'No control specified inside section',
              section: sectionSummary.section,
              controls: sectionSummary.controls,
            };
          }
          const clickResult = clickWithVerification(chosen);
          const selectionState = getSectionSelectionState(chosen);
          let sectionVerified = clickResult.ok;
          let sectionReason = clickResult.reason;
          if (selectionState.hasSelectableControls) {
            if (!selectionState.selected) {
              sectionVerified = false;
              sectionReason = 'A click was dispatched inside the section, but no option became selected.';
            } else if (selectionState.selected.isUnanswered) {
              sectionVerified = false;
              sectionReason = 'The section still has "Leave unanswered" selected after the click.';
            } else if (controlNeedle) {
              const sameSelectedElement = Boolean(
                clickResult.verification?.selector
                && selectionState.selected.selector
                && clickResult.verification.selector === selectionState.selected.selector
              );
              const selectedHay = lower([
                selectionState.selected.label,
                selectionState.selected.value,
                selectionState.selected.id,
              ].filter(Boolean).join(' '));
              const selectedCanonical = canonical(selectedHay);
              const selectedScore = tokenOverlapScore(selectedHay, controlNeedle)
                + (selectedHay.includes(controlNeedle) ? 600 : 0)
                + (selectedCanonical.includes(controlNeedleCanonical) ? 550 : 0);
              if (!sameSelectedElement && selectedScore <= 0) {
                sectionVerified = false;
                sectionReason = `A different option appears selected inside the section: ${selectionState.selected.label || selectionState.selected.selector}`;
              }
            }
          }
          return {
            ok: sectionVerified,
            reason: sectionReason,
            section: sectionSummary.section,
            clicked: summarizeControl(chosen, scored[0]?.idx ?? controlIndex ?? 0, sectionEl),
            verification: {
              ...clickResult.verification,
              sectionSelection: selectionState.selected,
            },
          };
        }
        if (payload.mode === 'fill' || payload.commandName === 'fillWithinSection') {
          const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
          const editable = sectionControls.filter((el) => {
            const tag = el.tagName.toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select' || el.getAttribute('contenteditable') === 'true';
          });
          const optionLike = sectionControls.filter((el) => {
            const tag = el.tagName.toLowerCase();
            const type = (el.getAttribute('type') || '').toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            return type === 'radio' || type === 'checkbox' || role === 'radio' || role === 'checkbox' || tag === 'label';
          });
          if (!Object.keys(fields).length) {
            return {
              ok: false,
              reason: 'No fields were provided for fillWithinSection. Use clickWithinSection for option-style sections or pass a fields object for real inputs.',
              section: sectionSummary.section,
              controls: sectionSummary.controls,
            };
          }
          if (!editable.length) {
            return {
              ok: false,
              reason: optionLike.length
                ? 'This section looks like selectable options (radio/checkbox/label), not fillable text fields. Use clickWithinSection instead of fillWithinSection.'
                : 'No editable fields were found inside this section.',
              section: sectionSummary.section,
              controls: sectionSummary.controls,
            };
          }
          const updates = [];
          for (const [fieldNeedleRaw, fieldValue] of Object.entries(fields)) {
            const fieldNeedle = lower(fieldNeedleRaw);
            const ranked = editable.map((el, idx) => {
              const info = summarizeControl(el, idx, sectionEl);
              const hay = lower([
                info.label,
                info.text,
                info.selector,
                info.id,
                info.name,
                info.placeholder,
              ].filter(Boolean).join(' '));
              let score = 0;
              if (hay === fieldNeedle) score += 2000;
              if (hay.startsWith(fieldNeedle)) score += 1200;
              if (hay.includes(fieldNeedle)) score += 800;
              return { el, info, score };
            }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
            const chosen = ranked[0]?.el || null;
            if (!chosen) {
              updates.push({ field: fieldNeedleRaw, ok: false, reason: 'No matching field in section' });
              continue;
            }
            const value = String(fieldValue ?? '');
            chosen.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            chosen.focus?.();
            if (chosen.tagName.toLowerCase() === 'select') {
              const option = Array.from(chosen.options || []).find((opt) => lower(opt.textContent || opt.value || '') === lower(value) || lower(opt.textContent || opt.value || '').includes(lower(value)));
              if (option) {
                chosen.value = option.value;
              } else {
                chosen.value = value;
              }
            } else if (chosen.getAttribute('contenteditable') === 'true') {
              chosen.textContent = value;
            } else {
              chosen.value = value;
            }
            chosen.dispatchEvent(new Event('input', { bubbles: true }));
            chosen.dispatchEvent(new Event('change', { bubbles: true }));
            updates.push({ field: fieldNeedleRaw, ok: true, selector: selectorFor(chosen), value });
          }
          return {
            ok: updates.some((item) => item.ok),
            reason: updates.some((item) => item.ok)
              ? ''
              : optionLike.length
                ? 'No matching editable fields were updated. This section appears to contain selectable options, so clickWithinSection is likely the correct tool.'
                : 'No matching editable fields were updated inside this section.',
            section: sectionSummary.section,
            updates,
          };
        }
        return {
          ok: false,
          reason: `Unsupported section mode: ${payload.mode || payload.commandName || 'unknown'}`,
        };
      }, [{
        sectionNeedle: normalizedAction === 'clickWithinSection' || normalizedAction === 'fillWithinSection'
          ? (
            params.sectionNeedle
            || params.section_needle
            || params.sectionSelector
            || params.section_selector
            || params.section
            || params.heading
            || params.question
            || (params.questionNumber != null || params.question_number != null ? `Запитання ${params.questionNumber ?? params.question_number}` : null)
          )
          : (params.sectionNeedle || params.section_needle || params.sectionSelector || params.section_selector || params.needle || params.section || params.heading || null),
        controlNeedle: params.controlNeedle || params.control_needle || params.controlSelector || params.control_selector || params.control || (normalizedAction === 'clickWithinSection' ? params.needle : null) || null,
        controlIndex: params.controlIndex ?? params.control_index ?? null,
        index: params.index ?? null,
        exact: !!params.exact,
        fields: params.fields || null,
        maxItems: params.maxItems || 30,
        mode: normalizedAction === 'scopeToSection'
          ? 'scope'
          : normalizedAction === 'listSectionControls'
            ? 'list'
            : normalizedAction === 'clickWithinSection'
              ? 'click'
              : normalizedAction === 'fillWithinSection'
                ? 'fill'
                : 'describe',
        commandName: normalizedAction,
      }], params.tabId ?? null);
    case 'modalDetector':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const modalSelectors = [
          '[role="dialog"]',
          '[role="alertdialog"]',
          'dialog',
          '[aria-modal="true"]',
          '.modal',
          '.dialog',
          '.popover',
          '.toast',
          '.dropdown-menu',
          '.menu',
          '.overlay',
        ];
        const modals = modalSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => {
          if (!visible(el)) return null;
          const rect = el.getBoundingClientRect();
          const closeButtons = Array.from(el.querySelectorAll('button, [role="button"], [aria-label], [title]'))
            .filter(visible)
            .map((btn) => norm([
              btn.innerText,
              btn.textContent,
              btn.getAttribute('aria-label'),
              btn.getAttribute('title'),
              btn.getAttribute('value'),
            ].filter(Boolean).join(' ')))
            .filter(Boolean)
            .slice(0, 10);
          return {
            selector,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            text: norm(el.innerText || el.textContent || '').slice(0, 240),
            id: el.id || null,
            className: typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join(' ') : null,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            closeButtons,
          };
        }).filter(Boolean)).slice(0, Math.max(1, Number(options.maxItems || 12)));
        return {
          title: document.title,
          url: location.href,
          count: modals.length,
          modals,
        };
      }, [{ maxItems: params.maxItems || 12 }], params.tabId ?? null);
    case 'repeatedElementMatcher':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorMap = {
          all: 'a[href], button, input, select, textarea, [contenteditable="true"], [role], li, article, section, div, span',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          links: 'a[href], [role="link"]',
          inputs: 'input, select, textarea, [contenteditable="true"]',
          text: 'li, article, section, div, span, p, td, th',
        };
        const kind = String(options.kind || 'all').toLowerCase();
        const selector = selectorMap[kind] || selectorMap.all;
        const elements = Array.from(document.querySelectorAll(selector))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 500)));
        const signatureFor = (el) => {
          const text = norm([
            el.innerText,
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' ')).toLowerCase();
          return [
            el.tagName.toLowerCase(),
            el.getAttribute('role') || '',
            el.getAttribute('type') || '',
            text.slice(0, 100),
          ].join('|');
        };
        const groups = new Map();
        for (const el of elements) {
          const signature = signatureFor(el);
          if (!groups.has(signature)) {
            groups.set(signature, []);
          }
          groups.get(signature).push(el);
        }
        const repeated = Array.from(groups.entries())
          .filter(([, items]) => items.length > 1)
          .map(([signature, items]) => {
            const sample = items[0];
            const rect = sample.getBoundingClientRect();
            return {
              signature,
              count: items.length,
              tag: sample.tagName.toLowerCase(),
              role: sample.getAttribute('role') || null,
              type: sample.getAttribute('type') || null,
              sampleText: norm(sample.innerText || sample.textContent || sample.value || '').slice(0, 160),
              sampleSelector: sample.id ? `#${CSS.escape(sample.id)}` : sample.tagName.toLowerCase(),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              items: items.slice(0, 10).map((el) => ({
                selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
                text: norm(el.innerText || el.textContent || el.value || '').slice(0, 120),
              })),
            };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.max(1, Number(options.maxGroups || 20)));
        return {
          title: document.title,
          url: location.href,
          kind,
          repeated,
        };
      }, [{ kind: params.kind || 'all', maxItems: params.maxItems || 500, maxGroups: params.maxGroups || 20 }], params.tabId ?? null);
    case 'nextVisibleControl':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible);
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const currentSelector = norm(options.selector || '');
        const current = currentSelector ? document.querySelector(currentSelector) : document.activeElement;
        let startIndex = current ? controls.indexOf(current) : -1;
        if (startIndex < 0 && current?.form) {
          startIndex = controls.findIndex((el) => el.form && el.form === current.form);
        }
        const wrap = options.wrap !== false;
        const nextIndex = startIndex >= 0 ? startIndex + 1 : 0;
        const chosen = controls[nextIndex] || (wrap ? controls[0] : null);
        if (!chosen) {
          return {
            ok: false,
            reason: 'No visible control found',
            controls: controls.length,
          };
        }
        const rect = chosen.getBoundingClientRect();
        const result = {
          ok: true,
          index: controls.indexOf(chosen),
          total: controls.length,
          tag: chosen.tagName.toLowerCase(),
          type: chosen.getAttribute('type') || null,
          role: chosen.getAttribute('role') || null,
          selector: selectorFor(chosen),
          text: norm(chosen.innerText || chosen.textContent || chosen.value || '').slice(0, 180),
          placeholder: chosen.getAttribute('placeholder') || null,
          name: chosen.getAttribute('name') || null,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        if (options.focus !== false) {
          chosen.focus();
          chosen.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
        if (options.click === true) {
          chosen.click();
          result.clicked = true;
        }
        return result;
      }, [{ selector: params.selector || null, wrap: params.wrap !== false, focus: params.focus !== false, click: !!params.click }], params.tabId ?? null);
    case 'pageInteractMap':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const controlQuery = options.kind === 'inputs'
          ? 'input, select, textarea, [contenteditable="true"]'
          : options.kind === 'buttons'
            ? 'button, input[type="button"], input[type="submit"], [role="button"]'
            : options.kind === 'links'
              ? 'a[href], [role="link"]'
              : 'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary';
        const controls = Array.from(document.querySelectorAll(controlQuery))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 200)));
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(document.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
            const labelled = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            for (const id of labelled) {
              const ref = document.getElementById(id);
              if (ref) parts.push(ref.innerText || ref.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const controlsMap = controls.map((el, index) => {
          const rect = el.getBoundingClientRect();
          const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 180);
          const label = labelTextFor(el).slice(0, 180);
          const hint = norm([
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.id,
            el.getAttribute('title'),
            label,
          ].filter(Boolean).join(' ')).slice(0, 180);
          const intent = lower([
            text,
            label,
            hint,
          ].filter(Boolean).join(' '));
          return {
            index,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            selector: selectorFor(el),
            text,
            label,
            hint,
            id: el.id || null,
            name: el.getAttribute('name') || null,
            href: el.href || null,
            intent,
            visible: true,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
        return {
          title: document.title,
          url: location.href,
          kind: options.kind || 'all',
          controls: controlsMap,
          summaryText: controlsMap.slice(0, 20).map((item) => `${item.index}: ${item.tag}${item.type ? `:${item.type}` : ''} ${item.label || item.text || item.hint || item.selector}`).join(' | '),
        };
      }, [{ kind: params.kind || 'all', maxItems: params.maxItems || 200 }], params.tabId ?? null);
    case 'pageInteractClick':
      return await executeInTab((payload) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const resolveToggleTarget = (el) => {
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          if ((tag === 'input' && (type === 'radio' || type === 'checkbox')) || role === 'radio' || role === 'checkbox') {
            return el;
          }
          if (tag === 'label') {
            if (el.htmlFor) {
              const linked = document.getElementById(el.htmlFor);
              if (linked) return linked;
            }
            const nested = el.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
            if (nested) return nested;
          }
          return null;
        };
        const readToggleState = (el) => {
          if (!el) return null;
          if ('checked' in el) return !!el.checked;
          const ariaChecked = el.getAttribute?.('aria-checked');
          if (ariaChecked === 'true') return true;
          if (ariaChecked === 'false') return false;
          return null;
        };
        const dispatchVerifiedClick = (el) => {
          const rect = el.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          el.focus?.();
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.click?.();
        };
        const clickWithVerification = (el) => {
          const toggleTarget = resolveToggleTarget(el);
          const before = readToggleState(toggleTarget);
          dispatchVerifiedClick(el);
          if (toggleTarget && readToggleState(toggleTarget) !== true && toggleTarget !== el) {
            dispatchVerifiedClick(toggleTarget);
          }
          const after = readToggleState(toggleTarget);
          if (toggleTarget) {
            const verified = after === true || (before !== null && after !== null && before !== after);
            return {
              ok: verified,
              verification: {
                kind: 'toggle',
                before,
                after,
                selector: selectorFor(toggleTarget),
              },
              reason: verified ? '' : 'Click was dispatched, but the radio/checkbox state did not change as expected.',
            };
          }
          return {
            ok: true,
            verification: {
              kind: 'click',
              before: null,
              after: null,
              selector: selectorFor(el),
            },
            reason: '',
          };
        };
        const elementId = norm(payload.elementId || payload.element_id || payload.id || '');
        const query = norm(payload.selector || (elementId ? `#${elementId}` : ''));
        const needle = lower(payload.needle || payload.intent || '');
        const index = Number.isFinite(Number(payload.index)) ? Number(payload.index) : null;
        const kind = String(payload.kind || 'all').toLowerCase();
        const controlQuery = kind === 'inputs'
          ? 'input, select, textarea, [contenteditable="true"]'
          : kind === 'buttons'
            ? 'button, input[type="button"], input[type="submit"], [role="button"]'
            : kind === 'links'
              ? 'a[href], [role="link"]'
              : 'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary';
        const controls = Array.from(document.querySelectorAll(controlQuery)).filter(visible);
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(document.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const pageLooksLikeTest = () => /test|quiz|exam|attempt|пройти тест|тест|іспит|екзамен|контроль/i.test([
          document.title,
          location.href,
          document.body?.innerText?.slice(0, 3000),
        ].filter(Boolean).join(' '));
        const targetText = (el) => lower([
          el?.innerText,
          el?.textContent,
          el?.value,
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.getAttribute?.('name'),
          el?.id,
          labelTextFor(el),
        ].filter(Boolean).join(' '));
        const isFinalizeTarget = (el) => /(submit|send|finish|final|complete|turn in|відправ|надісл|заверш|закінч|здати|зберегти відповід|пройти тест|завершити тест)/i.test(targetText(el));
        const candidates = controls.map((el, idx) => {
          const text = lower([
            el.innerText,
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('title'),
            labelTextFor(el),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' '));
          let score = 0;
          if (index != null && idx === index) score += 2000;
          if (query && selectorFor(el) === query) score += 3000;
          if (needle) {
            if (text === needle) score += 1000;
            if (text.startsWith(needle)) score += 700;
            if (text.includes(needle)) score += 500;
          }
          if (payload.exact === true && needle && text !== needle) return null;
          if (score <= 0 && !query && !needle && index == null) return null;
          return { el, score, idx };
        }).filter(Boolean).sort((a, b) => b.score - a.score);
        const chosen = candidates[0]?.el || (index != null ? controls[index] : null) || (query ? document.querySelector(query) : null);
        if (!chosen) {
          return {
            ok: false,
            reason: 'No matching visible control found',
            controls: controls.length,
          };
        }
        if (pageLooksLikeTest() && isFinalizeTarget(chosen)) {
          return {
            ok: false,
            blocked: true,
            reason: 'Blocked finalize/submit click on a test-like page.',
            selector: selectorFor(chosen),
            text: norm(chosen.innerText || chosen.textContent || chosen.value || '').slice(0, 180),
            label: labelTextFor(chosen).slice(0, 180),
          };
        }
        const clickResult = clickWithVerification(chosen);
        const rect = chosen.getBoundingClientRect();
        return {
          ok: clickResult.ok,
          reason: clickResult.reason,
          tag: chosen.tagName.toLowerCase(),
          type: chosen.getAttribute('type') || null,
          role: chosen.getAttribute('role') || null,
          selector: selectorFor(chosen),
          text: norm(chosen.innerText || chosen.textContent || chosen.value || '').slice(0, 180),
          label: labelTextFor(chosen).slice(0, 180),
          href: chosen.href || null,
          verification: clickResult.verification,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }, [{
        selector: params.selector || (params.elementId ? `#${params.elementId}` : params.element_id ? `#${params.element_id}` : params.id ? `#${params.id}` : null),
        needle: params.needle || params.intent || null,
        intent: params.intent || null,
        index: params.index != null ? Number(params.index) : null,
        kind: params.kind || 'all',
        exact: !!params.exact,
        elementId: params.elementId || params.element_id || params.id || null,
      }], params.tabId ?? null);
    case 'semanticClick':
      return await runAndRemember('semanticClick', (intent, selector) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const query = selector || null;
        const normalizeIntent = lower(intent);
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          return el.tagName.toLowerCase();
        };
        const resolveToggleTarget = (el) => {
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          if ((tag === 'input' && (type === 'radio' || type === 'checkbox')) || role === 'radio' || role === 'checkbox') {
            return el;
          }
          if (tag === 'label') {
            if (el.htmlFor) {
              const linked = document.getElementById(el.htmlFor);
              if (linked) return linked;
            }
            const nested = el.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
            if (nested) return nested;
          }
          return null;
        };
        const readToggleState = (el) => {
          if (!el) return null;
          if ('checked' in el) return !!el.checked;
          const ariaChecked = el.getAttribute?.('aria-checked');
          if (ariaChecked === 'true') return true;
          if (ariaChecked === 'false') return false;
          return null;
        };
        const dispatchVerifiedClick = (el) => {
          const rect = el.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          el.focus?.();
          el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, view: window }));
          el.click?.();
        };
        const clickWithVerification = (el) => {
          const toggleTarget = resolveToggleTarget(el);
          const before = readToggleState(toggleTarget);
          dispatchVerifiedClick(el);
          if (toggleTarget && readToggleState(toggleTarget) !== true && toggleTarget !== el) {
            dispatchVerifiedClick(toggleTarget);
          }
          const after = readToggleState(toggleTarget);
          if (toggleTarget) {
            const verified = after === true || (before !== null && after !== null && before !== after);
            return {
              ok: verified,
              verification: {
                kind: 'toggle',
                before,
                after,
                selector: selectorFor(toggleTarget),
              },
              reason: verified ? '' : 'Click was dispatched, but the radio/checkbox state did not change as expected.',
            };
          }
          return {
            ok: true,
            verification: {
              kind: 'click',
              before: null,
              after: null,
              selector: selectorFor(el),
            },
            reason: '',
          };
        };
        const intentMap = [
          { match: /(submit|send|save|continue|next|finish|apply|upload|відправ|надісл|зберегти|далі|продовж|увійти|register|sign up)/i, needles: ['submit', 'send', 'save', 'continue', 'next', 'finish', 'apply', 'upload', 'ok', 'continue', 'save changes', 'зберегти', 'далі', 'продовжити', 'увійти', 'зареєструватися'] },
          { match: /(close|dismiss|cancel|back|закр|відміни|сховай|hide|x)/i, needles: ['close', 'dismiss', 'cancel', 'back', 'ok', 'done', 'закрити', 'скасувати', 'відмінити', 'x', '×'] },
          { match: /(search|find|query|пошук)/i, needles: ['search', 'find', 'submit', 'ok', 'пошук'] },
          { match: /(open first result|first result|open result)/i, needles: ['a[href]', 'button', 'result'] },
          { match: /(login|sign in|log in|auth)/i, needles: ['login', 'sign in', 'sign in', 'увійти', 'login'] },
        ];
        const matchedRule = intentMap.find((rule) => rule.match.test(normalizeIntent)) || null;
        const candidateSelectors = query ? [query] : [];
        if (matchedRule?.needles?.includes('a[href]')) {
          const firstLink = Array.from(document.querySelectorAll('a[href]')).find((el) => visible(el));
          if (firstLink) candidateSelectors.unshift(firstLink.id ? `#${CSS.escape(firstLink.id)}` : 'a[href]');
        }
        const controlQuery = query || 'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]';
        const candidates = Array.from(document.querySelectorAll(controlQuery)).filter(visible);
        const scoreCandidate = (el) => {
          const hay = lower([
            el.innerText,
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('title'),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' '));
          let score = 0;
          const needles = matchedRule?.needles || [normalizeIntent];
          for (const needle of needles) {
            const n = lower(needle);
            if (!n) continue;
            if (hay === n) score += 1000;
            if (hay.startsWith(n)) score += 700;
            if (hay.includes(n)) score += 500;
          }
          if (hay.includes('result') && /result/.test(normalizeIntent)) score += 120;
          if (el.tagName === 'BUTTON') score += 30;
          return score;
        };
        const ranked = candidates
          .map((el) => ({ el, score: scoreCandidate(el) }))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score);
        let target = ranked[0]?.el || null;
        if (!target && matchedRule?.match?.test(normalizeIntent) && normalizeIntent.includes('first result')) {
          target = Array.from(document.querySelectorAll('a[href]')).find((el) => visible(el)) || null;
        }
        if (!target && selector) {
          target = document.querySelector(selector);
        }
        if (!target) throw new Error(`No semantic click target found for: ${intent}`);
        const semanticPageLooksLikeTest = () => /test|quiz|exam|attempt|пройти тест|тест|іспит|екзамен|контроль/i.test([
          document.title,
          location.href,
          document.body?.innerText?.slice(0, 3000),
        ].filter(Boolean).join(' '));
        const semanticTargetText = (el) => lower([
          el?.innerText,
          el?.textContent,
          el?.value,
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.getAttribute?.('name'),
          el?.id,
        ].filter(Boolean).join(' '));
        const semanticIsFinalizeTarget = (el) => /(submit|send|finish|final|complete|turn in|відправ|надісл|заверш|закінч|здати|зберегти відповід|пройти тест|завершити тест)/i.test(semanticTargetText(el));
        if (semanticPageLooksLikeTest() && semanticIsFinalizeTarget(target)) {
          return {
            clicked: false,
            ok: false,
            blocked: true,
            reason: 'Blocked finalize/submit click on a test-like page.',
            intent,
            selector: selectorFor(target),
            tag: target.tagName.toLowerCase(),
            text: norm(target.innerText || target.textContent || target.value || '').slice(0, 160),
          };
        }
        const clickResult = clickWithVerification(target);
        return {
          clicked: clickResult.ok,
          ok: clickResult.ok,
          reason: clickResult.reason,
          intent,
          selector: selectorFor(target),
          tag: target.tagName.toLowerCase(),
          text: norm(target.innerText || target.textContent || target.value || '').slice(0, 160),
          verification: clickResult.verification,
        };
      }, [params.intent || params.text || '', params.selector || null], params.tabId ?? null, () => ({
        intent: params.intent || params.text || '',
        selector: params.selector || null,
      }));
    case 'pageDiffMemory':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const snapshot = {
          title: document.title,
          url: location.href,
          headingTexts: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(visible).slice(0, 20).map((el) => norm(el.innerText || el.textContent || '').slice(0, 120)),
          controlSignatures: Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
            .filter(visible)
            .slice(0, 100)
            .map((el) => [
              el.tagName.toLowerCase(),
              el.getAttribute('role') || '',
              el.getAttribute('type') || '',
              norm(el.innerText || el.textContent || el.value || '').slice(0, 80),
              el.id || '',
              el.getAttribute('name') || '',
            ].join('|')),
          modalSignatures: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], .modal, .dialog, .popover, .toast'))
            .filter(visible)
            .slice(0, 20)
            .map((el) => norm(el.innerText || el.textContent || '').slice(0, 120)),
          activeElement: document.activeElement ? {
            tag: document.activeElement.tagName?.toLowerCase?.() || null,
            type: document.activeElement.getAttribute?.('type') || null,
            id: document.activeElement.id || null,
            name: document.activeElement.getAttribute?.('name') || null,
            placeholder: document.activeElement.getAttribute?.('placeholder') || null,
            text: norm(document.activeElement.innerText || document.activeElement.textContent || document.activeElement.value || '').slice(0, 120),
          } : null,
        };
        const snapshotKey = String(options.tabId);
        const previous = sessionMemory.pageSnapshotsByTab[snapshotKey] || null;
        const diffSignature = (listA, listB) => {
          const a = new Set(listA || []);
          const b = new Set(listB || []);
          return {
            added: Array.from(a).filter((item) => !b.has(item)).slice(0, 100),
            removed: Array.from(b).filter((item) => !a.has(item)).slice(0, 100),
          };
        };
        const diff = previous ? {
          titleChanged: previous.title !== snapshot.title,
          urlChanged: previous.url !== snapshot.url,
          headingDiff: diffSignature(snapshot.headingTexts, previous.headingTexts),
          controlDiff: diffSignature(snapshot.controlSignatures, previous.controlSignatures),
          modalDiff: diffSignature(snapshot.modalSignatures, previous.modalSignatures),
          activeElementChanged: JSON.stringify(previous.activeElement || null) !== JSON.stringify(snapshot.activeElement || null),
          previousCounts: {
            headings: previous.headingTexts?.length || 0,
            controls: previous.controlSignatures?.length || 0,
            modals: previous.modalSignatures?.length || 0,
          },
          currentCounts: {
            headings: snapshot.headingTexts.length,
            controls: snapshot.controlSignatures.length,
            modals: snapshot.modalSignatures.length,
          },
        } : {
          firstSnapshot: true,
        };
        sessionMemory.pageSnapshotsByTab[snapshotKey] = snapshot;
        return {
          title: document.title,
          url: location.href,
          previousExists: !!previous,
          current: snapshot,
          diff,
        };
      }, [{ tabId: await resolveTargetTabId(params.tabId ?? null) }], params.tabId ?? null);
    case 'siteMemorySnapshot':
      return {
        ok: true,
        ...compactSiteMemory(await resolveTargetTabId(params.tabId ?? null)),
      };
    case 'pageRegionMemory':
      return await (async () => {
        const tabId = await resolveTargetTabId(params.tabId ?? null);
        const mode = String(params.mode || params.action || params.command || 'remember').toLowerCase();
        if (mode === 'read' || mode === 'get') {
          return {
            ok: true,
            tabId,
            region: getPageRegionMemory(tabId),
          };
        }
        if (mode === 'clear' || mode === 'forget' || mode === 'remove') {
          return {
            ok: true,
            ...clearPageRegionMemory(tabId),
          };
        }
        const resolveNeedle = String(params.selector || params.needle || params.regionNeedle || params.label || '').trim();
        const useSelection = mode === 'selection' || mode === 'captureselection' || params.captureSelection === true;
        const region = await executeInTab((options) => {
          const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const lower = (value) => norm(value).toLowerCase();
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const selectorFor = (el) => {
            if (!el) return null;
            if (el.id) return `#${CSS.escape(el.id)}`;
            const name = el.getAttribute('name');
            if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
            const aria = el.getAttribute('aria-label');
            if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
            const role = el.getAttribute('role');
            if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
            return el.tagName.toLowerCase();
          };
          const makeRegion = (el, source = 'selector') => {
            if (!el || !visible(el)) return null;
            const rect = el.getBoundingClientRect();
            const label = norm([
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
              el.innerText,
              el.textContent,
            ].filter(Boolean).join(' ')).slice(0, 220);
            const controls = el.querySelectorAll?.('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="radio"], [role="checkbox"]')?.length || 0;
            return {
              source,
              title: document.title || '',
              url: location.href,
              selector: selectorFor(el),
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || null,
              name: el.getAttribute('name') || null,
              id: el.id || null,
              text: norm(el.innerText || el.textContent || el.value || '').slice(0, 320),
              label,
              ariaLabel: norm(el.getAttribute('aria-label') || '').slice(0, 220) || null,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              controls,
            };
          };
          const query = String(options.query || '').trim();
          const index = Number.isFinite(Number(options.index)) ? Number(options.index) : null;
          if (options.useSelection) {
            const selection = window.getSelection?.();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
              return { ok: false, reason: 'No current text selection to capture' };
            }
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect?.();
            const parent = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
              ? range.commonAncestorContainer
              : range.commonAncestorContainer?.parentElement;
            const target = parent && visible(parent) ? parent : document.activeElement || document.body;
            const region = makeRegion(target, 'selection');
            return {
              ok: !!region,
              region: region ? {
                ...region,
                selectionText: norm(selection.toString()).slice(0, 400),
                x: Math.round(rect?.left || region.x || 0),
                y: Math.round(rect?.top || region.y || 0),
                width: Math.round(rect?.width || region.width || 0),
                height: Math.round(rect?.height || region.height || 0),
              } : null,
            };
          }
          const candidates = Array.from(document.querySelectorAll('main, article, section, form, fieldset, li, tr, div, aside, nav'))
            .filter(visible);
          const interactive = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="radio"], [role="checkbox"], summary, label'))
            .filter(visible);
          const pool = interactive.length ? interactive : candidates;
          let chosen = null;
          if (index != null && index >= 0 && index < pool.length) {
            chosen = pool[index];
          }
          if (!chosen && query) {
            const queryLower = lower(query);
            chosen = pool.map((el) => {
              const hay = lower([
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('title'),
                el.getAttribute('name'),
                el.id,
              ].filter(Boolean).join(' '));
              let score = 0;
              if (hay === queryLower) score += 1000;
              if (hay.startsWith(queryLower)) score += 700;
              if (hay.includes(queryLower)) score += 500;
              return { el, score };
            }).sort((a, b) => b.score - a.score)[0]?.el || null;
          }
          if (!chosen && document.activeElement && visible(document.activeElement)) {
            chosen = document.activeElement;
          }
          const region = makeRegion(chosen, index != null ? 'index' : query ? 'query' : 'active');
          return {
            ok: !!region,
            region,
          };
        }, [{
          query: resolveNeedle,
          index: params.index,
          useSelection,
        }], tabId);
        if (region?.ok === false || !region?.region) {
          return region;
        }
        const stored = {
          ...region.region,
          regionId: `${tabId}-${Date.now()}`,
        };
        setPageRegionMemory(tabId, stored);
        return {
          ok: true,
          region: stored,
        };
      })();
    case 'resolveDomRoute':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const selector = norm(options.selector || '');
        const needle = norm(options.needle || '');
        const exact = !!options.exact;
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidateSelectors = [
          selector,
          needle ? null : null,
        ].filter(Boolean);
        let element = selector ? document.querySelector(selector) : null;
        if (!element && needle) {
          const targets = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary, [role], div, span, p'))
            .filter(visible);
          const ranked = targets.map((el) => {
            const hay = lower([
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('title'),
              el.getAttribute('name'),
              el.id,
            ].filter(Boolean).join(' '));
            let score = 0;
            const target = lower(needle);
            if (exact) {
              score = hay === target ? 1000 : -1;
            } else {
              if (hay === target) score += 1000;
              if (hay.startsWith(target)) score += 700;
              if (hay.includes(target)) score += 500;
            }
            return { el, score };
          }).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score);
          element = ranked[0]?.el || null;
        }
        if (!element) throw new Error('Element not found');
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const ancestry = [];
        let node = element;
        while (node && node !== document.documentElement) {
          ancestry.push({
            tag: node.tagName?.toLowerCase?.() || node.nodeName?.toLowerCase?.() || null,
            selector: node.nodeType === Node.ELEMENT_NODE ? selectorFor(node) : null,
            id: node.id || null,
            role: node.getAttribute?.('role') || null,
            name: node.getAttribute?.('name') || null,
          });
          node = node.parentElement || (node.assignedSlot || null);
        }
        const framePath = [];
        let owner = element.ownerDocument;
        while (owner && owner.defaultView && owner.defaultView.frameElement) {
          const frame = owner.defaultView.frameElement;
          framePath.push({
            selector: selectorFor(frame),
            tag: frame.tagName.toLowerCase(),
            id: frame.id || null,
            name: frame.getAttribute('name') || null,
            title: frame.getAttribute('title') || null,
            src: frame.getAttribute('src') || null,
          });
          owner = frame.ownerDocument;
        }
        const shadowPath = [];
        let root = element.getRootNode();
        while (root && root.host) {
          const host = root.host;
          shadowPath.push({
            selector: selectorFor(host),
            tag: host.tagName.toLowerCase(),
            id: host.id || null,
            name: host.getAttribute('name') || null,
            role: host.getAttribute('role') || null,
          });
          root = host.getRootNode();
        }
        const rect = element.getBoundingClientRect();
        return {
          title: document.title,
          url: location.href,
          selector: selectorFor(element),
          route: {
            framePath,
            shadowPath,
            ancestry: ancestry.slice(0, 40),
          },
          element: {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type') || null,
            role: element.getAttribute('role') || null,
            text: norm(element.innerText || element.textContent || element.value || '').slice(0, 180),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }, [{ selector: params.selector || null, needle: params.needle || null, exact: !!params.exact }], params.tabId ?? null);
    case 'pageDomOutline':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const maxItems = Math.max(1, Number(options.maxItems || 80));
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const includeTextBlocks = options.includeTextBlocks !== false;
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        let index = 0;
        while (index < roots.length) {
          const root = roots[index];
          index += 1;
          const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          if (includeShadowDom) {
            for (const el of all) {
              if (el.shadowRoot) pushRoot(el.shadowRoot);
            }
          }
          if (includeFrames) {
            for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
              try {
                if (frame.contentDocument) pushRoot(frame.contentDocument);
              } catch {
                // Cross-origin frame skipped.
              }
            }
          }
        }
        const qAll = (selector) => {
          const out = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(selector))) {
              if (seen.has(el)) continue;
              seen.add(el);
              out.push(el);
            }
          }
          return out;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(qAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const collect = (selector, kind) => qAll(selector).filter(isVisible).slice(0, maxItems).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            kind,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            selector: selectorFor(el),
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 180),
            label: labelTextFor(el).slice(0, 180),
            placeholder: el.getAttribute('placeholder') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            href: el.href || null,
            visible: true,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
        const headings = collect('h1, h2, h3, h4, h5, h6', 'heading');
        const forms = qAll('form').slice(0, maxItems).map((form, index) => {
          const rect = form.getBoundingClientRect();
          const fields = Array.from(form.elements || []).slice(0, 40).map((field) => {
            const fRect = field.getBoundingClientRect ? field.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: field.tagName?.toLowerCase?.() || null,
              type: field.getAttribute?.('type') || null,
              name: field.getAttribute?.('name') || null,
              id: field.id || null,
              selector: selectorFor(field),
              label: labelTextFor(field).slice(0, 160),
              placeholder: field.getAttribute?.('placeholder') || null,
              valuePreview: String('value' in field ? field.value || '' : '').slice(0, 80),
              visible: isVisible(field),
              x: Math.round(fRect.left || 0),
              y: Math.round(fRect.top || 0),
              width: Math.round(fRect.width || 0),
              height: Math.round(fRect.height || 0),
            };
          });
          return {
            kind: 'form',
            index,
            selector: selectorFor(form),
            id: form.id || null,
            name: form.getAttribute('name') || null,
            action: form.getAttribute('action') || null,
            method: form.getAttribute('method') || 'get',
            fieldCount: form.elements?.length || 0,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            fields,
          };
        });
        const controls = [
          ...collect('input, textarea, select, button, [contenteditable="true"]', 'control'),
          ...collect('a[href], [role="button"], [role="link"], summary', 'interactive'),
        ].slice(0, maxItems);
        const landmarks = ['header', 'nav', 'main', 'aside', 'footer', '[role="main"]', '[role="navigation"]', '[role="dialog"]']
          .flatMap((selector) => collect(selector, 'landmark'))
          .slice(0, maxItems);
        const textBlocks = includeTextBlocks
          ? qAll('p, li, blockquote, article, section, td, th, figcaption')
            .filter(isVisible)
            .slice(0, maxItems)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                kind: 'text',
                tag: el.tagName.toLowerCase(),
                selector: selectorFor(el),
                text: norm(el.innerText || el.textContent || '').slice(0, 240),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })
          : [];
        return {
          title: document.title,
          url: location.href,
          counts: {
            headings: headings.length,
            forms: forms.length,
            controls: controls.length,
            landmarks: landmarks.length,
            textBlocks: textBlocks.length,
            frames: qAll('iframe, frame').length,
            shadowHosts: qAll('*').filter((el) => !!el.shadowRoot).length,
          },
          headings,
          forms,
          controls,
          landmarks,
          textBlocks,
        };
      }, [{
        maxItems: params.maxItems || 80,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
        includeTextBlocks: params.includeTextBlocks !== false,
      }], params.tabId ?? null);
    case 'pageDomSnapshot':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const includeHidden = !!options.includeHidden;
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const maxItems = Math.max(1, Number(options.maxItems || 120));
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const isDeepRoot = (node) => node && (node.nodeType === Node.DOCUMENT_NODE || node instanceof ShadowRoot);
        const collectRoots = () => {
          let index = 0;
          while (index < roots.length) {
            const root = roots[index];
            index += 1;
            const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            if (includeShadowDom) {
              for (const el of elements) {
                if (el.shadowRoot) pushRoot(el.shadowRoot);
              }
            }
            if (includeFrames) {
              for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
                try {
                  if (frame.contentDocument && isDeepRoot(frame.contentDocument)) {
                    pushRoot(frame.contentDocument);
                  }
                } catch {
                  // Cross-origin frames are skipped.
                }
              }
            }
          }
        };
        collectRoots();
        const queryAllDeep = (selector) => {
          const results = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(selector))) {
              if (seen.has(el)) continue;
              seen.add(el);
              results.push(el);
            }
          }
          return results;
        };
        const queryDeep = (selector) => {
          for (const root of roots) {
            if (!root.querySelector) continue;
            const found = root.querySelector(selector);
            if (found) return found;
          }
          return null;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(queryAllDeep('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
            const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            for (const id of ids) {
              const ref = queryDeep(`#${CSS.escape(id)}`);
              if (ref) parts.push(ref.innerText || ref.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          const parent = el.parentElement?.innerText || '';
          if (parent) parts.push(parent);
          return norm(parts.join(' '));
        };
        const controlHint = (el) => norm([
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('name'),
          el.id,
          el.getAttribute('title'),
          el.getAttribute('autocomplete'),
          el.getAttribute('data-testid'),
          el.getAttribute('data-test'),
          el.getAttribute('role'),
          labelTextFor(el),
        ].filter(Boolean).join(' '));
        const controlEntries = queryAllDeep('a, button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || null;
            const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 220);
            return {
              tag,
              type,
              role: el.getAttribute('role') || null,
              selector: selectorFor(el),
              text,
              label: labelTextFor(el).slice(0, 220),
              hint: controlHint(el).slice(0, 220),
              id: el.id || null,
              name: el.getAttribute('name') || null,
              href: el.href || null,
              valuePreview: ('value' in el ? String(el.value || '') : '').slice(0, 120),
              visible: visible(el),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const selectEntries = queryAllDeep('select')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems)
          .map((select) => {
            const rect = select.getBoundingClientRect();
            const options = Array.from(select.options || []).slice(0, 20).map((opt, index) => ({
              index,
              text: norm(opt.textContent || opt.label || '').slice(0, 180),
              value: String(opt.value || '').slice(0, 120),
              selected: !!opt.selected,
              disabled: !!opt.disabled,
            })).filter((opt) => opt.text || opt.value);
            return {
              tag: 'select',
              selector: selectorFor(select),
              id: select.id || null,
              name: select.getAttribute('name') || null,
              label: labelTextFor(select).slice(0, 220),
              hint: controlHint(select).slice(0, 220),
              visible: visible(select),
              multiple: !!select.multiple,
              size: Number(select.size || 0) || null,
              optionCount: select.options?.length || 0,
              options,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const radioGroupsMap = new Map();
        const checkboxGroupsMap = new Map();
        for (const input of queryAllDeep('input[type="radio"], input[type="checkbox"]')) {
          if (!(includeHidden || visible(input))) continue;
          const type = String(input.getAttribute('type') || '').toLowerCase();
          const map = type === 'radio' ? radioGroupsMap : checkboxGroupsMap;
          const key = input.getAttribute('name') || input.id || labelTextFor(input) || `${input.tagName.toLowerCase()}-${map.size}`;
          if (!map.has(key)) {
            map.set(key, {
              key,
              type,
              name: input.getAttribute('name') || null,
              label: labelTextFor(input).slice(0, 220),
              items: [],
            });
          }
          const rect = input.getBoundingClientRect();
          map.get(key).items.push({
            selector: selectorFor(input),
            id: input.id || null,
            name: input.getAttribute('name') || null,
            value: String(input.value || '').slice(0, 120),
            checked: !!input.checked,
            disabled: !!input.disabled,
            label: labelTextFor(input).slice(0, 220),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
        const radioGroups = Array.from(radioGroupsMap.values()).slice(0, maxItems);
        const checkboxGroups = Array.from(checkboxGroupsMap.values()).slice(0, maxItems);
        const tableEntries = queryAllDeep('table')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems)
          .map((table, index) => {
            const rect = table.getBoundingClientRect();
            const caption = norm(table.querySelector('caption')?.innerText || table.querySelector('caption')?.textContent || '').slice(0, 180);
            const headers = Array.from(table.querySelectorAll('thead th, tr th'))
              .map((th) => norm(th.innerText || th.textContent || '').slice(0, 120))
              .filter(Boolean)
              .slice(0, 20);
            const rows = Array.from(table.querySelectorAll('tbody tr, tr'))
              .filter((tr) => visible(tr))
              .slice(0, 8)
              .map((tr) => Array.from(tr.querySelectorAll('th, td'))
                .map((cell) => norm(cell.innerText || cell.textContent || '').slice(0, 80))
                .filter(Boolean)
                .slice(0, 8));
            return {
              index,
              selector: selectorFor(table),
              id: table.id || null,
              name: table.getAttribute('name') || null,
              caption,
              headers,
              rowCount: table.querySelectorAll('tr').length,
              visibleRows: rows.length,
              rows,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const listEntries = queryAllDeep('ul, ol, dl, menu')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems)
          .map((list, index) => {
            const rect = list.getBoundingClientRect();
            const items = Array.from(list.querySelectorAll('li, dt, dd, option'))
              .filter((node) => includeHidden || visible(node))
              .slice(0, 12)
              .map((node) => norm(node.innerText || node.textContent || '').slice(0, 120))
              .filter(Boolean);
            return {
              index,
              selector: selectorFor(list),
              tag: list.tagName.toLowerCase(),
              id: list.id || null,
              name: list.getAttribute('name') || null,
              itemCount: list.querySelectorAll('li, dt, dd, option').length,
              items,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const textBlocks = queryAllDeep('p, label, li, figcaption, caption, th, td, blockquote, code, pre, summary, legend')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems * 2)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || null,
              selector: selectorFor(el),
              text: norm(el.innerText || el.textContent || '').slice(0, 200),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }).filter((item) => item.text);
        const formEntries = Array.from(document.forms).slice(0, maxItems).map((form, index) => {
          const fields = Array.from(form.elements || []).slice(0, 80).map((field) => {
            const rect = field.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: field.tagName?.toLowerCase?.() || null,
              type: field.getAttribute?.('type') || null,
              name: field.getAttribute?.('name') || null,
              id: field.id || null,
              selector: field.id ? `#${CSS.escape(field.id)}` : field.getAttribute?.('name') ? `${field.tagName.toLowerCase()}[name="${CSS.escape(field.getAttribute('name'))}"]` : field.tagName?.toLowerCase?.() || null,
              label: labelTextFor(field).slice(0, 220),
              hint: controlHint(field).slice(0, 220),
              placeholder: field.getAttribute?.('placeholder') || null,
              valuePreview: String('value' in field ? field.value || '' : '').slice(0, 120),
              required: !!field.required,
              disabled: !!field.disabled,
              visible: visible(field),
              x: Math.round(rect.left || 0),
              y: Math.round(rect.top || 0),
              width: Math.round(rect.width || 0),
              height: Math.round(rect.height || 0),
            };
          });
          return {
            index,
            id: form.id || null,
            name: form.getAttribute('name') || null,
            action: form.getAttribute('action') || null,
            method: form.getAttribute('method') || 'get',
            selector: form.id ? `#${CSS.escape(form.id)}` : 'form',
            fieldCount: form.elements?.length || 0,
            fields,
          };
        });
        const frameEntries = includeFrames ? Array.from(queryAllDeep('iframe, frame')).slice(0, maxItems).map((frame, index) => {
          const rect = frame.getBoundingClientRect();
          let sameOrigin = false;
          let innerTitle = null;
          let innerUrl = null;
          let innerControlCount = null;
          try {
            const doc = frame.contentDocument;
            sameOrigin = !!doc;
            innerTitle = doc?.title || null;
            innerUrl = doc?.location?.href || null;
            innerControlCount = doc ? doc.querySelectorAll('a, button, input, select, textarea').length : null;
          } catch {
            sameOrigin = false;
          }
          return {
            index,
            tag: frame.tagName.toLowerCase(),
            id: frame.id || null,
            name: frame.getAttribute('name') || null,
            title: frame.getAttribute('title') || null,
            src: frame.getAttribute('src') || null,
            selector: frame.id ? `#${CSS.escape(frame.id)}` : frame.tagName.toLowerCase(),
            sameOrigin,
            innerTitle,
            innerUrl,
            innerControlCount,
            visible: visible(frame),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }) : [];
        const shadowHosts = includeShadowDom ? queryAllDeep('*')
          .filter((el) => !!el.shadowRoot)
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              name: el.getAttribute('name') || null,
              role: el.getAttribute('role') || null,
              selector: selectorFor(el),
              childCount: el.shadowRoot?.querySelectorAll('*').length || 0,
              visible: visible(el),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }) : [];
        const scrollContainers = queryAllDeep('*')
          .filter((el) => {
            if (!visible(el)) return false;
            const style = window.getComputedStyle(el);
            const overflowY = `${style.overflowY || ''}`.toLowerCase();
            const overflowX = `${style.overflowX || ''}`.toLowerCase();
            const rect = el.getBoundingClientRect();
            return (
              ['auto', 'scroll', 'overlay'].includes(overflowY) ||
              ['auto', 'scroll', 'overlay'].includes(overflowX)
            ) && rect.height > 0 && rect.width > 0;
          })
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              selector: selectorFor(el),
              text: norm(el.innerText || el.textContent || '').slice(0, 140),
              scrollHeight: el.scrollHeight,
              scrollWidth: el.scrollWidth,
              clientHeight: el.clientHeight,
              clientWidth: el.clientWidth,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const active = document.activeElement ? {
          tag: document.activeElement.tagName?.toLowerCase?.() || null,
          type: document.activeElement.getAttribute?.('type') || null,
          id: document.activeElement.id || null,
          name: document.activeElement.getAttribute?.('name') || null,
          placeholder: document.activeElement.getAttribute?.('placeholder') || null,
          ariaLabel: document.activeElement.getAttribute?.('aria-label') || null,
          selector: selectorFor(document.activeElement),
        } : null;
        return {
          title: document.title,
          url: location.href,
          lang: document.documentElement?.lang || null,
          counts: {
            headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
            links: queryAllDeep('a[href]').length,
            buttons: queryAllDeep('button, input[type="button"], input[type="submit"], [role="button"]').length,
            inputs: queryAllDeep('input, select, textarea, [contenteditable="true"]').length,
            forms: document.forms.length,
            frames: frameEntries.length,
            shadowHosts: shadowHosts.length,
            scrollContainers: scrollContainers.length,
          },
          activeElement: active,
          headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).slice(0, maxItems).map((el) => ({
            level: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 200),
          })).filter((item) => item.text),
          landmarks: ['header', 'nav', 'main', 'aside', 'footer', '[role="dialog"]', '[role="main"]', '[role="navigation"]']
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => ({
              selector,
              tag: el.tagName.toLowerCase(),
              text: norm(el.innerText || el.textContent || '').slice(0, 120),
            })))
            .slice(0, maxItems),
            controls: controlEntries,
            selects: selectEntries,
            radioGroups,
            checkboxGroups,
            tables: tableEntries,
            lists: listEntries,
            textBlocks,
            forms: formEntries,
            frames: frameEntries,
            shadowHosts,
            scrollContainers,
          };
      }, [{
        maxItems: params.maxItems || 120,
        includeHidden: !!params.includeHidden,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
    case 'findDomControl':
      return await executeInTab((needle, options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const exact = !!options.exact;
        const maxItems = Math.max(1, Number(options.maxItems || 20));
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const kind = String(options.kind || 'all').toLowerCase();
        const target = lower(needle);
        if (!target) throw new Error('needle is required');
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(document.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const traverseRoots = () => {
          let index = 0;
          while (index < roots.length) {
            const root = roots[index];
            index += 1;
            const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            if (includeShadowDom) {
              for (const el of elements) {
                if (el.shadowRoot) pushRoot(el.shadowRoot);
              }
            }
            if (includeFrames) {
              for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
                try {
                  if (frame.contentDocument) pushRoot(frame.contentDocument);
                } catch {
                  // Cross-origin frame skipped.
                }
              }
            }
          }
        };
        traverseRoots();
        const candidates = [];
        const allSelectors = {
          all: 'a, button, input, select, textarea, [contenteditable="true"], [role], summary',
          inputs: 'input, select, textarea, [contenteditable="true"]',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          links: 'a[href], [role="link"]',
          forms: 'form',
          text: 'body *',
        };
        const selector = allSelectors[kind] || allSelectors.all;
        for (const root of roots) {
          if (!root.querySelectorAll) continue;
          for (const el of Array.from(root.querySelectorAll(selector))) {
            if (!visible(el)) continue;
            const text = norm([
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              labelTextFor(el),
            ].filter(Boolean).join(' '));
            if (!text) continue;
            const hint = lower([
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('name'),
              el.id,
              el.getAttribute('title'),
              el.getAttribute('role'),
              labelTextFor(el),
            ].filter(Boolean).join(' '));
            const candidateScore = (() => {
              const hay = lower(text);
              if (!hay) return -1;
              if (exact) {
                return hay === target ? 1000 : -1;
              }
              let score = 0;
              if (hay === target) score += 1000;
              if (hay.startsWith(target)) score += 700;
              if (hay.includes(target)) score += 500;
              const pieces = target.split(' ').filter(Boolean);
              if (pieces.length) {
                const overlap = pieces.filter((piece) => hay.includes(piece)).length;
                score += overlap * 80;
              }
              if (hint.includes(target)) score += 120;
              return score > 0 ? score : -1;
            })();
            if (candidateScore < 0) continue;
            const rect = el.getBoundingClientRect();
            candidates.push({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || null,
              role: el.getAttribute('role') || null,
              text: text.slice(0, 220),
              label: labelTextFor(el).slice(0, 220),
              hint: hint.slice(0, 220),
              selector: selectorFor(el),
              href: el.href || null,
              id: el.id || null,
              name: el.getAttribute('name') || null,
              visible: true,
              score: candidateScore,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        return {
          needle: target,
          exact,
          kind,
          matches: candidates.slice(0, maxItems),
        };
      }, [params.needle, {
        kind: params.kind || 'all',
        exact: !!params.exact,
        maxItems: params.maxItems || 20,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
    case 'describeDomElement':
      return await executeInTab((payload) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const includeFrames = payload.includeFrames !== false;
        const includeShadowDom = payload.includeShadowDom !== false;
        const selector = norm(payload.selector || '');
        const needle = norm(payload.needle || '');
        const exact = !!payload.exact;
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        let index = 0;
        while (index < roots.length) {
          const root = roots[index];
          index += 1;
          const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          if (includeShadowDom) {
            for (const el of all) {
              if (el.shadowRoot) pushRoot(el.shadowRoot);
            }
          }
          if (includeFrames) {
            for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
              try {
                if (frame.contentDocument) pushRoot(frame.contentDocument);
              } catch {
                // Cross-origin frame skipped.
              }
            }
          }
        }
        const qAll = (query) => {
          const out = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(query))) {
              if (seen.has(el)) continue;
              seen.add(el);
              out.push(el);
            }
          }
          return out;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(qAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
            const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            for (const id of ids) {
              const ref = qAll(`#${CSS.escape(id)}`)[0];
              if (ref) parts.push(ref.innerText || ref.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const describe = (el, source) => {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            source,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            selector: selectorFor(el),
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 240),
            label: labelTextFor(el).slice(0, 240),
            placeholder: el.getAttribute('placeholder') || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            title: el.getAttribute('title') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            href: el.href || null,
            valuePreview: ('value' in el ? String(el.value || '') : '').slice(0, 160),
            checked: typeof el.checked === 'boolean' ? !!el.checked : undefined,
            disabled: !!el.disabled,
            required: !!el.required,
            contentEditable: !!el.isContentEditable,
            visible: visible(el),
            attributes: Array.from(el.attributes || []).slice(0, 40).map((attr) => ({ name: attr.name, value: attr.value })).filter((attr) => !['style'].includes(attr.name)),
            form: el.form ? {
              selector: selectorFor(el.form),
              id: el.form.id || null,
              name: el.form.getAttribute('name') || null,
              action: el.form.getAttribute('action') || null,
              method: el.form.getAttribute('method') || 'get',
            } : null,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const candidateSelectors = [];
        if (selector) candidateSelectors.push(selector);
        if (needle) {
          const target = lower(needle);
          const byKind = String(payload.kind || 'all').toLowerCase();
          const selectorMap = {
            all: 'a, button, input, select, textarea, [contenteditable="true"], [role], summary',
            inputs: 'input, select, textarea, [contenteditable="true"]',
            buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
            links: 'a[href], [role="link"]',
            forms: 'form',
            text: 'body *',
          };
          const searchSelector = selectorMap[byKind] || selectorMap.all;
          const candidates = qAll(searchSelector)
            .filter(visible)
            .map((el) => {
              const combined = lower([
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                labelTextFor(el),
                el.getAttribute('name'),
                el.id,
              ].filter(Boolean).join(' '));
              let score = 0;
              if (exact ? combined === target : combined.includes(target)) score += exact ? 1000 : 700;
              if (combined.startsWith(target)) score += 120;
              const rect = el.getBoundingClientRect();
              return { el, score, rect };
            })
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);
          const top = candidates[0]?.el || null;
          const list = candidates.slice(0, Math.max(1, Number(payload.maxItems || 10))).map((item) => describe(item.el, 'needle'));
          return {
            title: document.title,
            url: location.href,
            found: !!top,
            selector: top ? selectorFor(top) : null,
            exact,
            needle: target,
            element: top ? describe(top, 'needle') : null,
            matches: list,
            activeElement: document.activeElement ? describe(document.activeElement, 'activeElement') : null,
          };
        }
        const source = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const el = source || qAll('input, textarea, select, button, [contenteditable="true"], a[href], [role], summary')[0] || null;
        if (!el) {
          return {
            title: document.title,
            url: location.href,
            found: false,
            element: null,
            activeElement: null,
          };
        }
        return {
          title: document.title,
          url: location.href,
          found: true,
          element: describe(el, source ? 'activeElement' : 'firstInteractive'),
          activeElement: document.activeElement ? describe(document.activeElement, 'activeElement') : null,
        };
      }, [{
        selector: params.selector || null,
        needle: params.needle || null,
        exact: !!params.exact,
        kind: params.kind || 'all',
        maxItems: params.maxItems || 10,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
    case 'smartFocus':
      return await runAndRemember('smartFocus', (mode, textNeedle) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('input, textarea, select, button, [contenteditable="true"], [role="button"]'))
          .filter(isVisible);
        let target = null;
        if (textNeedle) {
          const needle = norm(textNeedle).toLowerCase();
          target = controls.find((el) => {
            const text = norm(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes(needle);
          }) || null;
        }
        if (!target) {
          if (mode === 'button') {
            target = controls.find((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') || null;
          } else {
            target = controls.find((el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) || null;
          }
        }
        if (!target) throw new Error('No focusable target found');
        target.focus();
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return {
          focused: true,
          tag: target.tagName.toLowerCase(),
          type: target.getAttribute('type'),
          placeholder: target.getAttribute('placeholder'),
          ariaLabel: target.getAttribute('aria-label'),
        };
      }, [params.mode || 'input', params.text || null], params.tabId ?? null, (result) => ({
        tag: result?.tag || null,
      }));
    case 'openFilePicker':
      return await runAndRemember('openFilePicker', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
          throw new Error('Target is not an input[type="file"]');
        }
        el.click();
        return { opened: true, selector, awaitsUserSelection: true };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'setFileInputFiles':
      return await setFileInputFiles(params.selector, params.files || [], params.tabId ?? null);
    case 'atoPrepareDropboxUpload':
      return await atoPrepareDropboxUpload({
        files: params.files || [],
        fileSelector: params.fileSelector || null,
      }, params.tabId ?? null);
    case 'getSessionMemory':
      return getSessionMemory(params.tabId ?? null);
    case 'clearSessionMemory':
      return clearSessionMemory(params.tabId ?? null);
    case 'getConsoleLog':
      return getConsoleSnapshot(params.tabId ?? null);
    case 'clearConsoleLog':
      return clearConsoleLog(params.tabId ?? null);
    case 'readResponseBody': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      const requestId = String(params.requestId || '');
      if (!requestId) throw new Error('requestId is required');
      const responseBody = getRecordedResponseBody(resolvedTabId, requestId);
      if (!responseBody) throw new Error(`No recorded response body for requestId: ${requestId}`);
      return {
        tabId: resolvedTabId,
        requestId,
        ...responseBody,
      };
    }
    case 'getCookies': {
      const url = params.url || await getPageUrl(params.tabId ?? null);
      const cookies = await chrome.cookies.getAll({ url });
      return { url, cookies };
    }
    case 'downloadUrl': {
      const url = params.url;
      if (!url) throw new Error('url is required');
      const downloadId = await chrome.downloads.download({
        url,
        filename: params.filename || undefined,
        saveAs: params.saveAs !== false,
      });
      downloadMemory.recent = [{
        at: new Date().toISOString(),
        id: downloadId,
        url,
        filename: params.filename || null,
        saveAs: params.saveAs !== false,
      }, ...downloadMemory.recent].slice(0, 40);
      return { ok: true, url, downloadId };
    }
    case 'watchDownloads': {
      const snapshot = await queryDownloadsSnapshot({});
      const needle = String(params.needle || '').trim().toLowerCase();
      const items = needle
        ? snapshot.filter((item) => `${item.filename || ''} ${item.url || ''} ${item.finalUrl || ''}`.toLowerCase().includes(needle))
        : snapshot;
      return {
        ok: true,
        count: items.length,
        recent: downloadMemory.recent,
        downloads: items.slice(0, Math.max(1, params.maxItems || 20)),
      };
    }
    case 'waitForDownload':
      return await waitForDownloadMatch(params.needle || '', {
        timeoutMs: params.timeoutMs || 20000,
        pollMs: params.pollMs || 500,
        waitForComplete: params.waitForComplete !== false,
        filter: params.filter || {},
      });
    case 'domActions':
      return await executeStructuredDomActions(params.actions || [], params.tabId ?? null);
    case 'startMacroRecording':
      macroState = {
        recording: true,
        name: params.name || null,
        actions: [],
        startedAt: new Date().toISOString(),
      };
      return getMacroState();
    case 'stopMacroRecording': {
      const finished = getMacroState();
      macroState.recording = false;
      if (params.saveAs || macroState.name) {
        namedRecipes[params.saveAs || macroState.name] = finished.actions;
        await persistRecipes();
      }
      return finished;
    }
    case 'getMacroState':
      return getMacroState();
    case 'saveFormProfile': {
      const name = String(params.name || '').trim();
      if (!name) throw new Error('name is required');
      const profile = {
        fields: params.fields || {},
        buttonText: params.buttonText || null,
        buttonSelector: params.buttonSelector || null,
        clickButton: !!params.clickButton,
        confirmSubmit: !!params.confirmSubmit,
        updatedAt: new Date().toISOString(),
      };
      setFormProfile(name, profile);
      await persistFormProfiles();
      return { ok: true, name, profile };
    }
    case 'listFormProfiles':
      return {
        profiles: Object.entries(getFormProfiles()).map(([name, profile]) => ({
          name,
          fieldCount: profile?.fields ? Object.keys(profile.fields).length : 0,
          buttonText: profile?.buttonText || null,
          buttonSelector: profile?.buttonSelector || null,
          clickButton: !!profile?.clickButton,
          confirmSubmit: !!profile?.confirmSubmit,
          updatedAt: profile?.updatedAt || null,
        })),
      };
    case 'deleteFormProfile': {
      const name = String(params.name || '').trim();
      if (!name) throw new Error('name is required');
      delete formProfiles[name];
      await persistFormProfiles();
      return { ok: true, deleted: name };
    }
    case 'formProfileAutofill': {
      const name = String(params.profileName || params.name || '').trim();
      const saved = name ? (formProfiles[name] || null) : null;
      const profile = params.profile || saved || {};
      const fields = params.fields || profile.fields || {};
      return await universalFormAssist({
        fields,
        entries: params.entries || null,
        clickButton: params.clickButton ?? !!profile.clickButton,
        confirmSubmit: params.confirmSubmit ?? !!profile.confirmSubmit,
        buttonText: params.buttonText || profile.buttonText || null,
        buttonSelector: params.buttonSelector || profile.buttonSelector || null,
        exactButton: !!params.exactButton,
        allowFallback: params.allowFallback === true,
      }, params.tabId ?? null);
    }
    case 'saveRecipe':
      if (!params.name) throw new Error('name is required');
      namedRecipes[String(params.name)] = params.actions || [];
      await persistRecipes();
      return { ok: true, name: String(params.name), actionCount: namedRecipes[String(params.name)].length };
    case 'listRecipes':
      return {
        recipes: Object.entries(namedRecipes).map(([name, actions]) => ({
          name,
          actionCount: Array.isArray(actions) ? actions.length : 0,
        })),
      };
    case 'deleteRecipe':
      if (!params.name) throw new Error('name is required');
      delete namedRecipes[String(params.name)];
      await persistRecipes();
      return { ok: true, deleted: String(params.name) };
    case 'runRecipe': {
      const name = String(params.name || '');
      if (!name) throw new Error('name is required');
      const recipe = namedRecipes[name];
      if (!Array.isArray(recipe)) throw new Error(`Unknown recipe: ${name}`);
      const results = [];
      for (const step of recipe) {
        const stepParams = { ...(step.params || {}) };
        if (params.tabId != null && stepParams.tabId == null) {
          stepParams.tabId = params.tabId;
        }
        results.push(await handleCommand({ action: step.action, params: stepParams }));
      }
      return { ok: true, name, stepCount: recipe.length, results };
    }
    case 'runActionQueue': {
      const queue = Array.isArray(params.queue) ? params.queue : [];
      if (!queue.length) throw new Error('queue is required');
      const results = [];
      for (const step of queue) {
        const action = String(step.action || '').trim();
        if (!action) throw new Error('queue step action is required');
        const stepParams = { ...(step.params || {}) };
        if (params.tabId != null && stepParams.tabId == null) {
          stepParams.tabId = params.tabId;
        }
        results.push({
          action,
          result: await handleCommand({ action, params: stepParams }),
        });
      }
      return { ok: true, steps: queue.length, results };
    }
    case 'runScript':
      return await executeInTab((script) => {
        const serialize = (value) => {
          try {
            return JSON.parse(JSON.stringify(value));
          } catch {
            return String(value);
          }
        };
        try {
          const result = (0, eval)(script);
          return {
            ok: true,
            result: serialize(result),
          };
        } catch (error) {
          return {
            ok: false,
            error: error?.message || String(error),
            hint: 'The page blocked eval-style script execution. Use domActions for CSP-safe interactions.',
          };
        }
      }, [params.script || 'null'], params.tabId ?? null);
    case 'networkAttach':
      return await attachNetworkMonitor(params.tabId ?? null);
    case 'networkDetach':
      return await detachNetworkMonitor(params.tabId ?? null);
    case 'networkGetLog':
      return getNetworkSnapshot(params.tabId ?? null);
    case 'networkClearLog':
      return clearNetworkLog(params.tabId ?? null);
    case 'recentTabs':
      return { tabs: await recentTabs(params.maxItems || 20) };
    default:
      throw new Error(`Unsupported action: ${command.action}`);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const consoleAttached = consoleState.attachedTabId === tabId;
  const networkAttached = networkState.attachedTabId === tabId;
  if (!consoleAttached && !networkAttached) return;
  const key = ensureTabBuckets(tabId);
  const requestMap = networkState.requestsByTab[key];

  if (consoleAttached && method === 'Runtime.consoleAPICalled') {
    appendConsoleEntry(tabId, {
      kind: 'console',
      level: params.type || 'log',
      text: (params.args || []).map((arg) => arg?.value ?? arg?.description ?? '').join(' ').trim(),
      stack: params.stackTrace?.callFrames?.slice(0, 6).map((frame) => ({
        url: frame.url,
        functionName: frame.functionName,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      })) || [],
    });
    return;
  }

  if (consoleAttached && method === 'Runtime.exceptionThrown') {
    appendConsoleEntry(tabId, {
      kind: 'exception',
      level: 'error',
      text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Runtime exception',
      url: params.exceptionDetails?.url || '',
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
    });
    return;
  }

  if (consoleAttached && method === 'Log.entryAdded') {
    appendConsoleEntry(tabId, {
      kind: 'log',
      level: params.entry?.level || 'info',
      text: params.entry?.text || '',
      url: params.entry?.url || '',
      lineNumber: params.entry?.lineNumber,
    });
    return;
  }

  if (!networkAttached) return;

  if (method === 'Network.requestWillBeSent') {
    requestMap[params.requestId] = {
      requestId: params.requestId,
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      startedAt: Date.now(),
      requestHeaders: params.request?.headers || {},
      requestBodyPreview: previewText(params.request?.postData),
    };
    appendNetworkEntry(tabId, {
      kind: 'request',
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      requestBodyPreview: previewText(params.request?.postData),
    });
    return;
  }

  if (method === 'Network.responseReceived') {
    const entry = requestMap[params.requestId] || {};
    entry.status = params.response?.status;
    entry.statusText = params.response?.statusText;
    entry.mimeType = params.response?.mimeType;
    entry.responseHeaders = params.response?.headers || {};
    entry.responseUrl = params.response?.url;
    requestMap[params.requestId] = entry;
    appendNetworkEntry(tabId, {
      kind: 'response',
      requestId: params.requestId,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      url: params.response?.url,
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const entry = requestMap[params.requestId] || {};
    const durationMs = entry.startedAt ? Date.now() - entry.startedAt : null;
    let responseMeta = { body: '', base64Encoded: false, preview: '' };
    try {
      const response = await chrome.debugger.sendCommand(debuggerTarget(tabId), 'Network.getResponseBody', {
        requestId: params.requestId,
      });
      responseMeta = normalizeResponseBody(response?.body || '', !!response?.base64Encoded, entry.mimeType || '');
    } catch {
      responseMeta = { body: '', base64Encoded: false, preview: '' };
    }
    networkState.responseBodiesByTab[key][params.requestId] = {
      url: entry.responseUrl || entry.url,
      mimeType: entry.mimeType || '',
      status: entry.status || null,
      method: entry.method || '',
      body: responseMeta.body,
      base64Encoded: responseMeta.base64Encoded,
      preview: responseMeta.preview,
    };
    appendNetworkEntry(tabId, {
      kind: 'finished',
      requestId: params.requestId,
      method: entry.method,
      status: entry.status,
      url: entry.responseUrl || entry.url,
      mimeType: entry.mimeType,
      durationMs,
      requestBodyPreview: entry.requestBodyPreview || '',
      responseBodyPreview: responseMeta.preview,
    });
    delete requestMap[params.requestId];
    return;
  }

  if (method === 'Network.loadingFailed') {
    const entry = requestMap[params.requestId] || {};
    appendNetworkEntry(tabId, {
      kind: 'failed',
      requestId: params.requestId,
      method: entry.method,
      url: entry.url,
      errorText: params.errorText,
      canceled: !!params.canceled,
    });
    delete requestMap[params.requestId];
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (networkState.attachedTabId === tabId) {
    appendNetworkEntry(tabId, { kind: 'system', message: `Network monitor detached: ${reason}` });
    networkState.attachedTabId = null;
  }
  if (consoleState.attachedTabId === tabId) {
    appendConsoleEntry(tabId, { kind: 'system', level: 'warn', text: `Console monitor detached: ${reason}` });
    consoleState.attachedTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ensureStateLoaded();
    if (message?.type === 'offscreen-heartbeat') {
      void warmBridge().catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'popup-connect-native-bridge') {
      const port = await connectNativeBridge();
      sendResponse({ ok: !!port, connected: !!nativeBridgePort, host: NATIVE_HOST_NAME });
      return;
    }
    if (message?.type === 'popup-get-state') {
      sendResponse({
        clientId: state.clientId,
        serverUrl: state.serverUrl,
        bridgeToken: state.bridgeToken,
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantApiKey: state.assistantApiKey,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
        assistantChatLog,
        assistantDraftAttachments,
        assistantArchiveAttachments,
        accessProfile: state.accessProfile,
        mouseCueEnabled: state.mouseCueEnabled,
        bridgeState: state,
        activeTab: await activeTab(),
        commandLog,
        network: getNetworkSnapshot(message.tabId ?? null),
        console: getConsoleSnapshot(message.tabId ?? null),
        macro: getMacroState(),
        recipes: Object.keys(namedRecipes),
        nativeBridge: {
          connected: !!nativeBridgePort,
          host: NATIVE_HOST_NAME,
          workspaceGroupId: state.workspaceGroupId,
        },
      });
      return;
    }
    if (message?.type === 'popup-save-server-url') {
      const value = String(message.serverUrl || '').trim();
      state.serverUrl = value || DEFAULT_SERVER;
      await chrome.storage.local.set({ serverUrl: state.serverUrl });
      sendResponse({ ok: true, serverUrl: state.serverUrl });
      return;
    }
    if (message?.type === 'popup-save-token') {
      state.bridgeToken = String(message.bridgeToken || '').trim();
      await chrome.storage.local.set({ bridgeToken: state.bridgeToken });
      sendResponse({ ok: true, bridgeToken: state.bridgeToken });
      return;
    }
    if (message?.type === 'popup-save-assistant-settings') {
      state.assistantApiEndpoint = String(message.assistantApiEndpoint || '').trim();
      state.assistantModel = String(message.assistantModel || '').trim();
      state.assistantApiKey = String(message.assistantApiKey || '').trim();
      state.assistantTask = String(message.assistantTask || '').trim();
      state.assistantRememberApiKey = message.assistantRememberApiKey === true;
      await chrome.storage.local.set({
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
        assistantChatLog,
      });
      if (state.assistantRememberApiKey) {
        await chrome.storage.local.set({ assistantApiKey: state.assistantApiKey });
      } else {
        await chrome.storage.local.remove('assistantApiKey');
      }
      sendResponse({
        ok: true,
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantApiKey: state.assistantApiKey,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
      });
      return;
    }
    if (message?.type === 'popup-run-assistant-task') {
      const assistantTask = String(message.assistantTask ?? state.assistantTask ?? '').trim();
      if (assistantTask) {
        const runSerial = ++assistantRunSerial;
        pushAssistantChat({
          role: 'user',
          text: assistantTask,
          attachments: assistantDraftAttachments.map((item) => ({ ...item })),
        });
        pushCommandLog({
          action: 'assistantTask',
          paramsPreview: assistantTask.length > 180 ? `${assistantTask.slice(0, 177)}...` : assistantTask,
        });
        try {
          const endpoint = String(message.assistantApiEndpoint || state.assistantApiEndpoint || '').trim();
          const apiKey = String(message.assistantApiKey || state.assistantApiKey || '').trim();
          const model = String(message.assistantModel || state.assistantModel || '').trim();
          if (!endpoint) throw new Error('Missing API endpoint');
          if (!apiKey) throw new Error('Missing API key');
          let browserContext = await collectAssistantPageContext();
          let assistantContext = buildAssistantRuntimeContext(browserContext);
          const conversation = [
            {
              role: 'system',
              content: buildAssistantSystemPrompt(assistantContext),
            },
            {
              role: 'user',
              content: buildAssistantTaskMessage(assistantTask, assistantDraftAttachments),
            },
          ];
          const assistantActionResults = [];
          const assistantReplies = [];
          const maxSteps = 100;
          let lastExecutionSummary = '';
          let finished = false;
          let lastModel = model;
          let previousActionFingerprint = '';
          let previousPageFingerprint = buildAssistantPageFingerprint(browserContext);
          const completedActionFingerprints = new Set();
          for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex += 1) {
            if (runSerial !== assistantRunSerial) {
              finished = true;
              lastExecutionSummary = 'Stopped because a newer assistant task started.';
              break;
            }
            const completion = await callAssistantApi({
              endpoint,
              apiKey,
              model,
              task: assistantTask,
              context: assistantContext,
              messages: conversation,
            });
            if (runSerial !== assistantRunSerial) {
              finished = true;
              lastExecutionSummary = 'Stopped because a newer assistant task started.';
              break;
            }
            lastModel = completion.model || lastModel;
            const completionText = extractAssistantTextFromCompletion(completion);
            const parsedPlan = normalizeAssistantPlan(parseAssistantPlan(completionText));
            const assistantText = parsedPlan?.assistantText || completionText || 'No response text returned.';
            const questionGuardReason = parsedPlan?.actions?.length
              ? questionChoiceGuardReason(parsedPlan.actions, assistantText, browserContext)
              : '';
            const displayedAssistantText = questionGuardReason
              ? 'План зупинено: не можна механічно вибирати перший або однаковий варіант. Потрібно розглянути одне питання, обґрунтувати конкретну дію та перевірити результат.'
              : assistantText;
            assistantReplies.push(displayedAssistantText);
            pushAssistantChat({ role: 'assistant', text: `Step ${stepIndex}: ${displayedAssistantText}` });
            conversation.push({
              role: 'assistant',
              content: displayedAssistantText,
            });
            if (parsedPlan?.actions?.length) {
              const currentActionFingerprint = buildAssistantActionFingerprint(parsedPlan.actions);
              const stepResults = await runAssistantActionPlan(parsedPlan.actions, browserContext.activeTab?.id ?? null, completedActionFingerprints, browserContext, assistantText);
              assistantActionResults.push(...stepResults);
              lastExecutionSummary = summarizeAssistantActions(stepResults);
              browserContext = await collectAssistantPageContext();
              assistantContext = buildAssistantRuntimeContext(browserContext);
              const currentPageFingerprint = buildAssistantPageFingerprint(browserContext);
              const repeatedAction = currentActionFingerprint
                && previousActionFingerprint
                && currentActionFingerprint === previousActionFingerprint;
              const unchangedPage = currentPageFingerprint === previousPageFingerprint;
              const sectionScopedFailure = stepResults.some((entry) => {
                const actionName = normalizeCommandAction(entry?.action || '');
                return (
                  (actionName === 'clickWithinSection' || actionName === 'scopeToSection' || actionName === 'listSectionControls' || actionName === 'describeSection' || actionName === 'fillWithinSection')
                  && entry?.result?.ok === false
                );
              });
              if (repeatedAction && unchangedPage && parsedPlan.done !== true) {
                lastExecutionSummary = [
                  lastExecutionSummary,
                  'Guard: the same action repeated while the page fingerprint did not change. Stop repeating it and inspect the page again before acting.',
                ].filter(Boolean).join('\n');
              }
              pushAssistantChat({
                role: 'assistant',
                text: `Step ${stepIndex} results:\n${lastExecutionSummary}`,
              });
              if (parsedPlan.done === true) {
                finished = true;
                break;
              }
              previousActionFingerprint = currentActionFingerprint;
              previousPageFingerprint = currentPageFingerprint;
              conversation.push({
                role: 'user',
                content: [
                  buildAssistantStepPrompt(
                    assistantTask,
                    stepIndex + 1,
                    assistantReplies.join('\n\n').slice(0, 4000),
                    lastExecutionSummary,
                  ),
                  buildAssistantLiveContextSnippet(browserContext),
                  repeatedAction && unchangedPage
                    ? 'Important: you just repeated the same action without changing the page. Do not repeat that action again. Read the fresh page state and choose a different next step or finish.'
                    : '',
                  sectionScopedFailure
                    ? 'Important: a section-scoped action failed. Retry with section-scoped tools only. Use explicit sectionNeedle and controlNeedle, and do not fall back to pageInteractClick or semanticClick across the whole page until the section is resolved.'
                    : '',
                ].filter(Boolean).join('\n\n'),
              });
              continue;
            }
            finished = true;
            break;
          }
          const assistantText = assistantReplies[assistantReplies.length - 1] || 'No response text returned.';
          state.assistantModel = lastModel || state.assistantModel;
          state.assistantTask = '';
          await chrome.storage.local.set({
            assistantTask: state.assistantTask,
            assistantChatLog,
            assistantApiEndpoint: endpoint,
            assistantModel: state.assistantModel,
          });
          sendResponse({
            ok: true,
            assistantTask: state.assistantTask,
            assistantReply: assistantText,
            assistantActionResults,
            assistantChatLog,
            assistantModel: state.assistantModel,
            assistantFinished: finished,
          });
          return;
        } catch (error) {
          const messageText = error.message || String(error);
          pushAssistantChat({ role: 'assistant', text: `Error: ${messageText}` });
          state.assistantTask = '';
          await chrome.storage.local.set({ assistantTask: state.assistantTask, assistantChatLog });
          sendResponse({
            ok: false,
            error: messageText,
            assistantChatLog,
            assistantTask: state.assistantTask,
          });
          return;
        }
      }
      sendResponse({ ok: true, assistantTask: state.assistantTask, assistantChatLog });
      return;
    }
    if (message?.type === 'popup-clear-assistant-chat') {
      assistantChatLog = [];
      await chrome.storage.local.set({ assistantChatLog });
      sendResponse({ ok: true, assistantChatLog });
      return;
    }
    if (message?.type === 'popup-add-assistant-files') {
      const destination = String(message.destination || 'draft').trim() === 'archive' ? 'archive' : 'draft';
      const items = Array.isArray(message.attachments)
        ? message.attachments.map((item) => sanitizeAssistantAttachment(item)).filter(Boolean)
        : [];
      if (!items.length) {
        sendResponse({
          ok: true,
          assistantDraftAttachments,
          assistantArchiveAttachments,
        });
        return;
      }
      if (destination === 'archive') {
        assistantArchiveAttachments = [...items, ...assistantArchiveAttachments]
          .slice(0, MAX_ASSISTANT_ATTACHMENT_ITEMS * 5);
      } else {
        assistantDraftAttachments = [...items, ...assistantDraftAttachments]
          .slice(0, MAX_ASSISTANT_ATTACHMENT_ITEMS);
      }
      await chrome.storage.local.set({
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      sendResponse({
        ok: true,
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      return;
    }
    if (message?.type === 'popup-remove-assistant-file') {
      const destination = String(message.destination || 'draft').trim() === 'archive' ? 'archive' : 'draft';
      const id = String(message.id || '').trim();
      if (id) {
        if (destination === 'archive') {
          assistantArchiveAttachments = assistantArchiveAttachments.filter((item) => item.id !== id);
        } else {
          assistantDraftAttachments = assistantDraftAttachments.filter((item) => item.id !== id);
        }
        await chrome.storage.local.set({
          assistantDraftAttachments,
          assistantArchiveAttachments,
        });
      }
      sendResponse({
        ok: true,
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      return;
    }
    if (message?.type === 'popup-copy-assistant-archive-file') {
      const id = String(message.id || '').trim();
      const item = assistantArchiveAttachments.find((entry) => entry.id === id);
      if (item) {
        assistantDraftAttachments = [{ ...item, source: 'chat' }, ...assistantDraftAttachments]
          .slice(0, MAX_ASSISTANT_ATTACHMENT_ITEMS);
        await chrome.storage.local.set({
          assistantDraftAttachments,
          assistantArchiveAttachments,
        });
      }
      sendResponse({
        ok: true,
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      return;
    }
    if (message?.type === 'popup-clear-assistant-files') {
      const destination = String(message.destination || 'draft').trim() === 'archive' ? 'archive' : 'draft';
      if (destination === 'archive') {
        assistantArchiveAttachments = [];
      } else {
        assistantDraftAttachments = [];
      }
      await chrome.storage.local.set({
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      sendResponse({
        ok: true,
        assistantDraftAttachments,
        assistantArchiveAttachments,
      });
      return;
    }
    if (message?.type === 'popup-save-access-profile') {
      const value = String(message.accessProfile || 'controlled').trim().toLowerCase();
      state.accessProfile = value === 'expanded' ? 'expanded' : 'controlled';
      await chrome.storage.local.set({ accessProfile: state.accessProfile });
      await persistWorkspaceState();
      void syncAccessProfileToBridge();
      sendResponse({ ok: true, accessProfile: state.accessProfile });
      return;
    }
    if (message?.type === 'popup-save-mouse-cue') {
      state.mouseCueEnabled = message.mouseCueEnabled !== false;
      await chrome.storage.local.set({ mouseCueEnabled: state.mouseCueEnabled });
      sendResponse({ ok: true, mouseCueEnabled: state.mouseCueEnabled });
      return;
    }
    if (message?.type === 'popup-network-attach') {
      sendResponse(await attachNetworkMonitor(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-network-detach') {
      sendResponse(await detachNetworkMonitor(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-network-clear') {
      sendResponse(clearNetworkLog(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-run-command') {
      const result = await handleCommand({
        action: message.action,
        params: message.params || {},
      });
      sendResponse({ ok: true, result });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown popup message' });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapBridge();
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapBridge();
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm?.name === HEARTBEAT_ALARM || alarm?.name === POLL_ALARM) {
    void warmBridge().catch(() => {});
  }
});

async function heartbeat() {
  await ensureStateLoaded();
  try {
    const tab = await activeTab();
    const response = await post('/api/register', { clientId: state.clientId, lastTab: tab });
    state.connected = true;
    state.lastError = null;
    state.mode = response.mode || state.mode;
    lastHeartbeatAt = Date.now();
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await persistBridgeState();
}

async function pollOnce() {
  await ensureStateLoaded();
  try {
    const payload = await get(`/api/pull?clientId=${encodeURIComponent(state.clientId)}`);
    state.connected = true;
    state.lastError = null;
    lastPollAt = Date.now();
    if (payload.command) {
      try {
        const data = await handleCommand(payload.command);
        await post('/api/result', {
          clientId: state.clientId,
          commandId: payload.command.commandId,
          ok: true,
          data,
          lastTab: await safeActiveTab(),
        });
      } catch (error) {
        try {
          await post('/api/result', {
            clientId: state.clientId,
            commandId: payload.command.commandId,
            ok: false,
            error: error.message || String(error),
            lastTab: await safeActiveTab(),
          });
        } catch (reportError) {
          state.lastError = reportError.message || String(reportError);
        }
      }
    }
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await persistBridgeState();
}

async function loop() {
  await bootstrapBridge();
  setInterval(heartbeat, 5000);
  setInterval(pollOnce, 700);
}

loop().catch((error) => {
  state.connected = false;
  state.lastError = error.message || String(error);
  void persistBridgeState();
});
