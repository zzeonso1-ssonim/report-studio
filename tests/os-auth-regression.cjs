const {buildSync}=require('esbuild-wasm');
const {mkdtempSync,rmSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');
(async()=>{
  const dir=mkdtempSync(path.join(__dirname,'.os-auth-'));
  const originalFetch=global.fetch, originalEnv=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  const token='rs1.test.signature';
  let active=true, role='STAFF', unavailable=false;
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://daishin-ai-research.vercel.app/api/report-studio-auth');
    assert.equal(options.cache,'no-store');
    assert.equal(options.redirect,'error');
    if(unavailable)throw Error('OS unavailable');
    const body=options.body?JSON.parse(options.body):null;
    if(!body)return Response.json({roster:[{id:'os-staff',name:'직원',hasPhone:true}]});
    if(body.action==='login'&&body.userId==='os-staff'&&body.last4==='0010')return Response.json({token,user:{id:'os-staff',name:'직원',role}});
    if(body.action==='session'&&body.token===token&&active)return Response.json({user:{id:'os-staff',name:'직원',role}});
    return Response.json({error:'invalid'},{status:401});
  };
  try{
    for(const [name,entry] of Object.entries({proxy:'proxy.ts',login:'app/api/login/route.ts',os:'lib/os-auth.ts'})){
      buildSync({entryPoints:[entry],outfile:path.join(dir,`${name}.cjs`),bundle:true,platform:'node',format:'cjs',external:['next/*']});
    }
    const {proxy}=require(path.join(dir,'proxy.cjs'));
    const {POST}=require(path.join(dir,'login.cjs'));
    const {osRoster}=require(path.join(dir,'os.cjs'));
    const request=(pathname,cookie)=>new NextRequest(`https://report-studio-kr.vercel.app${pathname}`,{headers:cookie?{cookie}:undefined});
    assert.equal((await osRoster())[0].hasPhone,true);
    const response=await POST(new Request('https://report-studio-kr.vercel.app/api/login',{method:'POST',body:JSON.stringify({userId:'os-staff',last4:'0010'})}));
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/i); assert.match(cookie,/Secure/i);
    assert.ok(!cookie.includes('0010'));
    const pair=cookie.split(';')[0];
    assert.equal((await proxy(request('/',pair))).status,200);
    assert.equal((await proxy(request('/api/admin/roster',pair))).status,403);
    role='ADMIN';
    assert.equal((await proxy(request('/api/admin/roster',pair))).status,200);
    active=false;
    assert.equal((await proxy(request('/api/indicators',pair))).status,401);
    assert.equal((await proxy(request('/',pair))).status,307);
    assert.equal((await proxy(request('/api/indicators','app_session=v2.old.token.value'))).status,401);
    unavailable=true;
    assert.equal((await proxy(request('/api/indicators',pair))).status,401);
    assert.equal((await POST(new Request('https://report-studio-kr.vercel.app/api/login',{method:'POST',body:JSON.stringify({userId:'os-staff',last4:'0010'})}))).status,503);
    console.log('PASS: Studio OS roster/login, secure cookie, live role checks, deactivation, old-token rejection, fail-closed outage');
  }finally{global.fetch=originalFetch;process.env.NODE_ENV=originalEnv;rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
