import json, os, sys, urllib.request, urllib.error
from pathlib import Path
from typing import Any
HOST = os.environ.get("CHROME_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHROME_BRIDGE_PORT", "17373"))
BASE_URL = f"http://{HOST}:{PORT}"
TOKEN = os.environ.get("CHROME_BRIDGE_TOKEN", "")
if not TOKEN:
    runtime_path = Path.home() / ".chrome-bridge" / "runtime.json"
    if runtime_path.exists():
        try:
            TOKEN = json.loads(runtime_path.read_text(encoding="utf-8")).get("token", "")
        except Exception:
            TOKEN = ""
TOOLS = [
    {"name":"chrome_bridge_status","description":"Return Chrome Bridge connectivity status and the latest connected client.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_active_tab","description":"Get metadata about the active Chrome tab in the connected profile.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_list_tabs","description":"List open Chrome tabs in the connected profile.","inputSchema":{"type":"object","properties":{"currentWindowOnly":{"type":"boolean","description":"When true, only list tabs from the current window."}},"additionalProperties":False}},
    {"name":"chrome_bridge_recent_tabs","description":"List recently accessed Chrome tabs.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_switch_tab","description":"Activate a Chrome tab by its id.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"required":["tabId"],"additionalProperties":False}},
    {"name":"chrome_bridge_open_tab","description":"Open a new Chrome tab.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"active":{"type":"boolean"}},"additionalProperties":False}},
    {"name":"chrome_bridge_search_web","description":"Open a new tab or navigate the current tab to a web search or direct URL.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"engine":{"type":"string","enum":["bing","google","duckduckgo","ddg","yahoo","brave"]},"newTab":{"type":"boolean"},"active":{"type":"boolean"},"timeoutMs":{"type":"integer"},"titleContains":{"type":"string"},"urlContains":{"type":"string"},"tabId":{"type":"integer"}},"required":["query"],"additionalProperties":False}},
    {"name":"chrome_bridge_reddit_compose_draft","description":"Open Reddit compose page in the user's personal browser and optionally prefill title/body for a draft post.","inputSchema":{"type":"object","properties":{"subreddit":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"},"timeoutMs":{"type":"integer"},"titleContains":{"type":"string"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_create_tab_group","description":"Open a new tab and place it into a Codex tab group workspace.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"active":{"type":"boolean"},"title":{"type":"string"},"color":{"type":"string"},"collapsed":{"type":"boolean"}},"additionalProperties":False}},
    {"name":"chrome_bridge_open_in_codex_workspace","description":"Open a new tab and add it to the existing Codex workspace group, or create the group if needed.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"active":{"type":"boolean"},"title":{"type":"string"},"color":{"type":"string"},"collapsed":{"type":"boolean"}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_tab_workspace_state","description":"Return the current Codex tab workspace group state.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_add_active_tab_to_workspace","description":"Add the active tab to the current Codex workspace group.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"},"title":{"type":"string"},"color":{"type":"string"},"collapsed":{"type":"boolean"}},"additionalProperties":False}},
    {"name":"chrome_bridge_close_tab","description":"Close a Chrome tab by id or the current active tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_text","description":"Extract visible page text from the active tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_html","description":"Extract page HTML from the active tab.","inputSchema":{"type":"object","properties":{"maxLength":{"type":"integer","description":"Maximum number of HTML characters to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_visible_dom","description":"Extract a compact list of visible interactive DOM elements from the active tab.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer","description":"Maximum number of visible elements to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_find_by_text","description":"Find visible page elements by text content.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_click_by_text","description":"Click the first visible interactive element whose text matches the provided text.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"exact":{"type":"boolean"},"selector":{"type":"string"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_click_nearest_match","description":"Click the closest visible text match among likely interactive elements.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"selector":{"type":"string"},"maxItems":{"type":"integer"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_list_frames","description":"List iframe/frame elements on the page.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_forms","description":"Inspect forms and fields on the page.","inputSchema":{"type":"object","properties":{"maxForms":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_fill_fields","description":"Fill multiple fields by selector in one call.","inputSchema":{"type":"object","properties":{"entries":{"type":"array","items":{"type":"object","properties":{"selector":{"type":"string"},"value":{"type":"string"},"checked":{"type":"boolean"},"selectValue":{"type":"string"}},"required":["selector"],"additionalProperties":False}}},"required":["entries"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_form_assist","description":"Find common form fields by label/name/placeholder/id and fill them, optionally clicking a button by text after confirmation.","inputSchema":{"type":"object","properties":{"fields":{"type":"object","additionalProperties":True},"entries":{"type":"array","items":{"type":"object","properties":{"key":{"type":"string"},"name":{"type":"string"},"label":{"type":"string"},"field":{"type":"string"},"selector":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"},"kind":{"type":"string"},"checked":{"type":"boolean"},"selectValue":{"type":"string"},"optionText":{"type":"string"},"optionValue":{"type":"string"},"buttonText":{"type":"string"},"buttonSelector":{"type":"string"},"exactButton":{"type":"boolean"},"clickButton":{"type":"boolean"},"confirmSubmit":{"type":"boolean"}},"additionalProperties":True}},"buttonText":{"type":"string"},"buttonSelector":{"type":"string"},"clickButton":{"type":"boolean"},"confirmSubmit":{"type":"boolean"},"exactButton":{"type":"boolean"},"allowFallback":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_elements","description":"List visible links, buttons, inputs, or all common interactive elements on the active tab.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["all","links","buttons","inputs"]},"maxItems":{"type":"integer","description":"Maximum number of elements to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_scroll","description":"Scroll the active tab vertically by a number of pixels.","inputSchema":{"type":"object","properties":{"deltaY":{"type":"integer","description":"Pixels to scroll. Positive scrolls down."}},"required":["deltaY"],"additionalProperties":False}},
    {"name":"chrome_bridge_smooth_scroll","description":"Scroll the active tab in smaller human-like steps.","inputSchema":{"type":"object","properties":{"totalY":{"type":"integer"},"stepY":{"type":"integer"},"delayMs":{"type":"integer"}},"required":["totalY"],"additionalProperties":False}},
    {"name":"chrome_bridge_infinite_scroll","description":"Scroll repeatedly to load more content until the page stabilizes.","inputSchema":{"type":"object","properties":{"maxPasses":{"type":"integer"},"stepY":{"type":"integer"},"delayMs":{"type":"integer"},"stablePasses":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_scroll_to_selector","description":"Scroll the page so a CSS selector is brought into view.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_click","description":"Click the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_move_cursor","description":"Move a visual cursor along a trajectory to a matching element.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"steps":{"type":"integer"},"durationMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_human_click","description":"Dispatch a more human-like pointer click on a selector.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"steps":{"type":"integer"},"button":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_double_click","description":"Double click the first element matching a CSS selector.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_right_click","description":"Open the context menu on the first element matching a CSS selector.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_hover","description":"Hover over the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_hover_inspect","description":"Hover and inspect whether menus, dialogs, or dropdowns appeared.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"waitMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_drag_and_drop","description":"Drag one element and drop it onto another selector.","inputSchema":{"type":"object","properties":{"sourceSelector":{"type":"string"},"targetSelector":{"type":"string"}},"required":["sourceSelector","targetSelector"],"additionalProperties":False}},
    {"name":"chrome_bridge_type","description":"Type text into the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"required":["selector","text"],"additionalProperties":False}},
    {"name":"chrome_bridge_paste_text","description":"Paste text into an element more like a user paste action.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"required":["selector","text"],"additionalProperties":False}},
    {"name":"chrome_bridge_type_into_editor","description":"Type into Monaco, CodeMirror, or contenteditable editors.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"},"append":{"type":"boolean"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_press_key","description":"Press a keyboard key in the active tab.","inputSchema":{"type":"object","properties":{"key":{"type":"string"},"ctrlKey":{"type":"boolean"},"altKey":{"type":"boolean"},"shiftKey":{"type":"boolean"},"metaKey":{"type":"boolean"}},"required":["key"],"additionalProperties":False}},
    {"name":"chrome_bridge_wait_for_selector","description":"Wait until a CSS selector appears and becomes visible in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"timeoutMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_wait_for_text","description":"Wait until visible page text appears.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"timeoutMs":{"type":"integer"},"exact":{"type":"boolean"},"selector":{"type":"string"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_select_option","description":"Select an option in a native <select> element.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"value":{"type":"string"},"label":{"type":"string"},"index":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_highlight_element","description":"Temporarily highlight a CSS selector on the page.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"color":{"type":"string"},"durationMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_screenshot","description":"Capture a screenshot of the current visible tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_element_screenshot","description":"Capture a screenshot cropped to a matching element selector.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"padding":{"type":"integer"},"tabId":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_full_page_screenshot","description":"Capture a full-page screenshot of the current tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_copy_page_content","description":"Copy the current page text or HTML to the system clipboard, even when the site blocks normal copy handlers.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["text","html"]},"maxLength":{"type":"integer","description":"Maximum number of characters to copy."}},"additionalProperties":False}},
    {"name":"chrome_bridge_select_text","description":"Select text on the page using a CSS selector or matching visible text.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_select_text_by_drag","description":"Select all text from an element using a drag-like gesture.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_copy_selected_text","description":"Copy the current browser text selection to the clipboard.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_storage","description":"Read localStorage and/or sessionStorage from the page.","inputSchema":{"type":"object","properties":{"storage":{"type":"string","enum":["local","session","all"]}},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_tables","description":"Extract structured table data from the page.","inputSchema":{"type":"object","properties":{"maxTables":{"type":"integer"},"maxRows":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_canvas_inspect","description":"Inspect canvas elements on the page and optionally return previews.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"includeDataUrl":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_overview","description":"Return a compact structural overview of the current page.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_page_dom_snapshot","description":"Return a deep DOM snapshot with forms, controls, frames, shadow hosts, and visible interactive elements.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"includeHidden":{"type":"boolean"},"includeFrames":{"type":"boolean"},"includeShadowDom":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_dom_outline","description":"Return a compact DOM outline with headings, forms, controls, landmarks, and optional text blocks.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"includeFrames":{"type":"boolean"},"includeShadowDom":{"type":"boolean"},"includeTextBlocks":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_summary","description":"Return a concise summary of the current page with title, url, headings, controls, and key notes.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_inspect","description":"Detect WordPress and report the current editor type, post context, login state, and available Elementor capabilities.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_admin_inspect","description":"Map the current WordPress admin screen, menu, notices, and visible list-table rows.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_content_list","description":"Read and filter visible WordPress posts, pages, media, plugins, themes, or users from the current admin list screen.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"text":{"type":"string"},"limit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_plugin_theme_audit","description":"Read plugin/theme rows, versions, notices, and available updates without changing anything.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_open_admin_section","description":"Navigate within the same WordPress site to a known admin section.","inputSchema":{"type":"object","properties":{"section":{"type":"string","enum":["dashboard","posts","pages","media","comments","themes","plugins","users","tools","settings","menus","widgets","elementortemplates","sitehealth"]},"timeoutMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["section"],"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_create_draft","description":"Create a WordPress page or post as draft only, using the current logged-in admin REST nonce and explicit confirmation.","inputSchema":{"type":"object","properties":{"type":{"type":"string","enum":["page","post"]},"title":{"type":"string"},"content":{"type":"string"},"excerpt":{"type":"string"},"slug":{"type":"string"},"confirmCreate":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["type","title","confirmCreate"],"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_open_plugin_search","description":"Open the same WordPress site's Add Plugins search screen for a query.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"timeoutMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["query"],"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_plugin_action","description":"Install, activate, deactivate, update, or delete a visible WordPress plugin only after explicit confirmation.","inputSchema":{"type":"object","properties":{"pluginAction":{"type":"string","enum":["install","activate","deactivate","update","delete"]},"pluginSlug":{"type":"string"},"name":{"type":"string"},"confirmAction":{"type":"boolean"},"confirmDelete":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["pluginAction","confirmAction"],"additionalProperties":False}},
    {"name":"chrome_bridge_wordpress_theme_action","description":"Install, activate, update, or delete a visible WordPress theme only after explicit confirmation.","inputSchema":{"type":"object","properties":{"themeAction":{"type":"string","enum":["install","activate","update","delete"]},"themeSlug":{"type":"string"},"name":{"type":"string"},"confirmAction":{"type":"boolean"},"confirmDelete":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["themeAction","confirmAction"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_wait_ready","description":"Wait until both the Elementor settings panel and preview document are fully available.","inputSchema":{"type":"object","properties":{"timeoutMs":{"type":"integer"},"pollMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_inspect","description":"Inspect the Elementor editor, preview iframe, stable element data-ids, widget types, selected element, and panel controls.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_navigator","description":"Return a compact Elementor hierarchy with stable ids, parent ids, depth, widget types, and short text.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"textLimit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_find_elements","description":"Find only matching Elementor elements by text, widget type, element type, parent id, and visibility.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"text":{"type":"string"},"textNeedle":{"type":"string"},"widgetType":{"type":"string"},"elementType":{"type":"string"},"parentId":{"type":"string"},"visibleOnly":{"type":"boolean"},"limit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_audit","description":"Run a technical Elementor preview audit for accessibility names, alt text, heading order, duplicate ids, field labels, overflow, and hit target size.","inputSchema":{"type":"object","properties":{"maxIssues":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_quality_suite","description":"Run a read-only Elementor quality suite for style tokens, links, forms, performance, language, layout, and reusable template widgets.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_responsive_audit","description":"Switch through desktop, tablet, and mobile Elementor modes, audit each preview, then restore the requested mode.","inputSchema":{"type":"object","properties":{"modes":{"type":"array","items":{"type":"string","enum":["desktop","tablet","mobile"]}},"restoreMode":{"type":"string","enum":["desktop","tablet","mobile"]},"maxIssues":{"type":"integer"},"waitMs":{"type":"integer"},"stopOnError":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_create_checkpoint","description":"Save a named session checkpoint of the current Elementor hierarchy before making changes.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"maxItems":{"type":"integer"},"textLimit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_compare_checkpoint","description":"Compare the current Elementor hierarchy with a named checkpoint and report added, removed, and changed elements.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"maxItems":{"type":"integer"},"textLimit":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_list_checkpoints","description":"List Elementor hierarchy checkpoints stored for the current browser tab session.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_select_element","description":"Select an Elementor element by stable elementId, map index, visible text, or widget type.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"textNeedle":{"type":"string"},"widgetType":{"type":"string"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_edit_text","description":"Select an Elementor element and edit its text through the real Elementor settings control so the change persists in the document model.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"textNeedle":{"type":"string"},"widgetType":{"type":"string"},"controlName":{"type":"string"},"value":{"type":"string"},"textValue":{"type":"string"},"content":{"type":"string"},"html":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_set_control","description":"Set one visible Elementor panel control by setting name or label after optionally selecting an element.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"textNeedle":{"type":"string"},"widgetType":{"type":"string"},"controlName":{"type":"string"},"setting":{"type":"string"},"label":{"type":"string"},"value":{"type":"string"},"checked":{"type":"boolean"},"html":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_set_controls","description":"Apply and verify a batch of named Elementor panel controls for one selected element.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"textNeedle":{"type":"string"},"widgetType":{"type":"string"},"controls":{"type":"array","items":{"type":"object","properties":{"controlName":{"type":"string"},"setting":{"type":"string"},"label":{"type":"string"},"value":{},"content":{},"checked":{"type":"boolean"},"html":{"type":"boolean"},"waitMs":{"type":"integer"}},"additionalProperties":False}},"stopOnError":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["controls"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_add_widget","description":"Add an Elementor widget from the Elements panel to a container using a verified drag-and-drop gesture.","inputSchema":{"type":"object","properties":{"widgetType":{"type":"string"},"widget":{"type":"string"},"targetElementId":{"type":"string"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_move_element","description":"Move an Elementor element into another container by stable ids and verify the hierarchy changed.","inputSchema":{"type":"object","properties":{"sourceElementId":{"type":"string"},"targetElementId":{"type":"string"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["sourceElementId","targetElementId"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_duplicate_element","description":"Duplicate one Elementor element and verify that a new element appeared.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"widgetType":{"type":"string"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_delete_element","description":"Delete one Elementor element only with explicit confirmDelete=true and verify its removal.","inputSchema":{"type":"object","properties":{"elementId":{"type":"string"},"index":{"type":"integer"},"text":{"type":"string"},"widgetType":{"type":"string"},"confirmDelete":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["confirmDelete"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_panel_tab","description":"Open the Elementor Content, Style, Advanced, or Layout settings tab and return its visible controls.","inputSchema":{"type":"object","properties":{"tab":{"type":"string","enum":["content","style","advanced","layout"]},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["tab"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_responsive_mode","description":"Switch the Elementor editor between desktop, tablet, and mobile responsive modes.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["desktop","tablet","mobile"]},"tabId":{"type":"integer"}},"required":["mode"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_undo","description":"Undo the latest Elementor document change.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_redo","description":"Redo the latest Elementor document change.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_preview","description":"Open Elementor preview without saving or publishing.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_run_workflow","description":"Run up to 60 verified Elementor steps, optionally roll back mutations on failure, preview, audit, and save only with explicit confirmation.","inputSchema":{"type":"object","properties":{"steps":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string"},"operation":{"type":"string"},"params":{"type":"object","additionalProperties":True}},"additionalProperties":False}},"stopOnError":{"type":"boolean"},"rollbackOnError":{"type":"boolean"},"previewAfter":{"type":"boolean"},"auditAfter":{"type":"boolean"},"maxAuditIssues":{"type":"integer"},"saveMode":{"type":"string","enum":["draft","update","publish"]},"confirmSave":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["steps"],"additionalProperties":False}},
    {"name":"chrome_bridge_elementor_save","description":"Save an Elementor document as draft, update, or publish only after explicit user confirmation.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["draft","update","publish"]},"confirmSave":{"type":"boolean"},"waitMs":{"type":"integer"},"tabId":{"type":"integer"}},"required":["mode","confirmSave"],"additionalProperties":False}},
    {"name":"chrome_bridge_page_section_reader","description":"Read the page as logical sections with titles, visible text, and nearby controls.","inputSchema":{"type":"object","properties":{"maxSections":{"type":"integer"},"maxItems":{"type":"integer"},"includeFrames":{"type":"boolean"},"includeShadowDom":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_scope_to_section","description":"Find the best visible container section by heading or keyword and return only that scoped block.","inputSchema":{"type":"object","properties":{"sectionNeedle":{"type":"string"},"section_needle":{"type":"string"},"needle":{"type":"string"},"section":{"type":"string"},"heading":{"type":"string"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_list_section_controls","description":"List only the visible controls inside a matched section container.","inputSchema":{"type":"object","properties":{"sectionNeedle":{"type":"string"},"section_needle":{"type":"string"},"needle":{"type":"string"},"section":{"type":"string"},"heading":{"type":"string"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_click_within_section","description":"Click only inside a matched section container using a control keyword or index.","inputSchema":{"type":"object","properties":{"sectionNeedle":{"type":"string"},"section_needle":{"type":"string"},"needle":{"type":"string"},"section":{"type":"string"},"heading":{"type":"string"},"controlNeedle":{"type":"string"},"control_needle":{"type":"string"},"control":{"type":"string"},"controlIndex":{"type":"integer"},"control_index":{"type":"integer"},"index":{"type":"integer"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_fill_within_section","description":"Fill fields only inside a matched section container.","inputSchema":{"type":"object","properties":{"sectionNeedle":{"type":"string"},"section_needle":{"type":"string"},"needle":{"type":"string"},"section":{"type":"string"},"heading":{"type":"string"},"fields":{"type":"object","additionalProperties":True},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_describe_section","description":"Describe a matched visible section and summarize its local controls.","inputSchema":{"type":"object","properties":{"sectionNeedle":{"type":"string"},"section_needle":{"type":"string"},"needle":{"type":"string"},"section":{"type":"string"},"heading":{"type":"string"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_find_dom_control","description":"Find DOM controls by text, label, placeholder, name, id, role, or kind across the current page.","inputSchema":{"type":"object","properties":{"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"includeFrames":{"type":"boolean"},"includeShadowDom":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["needle"],"additionalProperties":False}},
    {"name":"chrome_bridge_describe_dom_element","description":"Describe a specific DOM element or the best match for a needle, including label, attributes, form context, and geometry.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"exact":{"type":"boolean"},"maxItems":{"type":"integer"},"includeFrames":{"type":"boolean"},"includeShadowDom":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_modal_detector","description":"Detect visible modals, dialogs, popovers, toasts, and blocking overlays on the page.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_repeated_element_matcher","description":"Find repeated similar elements on the page and group them by signature.","inputSchema":{"type":"object","properties":{"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_next_visible_control","description":"Find the next visible interactive control relative to a needle or current focus.","inputSchema":{"type":"object","properties":{"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"direction":{"type":"string","enum":["next","previous","first","last"]},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_semantic_click","description":"Click a page element by intent or visible text rather than a strict selector.","inputSchema":{"type":"object","properties":{"intent":{"type":"string"},"selector":{"type":"string"},"tabId":{"type":"integer"}},"required":["intent"],"additionalProperties":False}},
    {"name":"chrome_bridge_page_diff_memory","description":"Store a short-term page snapshot and return diffs from the previous snapshot for the tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_resolve_dom_route","description":"Resolve the DOM route and geometry for a selector or visible text needle.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"exact":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_intent_map","description":"Map visible controls into likely intents such as submit, next, search, close, upload, or download.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_interact_map","description":"Build a numbered interaction map of visible controls so the agent can work by index or intent.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_page_interact_click","description":"Click a visible control from the interaction map by index, intent, or needle.","inputSchema":{"type":"object","properties":{"index":{"type":"integer"},"intent":{"type":"string"},"needle":{"type":"string"},"kind":{"type":"string","enum":["all","inputs","buttons","links","forms","text"]},"maxItems":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_smart_focus","description":"Focus the most likely input or button on the page.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["input","button"]},"text":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_watch_downloads","description":"Watch recent browser downloads and return a compact snapshot of matching items.","inputSchema":{"type":"object","properties":{"needle":{"type":"string"},"waitForComplete":{"type":"boolean"},"timeoutMs":{"type":"integer"},"pollMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_wait_for_download","description":"Wait until a matching browser download appears or completes.","inputSchema":{"type":"object","properties":{"needle":{"type":"string"},"waitForComplete":{"type":"boolean"},"timeoutMs":{"type":"integer"},"pollMs":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_ocr_from_screenshot","description":"Run OCR on a screenshot of the current page or a specific element.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"fullPage":{"type":"boolean"},"lang":{"type":"string"},"language":{"type":"string"},"padding":{"type":"integer"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_visual_page_compare","description":"Capture a screenshot and compare it against the previous baseline for the same site.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"fullPage":{"type":"boolean"},"baselinePath":{"type":"string"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_site_memory_snapshot","description":"Capture a page summary and store it in site memory for the current host.","inputSchema":{"type":"object","properties":{"note":{"type":"string"},"includeIntentMap":{"type":"boolean"},"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_site_memory","description":"Read the stored memory for the current site.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_clear_site_memory","description":"Clear the stored memory for the current site or a provided site URL.","inputSchema":{"type":"object","properties":{"site":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_open_file_picker","description":"Open the system file picker for an input[type=file].","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_set_file_input_files","description":"Set files on an input[type=file] using local filesystem paths.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"files":{"type":"array","items":{"type":"string"}},"tabId":{"type":"integer"}},"required":["selector","files"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_preview","description":"Preview assistive upload: validates allowed/manual files and returns file info + page screenshot before attachment.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"files":{"type":"array","items":{"type":"string"}},"manualSelectedFiles":{"type":"boolean"},"userOwnedCompletedWork":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["files"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_attach","description":"Attach validated files (no submit) after explicit confirmAttach=true.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"files":{"type":"array","items":{"type":"string"}},"manualSelectedFiles":{"type":"boolean"},"userOwnedCompletedWork":{"type":"boolean"},"confirmAttach":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["files","confirmAttach"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_submit","description":"Assistive submit with explicit confirmation and strict target guards (selector + optional expected host/url).","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"confirmSubmit":{"type":"boolean"},"expectedHost":{"type":"string"},"expectedUrlContains":{"type":"string"},"userOwnedCompletedWork":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["selector","confirmSubmit"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_attach_and_submit","description":"Attach and submit user-owned completed file with strict upload/domain/policy checks.","inputSchema":{"type":"object","properties":{"fileName":{"type":"string"},"userOwnedCompletedWork":{"type":"boolean"},"confirmAttach":{"type":"boolean"},"confirmSubmit":{"type":"boolean"},"allowEducationPlatformUpload":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"tabId":{"type":"integer"}},"required":["fileName","userOwnedCompletedWork","confirmAttach","confirmSubmit","allowEducationPlatformUpload"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_preflight","description":"Create preflight copy and perform technical readiness checks only.","inputSchema":{"type":"object","properties":{"fileName":{"type":"string"},"fileQuery":{"type":"string"},"userOwnedCompletedWork":{"type":"boolean"},"createTempCopy":{"type":"boolean"},"checkOnlyCopy":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}}},"required":["userOwnedCompletedWork"],"additionalProperties":False}},
    {"name":"chrome_bridge_file_upload_assistant_preflight_attach_and_submit","description":"Run preflight then attach and submit only if safeToAttach and policy checks pass.","inputSchema":{"type":"object","properties":{"fileName":{"type":"string"},"fileQuery":{"type":"string"},"userOwnedCompletedWork":{"type":"boolean"},"confirmAttach":{"type":"boolean"},"confirmSubmit":{"type":"boolean"},"allowEducationPlatformUpload":{"type":"boolean"},"usePreflightCopy":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"tabId":{"type":"integer"}},"required":["userOwnedCompletedWork","confirmAttach","confirmSubmit","allowEducationPlatformUpload"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_file_upload_preflight","description":"Find matching files by fileQuery and run preflight checks with screenshot.","inputSchema":{"type":"object","properties":{"fileQuery":{"type":"string"},"multiple":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"tabId":{"type":"integer"}},"required":["fileQuery"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_file_upload_preview","description":"Alias of universal preflight preview.","inputSchema":{"type":"object","properties":{"fileQuery":{"type":"string"},"multiple":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"tabId":{"type":"integer"}},"required":["fileQuery"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_file_upload_attach","description":"Attach matched allowed files by fileQuery.","inputSchema":{"type":"object","properties":{"fileQuery":{"type":"string"},"multiple":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"confirmAttach":{"type":"boolean"},"userOwnedCompletedWork":{"type":"boolean"},"allowEducationPlatformUpload":{"type":"boolean"},"usePreflightCopy":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["fileQuery","confirmAttach"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_file_upload_attach_and_submit","description":"Attach and submit matched files by fileQuery under strict policy checks.","inputSchema":{"type":"object","properties":{"fileQuery":{"type":"string"},"multiple":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"confirmAttach":{"type":"boolean"},"confirmSubmit":{"type":"boolean"},"userOwnedCompletedWork":{"type":"boolean"},"allowEducationPlatformUpload":{"type":"boolean"},"usePreflightCopy":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["fileQuery","confirmAttach","confirmSubmit","userOwnedCompletedWork","allowEducationPlatformUpload"],"additionalProperties":False}},
    {"name":"chrome_bridge_universal_file_upload_preflight_attach_and_submit","description":"Run preflight, then attach and submit in one guarded action.","inputSchema":{"type":"object","properties":{"fileQuery":{"type":"string"},"multiple":{"type":"boolean"},"manualSelectedFiles":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"confirmAttach":{"type":"boolean"},"confirmSubmit":{"type":"boolean"},"userOwnedCompletedWork":{"type":"boolean"},"allowEducationPlatformUpload":{"type":"boolean"},"usePreflightCopy":{"type":"boolean"},"tabId":{"type":"integer"}},"required":["fileQuery","confirmAttach","confirmSubmit","userOwnedCompletedWork","allowEducationPlatformUpload"],"additionalProperties":False}},
    {"name":"chrome_bridge_get_session_memory","description":"Read short-term bridge memory for the current page session.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_clear_session_memory","description":"Clear short-term bridge memory for a tab or for all tabs.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_save_form_profile","description":"Save a reusable set of form field values for the current browser workflow.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"profile":{"type":"object"},"tabId":{"type":"integer"}},"required":["name","profile"],"additionalProperties":False}},
    {"name":"chrome_bridge_list_form_profiles","description":"List saved form profiles.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_delete_form_profile","description":"Delete a saved form profile by name.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":False}},
    {"name":"chrome_bridge_form_profile_autofill","description":"Autofill the page using a saved form profile.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"tabId":{"type":"integer"}},"required":["name"],"additionalProperties":False}},
    {"name":"chrome_bridge_get_console_log","description":"Read captured console logs and page exceptions without opening DevTools.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_clear_console_log","description":"Clear captured console logs for a tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_cookies","description":"Read cookies for the current page URL or a provided URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_download_url","description":"Download a file directly through the browser.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"filename":{"type":"string"},"saveAs":{"type":"boolean"}},"required":["url"],"additionalProperties":False}},
    {"name":"chrome_bridge_read_response_body","description":"Read the stored full response body for a captured network request id.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"tabId":{"type":"integer"}},"required":["requestId"],"additionalProperties":False}},
    {"name":"chrome_bridge_start_macro_recording","description":"Start recording bridge commands into a reusable macro.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_stop_macro_recording","description":"Stop recording a macro and optionally save it as a named recipe.","inputSchema":{"type":"object","properties":{"saveAs":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_macro_state","description":"Read the current macro recorder state.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_save_recipe","description":"Save a named recipe made of bridge action steps.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"actions":{"type":"array","items":{"type":"object"}}},"required":["name","actions"],"additionalProperties":False}},
    {"name":"chrome_bridge_list_recipes","description":"List saved named recipes.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_delete_recipe","description":"Delete a saved named recipe.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":False}},
    {"name":"chrome_bridge_run_recipe","description":"Run a saved named recipe.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"tabId":{"type":"integer"}},"required":["name"],"additionalProperties":False}},
    {"name":"chrome_bridge_dom_actions","description":"Run a CSP-safe structured list of DOM actions such as Blockly block insertion, clicks, typing, notes, and attribute updates.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"},"actions":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string"}},"required":["action"],"additionalProperties":True}}},"required":["actions"],"additionalProperties":False}},
    {"name":"chrome_bridge_run_script","description":"Execute custom JavaScript in the page context and return a serialized result.","inputSchema":{"type":"object","properties":{"script":{"type":"string"}},"required":["script"],"additionalProperties":False}},
    {"name":"chrome_bridge_navigate","description":"Navigate the active tab to a URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":False}},
    {"name":"chrome_bridge_back","description":"Navigate the current tab back in history.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_forward","description":"Navigate the current tab forward in history.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_reload","description":"Reload the current tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
]
def http_get(path:str)->Any:
    headers={"Content-Type":"application/json"}
    if TOKEN: headers["X-Bridge-Token"]=TOKEN
    req=urllib.request.Request(BASE_URL+path,headers=headers)
    with urllib.request.urlopen(req,timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))
def http_post(path:str,payload:dict[str,Any])->Any:
    if TOKEN and "token" not in payload:
        payload["token"]=TOKEN
    data=json.dumps(payload).encode("utf-8")
    headers={"Content-Type":"application/json"}
    if TOKEN: headers["X-Bridge-Token"]=TOKEN
    req=urllib.request.Request(BASE_URL+path,data=data,headers=headers,method="POST")
    with urllib.request.urlopen(req,timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))
def send_response(msg_id:Any,result:Any)->None:
    payload={"jsonrpc":"2.0","id":msg_id,"result":result}
    raw=json.dumps(payload).encode("utf-8")
    sys.stdout.write(f"Content-Length: {len(raw)}\r\n\r\n")
    sys.stdout.flush(); sys.stdout.buffer.write(raw); sys.stdout.buffer.flush()
def send_error(msg_id:Any,code:int,message:str)->None:
    payload={"jsonrpc":"2.0","id":msg_id,"error":{"code":code,"message":message}}
    raw=json.dumps(payload).encode("utf-8")
    sys.stdout.write(f"Content-Length: {len(raw)}\r\n\r\n")
    sys.stdout.flush(); sys.stdout.buffer.write(raw); sys.stdout.buffer.flush()
def read_message()->dict[str,Any] | None:
    headers={}
    while True:
        line=sys.stdin.buffer.readline()
        if not line: return None
        if line in (b"\r\n", b"\n"): break
        key,value=line.decode("utf-8").split(":",1)
        headers[key.strip().lower()]=value.strip()
    length=int(headers.get("content-length","0"))
    if length<=0: return None
    body=sys.stdin.buffer.read(length)
    if not body: return None
    return json.loads(body.decode("utf-8"))
def as_text_content(value:Any)->dict[str,Any]:
    return {"content":[{"type":"text","text":json.dumps(value,ensure_ascii=False,indent=2)}]}
def call_bridge(action:str,params:dict[str,Any] | None=None)->Any:
    return http_post("/api/command",{"action":action,"params":params or {},"waitMs":20000})
def handle_tool(name:str,arguments:dict[str,Any])->dict[str,Any]:
    if name=="chrome_bridge_status": return as_text_content(http_get("/api/status"))
    if name=="chrome_bridge_get_active_tab": return as_text_content(call_bridge("getActiveTab"))
    if name=="chrome_bridge_list_tabs": return as_text_content(call_bridge("listTabs",{"currentWindowOnly":bool(arguments.get("currentWindowOnly",False))}))
    if name=="chrome_bridge_recent_tabs":
        payload={}
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("recentTabs",payload))
    if name=="chrome_bridge_switch_tab": return as_text_content(call_bridge("switchTab",{"tabId":int(arguments["tabId"])}))
    if name=="chrome_bridge_open_tab": return as_text_content(call_bridge("openNewTab",{"url":arguments.get("url","about:blank"),"active":bool(arguments.get("active",True))}))
    if name=="chrome_bridge_search_web":
        payload={"query":arguments["query"]}
        for field in ("engine","titleContains","urlContains"):
            if field in arguments: payload[field]=arguments[field]
        for field in ("newTab","active"):
            if field in arguments: payload[field]=bool(arguments[field])
        if "timeoutMs" in arguments: payload["timeoutMs"]=int(arguments["timeoutMs"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("searchWeb",payload))
    if name=="chrome_bridge_reddit_compose_draft":
        payload={}
        for field in ("subreddit","title","body","titleContains"):
            if field in arguments: payload[field]=arguments[field]
        if "timeoutMs" in arguments: payload["timeoutMs"]=int(arguments["timeoutMs"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("redditComposeDraft",payload))
    if name=="chrome_bridge_create_tab_group":
        payload={"url":arguments.get("url","about:blank"),"active":bool(arguments.get("active",True))}
        if "title" in arguments: payload["title"]=arguments["title"]
        if "color" in arguments: payload["color"]=arguments["color"]
        if "collapsed" in arguments: payload["collapsed"]=bool(arguments["collapsed"])
        return as_text_content(call_bridge("createCodexTabGroup",payload))
    if name=="chrome_bridge_open_in_codex_workspace":
        payload={"url":arguments.get("url","about:blank"),"active":bool(arguments.get("active",True))}
        if "title" in arguments: payload["title"]=arguments["title"]
        if "color" in arguments: payload["color"]=arguments["color"]
        if "collapsed" in arguments: payload["collapsed"]=bool(arguments["collapsed"])
        return as_text_content(call_bridge("openInCodexWorkspace",payload))
    if name=="chrome_bridge_get_tab_workspace_state": return as_text_content(call_bridge("getTabWorkspaceState"))
    if name=="chrome_bridge_add_active_tab_to_workspace":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        if "title" in arguments: payload["title"]=arguments["title"]
        if "color" in arguments: payload["color"]=arguments["color"]
        if "collapsed" in arguments: payload["collapsed"]=bool(arguments["collapsed"])
        return as_text_content(call_bridge("addActiveTabToWorkspace",payload))
    if name=="chrome_bridge_close_tab":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("closeTab",payload))
    if name=="chrome_bridge_extract_text": return as_text_content(call_bridge("extractText"))
    if name=="chrome_bridge_extract_html":
        payload={}
        if "maxLength" in arguments: payload["maxLength"]=int(arguments["maxLength"])
        return as_text_content(call_bridge("extractHtml",payload))
    if name=="chrome_bridge_extract_visible_dom":
        payload={}
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("extractVisibleDom",payload))
    if name=="chrome_bridge_find_by_text":
        payload={"text":arguments["text"]}
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("findByText",payload))
    if name=="chrome_bridge_click_by_text":
        payload={"text":arguments["text"]}
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "selector" in arguments: payload["selector"]=arguments["selector"]
        return as_text_content(call_bridge("clickByText",payload))
    if name=="chrome_bridge_click_nearest_match":
        payload={"text":arguments["text"]}
        if "selector" in arguments: payload["selector"]=arguments["selector"]
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("clickNearestMatch",payload))
    if name=="chrome_bridge_list_frames": return as_text_content(call_bridge("listFrames"))
    if name=="chrome_bridge_get_forms":
        payload={}
        if "maxForms" in arguments: payload["maxForms"]=int(arguments["maxForms"])
        return as_text_content(call_bridge("getForms",payload))
    if name=="chrome_bridge_fill_fields": return as_text_content(call_bridge("fillFields",{"entries":arguments["entries"]}))
    if name=="chrome_bridge_universal_form_assist":
        payload={}
        for field in ("fields","entries","buttonText","buttonSelector","exactButton","allowFallback"):
            if field in arguments: payload[field]=arguments[field]
        for field in ("clickButton","confirmSubmit"):
            if field in arguments: payload[field]=bool(arguments[field])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("universalFormAssist",payload))
    if name=="chrome_bridge_get_elements":
        payload={}
        if "kind" in arguments: payload["kind"]=arguments["kind"]
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("getElements",payload))
    if name=="chrome_bridge_scroll": return as_text_content(call_bridge("scroll",{"deltaY":int(arguments.get("deltaY",0))}))
    if name=="chrome_bridge_smooth_scroll":
        payload={"totalY":int(arguments["totalY"])}
        if "stepY" in arguments: payload["stepY"]=int(arguments["stepY"])
        if "delayMs" in arguments: payload["delayMs"]=int(arguments["delayMs"])
        return as_text_content(call_bridge("smoothScroll",payload))
    if name=="chrome_bridge_infinite_scroll":
        payload={}
        for field in ("maxPasses","stepY","delayMs","stablePasses"):
            if field in arguments: payload[field]=int(arguments[field])
        return as_text_content(call_bridge("infiniteScroll",payload))
    if name=="chrome_bridge_scroll_to_selector": return as_text_content(call_bridge("scrollToSelector",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_click": return as_text_content(call_bridge("click",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_move_cursor":
        payload={"selector":arguments["selector"]}
        if "steps" in arguments: payload["steps"]=int(arguments["steps"])
        if "durationMs" in arguments: payload["durationMs"]=int(arguments["durationMs"])
        return as_text_content(call_bridge("moveCursor",payload))
    if name=="chrome_bridge_human_click":
        payload={"selector":arguments["selector"]}
        if "steps" in arguments: payload["steps"]=int(arguments["steps"])
        if "button" in arguments: payload["button"]=int(arguments["button"])
        return as_text_content(call_bridge("humanClick",payload))
    if name=="chrome_bridge_double_click": return as_text_content(call_bridge("doubleClick",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_right_click": return as_text_content(call_bridge("rightClick",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_hover": return as_text_content(call_bridge("hover",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_hover_inspect":
        payload={"selector":arguments["selector"]}
        if "waitMs" in arguments: payload["waitMs"]=int(arguments["waitMs"])
        return as_text_content(call_bridge("hoverInspect",payload))
    if name=="chrome_bridge_drag_and_drop": return as_text_content(call_bridge("dragAndDrop",{"sourceSelector":arguments["sourceSelector"],"targetSelector":arguments["targetSelector"]}))
    if name=="chrome_bridge_type": return as_text_content(call_bridge("type",{"selector":arguments["selector"],"text":arguments["text"]}))
    if name=="chrome_bridge_paste_text": return as_text_content(call_bridge("pasteText",{"selector":arguments["selector"],"text":arguments["text"]}))
    if name=="chrome_bridge_type_into_editor":
        payload={"text":arguments["text"]}
        if "selector" in arguments: payload["selector"]=arguments["selector"]
        if "append" in arguments: payload["append"]=bool(arguments["append"])
        return as_text_content(call_bridge("typeIntoEditor",payload))
    if name=="chrome_bridge_press_key":
        payload={"key":arguments["key"]}
        for field in ("ctrlKey","altKey","shiftKey","metaKey"):
            if field in arguments: payload[field]=bool(arguments[field])
        return as_text_content(call_bridge("pressKey",payload))
    if name=="chrome_bridge_wait_for_selector":
        payload={"selector":arguments["selector"]}
        if "timeoutMs" in arguments: payload["timeoutMs"]=int(arguments["timeoutMs"])
        return as_text_content(call_bridge("waitForSelector",payload))
    if name=="chrome_bridge_wait_for_text":
        payload={"text":arguments["text"]}
        if "timeoutMs" in arguments: payload["timeoutMs"]=int(arguments["timeoutMs"])
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "selector" in arguments: payload["selector"]=arguments["selector"]
        return as_text_content(call_bridge("waitForText",payload))
    if name=="chrome_bridge_select_option":
        payload={"selector":arguments["selector"]}
        for field in ("value","label","index"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field=="index" else arguments[field]
        return as_text_content(call_bridge("selectOption",payload))
    if name=="chrome_bridge_highlight_element":
        payload={"selector":arguments["selector"]}
        if "color" in arguments: payload["color"]=arguments["color"]
        if "durationMs" in arguments: payload["durationMs"]=int(arguments["durationMs"])
        return as_text_content(call_bridge("highlightElement",payload))
    if name=="chrome_bridge_screenshot": return as_text_content(call_bridge("screenshot"))
    if name=="chrome_bridge_element_screenshot":
        payload={"selector":arguments["selector"]}
        if "padding" in arguments: payload["padding"]=int(arguments["padding"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("elementScreenshot",payload))
    if name=="chrome_bridge_full_page_screenshot": return as_text_content(call_bridge("fullPageScreenshot"))
    if name=="chrome_bridge_copy_page_content":
        payload={}
        if "mode" in arguments: payload["mode"]=arguments["mode"]
        if "maxLength" in arguments: payload["maxLength"]=int(arguments["maxLength"])
        return as_text_content(call_bridge("copyPageContent",payload))
    if name=="chrome_bridge_select_text":
        payload={}
        if "selector" in arguments: payload["selector"]=arguments["selector"]
        if "text" in arguments: payload["text"]=arguments["text"]
        return as_text_content(call_bridge("selectText",payload))
    if name=="chrome_bridge_select_text_by_drag": return as_text_content(call_bridge("selectTextByDrag",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_copy_selected_text": return as_text_content(call_bridge("copySelectedText"))
    if name=="chrome_bridge_get_storage":
        payload={}
        if "storage" in arguments: payload["storage"]=arguments["storage"]
        return as_text_content(call_bridge("getStorage",payload))
    if name=="chrome_bridge_extract_tables":
        payload={}
        if "maxTables" in arguments: payload["maxTables"]=int(arguments["maxTables"])
        if "maxRows" in arguments: payload["maxRows"]=int(arguments["maxRows"])
        return as_text_content(call_bridge("extractTables",payload))
    if name=="chrome_bridge_canvas_inspect":
        payload={}
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        if "includeDataUrl" in arguments: payload["includeDataUrl"]=bool(arguments["includeDataUrl"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("canvasInspect",payload))
    if name=="chrome_bridge_page_overview": return as_text_content(call_bridge("pageOverview"))
    if name=="chrome_bridge_page_dom_snapshot":
        payload={}
        for field in ("maxItems","includeHidden","includeFrames","includeShadowDom","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else bool(arguments[field])
        return as_text_content(call_bridge("pageDomSnapshot",payload))
    if name=="chrome_bridge_page_dom_outline":
        payload={}
        for field in ("maxItems","includeFrames","includeShadowDom","includeTextBlocks","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else bool(arguments[field])
        return as_text_content(call_bridge("pageDomOutline",payload))
    if name=="chrome_bridge_page_summary":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("pageSummary",payload))
    if name=="chrome_bridge_page_section_reader":
        payload={}
        for field in ("maxSections","maxItems","includeFrames","includeShadowDom","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxSections","maxItems","tabId") else bool(arguments[field])
        return as_text_content(call_bridge("pageSectionReader",payload))
    if name=="chrome_bridge_scope_to_section":
        payload={}
        for field in ("sectionNeedle","section_needle","needle","section","heading","tabId"):
            if field in arguments and arguments[field] is not None:
                payload["tabId" if field=="tabId" else field]=int(arguments[field]) if field=="tabId" else arguments[field]
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("scopeToSection",payload))
    if name=="chrome_bridge_list_section_controls":
        payload={}
        for field in ("sectionNeedle","section_needle","needle","section","heading","tabId"):
            if field in arguments and arguments[field] is not None:
                payload["tabId" if field=="tabId" else field]=int(arguments[field]) if field=="tabId" else arguments[field]
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("listSectionControls",payload))
    if name=="chrome_bridge_click_within_section":
        payload={}
        for field in ("sectionNeedle","section_needle","needle","section","heading","controlNeedle","control_needle","control","tabId"):
            if field in arguments and arguments[field] is not None:
                payload["tabId" if field=="tabId" else field]=int(arguments[field]) if field=="tabId" else arguments[field]
        for field in ("controlIndex","control_index","index","maxItems"):
            if field in arguments and arguments[field] is not None:
                payload[field]=int(arguments[field])
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        return as_text_content(call_bridge("clickWithinSection",payload))
    if name=="chrome_bridge_fill_within_section":
        payload={}
        for field in ("sectionNeedle","section_needle","needle","section","heading","tabId"):
            if field in arguments and arguments[field] is not None:
                payload["tabId" if field=="tabId" else field]=int(arguments[field]) if field=="tabId" else arguments[field]
        if "fields" in arguments and arguments["fields"] is not None: payload["fields"]=arguments["fields"]
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("fillWithinSection",payload))
    if name=="chrome_bridge_describe_section":
        payload={}
        for field in ("sectionNeedle","section_needle","needle","section","heading","tabId"):
            if field in arguments and arguments[field] is not None:
                payload["tabId" if field=="tabId" else field]=int(arguments[field]) if field=="tabId" else arguments[field]
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("describeSection",payload))
    if name=="chrome_bridge_find_dom_control":
        payload={"needle":arguments["needle"]}
        for field in ("kind","exact","maxItems","includeFrames","includeShadowDom","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else bool(arguments[field]) if field in ("exact","includeFrames","includeShadowDom") else arguments[field]
        return as_text_content(call_bridge("findDomControl",payload))
    if name=="chrome_bridge_describe_dom_element":
        payload={}
        for field in ("selector","needle","kind"):
            if field in arguments and arguments[field] is not None:
                payload[field]=arguments[field]
        for field in ("exact","maxItems","includeFrames","includeShadowDom","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else bool(arguments[field]) if field in ("exact","includeFrames","includeShadowDom") else arguments[field]
        return as_text_content(call_bridge("describeDomElement",payload))
    if name=="chrome_bridge_modal_detector":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("modalDetector",payload))
    if name=="chrome_bridge_repeated_element_matcher":
        payload={}
        for field in ("needle","kind","maxItems","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else arguments[field]
        return as_text_content(call_bridge("repeatedElementMatcher",payload))
    if name=="chrome_bridge_next_visible_control":
        payload={}
        for field in ("needle","kind","direction","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field=="tabId" else arguments[field]
        return as_text_content(call_bridge("nextVisibleControl",payload))
    if name=="chrome_bridge_semantic_click":
        payload={"intent":arguments["intent"]}
        if "selector" in arguments and arguments["selector"] is not None:
            payload["selector"]=arguments["selector"]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("semanticClick",payload))
    if name=="chrome_bridge_page_diff_memory":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("pageDiffMemory",payload))
    if name=="chrome_bridge_resolve_dom_route":
        payload={}
        for field in ("selector","needle","kind"):
            if field in arguments and arguments[field] is not None:
                payload[field]=arguments[field]
        if "exact" in arguments: payload["exact"]=bool(arguments["exact"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("resolveDomRoute",payload))
    if name=="chrome_bridge_page_intent_map":
        payload={}
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("pageIntentMap",payload))
    if name=="chrome_bridge_page_interact_map":
        payload={}
        for field in ("kind","maxItems","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("maxItems","tabId") else arguments[field]
        return as_text_content(call_bridge("pageInteractMap",payload))
    if name=="chrome_bridge_page_interact_click":
        payload={}
        for field in ("index","intent","needle","kind","maxItems","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("index","maxItems","tabId") else arguments[field]
        return as_text_content(call_bridge("pageInteractClick",payload))
    if name=="chrome_bridge_smart_focus":
        payload={}
        if "mode" in arguments: payload["mode"]=arguments["mode"]
        if "text" in arguments: payload["text"]=arguments["text"]
        return as_text_content(call_bridge("smartFocus",payload))
    if name=="chrome_bridge_watch_downloads":
        payload={}
        for field in ("needle","waitForComplete","timeoutMs","pollMs","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("timeoutMs","pollMs","tabId") else bool(arguments[field]) if field=="waitForComplete" else arguments[field]
        return as_text_content(call_bridge("watchDownloads",payload))
    if name=="chrome_bridge_wait_for_download":
        payload={}
        for field in ("needle","waitForComplete","timeoutMs","pollMs","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("timeoutMs","pollMs","tabId") else bool(arguments[field]) if field=="waitForComplete" else arguments[field]
        return as_text_content(call_bridge("waitForDownload",payload))
    if name=="chrome_bridge_ocr_from_screenshot":
        payload={}
        for field in ("selector","fullPage","lang","language","padding","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field in ("padding","tabId") else bool(arguments[field]) if field=="fullPage" else arguments[field]
        return as_text_content(call_bridge("ocrFromScreenshot",payload))
    if name=="chrome_bridge_visual_page_compare":
        payload={}
        for field in ("selector","fullPage","baselinePath","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field=="tabId" else bool(arguments[field]) if field=="fullPage" else arguments[field]
        return as_text_content(call_bridge("visualPageCompare",payload))
    if name=="chrome_bridge_site_memory_snapshot":
        payload={}
        for field in ("note","includeIntentMap","tabId"):
            if field in arguments:
                payload[field]=int(arguments[field]) if field=="tabId" else bool(arguments[field]) if field=="includeIntentMap" else arguments[field]
        return as_text_content(call_bridge("siteMemorySnapshot",payload))
    if name=="chrome_bridge_get_site_memory":
        return as_text_content(call_bridge("getSiteMemory"))
    if name=="chrome_bridge_clear_site_memory":
        payload={}
        if "site" in arguments: payload["site"]=arguments["site"]
        return as_text_content(call_bridge("clearSiteMemory",payload))
    if name=="chrome_bridge_open_file_picker": return as_text_content(call_bridge("openFilePicker",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_set_file_input_files":
        payload={"selector":arguments["selector"],"files":arguments["files"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("setFileInputFiles",payload))
    if name=="chrome_bridge_file_upload_assistant_preview":
        payload={"files":arguments["files"]}
        for field in ("selector","manualSelectedFiles","userOwnedCompletedWork"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("fileUploadAssistantPreview",payload))
    if name=="chrome_bridge_file_upload_assistant_attach":
        payload={"files":arguments["files"],"confirmAttach":bool(arguments.get("confirmAttach",False))}
        for field in ("selector","manualSelectedFiles","userOwnedCompletedWork"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("fileUploadAssistantAttach",payload))
    if name=="chrome_bridge_file_upload_assistant_submit":
        payload={"selector":arguments["selector"],"confirmSubmit":bool(arguments.get("confirmSubmit",False))}
        for field in ("expectedHost","expectedUrlContains","userOwnedCompletedWork"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("fileUploadAssistantSubmit",payload))
    if name=="chrome_bridge_file_upload_assistant_attach_and_submit":
        payload={
            "fileName":arguments["fileName"],
            "userOwnedCompletedWork":bool(arguments.get("userOwnedCompletedWork",False)),
            "confirmAttach":bool(arguments.get("confirmAttach",False)),
            "confirmSubmit":bool(arguments.get("confirmSubmit",False)),
            "allowEducationPlatformUpload":bool(arguments.get("allowEducationPlatformUpload",False)),
        }
        for field in ("manualSelectedFiles","selector"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("fileUploadAssistantAttachAndSubmit",payload))
    if name=="chrome_bridge_file_upload_assistant_preflight":
        payload={"userOwnedCompletedWork":bool(arguments.get("userOwnedCompletedWork",False))}
        for field in ("fileName","fileQuery","createTempCopy","checkOnlyCopy","manualSelectedFiles"):
            if field in arguments: payload[field]=arguments[field]
        if "fileQuery" not in payload and "fileName" in payload:
            payload["fileQuery"]=payload["fileName"]
        return as_text_content(call_bridge("fileUploadAssistantPreflight",payload))
    if name=="chrome_bridge_file_upload_assistant_preflight_attach_and_submit":
        payload={
            "userOwnedCompletedWork":bool(arguments.get("userOwnedCompletedWork",False)),
            "confirmAttach":bool(arguments.get("confirmAttach",False)),
            "confirmSubmit":bool(arguments.get("confirmSubmit",False)),
            "allowEducationPlatformUpload":bool(arguments.get("allowEducationPlatformUpload",False)),
            "usePreflightCopy":bool(arguments.get("usePreflightCopy",True)),
        }
        for field in ("fileName","fileQuery","manualSelectedFiles","selector"):
            if field in arguments: payload[field]=arguments[field]
        if "fileQuery" not in payload and "fileName" in payload:
            payload["fileQuery"]=payload["fileName"]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("fileUploadAssistantPreflightAttachAndSubmit",payload))
    if name in ("chrome_bridge_universal_file_upload_preflight","chrome_bridge_universal_file_upload_preview"):
        payload={"fileQuery":arguments["fileQuery"]}
        for field in ("multiple","manualSelectedFiles","selector"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("universalFileUploadPreflight",payload))
    if name=="chrome_bridge_universal_file_upload_attach":
        payload={"fileQuery":arguments["fileQuery"],"confirmAttach":bool(arguments.get("confirmAttach",False))}
        for field in ("multiple","manualSelectedFiles","selector","userOwnedCompletedWork","allowEducationPlatformUpload","usePreflightCopy"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("universalFileUploadAttach",payload))
    if name in ("chrome_bridge_universal_file_upload_attach_and_submit","chrome_bridge_universal_file_upload_preflight_attach_and_submit"):
        payload={
            "fileQuery":arguments["fileQuery"],
            "confirmAttach":bool(arguments.get("confirmAttach",False)),
            "confirmSubmit":bool(arguments.get("confirmSubmit",False)),
            "userOwnedCompletedWork":bool(arguments.get("userOwnedCompletedWork",False)),
            "allowEducationPlatformUpload":bool(arguments.get("allowEducationPlatformUpload",False)),
        }
        for field in ("multiple","manualSelectedFiles","selector","usePreflightCopy"):
            if field in arguments: payload[field]=arguments[field]
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("universalFileUploadAttachAndSubmit",payload))
    if name=="chrome_bridge_get_session_memory":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("getSessionMemory",payload))
    if name=="chrome_bridge_clear_session_memory":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("clearSessionMemory",payload))
    if name=="chrome_bridge_save_form_profile":
        payload={"name":arguments["name"],"profile":arguments["profile"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("saveFormProfile",payload))
    if name=="chrome_bridge_list_form_profiles":
        return as_text_content(call_bridge("listFormProfiles"))
    if name=="chrome_bridge_delete_form_profile":
        return as_text_content(call_bridge("deleteFormProfile",{"name":arguments["name"]}))
    if name=="chrome_bridge_form_profile_autofill":
        payload={"name":arguments["name"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("formProfileAutofill",payload))
    if name=="chrome_bridge_get_console_log":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("getConsoleLog",payload))
    if name=="chrome_bridge_clear_console_log":
        payload={}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("clearConsoleLog",payload))
    if name=="chrome_bridge_get_cookies":
        payload={}
        if "url" in arguments: payload["url"]=arguments["url"]
        return as_text_content(call_bridge("getCookies",payload))
    if name=="chrome_bridge_download_url":
        payload={"url":arguments["url"]}
        if "filename" in arguments: payload["filename"]=arguments["filename"]
        if "saveAs" in arguments: payload["saveAs"]=bool(arguments["saveAs"])
        return as_text_content(call_bridge("downloadUrl",payload))
    if name=="chrome_bridge_read_response_body":
        payload={"requestId":arguments["requestId"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("readResponseBody",payload))
    if name=="chrome_bridge_start_macro_recording":
        payload={}
        if "name" in arguments: payload["name"]=arguments["name"]
        return as_text_content(call_bridge("startMacroRecording",payload))
    if name=="chrome_bridge_stop_macro_recording":
        payload={}
        if "saveAs" in arguments: payload["saveAs"]=arguments["saveAs"]
        return as_text_content(call_bridge("stopMacroRecording",payload))
    if name=="chrome_bridge_get_macro_state": return as_text_content(call_bridge("getMacroState"))
    if name=="chrome_bridge_save_recipe": return as_text_content(call_bridge("saveRecipe",{"name":arguments["name"],"actions":arguments["actions"]}))
    if name=="chrome_bridge_list_recipes": return as_text_content(call_bridge("listRecipes"))
    if name=="chrome_bridge_delete_recipe": return as_text_content(call_bridge("deleteRecipe",{"name":arguments["name"]}))
    if name=="chrome_bridge_run_recipe":
        payload={"name":arguments["name"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("runRecipe",payload))
    if name=="chrome_bridge_dom_actions":
        payload={"actions":arguments["actions"]}
        if "tabId" in arguments: payload["tabId"]=int(arguments["tabId"])
        return as_text_content(call_bridge("domActions",payload))
    if name=="chrome_bridge_run_script": return as_text_content(call_bridge("runScript",{"script":arguments["script"]}))
    if name=="chrome_bridge_navigate": return as_text_content(call_bridge("navigate",{"url":arguments["url"]}))
    if name=="chrome_bridge_back": return as_text_content(call_bridge("back"))
    if name=="chrome_bridge_forward": return as_text_content(call_bridge("forward"))
    if name=="chrome_bridge_reload": return as_text_content(call_bridge("reload"))
    elementor_tools={
        "chrome_bridge_wordpress_inspect":"wordpressInspect",
        "chrome_bridge_wordpress_admin_inspect":"wordpressAdminInspect",
        "chrome_bridge_wordpress_content_list":"wordpressContentList",
        "chrome_bridge_wordpress_plugin_theme_audit":"wordpressPluginThemeAudit",
        "chrome_bridge_wordpress_open_admin_section":"wordpressOpenAdminSection",
        "chrome_bridge_wordpress_create_draft":"wordpressCreateDraft",
        "chrome_bridge_wordpress_open_plugin_search":"wordpressOpenPluginSearch",
        "chrome_bridge_wordpress_plugin_action":"wordpressPluginAction",
        "chrome_bridge_wordpress_theme_action":"wordpressThemeAction",
        "chrome_bridge_elementor_wait_ready":"elementorWaitReady",
        "chrome_bridge_elementor_inspect":"elementorInspect",
        "chrome_bridge_elementor_navigator":"elementorNavigator",
        "chrome_bridge_elementor_find_elements":"elementorFindElements",
        "chrome_bridge_elementor_audit":"elementorAudit",
        "chrome_bridge_elementor_quality_suite":"elementorQualitySuite",
        "chrome_bridge_elementor_responsive_audit":"elementorResponsiveAudit",
        "chrome_bridge_elementor_create_checkpoint":"elementorCreateCheckpoint",
        "chrome_bridge_elementor_compare_checkpoint":"elementorCompareCheckpoint",
        "chrome_bridge_elementor_list_checkpoints":"elementorListCheckpoints",
        "chrome_bridge_elementor_select_element":"elementorSelectElement",
        "chrome_bridge_elementor_edit_text":"elementorEditText",
        "chrome_bridge_elementor_set_control":"elementorSetControl",
        "chrome_bridge_elementor_set_controls":"elementorSetControls",
        "chrome_bridge_elementor_add_widget":"elementorAddWidget",
        "chrome_bridge_elementor_move_element":"elementorMoveElement",
        "chrome_bridge_elementor_duplicate_element":"elementorDuplicateElement",
        "chrome_bridge_elementor_delete_element":"elementorDeleteElement",
        "chrome_bridge_elementor_panel_tab":"elementorPanelTab",
        "chrome_bridge_elementor_responsive_mode":"elementorResponsiveMode",
        "chrome_bridge_elementor_undo":"elementorUndo",
        "chrome_bridge_elementor_redo":"elementorRedo",
        "chrome_bridge_elementor_preview":"elementorPreview",
        "chrome_bridge_elementor_run_workflow":"elementorRunWorkflow",
        "chrome_bridge_elementor_save":"elementorSave",
    }
    if name in elementor_tools:
        payload=dict(arguments)
        if "tabId" in payload: payload["tabId"]=int(payload["tabId"])
        if "index" in payload: payload["index"]=int(payload["index"])
        if "maxItems" in payload: payload["maxItems"]=int(payload["maxItems"])
        if "textLimit" in payload: payload["textLimit"]=int(payload["textLimit"])
        if "waitMs" in payload: payload["waitMs"]=int(payload["waitMs"])
        if "timeoutMs" in payload: payload["timeoutMs"]=int(payload["timeoutMs"])
        if "pollMs" in payload: payload["pollMs"]=int(payload["pollMs"])
        if "limit" in payload: payload["limit"]=int(payload["limit"])
        if "maxIssues" in payload: payload["maxIssues"]=int(payload["maxIssues"])
        if "maxAuditIssues" in payload: payload["maxAuditIssues"]=int(payload["maxAuditIssues"])
        return as_text_content(call_bridge(elementor_tools[name],payload))
    raise ValueError(f"Unknown tool: {name}")
def main()->None:
    while True:
        message=read_message()
        if message is None: break
        method=message.get("method"); msg_id=message.get("id")
        try:
            if method=="initialize":
              send_response(msg_id,{"protocolVersion":message.get("params",{}).get("protocolVersion","2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"chrome-bridge","version":"0.3.0"}})
            elif method=="notifications/initialized":
                continue
            elif method=="tools/list":
                send_response(msg_id,{"tools":TOOLS})
            elif method=="tools/call":
                params=message.get("params",{})
                send_response(msg_id, handle_tool(params.get("name",""), params.get("arguments",{}) or {}))
            else:
                send_error(msg_id,-32601,f"Method not found: {method}")
        except urllib.error.URLError as exc:
            send_error(msg_id,-32000,f"Chrome Bridge hub is unreachable at {BASE_URL}: {exc}")
        except Exception as exc:
            send_error(msg_id,-32001,str(exc))
if __name__ == "__main__":
    main()
