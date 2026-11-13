const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');const {JSDOM}=require('jsdom');
const source=fs.readFileSync('app/reports/report-authoring-workspace.tsx','utf8');
const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>');
const context={exports:{},require,structuredClone,console,crypto:require('node:crypto').webcrypto,document:dom.window.document,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement};vm.createContext(context);
vm.runInContext(ts.transpile(source+'\nexport {reconcileRenderedDraft,createTemplates,normalizeDrafts,standaloneDocument,AnnotatedImage,imageBlock,chartItem,tableBlock,SourceText,chartReadability,svgDesignedSlot,chartReadabilityMessage,parseLegacyExport,embedExportLogo};',{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),context);
const {reconcileRenderedDraft,createTemplates,normalizeDrafts,standaloneDocument}=context.exports;
const templates=createTemplates(); const drafts=createTemplates();drafts.issue.blocks=[{id:'t1',type:'text',title:'이전 제목',body:'이전 본문',style:'plain'},{id:'c1',type:'chart',title:'차트',columns:1,charts:[{id:'ci1',title:'비교',src:'data:image/svg+xml,x',caption:'설명',source:'출처',insightLabel:'판단',insightTitle:'제목',insightBody:'본문',annotations:[{id:'a1',kind:'rect',x1:10,y1:20,x2:50,y2:80,color:'#cc0000'}]}]}];
dom.window.document.body.innerHTML='<article class="report-authoring-paper"><header class="report-authoring-cover"><h1>새 보고서</h1></header><section class="report-authoring-block"><div class="report-authoring-block-body"><h2>새 제목</h2><p class="report-authoring-body-copy">새 본문</p></div></section><section class="report-authoring-block"><div class="report-authoring-block-body"><h2>차트</h2><figure class="report-authoring-chart-card"><h3>비교</h3><img src="data:image/svg+xml,x"><figcaption><span>설명</span><small>출처</small></figcaption></figure></div></section></article>';
assert.equal(drafts.issue.blocks[0].body,'이전 본문'); // prior importer reads payload only: reproducible stale restore
const fixed=reconcileRenderedDraft(dom.window.document,drafts.issue);assert.equal(fixed.blocks[0].body,'새 본문');assert.equal(fixed.blocks[0].title,'새 제목');assert.equal(fixed.title,'새 보고서');assert.equal(fixed.blocks[1].charts[0].annotations.length,1);
drafts.issue=fixed;const html=standaloneDocument(dom.window.document.querySelector('article'),fixed.title,drafts,'issue');const exported=new JSDOM(html).window.document;const payload=JSON.parse(exported.querySelector('#econ-cockpit-report-draft').textContent);const normalized=normalizeDrafts(payload.drafts,templates);assert.equal(normalized.issue.blocks[0].body,'새 본문');assert.deepEqual(JSON.stringify(normalized.issue.blocks[1].charts[0].annotations),JSON.stringify(fixed.blocks[1].charts[0].annotations));assert.equal(normalized.weekly.title,drafts.weekly.title);
exported.querySelector('.report-authoring-block').remove();assert.throws(()=>reconcileRenderedDraft(exported,fixed),/structure differs/);
console.log('PASS 8 assertions: stale DOM reproduction; title/body reconciliation; annotations; export/reimport; inactive draft preservation; malformed structure rejection');
const metadataDoc = new JSDOM(html).window.document;
metadataDoc.querySelector('.report-authoring-cover').insertAdjacentHTML('beforeend','<p class="report-authoring-cover-meta">2026-09-18 · QA Desk · 검토대기 · AI 초안</p><aside><span>새 라벨</span><strong>새 유형</strong><small>새 출처</small></aside>');
metadataDoc.querySelector('article').insertAdjacentHTML('afterbegin','<section class="report-authoring-ranges"><p>새 범위 제목</p><div><label><span>국고 QA</span><strong>2.75 %</strong></label><label><span>커브 QA</span><strong>-15 bp</strong></label></div></section>');
const metadataFixed=reconcileRenderedDraft(metadataDoc,fixed);
assert.equal(metadataFixed.date,'2026-09-18');assert.equal(metadataFixed.desk,'QA Desk');assert.equal(metadataFixed.workspaceLabel,'검토대기 · AI 초안');assert.equal(metadataFixed.templateLabel,'새 라벨');assert.equal(metadataFixed.reportTypeLabel,'새 유형');assert.equal(metadataFixed.templateName,'새 출처');assert.equal(metadataFixed.rangeTitle,'새 범위 제목');assert.equal(metadataFixed.ranges[0].value,'2.75');assert.equal(metadataFixed.ranges[0].unit,'%');assert.equal(metadataFixed.ranges[1].value,'-15');assert.equal(metadataFixed.ranges[1].unit,'bp');assert.equal(metadataFixed.showRanges,true);metadataDoc.querySelector('.report-authoring-ranges').remove();assert.equal(reconcileRenderedDraft(metadataDoc,metadataFixed).showRanges,false);
console.log('PASS 13 additional assertions: cover metadata, template metadata, range values/units, removed ranges');
// Render the actual component: absent imageFit must opt into deliberate stretching.
const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const annotations=[{id:'stretch-qa',kind:'rect',x1:100,y1:200,x2:600,y2:800,color:'#cc0000'}];
const defaultImage=renderToStaticMarkup(React.createElement(context.exports.AnnotatedImage,{src:'data:image/png;base64,QA',alt:'QA',annotations,preview:true,onChange:()=>{}}));
const naturalImage=renderToStaticMarkup(React.createElement(context.exports.AnnotatedImage,{src:'data:image/png;base64,QA',alt:'QA',annotations,imageFit:'natural',preview:true,onChange:()=>{}}));
const stretchDOM=new JSDOM(defaultImage).window.document;const naturalDOM=new JSDOM(naturalImage).window.document;
assert.ok(stretchDOM.querySelector('.fit-uniform > .report-authoring-image-canvas > img'));assert.ok(naturalDOM.querySelector('.fit-natural > .report-authoring-image-canvas > img'));assert.equal(stretchDOM.querySelector('svg').getAttribute('preserveAspectRatio'),'none');assert.equal(stretchDOM.querySelector('[data-annotation-id]').outerHTML,naturalDOM.querySelector('[data-annotation-id]').outerHTML);
const editImage=renderToStaticMarkup(React.createElement(context.exports.AnnotatedImage,{src:'data:image/png;base64,QA',alt:'QA',preview:false,onChange:()=>{}}));assert.match(editImage,/박스 채우기\(비율 변경\)/);
console.log('PASS 5 stretch assertions: default box fill, optional natural, shared SVG geometry, explicit distortion label');
const cleanTemplates=createTemplates();
for(const kind of ['outlook','weekly','issue']) {
  const d=cleanTemplates[kind];assert.equal(d.templateLabel,'');assert.equal(d.templateName,'');assert.equal(d.workspaceLabel,'');assert.ok(d.reportTypeLabel);
  const roundtrip=normalizeDrafts(JSON.parse(JSON.stringify(cleanTemplates)),createTemplates());assert.equal(roundtrip[kind].templateLabel,'');assert.equal(roundtrip[kind].templateName,'');assert.equal(roundtrip[kind].workspaceLabel,'');
}
for(const item of [context.exports.imageBlock(),context.exports.chartItem(0),context.exports.tableBlock('QA',['a'],[['b']])]){assert.equal(item.insightLabel,'INSIGHT');assert.equal(item.insightTitle,'');assert.equal(item.insightBody,'');if('source' in item)assert.equal(item.source,'');}
const authored=structuredClone(cleanTemplates);authored.issue.workspaceLabel='LIVE REPORT WORKSPACE';authored.issue.templateLabel='TEMPLATE';authored.issue.templateName='GitHub bond-strategy-reports';authored.issue.blocks[0].body='유지할 사용자 본문';assert.deepEqual(JSON.stringify(normalizeDrafts(authored,cleanTemplates)),JSON.stringify(authored));
for(const rawSource of ['', '한국은행', '출처 : 한국은행']) { const markup=renderToStaticMarkup(React.createElement(context.exports.SourceText,{source:rawSource}));const sourceDoc=new JSDOM(markup).window.document;assert.equal(sourceDoc.querySelector('[data-report-source-value]').textContent,rawSource);assert.equal((sourceDoc.querySelector('small').textContent.match(/출처\s*:/g)||[]).length,1);const sourceRoundtripDoc=new JSDOM(html).window.document;sourceRoundtripDoc.querySelector('.report-authoring-chart-card figcaption small').outerHTML=markup;const sourceFixed=reconcileRenderedDraft(sourceRoundtripDoc,fixed);assert.equal(sourceFixed.blocks[1].charts[0].source,rawSource);}
console.log('PASS clean defaults across all 3 report kinds, blank insight/source factories, authored-content preservation, source-prefix raw-value roundtrip');
if(process.env.REPORT_DEFAULT_FIXTURE)fs.writeFileSync(process.env.REPORT_DEFAULT_FIXTURE,'<!doctype html><html><body><script type="application/json" id="econ-cockpit-report-draft">'+JSON.stringify({version:1,reportKind:'issue',drafts:cleanTemplates}).replace(/</g,'\\u003c')+'</script></body></html>');

// Chart readability hint: printed text = 12px x slot/natural x 0.75 (pt); generated SVGs carry data-slot-px.
{const {chartReadability,svgDesignedSlot,chartReadabilityMessage}=context.exports;context.atob=atob;context.TextDecoder=TextDecoder;
const wide=chartReadability(1200,293);assert.equal(wide.ok,false);assert.ok(Math.abs(wide.pt-2.1975)<0.01);assert.equal(wide.maxCaptureWidth,293);assert.equal(wide.needPx,50);
assert.match(chartReadabilityMessage(wide,2),/캡처 폭을 293px 이하/);
assert.equal(chartReadability(293,293).ok,true);
const svg=(slot)=>'data:image/svg+xml;base64,'+Buffer.from('<svg viewBox="0 0 620 520" data-slot-px="'+slot+'"><text>한글</text></svg>').toString('base64');
assert.equal(svgDesignedSlot(svg(293)),293);assert.equal(svgDesignedSlot('data:image/png;base64,QQ=='),undefined);
const fitted=chartReadability(620,293,svgDesignedSlot(svg(293)));assert.equal(fitted.ok,true);assert.ok(Math.abs(fitted.pt-9)<0.01);
const misplaced=chartReadability(760,293,svgDesignedSlot(svg(620)));assert.equal(misplaced.ok,false);assert.match(chartReadabilityMessage(misplaced,2),/slot:'half'/);
const big=chartReadability(620,620,svgDesignedSlot(svg(293)));assert.equal(big.ok,true);assert.equal(big.oversized,true);assert.match(chartReadabilityMessage(big,1),/글씨가 커요.*slot:'full'/);
const three=chartReadability(620,190,svgDesignedSlot(svg(293)));assert.equal(three.ok,false);assert.match(chartReadabilityMessage(three,3),/2개 이하/);assert.doesNotMatch(chartReadabilityMessage(three,3),/slot:'half'/);
assert.equal(chartReadability(620,293,svgDesignedSlot(svg(293))).oversized,false);
console.log('PASS 19 chart readability assertions: capture shrink, max capture width, generated slot match/mismatch, oversized, 3-column guidance');}

// Adding report kinds must preserve existing drafts and initialize only missing kinds.
const oldDrafts={outlook:cleanTemplates.outlook,weekly:cleanTemplates.weekly,issue:authored.issue};
const migrated=normalizeDrafts(oldDrafts,cleanTemplates);
assert.equal(migrated.issue.blocks[0].body,'유지할 사용자 본문');
assert.equal(migrated.basic.title,'보고서 제목');
assert.equal(migrated.morning.title,'Morning Meeting Brief');
for(const kind of ['basic','morning']) {
  const saved=JSON.parse(new JSDOM(standaloneDocument(dom.window.document.querySelector('article'),migrated[kind].title,migrated,kind)).window.document.querySelector('#econ-cockpit-report-draft').textContent);
  assert.equal(saved.reportKind,kind);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeDrafts(saved.drafts,cleanTemplates)[kind])),JSON.parse(JSON.stringify(migrated[kind])));
}
const initialEditor=new JSDOM(renderToStaticMarkup(React.createElement(context.exports.default))).window.document;
assert.equal(initialEditor.querySelector('.report-authoring-cover aside'),null);
assert.equal(initialEditor.querySelectorAll('[aria-label="보고서 제목"]').length,1);
assert.deepEqual([...initialEditor.querySelectorAll('select[aria-label="보고서 양식"] option')].map(n=>n.textContent),['기본 보고서','모닝미팅브리프','주간채권전략','이슈리포트']);
console.log('PASS new template migration, HTML roundtrip, single cover title and template menu');

