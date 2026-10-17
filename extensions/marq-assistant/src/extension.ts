import * as vscode from 'vscode';

type Message = { role: 'user' | 'assistant'; content: string };

export function activate(context: vscode.ExtensionContext) {
    const provider = new MarqChatProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('marq-assistant.chat', provider),
        vscode.commands.registerCommand('marq-assistant.newChat', () => provider.newChat())
    );
}

class MarqChatProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private messages: Message[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html(view.webview);

        view.webview.onDidReceiveMessage(async (message: { type: string; text?: string }) => {
            if (message.type === 'newChat') {
                this.newChat();
            } else if (message.type === 'send' && message.text?.trim()) {
                await this.send(message.text.trim());
            }
        });
    }

    newChat() {
        this.messages = [];
        this.view?.webview.postMessage({ type: 'clear' });
    }

    private async send(text: string) {
        this.messages.push({ role: 'user', content: text });
        this.view?.webview.postMessage({ type: 'user', text });

        const config = vscode.workspace.getConfiguration('marq-assistant');
        const baseUrl = config.get<string>('ollamaUrl', 'http://localhost:11434').replace(/\/+$/, '');
        const model = config.get<string>('model', 'qwen2.5:7b');

        this.view?.webview.postMessage({ type: 'status', text: `Thinking with ${model}…` });

        try {
            const response = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    stream: false,
                    messages: this.messages
                }),
                signal: AbortSignal.timeout(120000)
            });

            if (!response.ok) {
                throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
            }

            const result = await response.json() as { message?: { content?: string } };
            const answer = result.message?.content?.trim() || '(The model returned an empty response.)';

            this.messages.push({ role: 'assistant', content: answer });
            this.view?.webview.postMessage({ type: 'answer', text: answer });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.view?.webview.postMessage({
                type: 'error',
                text: `Could not reach Ollama at ${baseUrl}. Check that Ollama is running and model "${model}" is installed.\n\n${detail}`
            });
        }
    }

    private html(webview: vscode.Webview): string {
        const nonce = [...Array(32)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
        const csp = webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: dark; }
body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
header { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
.sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 14px; }
#messages { display:flex; flex-direction:column; gap:10px; padding-bottom:12px; }
.msg { white-space:pre-wrap; overflow-wrap:anywhere; border-radius:7px; padding:9px; line-height:1.5; }
.user { background:var(--vscode-textBlockQuote-background); border:1px solid var(--vscode-widget-border); }
.assistant { background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); }
.error { color:var(--vscode-errorForeground); }
#status { color:var(--vscode-descriptionForeground); font-size:11px; margin:8px 0; }
textarea { box-sizing:border-box; width:100%; resize:vertical; min-height:76px; padding:9px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:5px; font:inherit; }
button { border:0; border-radius:4px; padding:7px 12px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; }
button:hover { background:var(--vscode-button-hoverBackground); }
.row { display:flex; gap:8px; margin-top:8px; }
#send { flex:1; } #clear { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<header>MarQ Assistant</header>
<div class="sub">Local AI · Powered by Ollama</div>
<div id="messages"><div class="msg assistant">Hi! I'm MarQ. Ask me about your code or a programming problem.</div></div>
<div id="status" role="status"></div>
<textarea id="input" placeholder="Ask MarQ anything…" aria-label="Message"></textarea>
<div class="row"><button id="send">Send message</button><button id="clear">New chat</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const status = document.getElementById('status');
const send = document.getElementById('send');
function add(text, role) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  messages.appendChild(el);
  el.scrollIntoView({behavior:'smooth', block:'end'});
}
function submit() {
  const text = input.value.trim();
  if (!text || send.disabled) return;
  input.value = '';
  send.disabled = true;
  vscode.postMessage({type:'send', text});
}
send.addEventListener('click', submit);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({type:'newChat'}));
window.addEventListener('message', event => {
  const m = event.data;
  if (m.type === 'user') add(m.text, 'user');
  if (m.type === 'answer') { add(m.text, 'assistant'); send.disabled = false; status.textContent = ''; }
  if (m.type === 'error') { add(m.text, 'error'); send.disabled = false; status.textContent = ''; }
  if (m.type === 'status') status.textContent = m.text;
  if (m.type === 'clear') { messages.replaceChildren(); status.textContent = ''; send.disabled = false; }
});
</script>
</body>
</html>`;
    }
}

export function deactivate() {}
