import { createServer } from 'vite';
import path from 'node:path';

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流式输出调试验证</title>
<style>:root{color-scheme:dark;--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editor-background:#181818;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#424242;--vscode-input-background:#262626;--vscode-input-foreground:#ddd;--vscode-input-border:#555;--vscode-list-hoverBackground:#333;--vscode-focusBorder:#888;--vscode-errorForeground:#e99;--vscode-scrollbarSlider-background:#7776;--vscode-scrollbarSlider-hoverBackground:#9998}body{margin:0;background:#181818;color:#ddd;font:13px system-ui}#app{max-width:760px;margin:24px auto;padding:0 16px;box-sizing:border-box}button,input{font:inherit}*{box-sizing:border-box}</style></head><body><div id="app"></div>
<script>
window.__captureCommands=[];window.__captureRuns=[];window.__captureSettings={scope:'conversation',maxMiB:32,maxMinutes:30};
const publish=message=>window.dispatchEvent(new MessageEvent('message',{data:message}));
let revision=1;
window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage(message){
 const c=message.payload;window.__captureCommands.push(message);
 queueMicrotask(()=>{
  if(message.type==='settings.global.get'||message.type==='settings.global.update'){
   if(c.settings)window.__captureSettings=c.settings;
   publish({id:'settings-'+revision,type:'settings.global.snapshot',channel:'settings',correlationId:message.id,payload:{section:'debugCapture',settings:window.__captureSettings,revision:String(revision++),filePath:'/tmp/取证演示/settings/debug-capture.json'}});return;
  }
  if(message.type==='diagnostics.capture.observation'){publish({id:'ack',type:'diagnostics.capture.observation.ack',payload:{...c,accepted:true}});return;}
  if(message.type!=='diagnostics.capture.command')return;
  let analysis;
  if(c.action==='start')window.__captureRuns.unshift({runId:'20260907-000000-000-model-stream-0123abcd',status:'recording',target:window.__captureSettings.scope==='workspace'?{scope:'workspace'}:{scope:'conversation',conversationId:c.conversationId},startedAt:'2026-09-07T00:00:00Z',maxBytes:window.__captureSettings.maxMiB*1048576,maxDurationMs:window.__captureSettings.maxMinutes*60000,elapsedMs:56000,acceptedBytes:393216,durableSeq:120,lastAcceptedSeq:128,payloadBytes:65000,indexBytes:12000,peakMemoryBytes:240000,batches:2,hasGaps:false});
  if(c.action==='stop'){const r=window.__captureRuns.find(r=>r.runId===c.runId);r.status='sealed';r.stopReason='user';r.durableSeq=r.lastAcceptedSeq;}
  if(c.action==='delete')window.__captureRuns=window.__captureRuns.filter(r=>r.runId!==c.runId);
  if(c.action==='analyze')analysis={runId:c.runId,events:128,integrity:['验证样例：记录代码与分析代码不同。'],findings:[{level:'evidence',sequence:102,message:'同一条入口来源被再次追加给同一个工具。'},{level:'unknown',sequence:128,message:'工具在已保存范围内没有完成。'}],tools:[],truncated:false};
  publish({id:'result',type:'diagnostics.capture.result',channel:'diagnostics',correlationId:message.id,payload:{state:{active:window.__captureRuns.find(r=>r.status==='recording'),runs:window.__captureRuns,totalBytes:77000*window.__captureRuns.length,directory:'/tmp/取证演示/当前工作区/diagnostics/debug-captures'},...(analysis?{analysis}:{})}});
 });
}});
</script>
<script type="module">
import {createApp} from 'vue';
import {createPinia} from 'pinia';
import Component from '/src/components/settings/global/DebugCaptureSettings.vue';
import {useGlobalSettingsStore} from '/src/stores/useGlobalSettingsStore.ts';
import {useReliableKernelClientFeedStore} from '/src/stores/useReliableKernelClientFeedStore.ts';
import {bridge} from '/src/transport/index.ts';
import {installDebugCaptureTrace} from '/src/transport/debugCapture.ts';
const app=createApp(Component);const pinia=createPinia();app.use(pinia);
const settings=useGlobalSettingsStore(pinia);
bridge.on('settings.global.snapshot',message=>settings.applySnapshot(message.payload,message.correlationId));
useReliableKernelClientFeedStore(pinia).projections.activeConversationWindow={conversationId:'当前选定的对话-用于验证较窄窗口中的换行效果'};
installDebugCaptureTrace();app.mount('#app');
</script></body></html>`;
const server = await createServer({ configFile: path.resolve('vite.config.ts'), appType: 'custom', server: { host: '127.0.0.1', port: 31821, strictPort: true, hmr: false } });
server.middlewares.use('/__debug-capture-check', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(await server.transformIndexHtml('/__debug-capture-check', html));
});
await server.listen();
console.log('界面验证地址：http://127.0.0.1:31821/__debug-capture-check');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