// Sharing one report must not disclose drafts in other templates.
assert.deepEqual(Object.keys(payload.drafts),['issue']);
const incoming=JSON.parse(JSON.stringify(payload.drafts));
const unrelated=structuredClone(cleanTemplates);unrelated.weekly.title='다른 업무의 비공개 초안';
const merged=normalizeDrafts({...unrelated,...incoming},cleanTemplates);
assert.equal(merged.weekly.title,'다른 업무의 비공개 초안');
assert.equal(merged.issue.title,'새 보고서');

// A static HTML without its JSON must retain rendered titles/body/table/metadata.
const legacyDoc=new JSDOM('<article class="report-authoring-paper"><header class="report-authoring-cover"><p class="report-authoring-kicker">DAILY BRIEF</p><h1>Morning Meeting Brief</h1><p class="report-authoring-cover-meta"><span data-report-meta>2026-11-13</span> · <span data-report-company>대신자산운용</span> · <span data-report-meta>채권운용본부</span></p></header><section class="report-authoring-block report-authoring-block-text"><div class="report-authoring-block-body"><h2>실제 제목</h2><p class="report-authoring-body-copy">반드시 복원할 본문</p></div></section><section class="report-authoring-block report-authoring-block-table"><div class="report-authoring-block-body"><h2>검증 표</h2><table><thead><tr><th>구분</th><th>값</th></tr></thead><tbody><tr><td>국고채</td><td>검증값</td></tr></tbody></table></div></section></article>').window.document;
const legacy=context.exports.parseLegacyExport(legacyDoc,cleanTemplates);
assert.equal(legacy.kind,'morning');assert.equal(legacy.draft.blocks[0].title,'실제 제목');assert.equal(legacy.draft.blocks[0].body,'반드시 복원할 본문');assert.equal(legacy.draft.blocks[1].title,'검증 표');assert.equal(legacy.draft.blocks[1].rows.length,1);assert.equal(legacy.draft.blocks[1].rows[0][1],'검증값');assert.equal(legacy.draft.desk,'채권운용본부');assert.equal(legacy.draft.date,'2026-11-13');
console.log('PASS active-report-only export, unrelated draft preservation, static HTML import');

// Exported logo URLs must work after moving the file off the site.
context.fetch=async()=>({ok:true,arrayBuffer:async()=>Uint8Array.from([137,80,78,71]).buffer});
context.btoa=btoa;context.URL=URL;context.window={location:{href:'https://studio.example/'}};
context.exports.embedExportLogo('<style>@page{@bottom-right{content:url("/daishin-asset-management.png")}}</style><img src="https://studio.example/daishin-asset-management.png">').then(result=>{
  assert.equal((result.match(/data:image\/png;base64,/g)||[]).length,2);assert.ok(!result.includes('/daishin-asset-management.png'));
  console.log('PASS portable logo in body and print footer');
}).catch(error=>{console.error(error);process.exitCode=1;});
