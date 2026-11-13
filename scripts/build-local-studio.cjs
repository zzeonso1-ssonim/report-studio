// Build one offline HTML file. No CDN, server, installation or network request is required.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild-wasm');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'dist-local/report-studio.html'));
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/daishin-asset-management.png')).toString('base64');
const landscape = fs.readFileSync(path.join(root, 'public/bond-landscape-editor.html'), 'utf8');
const allCss = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const css = ('*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:"Malgun Gothic",sans-serif}' + allCss.slice(allCss.indexOf('@page {'))).replaceAll('/daishin-asset-management.png', logo);
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Workspace from './app/reports/report-authoring-workspace';
const payloadId = 'econ-cockpit-report-draft';
const data = JSON.parse(document.getElementById(payloadId)?.textContent || '{}');
const landscape = ${JSON.stringify(landscape)};
const logo = ${JSON.stringify(logo)};
function editableDocument(staticHtml) {
  const doc = new DOMParser().parseFromString(staticHtml, 'text/html');
  const payload = JSON.parse(doc.getElementById(payloadId).textContent);
  payload.docId = crypto.randomUUID();
  const title = doc.title.replace(/[<>&"]/g, '');
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const runtime = document.getElementById('studio-runtime').textContent.replace(/<\\/script/gi, '<\\\\/script');
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><style id="studio-style">'+document.getElementById('studio-style').textContent+'</style></head><body><div id="root"></div><div id="studio-static-snapshot" hidden>'+doc.querySelector('article').outerHTML+'</div><script type="application/json" id="'+payloadId+'">'+json+'</script><script id="studio-runtime">'+runtime+'</script></body></html>';
}
document.getElementById('studio-static-snapshot')?.remove();
createRoot(document.getElementById('root')).render(
  <main className="report-authoring-shell">
    <header className="report-authoring-app-header"><div><p className="report-authoring-eyebrow">REPORT STUDIO · LOCAL</p><h1>보고서작성</h1><p>작업 후 HTML로 저장하세요. 받은 HTML 파일을 열면 그대로 이어서 편집할 수 있습니다.</p></div></header>
    <Workspace storageKey={'report-studio:local:v1:'+(data.docId || 'blank')} legacyStorageKey={null}
      initialDocument={data.reportKind ? data : undefined} landscapeDocument={landscape} logoDataUrl={logo} createEditableDocument={editableDocument}/>
  </main>
);
`;
esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',minify:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).then(result=>{
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report Studio 로컬 편집기</title><style id="studio-style">'+css+'</style></head><body><div id="root"></div><script type="application/json" id="econ-cockpit-report-draft">{}</script><script id="studio-runtime">'+script+'</script></body></html>';
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.writeFileSync(destination,html);
  console.log('Local studio:',destination,'('+Buffer.byteLength(html)+' bytes)');
}).catch(error=>{console.error(error);process.exitCode=1;});
