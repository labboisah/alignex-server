import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDatabase} from '../dist/server/database.js';
const require=createRequire(import.meta.url);
const {installPilot}=require('../dist/server/adaptive-pilot.cjs');
const engine=require('../dist/server/adaptive-kernel.cjs');
function fixture(t) {
    const dir=mkdtempSync(join(tmpdir(),'alignex-adaptive-pilot-'));
    const db=createDatabase(join(dir,'test.sqlite')).connection;
    t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
    const now=Date.now();
    const config={version:engine.VERSION,starts_at:now-1000,closes_at:now+3600000,duration_ms:60000,start_difficulty:'medium',max_levels:2,
        penalty_bps:1000,min_budget:1,mastery_bps:7000,min_evidence:1,cooldown_ms:0,
        areas:[{key:'a',count:3,budget:10001,topics:[]}],items:Array.from({length:12},(_,i)=>({id:'i'+i,area:'a',difficulty:['easy','medium','hard'][i%3],topic:null,type:'single_choice',stem:'Private pool item '+i,
            options:[{id:'right',label:'A',text:'Choice A',correct:true},{id:'wrong',label:'B',text:'Choice B',correct:false}]}))};
    const payload={contract:'alignex.diagnostic-offline.v1',id:'package-1',title:'Test pilot',device_id:'center-device',
        config,candidates:[{id:'candidate-1',lease_id:'lease-1',registration:'CAND1',name:'Test Candidate',access_code:'PRIVATE-ACCESS'}]};
    const cfg={sync_token:'test-secret-'.repeat(6),device_id:'center-device',portal_url:'http://127.0.0.1'};
    db.prepare('INSERT INTO local_users(id,name,email,password_hash,password_salt,role,status) VALUES(?,?,?,?,?,?,?)')
        .run('admin','Test Admin','admin@test.local','test-only','test-only','admin','active');
    const pilot=installPilot({connection:db,getConfig:()=>cfg,authenticateAdmin:(email,password)=>{if(password!=='test-password')throw new Error('Bad password');}});
    const envelope=p=>{const body=Buffer.from(JSON.stringify(p)).toString('base64');return {contract:p.contract,body,mac:crypto.createHmac('sha256',cfg.sync_token).update(body).digest('hex')};};
    return {db,payload,pilot,envelope,cfg};
}
test('authenticated import rejects tampering/device mismatch and stores encrypted secrets',t=>{
    const {db,payload,pilot,envelope}=fixture(t);
    const valid=envelope(payload);
    assert.throws(()=>pilot.importEnvelope({...valid,mac:'0'.repeat(64)}),/authentication/);
    assert.throws(()=>pilot.importEnvelope(envelope({...payload,device_id:'other'})),/device/);
    assert.equal(db.prepare('SELECT count(*) as n FROM adaptive_pilot_packages').get().n,0);
    pilot.importEnvelope(valid);
    assert(pilot.importEnvelope(valid).already_imported);
    const raw=db.prepare('SELECT payload FROM adaptive_pilot_packages').get().payload;
    assert(!raw.includes('PRIVATE-ACCESS'));assert(!raw.includes('correct'));assert(!raw.includes('Private pool'));
});
test('real candidate API enforces supervisor pause, device binding, retries, recovery and private payloads',async t=>{
    const {db,payload,pilot,envelope}=fixture(t);pilot.importEnvelope(envelope(payload));
    const app=express();app.use(express.json());app.use('/api/adaptive-pilot',pilot.router);
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port+'/api/adaptive-pilot';
    const request=async(path,body,token='')=>{
        const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
        return {status:r.status,body:await r.json()};
    };
    assert.equal((await request('/admin/packages')).status,401);
    const admin=(await request('/admin/login',{email:'admin@test.local',password:'test-password'})).body.token;
    const login={package_id:payload.id,registration:'CAND1',access_code:'PRIVATE-ACCESS',device:'candidate-device-123'};
    assert.equal((await request('/login',{...login,access_code:'bad'})).status,401);
    const token=(await request('/login',login)).body.token;
    assert.equal((await request('/login',{...login,device:'another-device-456'})).status,409);
    assert.equal((await request('/command',{key:'start-111',op:'start'},token)).status,409);
    await request('/admin/packages/'+payload.id+'/pause',{paused:false},admin);
    let response=await request('/command',{key:'start-111',op:'start'},token);
    assert.equal(response.status,200);let state=response.body;
    assert(!JSON.stringify(state).includes('correct'));assert(!JSON.stringify(state).includes('weight'));
    const first=state.current_item.id;
    await request('/admin/packages/'+payload.id+'/pause',{paused:true},admin);
    let counter=0;
    while(state.status==='active') {
        const command={key:'answer-'+(++counter),op:'commit',state_version:state.state_version,item_id:state.current_item.id,option_ids:['wrong']};
        response=await request('/command',command,token);assert.equal(response.status,200);state=response.body;
        assert.equal((await request('/command',command,token)).status,200);
    }
    assert.equal(state.status,'between_levels');
    assert.equal((await request('/command',{key:'recover-111',op:'next-level'},token)).status,409);
    await request('/admin/packages/'+payload.id+'/pause',{paused:false},admin);
    state=(await request('/command',{key:'recover-111',op:'next-level'},token)).body;
    assert.notEqual(state.current_item.id,first);
    while(state.status==='active') state=(await request('/command',{key:'answer-'+(++counter),op:'commit',state_version:state.state_version,item_id:state.current_item.id,option_ids:['right']},token)).body;
    assert.equal(state.status,'closed');assert(state.result_pending_cloud_review);
    assert(!JSON.stringify(state).includes('earned'));
    await request('/admin/sessions/lease-1/reset-device',{},admin);
    assert.equal((await request('/state',undefined,token)).status,401);
    const events=db.prepare('SELECT event FROM adaptive_pilot_events').all().map(x=>x.event);
    assert(events.includes('new_starts_paused'));assert(events.includes('device_reset'));
});
