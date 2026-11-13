const fs=require('node:fs');
const assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync(process.argv[2] || '../../outputs/report-studio.html','utf8');
const opened=[];
const wait=()=>new Promise(resolve=>setTimeout(resolve,40));
function boot(contents, url='https://local-studio.test/'){
  const errors=[],downloads=[],blobs=new Map();let requests=0,printed=null;
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(contents,{url,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.Blob=Blob;
    w.structuredClone=structuredClone;
    w.fetch=()=>{requests++;throw Error('Offline build attempted a network request');};
    w.URL.createObjectURL=blob=>{const key='blob:test-'+blobs.size;blobs.set(key,blob);return key;};
    w.URL.revokeObjectURL=()=>{};
    w.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,blob:blobs.get(this.href)});};
    w.HTMLElement.prototype.scrollIntoView=()=>{};
    w.CSS={escape:s=>s.replace(/"/g,'\\"')};
    w.print=()=>{printed=w.document.querySelector('.report-authoring-print-document')?.innerHTML;};
    w.matchMedia=()=>({matches:false});
    w.confirm=()=>true;
  }});
  opened.push(dom);
  return {dom,errors,downloads,get requests(){return requests},get printed(){return printed}};
}
function field(app,label){const element=[...app.dom.window.document.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')===label);assert.ok(element,label);return element;}
async function fill(app,label,value){const input=field(app,label);const prototype=input.tagName==='TEXTAREA'?app.dom.window.HTMLTextAreaElement.prototype:app.dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,value);input.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));await wait();}
async function click(app,label){const button=[...app.dom.window.document.querySelectorAll('button')].find(n=>n.textContent.trim()===label || n.querySelector('strong')?.textContent===label);assert.ok(button,label);assert.ok(!button.disabled,label+' enabled');button.click();await wait();}
async function main(){
  const app=boot(html);await wait();await wait();
  assert.deepEqual([...field(app,'보고서 양식').options].map(n=>n.textContent),['기본 보고서','모닝미팅브리프','주간채권전략','이슈리포트']);
  await fill(app,'보고서 제목','로컬 전달 검증');
  await click(app,'되돌리기');assert.equal(field(app,'보고서 제목').value,'보고서 제목');
  await click(app,'다시 실행');assert.equal(field(app,'보고서 제목').value,'로컬 전달 검증');
  field(app,'1행 1열').dispatchEvent(new app.dom.window.MouseEvent('click',{bubbles:true}));await wait();
  await fill(app,'1행 1열','전달할 표 값');
  await click(app,'행 추가');await click(app,'열 추가');
  await click(app,'마지막 행 삭제');await click(app,'마지막 열 삭제');
  assert.equal(app.dom.window.document.querySelectorAll('tbody tr').length,2);
  assert.equal(app.dom.window.document.querySelectorAll('thead th').length,3);
  await click(app,'이미지');
  const imageInput=app.dom.window.document.querySelector('input[accept="image/*"]');
  Object.defineProperty(imageInput,'files',{value:[new app.dom.window.File([fs.readFileSync('public/daishin-asset-management.png')],'qa.png',{type:'image/png'})]});
  imageInput.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}));await wait();await wait();
  await click(app,'HTML 저장');
  assert.equal(app.downloads.length,1);
  const saved=await app.downloads[0].blob.text();
  const savedDoc=new JSDOM(saved).window.document;
  const payload=JSON.parse(savedDoc.getElementById('econ-cockpit-report-draft').textContent);
  assert.deepEqual(Object.keys(payload.drafts),['basic']);
  assert.equal(payload.drafts.basic.title,'로컬 전달 검증');
  assert.ok(payload.drafts.basic.blocks.find(block=>block.type==='image').src.startsWith('data:image/png;base64,'));
  assert.ok(savedDoc.querySelector('#studio-runtime'));
  assert.ok(savedDoc.querySelector('#studio-static-snapshot img').src.startsWith('data:image/png;base64,'));
  assert.equal(savedDoc.querySelectorAll('script[src],link[rel="stylesheet"],img[src^="http"]').length,0);
  const receiver=boot(saved);await wait();await wait();
  assert.equal(field(receiver,'보고서 제목').value,'로컬 전달 검증');
  assert.equal(field(receiver,'1행 1열').value,'전달할 표 값');
  assert.ok(receiver.dom.window.document.querySelector('.report-authoring-image-stage img').src.startsWith('data:image/png;base64,'));
  await fill(receiver,'보고서 제목','인수자가 수정한 보고서');
  await click(receiver,'HTML 저장');
  const next=boot(await receiver.downloads[0].blob.text());await wait();await wait();
  assert.equal(field(next,'보고서 제목').value,'인수자가 수정한 보고서');
  await click(next,'PDF 저장');assert.ok(next.printed.includes('인수자가 수정한 보고서'));
  assert.ok(!next.printed.includes('data-report-control'));
  await click(next,'가로형 편집기');
  const frame=next.dom.window.document.querySelector('iframe');assert.ok(frame.srcdoc.includes('embeddedState'));assert.ok(!frame.getAttribute('src'));
  await click(next,'세로형 편집기');
  assert.ok(next.dom.window.document.querySelector('.report-authoring-paper').textContent.includes('인수자가 수정한 보고서'));
  const restricted=boot(saved,'file:///offline-report.html');await wait();await wait();
  assert.equal(field(restricted,'보고서 제목').value,'로컬 전달 검증');
  await fill(restricted,'보고서 제목','자동저장 불가 환경에서도 저장');
  await click(restricted,'HTML 저장');assert.equal(restricted.downloads.length,1);
  for(const result of [app,receiver,next,restricted]){assert.equal(result.requests,0);assert.deepEqual(result.errors,[]);}
  console.log('PASS offline artifact: title/table edits, undo/redo, active-only HTML save, recipient open/edit/resave, inline logo, print snapshot, orientation preservation, zero network requests');
  for(const instance of opened)instance.window.close();
}
main().catch(error=>{for(const instance of opened)instance.window.close();console.error(error);process.exitCode=1;});
