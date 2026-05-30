import json, os, sys, urllib.request, urllib.error
from typing import Any
HOST = os.environ.get("CHROME_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHROME_BRIDGE_PORT", "17373"))
BASE_URL = f"http://{HOST}:{PORT}"
TOOLS = [
    {"name":"chrome_bridge_status","description":"Return Chrome Bridge connectivity status and the latest connected client.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_get_active_tab","description":"Get metadata about the active Chrome tab in the connected profile.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_extract_text","description":"Extract visible page text from the active tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":False}},
    {"name":"chrome_bridge_scroll","description":"Scroll the active tab vertically by a number of pixels.","inputSchema":{"type":"object","properties":{"deltaY":{"type":"integer","description":"Pixels to scroll. Positive scrolls down."}},"required":["deltaY"],"additionalProperties":False}},
    {"name":"chrome_bridge_click","description":"Click the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"}},"required":["selector"],"additionalProperties":False}},
    {"name":"chrome_bridge_type","description":"Type text into the first element matching a CSS selector in the active tab.","inputSchema":{"type":"object","properties":{"selector":{"type":"string"},"text":{"type":"string"}},"required":["selector","text"],"additionalProperties":False}},
    {"name":"chrome_bridge_navigate","description":"Navigate the active tab to a URL.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":False}},
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
    if name=="chrome_bridge_extract_text": return as_text_content(call_bridge("extractText"))
    if name=="chrome_bridge_scroll": return as_text_content(call_bridge("scroll",{"deltaY":int(arguments.get("deltaY",0))}))
    if name=="chrome_bridge_click": return as_text_content(call_bridge("click",{"selector":arguments["selector"]}))
    if name=="chrome_bridge_type": return as_text_content(call_bridge("type",{"selector":arguments["selector"],"text":arguments["text"]}))
    if name=="chrome_bridge_navigate": return as_text_content(call_bridge("navigate",{"url":arguments["url"]}))
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