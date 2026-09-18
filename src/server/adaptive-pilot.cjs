'use strict';
const crypto = require('node:crypto');
const { Router } = require('express');
const engine = require('./adaptive-kernel.cjs');
function installPilot({connection:db, getConfig, authenticateAdmin}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_pilot_packages (id TEXT PRIMARY KEY, payload TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 1, imported_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS adaptive_pilot_sessions (
            id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES adaptive_pilot_packages(id),
            candidate_id TEXT NOT NULL, token_hash TEXT, device_hash TEXT, state TEXT NOT NULL, commands TEXT NOT NULL,
            sync_status TEXT NOT NULL DEFAULT 'pending', UNIQUE(package_id,candidate_id));
        CREATE TABLE IF NOT EXISTS adaptive_pilot_events (id INTEGER PRIMARY KEY, session_id TEXT, event TEXT NOT NULL, occurred_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS adaptive_pilot_clock (id INTEGER PRIMARY KEY CHECK(id=1), last_at INTEGER NOT NULL);
    `);
    const router = Router(), adminTokens = new Map(), rates = new Map();
    const hash = x => crypto.createHash('sha256').update(String(x)).digest('hex');
    const fail = (message,status=422) => { const e=new Error(message); e.status=status; throw e; };
    const audit = (id,event) => db.prepare('INSERT INTO adaptive_pilot_events(session_id,event,occurred_at) VALUES(?,?,?)').run(id,event,Date.now());
    function clock() {
        const now=Date.now(), previous=db.prepare('SELECT last_at FROM adaptive_pilot_clock WHERE id=1').get();
        if (previous && now < previous.last_at) fail('Server clock moved backwards. Restore the clock before resuming.',409);
        db.prepare('INSERT INTO adaptive_pilot_clock(id,last_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at').run(now);
        return now;
    }
    function config() {
        const c=getConfig();
        if (!c.sync_token || !c.device_id) fail('Activate this center before using the adaptive pilot.',503);
        return c;
    }
    function seal(value) {
        const key=crypto.createHash('sha256').update(config().sync_token).digest(), iv=crypto.randomBytes(12);
        const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
        const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
        return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
    }
    function open(value) {
        try {
            const key=crypto.createHash('sha256').update(config().sync_token).digest(), bytes=Buffer.from(value,'base64');
            const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
            decipher.setAuthTag(bytes.subarray(12,28));
            return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
        } catch { fail('Encrypted pilot data cannot be opened. Restore the original center configuration backup.',409); }
    }
    function packageFor(id) {
        const row=db.prepare('SELECT * FROM adaptive_pilot_packages WHERE id=?').get(id);
        if(!row) fail('Package not found.',404);
        return {row,payload:open(row.payload)};
    }
    function session(token) {
        if(typeof token!=='string' || token.length<32) fail('Candidate session required.',401);
        const row=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE token_hash=?').get(hash(token));
        if(!row) fail('Candidate session expired.',401);
        const {payload,payload:pkg}=packageFor(row.package_id);
        return {row,payload:pkg,state:open(row.state),commands:open(row.commands)};
    }
    function execute(row,payload,command) {
        return db.transaction(() => {
            const current=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE id=?').get(row.id);
            const state=open(current.state), commands=open(current.commands);
            if(current.sync_status==='verified') fail('This progression has been accepted by the portal.',409);
            const at=clock();
            const p=db.prepare('SELECT paused FROM adaptive_pilot_packages WHERE id=?').get(row.package_id);
            if(p.paused && ['start','next-level'].includes(command.op)) fail('New levels are paused by the supervisor.',409);
            const normalized={key:command.key,op:command.op,at};
            for(const key of ['item_id','option_ids','state_version','event_name']) if(command[key]!==undefined) normalized[key]=command[key];
            const next=engine.transition(payload.config,state,normalized);
            if(!state.receipts[normalized.key]) {
                commands.push(normalized);
                db.prepare('UPDATE adaptive_pilot_sessions SET state=?, commands=?, sync_status=? WHERE id=?')
                    .run(seal(next),seal(commands),'pending',row.id);
                audit(row.id,command.op);
            }
            return engine.view(payload.config,next,at);
        }).immediate();
    }
    function read(row,payload) {
        let state=open(db.prepare('SELECT state FROM adaptive_pilot_sessions WHERE id=?').get(row.id).state);
        const at=clock();
        if ((state.status==='active' && at>=state.levels.at(-1).due_at) || (state.status==='between_levels' && at>=payload.config.closes_at))
            return execute(row,payload,{op:'tick',key:crypto.randomUUID()});
        return engine.view(payload.config,state,at);
    }
    async function cloud(path,body,admin) {
        const c=config(), url=new URL(path,c.portal_url);
        if(url.protocol!=='https:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) fail('Adaptive sync requires HTTPS to a remote portal.',422);
        const headers={Accept:'application/json',Authorization:'Bearer '+c.sync_token,'X-AlignEx-Device-Id':c.device_id};
        if(admin) { headers['X-AlignEx-Admin-Email']=c.admin_email; headers['X-AlignEx-Admin-Password']=c.admin_password; }
        if(body) headers['Content-Type']='application/json';
        const r=await fetch(url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(35000)});
        const data=await r.json();
        if(!r.ok) fail(data.message||'Portal rejected this request.',r.status);
        return data;
    }
    function importEnvelope(envelope) {
        const c=config();
        if(envelope.contract!=='alignex.diagnostic-offline.v1' || typeof envelope.body!=='string' || envelope.body.length>14000000
            || !/^[a-f0-9]{64}$/.test(envelope.mac)) fail('Unsupported package envelope.');
        const expected=crypto.createHmac('sha256',c.sync_token).update(envelope.body).digest();
        if(!crypto.timingSafeEqual(expected,Buffer.from(envelope.mac,'hex'))) fail('Package authentication failed.');
        const p=JSON.parse(Buffer.from(envelope.body,'base64').toString());
        if(p.contract!==envelope.contract || p.device_id!==c.device_id || p.config.closes_at<=clock()
            || !Array.isArray(p.candidates) || !p.candidates.length || p.candidates.length>200) fail('Package is expired or belongs to another device.');
        engine.validate(p.config);
        return db.transaction(()=>{
            if(db.prepare('SELECT id FROM adaptive_pilot_packages WHERE id=?').get(p.id)) return {id:p.id,already_imported:true};
            db.prepare('INSERT INTO adaptive_pilot_packages(id,payload,paused,imported_at) VALUES(?,?,1,?)').run(p.id,seal(p),clock());
            for(const candidate of p.candidates) {
                db.prepare('INSERT INTO adaptive_pilot_sessions(id,package_id,candidate_id,state,commands) VALUES(?,?,?,?,?)')
                    .run(candidate.lease_id,p.id,candidate.id,seal(engine.initial(p.config,candidate.id)),seal([]));
            }
            audit(null,'package_imported'); return {id:p.id,already_imported:false};
        }).immediate();
    }
    const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
    router.use((req,res,next)=>{
        const now=Date.now(), key=req.ip;
        if(rates.size>10000) rates.clear();
        let rate=rates.get(key); if(!rate || now-rate.at>60000) {rate={at:now,n:0};rates.set(key,rate);}
        if(++rate.n>180) return res.status(429).json({message:'Too many requests. Retry shortly.'});
        next();
    });
    router.post('/admin/login',wrap((req,res)=>{
        const email=String(req.body.email??''), password=String(req.body.password??'');
        if(!db.prepare("SELECT id FROM local_users WHERE email=? AND status='active'").get(email.trim())) fail('Invalid local admin credentials.',401);
        authenticateAdmin(email,password);
        for(const [key,value] of adminTokens) if(value<Date.now()) adminTokens.delete(key);
        const token=crypto.randomBytes(32).toString('hex');adminTokens.set(hash(token),Date.now()+1800000);
        audit(null,'supervisor_login');res.json({token});
    }));
    router.use('/admin',(req,res,next)=>{
        const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
        if((adminTokens.get(hash(token))??0)<Date.now()) return res.status(401).json({message:'Supervisor login required.'});
        next();
    });
    router.post('/admin/import',wrap(async(req,res)=>{
        const id=String(req.body.package_id??'');
        if(!/^[a-f0-9-]{36}$/.test(id)) fail('Enter a package ID.');
        res.json(importEnvelope(await cloud('/api/offline/adaptive/packages/'+id,null,true)));
    }));
    router.get('/admin/packages',wrap((req,res)=>{
        const rows=db.prepare('SELECT id,paused FROM adaptive_pilot_packages ORDER BY imported_at DESC').all();
        res.json({packages:rows.map(row=>{
            const p=packageFor(row.id).payload;
            const sessions=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE package_id=?').all(row.id);
            return {id:row.id,title:p.title,paused:!!row.paused,sessions:sessions.map(s=>{
                const state=open(s.state),c=p.candidates.find(c=>c.id===s.candidate_id);
                return {id:s.id,name:c.name,registration:c.registration,sync_status:s.sync_status,status:state.status,level:state.levels.length};
            })};
        })});
    }));
    router.post('/admin/packages/:id/pause',wrap((req,res)=>{
        packageFor(req.params.id);
        if(typeof req.body.paused!=='boolean') fail('Choose a pause state.');
        db.prepare('UPDATE adaptive_pilot_packages SET paused=? WHERE id=?').run(req.body.paused?1:0,req.params.id);
        audit(null,req.body.paused?'new_starts_paused':'new_starts_enabled');res.json({ok:true});
    }));
    router.post('/admin/sessions/:id/end',wrap((req,res)=>{
        const row=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE id=?').get(req.params.id);if(!row) fail('Session not found.',404);
        const p=packageFor(row.package_id).payload;
        res.json(execute(row,p,{op:req.body.disqualify===true?'disqualified':'supervisor_end',key:crypto.randomUUID()}));
    }));
    router.post('/admin/sessions/:id/reset-device',wrap((req,res)=>{
        const result=db.prepare('UPDATE adaptive_pilot_sessions SET token_hash=NULL,device_hash=NULL WHERE id=?').run(req.params.id);
        if(!result.changes) fail('Session not found.',404);
        audit(req.params.id,'device_reset');res.json({ok:true});
    }));
    router.post('/admin/sessions/:id/sync',wrap(async(req,res)=>{
        const row=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE id=?').get(req.params.id);if(!row) fail('Session not found.',404);
        const p=packageFor(row.package_id).payload;read(row,p);
        const latest=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE id=?').get(row.id), state=open(latest.state);
        if(state.status!=='closed') fail('Finalize the progression before syncing.');
        const body={commands:open(latest.commands),state_hash:engine.digest(state)};
        const result=await cloud('/api/offline/adaptive/leases/'+row.id+'/sync',body,false);
        db.prepare('UPDATE adaptive_pilot_sessions SET sync_status=? WHERE id=?').run(result.status,row.id);
        audit(row.id,'cloud_sync_'+result.status);res.json({status:result.status});
    }));
    router.get('/packages',wrap((req,res)=>{
        res.json({packages:db.prepare('SELECT id FROM adaptive_pilot_packages').all().map(r=>{
            const p=packageFor(r.id).payload;return {id:p.id,title:p.title};
        })});
    }));
    router.post('/login',wrap((req,res)=>{
        const {payload:p}=packageFor(String(req.body.package_id??''));
        const candidate=p.candidates.find(c=>c.registration===String(req.body.registration??'').trim());
        const code=String(req.body.access_code??''), device=String(req.body.device??'');
        if(!candidate || hash(candidate.access_code)!==hash(code) || device.length<16 || device.length>255) fail('Invalid candidate access details.',401);
        const row=db.prepare('SELECT * FROM adaptive_pilot_sessions WHERE id=?').get(candidate.lease_id);
        if(row.device_hash && row.device_hash!==hash(device)) fail('This attempt is bound to another device. Contact the supervisor.',409);
        const token=crypto.randomBytes(32).toString('hex');
        db.prepare('UPDATE adaptive_pilot_sessions SET token_hash=?,device_hash=? WHERE id=?').run(hash(token),hash(device),row.id);
        audit(row.id,'candidate_login');res.json({token,title:p.title,state:read(row,p)});
    }));
    router.get('/state',wrap((req,res)=>{
        const ctx=session(String(req.headers.authorization??'').replace(/^Bearer /,''));
        res.json(read(ctx.row,ctx.payload));
    }));
    router.post('/event',wrap((req,res)=>{
        const ctx=session(String(req.headers.authorization??'').replace(/^Bearer /,''));
        res.json(execute(ctx.row,ctx.payload,{op:'event',key:req.body.key,event_name:req.body.event_name}));
    }));
    router.post('/command',wrap((req,res)=>{
        const ctx=session(String(req.headers.authorization??'').replace(/^Bearer /,''));
        if(!['start','next-level','draft','commit','submit'].includes(req.body.op)) fail('Unsupported candidate operation.');
        res.json(execute(ctx.row,ctx.payload,req.body));
    }));
    router.use((error,req,res,next)=>{
        res.status(error.status??422).json({message:error.status?error.message:'The pilot request could not be completed. Reload the current state or contact the supervisor.'});
    });
    const expire = () => {
        for (const row of db.prepare("SELECT * FROM adaptive_pilot_sessions WHERE sync_status != 'verified'").all()) {
            try {
                const state=open(row.state), now=Date.now();
                if ((state.status==='active' && now>=state.levels.at(-1).due_at) || state.status==='between_levels')
                    read(row,packageFor(row.package_id).payload);
            }
            catch { /* Clock or key faults block writes and remain visible on the next operator request. */ }
        }
    };
    return {router,importEnvelope,execute,read,expire};
}
module.exports={installPilot};
