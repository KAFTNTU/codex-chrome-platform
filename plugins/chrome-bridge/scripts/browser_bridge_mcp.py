import json, os, sys, urllib.request, urllib.error
from typing import Any
HOST = os.environ.get("CHROME_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHROME_BRIDGE_PORT", "17373"))
BASE_URL = f"http://{HOST}:{PORT}"
TOOLS = [
    {"name":"chrome_bridge_status","description":"Return Chrome Bridge connectivity status and the latest connected client.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_active_tab","description":"Get metadata about the active Chrome tab in the connected profile.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_list_tabs","description":"List open Chrome tabs in the connected profile.","inputSchema":{"type":"object","properties":{"currentWindowOnly":{"type":"boolean","description":"When true, only list tabs from the current window."}},"additionalProperties":False}},
    {"name":"chrome_bridge_recent_tabs","description":"List recently accessed Chrome tabs.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_switch_tab","description":"Activate a Chrome tab by its id.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"required":["tabId"],"additionalProperties":False}},
    {"name":"chrome_bridge_open_tab","description":"Open a new Chrome tab.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"active":{"type":"boolean"}},"additionalProperties":False}},
    {"name":"chrome_bridge_close_tab","description":"Close a Chrome tab by id or the current active tab.","inputSchema":{"type":"object","properties":{"tabId":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_text","description":"Extract visible page text from the active tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_html","description":"Extract page HTML from the active tab.","inputSchema":{"type":"object","properties":{"maxLength":{"type":"integer","description":"Maximum number of HTML characters to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_visible_dom","description":"Extract a compact list of visible interactive DOM elements from the active tab.","inputSchema":{"type":"object","properties":{"maxItems":{"type":"integer","description":"Maximum number of visible elements to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_find_by_text","description":"Find visible page elements by text content.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"exact":{"type":"boolean"},"maxItems":{"type":"integer"}},"required":["text"],"additionalProperties":False}},
    {"name":"chrome_bridge_list_frames","description":"List iframe/frame elements on the page.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_forms","description":"Inspect forms and fields on the page.","inputSchema":{"type":"object","properties":{"maxForms":{"type":"integer"}},"additionalProperties":False}},
    {"name":"chrome_bridge_fill_fields","description":"Fill multiple fields by selector in one call.","inputSchema":{"type":"object","properties":{"entries":{"type":"array","items":{"type":"object","properties":{"selector":{"type":"string"},"value":{"type":"string"},"checked":{"type":"boolean"},"selectValue":{"type":"string"}},"required":["selector"],"additionalProperties":False}}},"required":["entries"],"additionalProperties":False}},
    {"name":"chrome_bridge_get_elements","description":"List visible links, buttons, inputs, or all common interactive elements on the active tab.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["all","links","buttons","inputs"]},"maxItems":{"type":"integer","description":"Maximum number of elements to return."}},"additionalProperties":False}},
    {"name":"chrome_bridge_scroll","description":"Scroll the active tab vertically by a number of pixels.","inputSchema":{"type":"object","properties":{"deltaY":{"type":"integer","description":"Pixels to scroll. Positive scrolls down."}},"required":["deltaY"],"additionalProperties":False}},
    {"name":"chrome_bridge_scroll_to_selector","description":"Scroll the page so a CSS selector is brought into view.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_click","description":"Click the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_type","description":"Type text into the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"required":["selector","text"],"additionalProperties":False}},
    {"name":"chrome_bridge_press_key","description":"Press a keyboard key in the active tab.","inputSchema":{"type":"object","properties":{"key":{"type":"string"},"ctrlKey":{"type":"boolean"},"altKey":{"type":"boolean"},"shiftKey":{"type":"boolean"},"metaKey":{"type":"boolean"}},"required":["key"],"additionalProperties":False}},
    {"name":"chrome_bridge_wait_for_selector","description":"Wait until a CSS selector appears and becomes visible in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"timeoutMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_select_option","description":"Select an option in a native <select> element.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"value":{"type":"string"},"label":{"type":"string"},"index":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_highlight_element","description":"Temporarily highlight a CSS selector on the page.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"color":{"type":"string"},"durationMs":{"type":"integer"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_screenshot","description":"Capture a screenshot of the current visible tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_full_page_screenshot","description":"Capture a full-page screenshot of the current tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_copy_page_content","description":"Copy the current page text or HTML to the system clipboard, even when the site blocks normal copy handlers.","inputSchema":{"type":"object","properties":{"mode":{"type":"string","enum":["text","html"]},"maxLength":{"type":"integer","description":"Maximum number of characters to copy."}},"additionalProperties":False}},
    {"name":"chrome_bridge_select_text","description":"Select text on the page using a CSS selector or matching visible text.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_copy_selected_text","description":"Copy the current browser text selection to the clipboard.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_storage","description":"Read localStorage and/or sessionStorage from the page.","inputSchema":{"type":"object","properties":{"storage":{"type":"string","enum":["local","session","all"]}},"additionalProperties":False}},
    {"name":"chrome_bridge_get_cookies","description":"Read cookies for the current page URL or a provided URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"additionalProperties":False}},
    {"name":"chrome_bridge_download_url","description":"Download a file directly through the browser.","inputSchema":{"type":"object","properties":{"url":{"type":"string"},"filename":{"type":"string"},"saveAs":{"type":"boolean"}},"required":["url"],"additionalProperties":False}},
    {"name":"chrome_bridge_run_script","description":"Execute custom JavaScript in the page context and return a serialized result.","inputSchema":{"type":"object","properties":{"script":{"type":"string"}},"required":["script"],"additionalProperties":False}},
    {"name":"chrome_bridge_navigate","description":"Navigate the active tab to a URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":False}},
    {"name":"chrome_bridge_back","description":"Navigate the current tab back in history.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_forward","description":"Navigate the current tab forward in history.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_reload","description":"Reload the current tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
]
def http_get(path:str)->Any:
    req=urllib.request.Request(BASE_URL+path,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))
def http_post(path:str,payload:dict[str,Any])->Any:
    data=json.dumps(payload).encode("utf-8")
    req=urllib.request.Request(BASE_URL+path,data=data,headers={"Content-Type":"application/json"},method="POST")
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
    if name=="chrome_bridge_list_frames": return as_text_content(call_bridge("listFrames"))
    if name=="chrome_bridge_get_forms":
        payload={}
        if "maxForms" in arguments: payload["maxForms"]=int(arguments["maxForms"])
        return as_text_content(call_bridge("getForms",payload))
    if name=="chrome_bridge_fill_fields": return as_text_content(call_bridge("fillFields",{"entries":arguments["entries"]}))
    if name=="chrome_bridge_get_elements":
        payload={}
        if "kind" in arguments: payload["kind"]=arguments["kind"]
        if "maxItems" in arguments: payload["maxItems"]=int(arguments["maxItems"])
        return as_text_content(call_bridge("getElements",payload))
    if name=="chrome_bridge_scroll": return as_text_content(call_bridge("scroll",{"deltaY":int(arguments.get("deltaY",0))}))
    if name=="chrome_bridge_scroll_to_selector": return as_text_content(call_bridge("scrollToSelector",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_click": return as_text_content(call_bridge("click",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_type": return as_text_content(call_bridge("type",{"selector":arguments["selector"],"text":arguments["text"]}))
    if name=="chrome_bridge_press_key":
        payload={"key":arguments["key"]}
        for field in ("ctrlKey","altKey","shiftKey","metaKey"):
            if field in arguments: payload[field]=bool(arguments[field])
        return as_text_content(call_bridge("pressKey",payload))
    if name=="chrome_bridge_wait_for_selector":
        payload={"selector":arguments["selector"]}
        if "timeoutMs" in arguments: payload["timeoutMs"]=int(arguments["timeoutMs"])
        return as_text_content(call_bridge("waitForSelector",payload))
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
    if name=="chrome_bridge_copy_selected_text": return as_text_content(call_bridge("copySelectedText"))
    if name=="chrome_bridge_get_storage":
        payload={}
        if "storage" in arguments: payload["storage"]=arguments["storage"]
        return as_text_content(call_bridge("getStorage",payload))
    if name=="chrome_bridge_get_cookies":
        payload={}
        if "url" in arguments: payload["url"]=arguments["url"]
        return as_text_content(call_bridge("getCookies",payload))
    if name=="chrome_bridge_download_url":
        payload={"url":arguments["url"]}
        if "filename" in arguments: payload["filename"]=arguments["filename"]
        if "saveAs" in arguments: payload["saveAs"]=bool(arguments["saveAs"])
        return as_text_content(call_bridge("downloadUrl",payload))
    if name=="chrome_bridge_run_script": return as_text_content(call_bridge("runScript",{"script":arguments["script"]}))
    if name=="chrome_bridge_navigate": return as_text_content(call_bridge("navigate",{"url":arguments["url"]}))
    if name=="chrome_bridge_back": return as_text_content(call_bridge("back"))
    if name=="chrome_bridge_forward": return as_text_content(call_bridge("forward"))
    if name=="chrome_bridge_reload": return as_text_content(call_bridge("reload"))
    raise ValueError(f"Unknown tool: {name}")
def main()->None:
    while True:
        message=read_message()
        if message is None: break
        method=message.get("method"); msg_id=message.get("id")
        try:
            if method=="initialize":
                send_response(msg_id,{"protocolVersion":message.get("params",{}).get("protocolVersion","2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"chrome-bridge","version":"0.2.0"}})
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
