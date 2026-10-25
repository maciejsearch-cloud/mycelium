// Testy API anonimowych kont (RLS, polecenia, kod odzyskiwania, portfel) na prawdziwej bazie, pokój e2e.
// MYC_E2E_KEY=… node web/e2e-account/accounts-api.mjs
const U='https://agortpieeygmcttjwjfx.supabase.co', K='sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P'
const E2E=process.env.MYC_E2E_KEY
const j=async r=>{const t=await r.text();try{return {s:r.status,b:JSON.parse(t)}}catch{return {s:r.status,b:t}}}
const anon=async()=> (await j(await fetch(U+'/auth/v1/signup',{method:'POST',headers:{apikey:K,'Content-Type':'application/json'},body:'{}'}))).b
const rpc=(tok,fn,a={})=>fetch(U+'/rest/v1/rpc/'+fn,{method:'POST',headers:{apikey:K,Authorization:'Bearer '+(tok||K),'Content-Type':'application/json'},body:JSON.stringify(a)}).then(j)
const get=(tok,p)=>fetch(U+'/rest/v1/'+p,{headers:{apikey:K,Authorization:'Bearer '+(tok||K)}}).then(j)
const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) process.exitCode=1}
const A=await anon(), B=await anon(), C=await anon()
ok(A.access_token && A.user?.is_anonymous, 'anonymous sign-in A')
const contrib=crypto.randomUUID(), node=crypto.randomUUID()
let r=await rpc(A.access_token,'myc_acct_create',{p_handle:'e2e_alfa'+Date.now()%10000,p_contrib:contrib,p_nodes:[node],p_room:'e2e'})
ok(r.s===200 && r.b.ref_code===contrib.replace(/-/g,'').slice(0,8), 'create A, ref_code from legacy contributor '+r.s)
const a=r.b
r=await rpc(B.access_token,'myc_acct_create',{p_handle:a.handle.toUpperCase(),p_room:'e2e'}); ok(r.s>=400,'duplicate handle rejected ('+(r.b.message||'')+')')
r=await rpc(B.access_token,'myc_acct_create',{p_handle:'e2e_beta'+Date.now()%10000,p_contrib:contrib,p_nodes:[node],p_ref:a.ref_code,p_room:'e2e'})
ok(r.s===200 && r.b.contributor_id===null && r.b.nodes.length===0 && r.b.referred_by===a.handle,'B: legacy id/node not stolen, referral recorded')
r=await rpc(B.access_token,'myc_acct_refer',{p_code:a.ref_code}); ok(r.s>=400,'second referral rejected')
r=await rpc(A.access_token,'myc_acct_refer',{p_code:r.b?.ref_code||''}); 
const bme=(await rpc(B.access_token,'myc_acct_me')).b
r=await rpc(A.access_token,'myc_acct_refer',{p_code:bme.ref_code}); ok(r.s>=400,'referral loop rejected ('+(r.b.message||'')+')')
r=await rpc(A.access_token,'myc_acct_refer',{p_code:a.ref_code}); ok(r.s>=400,'self referral rejected')
r=await rpc(A.access_token,'myc_acct_set_wallet',{p_addr:'4NkTzP8sRvB5o4m1mJ3o6cX6ZtJk2dC8b1v4e7xQ9yzA abandon abandon'}); ok(r.s>=400,'seed-like wallet rejected')
r=await rpc(A.access_token,'myc_acct_set_wallet',{p_addr:'5'.repeat(88)}); ok(r.s>=400,'private-key-length rejected')
r=await rpc(A.access_token,'myc_acct_set_wallet',{p_addr:'7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'}); ok(r.s===200 && r.b.wallet_sol,'public address accepted')
r=await rpc(A.access_token,'myc_acct_forget_device',{}); ok(r.s>=400,'cannot log out last device w/o recovery code')
r=await rpc(A.access_token,'myc_acct_recovery_new'); const code=r.b; ok(r.s===200 && /^MYC-/.test(code),'recovery code issued')
r=await rpc(C.access_token,'myc_acct_recover',{p_code:'MYC-WRONG-WRONG'}); ok(r.s>=400,'wrong recovery code rejected')
r=await rpc(C.access_token,'myc_acct_recover',{p_code:code.toLowerCase()}); ok(r.s===200 && r.b.id===a.id && r.b.devices===2,'C recovered A account')
// RLS
r=await get(null,'myc_accounts?select=id'); ok(r.s===401||r.s===403||(Array.isArray(r.b)&&r.b.length===0),'anon cannot read accounts ('+r.s+')')
r=await get(B.access_token,'myc_accounts?select=id,handle'); ok(r.s===200 && r.b.length===1 && r.b[0].id===bme.id,'B sees only own account row')
r=await get(B.access_token,'myc_accounts?select=recovery_hash'); ok(r.s>=400,'recovery_hash not readable')
r=await get(B.access_token,'myc_account_devices?select=*'); ok(r.s===200 && r.b.length===1,'B sees only own device')
r=await fetch(U+'/rest/v1/myc_accounts?id=eq.'+bme.id,{method:'PATCH',headers:{apikey:K,Authorization:'Bearer '+B.access_token,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({referred_by:null})}).then(j); ok(r.s>=400,'direct update blocked ('+r.s+')')
r=await fetch(U+'/rest/v1/myc_points',{method:'POST',headers:{apikey:K,Authorization:'Bearer '+B.access_token,'Content-Type':'application/json'},body:JSON.stringify({account_id:bme.id,source:'compute',ref:'x',points:1e6,status:'approved'})}).then(j); ok(r.s>=400,'points insert blocked ('+r.s+')')
r=await rpc(null,'myc_acct_me'); ok(r.s>=400,'anon (no login) cannot call account RPCs')
r=await rpc(null,'myc_points_sync'); ok(r.s>=400,'points_sync not callable')
r=await rpc(A.access_token,'myc_acct_me'); ok(r.b.can_refer===true && r.b.referrals===1 && r.b.referrals_qualified===0,'A: 1 referral, 0 qualified (needs real contribution)')
r=await rpc(null,'myc_acct_e2e_cleanup',{p_key:E2E}); ok(r.s===200 && r.b.accounts>=2,'cleanup '+JSON.stringify(r.b))
