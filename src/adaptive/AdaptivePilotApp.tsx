import { useCallback, useEffect, useRef, useState } from 'react';

type Item = {id:string;stem:string;type:string;options:{id:string;label:string;text:string}[]};
type State = {status:string;state_version:number;level:number;current_item:Item|null;selected:string[];remaining_seconds:number;answered:number;stop_reason?:string;recovery_at:number|null};
type Command = {key:string;op:string;state_version?:number;item_id?:string;option_ids?:string[]};
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), x=>x.toString(16).padStart(2,'0')).join('');
const deviceKey='alignex.adaptive.pilot.device';
function device() { let value=localStorage.getItem(deviceKey);if(!value){value=id();localStorage.setItem(deviceKey,value);}return value; }
export default function AdaptivePilotApp({baseUrl='',onBack}:{baseUrl?:string;onBack?:()=>void}) {
    const prefix='alignex.adaptive.pilot.'+baseUrl;
    const [admin,setAdmin]=useState(false), [token,setToken]=useState(()=>localStorage.getItem(prefix+'.token')??'');
    const [adminToken,setAdminToken]=useState(''),[packages,setPackages]=useState<{id:string;title:string;paused?:boolean;sessions?:{id:string;name:string;registration:string;status:string;level:number;sync_status:string}[]}[]>([]);
    const [state,setState]=useState<State|null>(null),[selected,setSelected]=useState<string[]>([]);
    const [pending,setPending]=useState<Command|null>(()=>JSON.parse(localStorage.getItem(prefix+'.pending.'+token)??'null'));
    const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
    const dirty=useRef(false), currentItem=useRef<string|null>(null);
    const [packageId,setPackageId]=useState(''),[registration,setRegistration]=useState(''),[code,setCode]=useState('');
    const [email,setEmail]=useState(''),[password,setPassword]=useState('');
    const api=useCallback(async(path:string,body?:unknown,auth='')=>{
        const response=await fetch(baseUrl+'/api/adaptive-pilot'+path,{method:body===undefined?'GET':'POST',
            headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:body===undefined?undefined:JSON.stringify(body),
            signal:AbortSignal.timeout(40000)});
        const data=await response.json();
        if(!response.ok) throw new Error(data.message??'Request failed.');
        return data;
    },[baseUrl]);
    const accept=(next:State)=>{
        dirty.current=false;currentItem.current=next.current_item?.id??null;
        setState(next);setSelected(next.selected);
    };
    const load=useCallback(async()=>{
        try {
            if(admin && adminToken) setPackages((await api('/admin/packages',undefined,adminToken)).packages);
            else if(!admin && token) {
                const next=await api('/state',undefined,token);
                if (!dirty.current || currentItem.current!==next.current_item?.id) {
                    dirty.current=false;currentItem.current=next.current_item?.id??null;
                    const saved=next.current_item?localStorage.getItem(prefix+'.draft.'+token+'.'+next.current_item.id):null;
                    setSelected(saved?JSON.parse(saved):next.selected);
                    dirty.current=!!saved;
                }
                setState(next);
            } else if(!admin) setPackages((await api('/packages')).packages);
        } catch(e){setError(e instanceof Error?e.message:'Connection unavailable.');}
    },[admin,adminToken,token,api,prefix]);
    useEffect(()=>{void load();},[load]);
    useEffect(()=>{
        if(!token || admin || pending || busy) return;
        const timer=setInterval(()=>void load(),15000);
        const online=()=>void load();window.addEventListener('online',online);
        return()=>{clearInterval(timer);window.removeEventListener('online',online);};
    },[token,admin,pending,busy,load]);
    useEffect(()=>{
        if(!state || state.status!=='active') return;
        const timer=setInterval(()=>setState(s=>s?{...s,remaining_seconds:Math.max(0,s.remaining_seconds-1)}:s),1000);
        return()=>clearInterval(timer);
    },[state?.status]);
    const work=async(fn:()=>Promise<void>)=>{
        if(busy) return;setBusy(true);setError('');setNotice('');
        try{await fn();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy(false);}
    };
    const send=async(command:Command)=>{
        localStorage.setItem(prefix+'.pending.'+token,JSON.stringify(command));setPending(command);
        const next=await api('/command',command,token);
        localStorage.removeItem(prefix+'.pending.'+token);
        if(command.item_id) localStorage.removeItem(prefix+'.draft.'+token+'.'+command.item_id);
        setPending(null);accept(next);
    };
    const command=(op:string)=>void work(()=>send({key:id(),op,...(['draft','commit'].includes(op)&&state?.current_item?
        {state_version:state.state_version,item_id:state.current_item.id,option_ids:selected}:{})}));
    useEffect(()=>{
        if(!token || admin) return;
        const report=(event_name:string)=>{void api('/event',{key:id(),event_name},token).catch(()=>{});};
        const handlers:{[key:string]:()=>void}={blur:()=>report('tab_blur'),focus:()=>report('focus'),copy:()=>report('copy_attempt'),paste:()=>report('paste_attempt'),online:()=>report('network_reconnect')};
        for(const [name,handler] of Object.entries(handlers)) window.addEventListener(name,handler);
        const fullscreen=()=>{if(!document.fullscreenElement) report('fullscreen_exit');};document.addEventListener('fullscreenchange',fullscreen);
        return()=>{for(const [name,handler] of Object.entries(handlers))window.removeEventListener(name,handler);document.removeEventListener('fullscreenchange',fullscreen);};
    },[token,admin,api]);
    const logout=()=>{
        if(pending){setError('Resolve the pending request before signing out.');return;}
        localStorage.removeItem(prefix+'.token');setToken('');setState(null);setAdminToken('');setCode('');setPassword('');
    };
    const adminAction=(path:string,body:unknown)=>void work(async()=>{await api('/admin'+path,body,adminToken);setNotice('Action completed.');await load();});
    return <main className="mx-auto max-w-4xl space-y-5 p-6 text-slate-900">
        <header className="rounded border bg-white p-5"><h1 className="text-2xl font-semibold">Adaptive diagnostic pilot</h1>
            <p>Local center delivery with weakness-focused recovery. Results require portal verification.</p>
            <div className="mt-3 flex gap-4">
                <button type="button" className="underline" disabled={!!pending} onClick={()=>{logout();setAdmin(!admin);setPackages([]);}}>Switch to {admin?'candidate':'supervisor'}</button>
                {onBack&&<button type="button" className="underline" disabled={!!pending} onClick={onBack}>Traditional CBT</button>}
                {(token||adminToken)&&<button type="button" className="underline" onClick={logout}>Sign out</button>}
            </div>
        </header>
        {error&&<p role="alert" className="rounded border border-red-500 bg-red-50 p-3">{error}</p>}
        {notice&&<p role="status" className="rounded bg-green-50 p-3">{notice}</p>}
        {busy&&<p role="status">Working...</p>}
        {admin&&!adminToken&&<form className="space-y-3 rounded border bg-white p-5" onSubmit={e=>{e.preventDefault();void work(async()=>{
            const result=await api('/admin/login',{email,password});setAdminToken(result.token);setPassword('');
        });}}>
            <label className="block">Supervisor email<input required type="email" className="block w-full rounded border p-2" value={email} onChange={e=>setEmail(e.target.value)}/></label>
            <label className="block">Password<input required type="password" className="block w-full rounded border p-2" value={password} onChange={e=>setPassword(e.target.value)}/></label>
            <button disabled={busy} className="rounded bg-green-700 px-4 py-2 text-white">Sign in</button>
        </form>}
        {admin&&adminToken&&<>
            <form className="flex gap-3 rounded border bg-white p-4" onSubmit={e=>{e.preventDefault();adminAction('/import',{package_id:packageId});}}>
                <input aria-label="Portal package ID" required placeholder="Portal package ID" className="grow rounded border p-2" value={packageId} onChange={e=>setPackageId(e.target.value)}/>
                <button disabled={busy} className="rounded bg-green-700 px-4 text-white">Import package</button>
            </form>
            {!packages.length&&<p>No pilot packages imported.</p>}
            {packages.map(p=><section key={p.id} className="space-y-3 rounded border bg-white p-4">
                <h2 className="text-lg font-semibold">{p.title}</h2><p>{p.paused?'New starts paused':'New starts enabled'}</p>
                <button disabled={busy} className="rounded border p-2" onClick={()=>adminAction('/packages/'+p.id+'/pause',{paused:!p.paused})}>{p.paused?'Enable new starts':'Pause new starts'}</button>
                {p.sessions?.map(s=><article key={s.id} className="rounded border p-3">
                    <p>{s.name} ({s.registration}) — level {s.level||1}: {s.status}; sync: {s.sync_status}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <button disabled={busy||s.status==='closed'} onClick={()=>{if(confirm('End this progression and close remaining recovery marks?'))adminAction('/sessions/'+s.id+'/end',{});}}>End progression</button>
                        <button disabled={busy||s.status==='closed'} onClick={()=>{if(confirm('Disqualify this candidate?'))adminAction('/sessions/'+s.id+'/end',{disqualify:true});}}>Disqualify</button>
                        <button disabled={busy} onClick={()=>{if(confirm('Invalidate the old device session so this candidate can sign in again?'))adminAction('/sessions/'+s.id+'/reset-device',{});}}>Reset device</button>
                        <button disabled={busy||s.status!=='closed'} onClick={()=>adminAction('/sessions/'+s.id+'/sync',{})}>Verify with portal</button>
                    </div>
                </article>)}
            </section>)}
        </>}
        {!admin&&!token&&<form className="space-y-3 rounded border bg-white p-5" onSubmit={e=>{e.preventDefault();void work(async()=>{
            const result=await api('/login',{package_id:packageId,registration,access_code:code,device:device()});
            localStorage.setItem(prefix+'.token',result.token);setToken(result.token);accept(result.state);setCode('');
        });}}>
            <label className="block">Exam<select required className="block w-full rounded border p-2" value={packageId} onChange={e=>setPackageId(e.target.value)}><option value="">Choose your exam</option>{packages.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
            <label className="block">Registration number<input required className="block w-full rounded border p-2" value={registration} onChange={e=>setRegistration(e.target.value)}/></label>
            <label className="block">Pilot access code<input required type="password" className="block w-full rounded border p-2" value={code} onChange={e=>setCode(e.target.value)}/></label>
            <button disabled={busy} className="rounded bg-green-700 px-4 py-2 text-white">Continue</button>
        </form>}
        {!admin&&token&&<>
            {pending&&<div className="space-y-2 rounded border border-amber-500 p-4"><p>A request is pending. Retry safely using the same request identity.</p>
                <button disabled={busy} onClick={()=>void work(()=>send(pending))}>Retry request</button>
                <button disabled={busy} onClick={()=>void work(async()=>{
                    const next=await api('/state',undefined,token);
                    if(['draft','commit'].includes(pending.op)&&next.state_version!==pending.state_version) {
                        localStorage.removeItem(prefix+'.pending.'+token);setPending(null);accept(next);
                    } else throw new Error('The request is still unresolved; retry it.');
                })}>Reload after a stale answer</button>
            </div>}
            {state&&<section className="space-y-4 rounded border bg-white p-5">
                <h2 className="text-xl font-semibold">Level {state.level}</h2>
                {state.status==='prepared'&&<><p>You will answer one question at a time. Confirmed answers cannot be changed. Recovery levels use fresh questions from weak areas and the exam's configured penalty.</p>
                    <button disabled={busy||!!pending} className="rounded bg-green-700 px-4 py-2 text-white" onClick={()=>command('start')}>Start level</button></>}
                {state.status==='active'&&<><p>Time remaining: {state.remaining_seconds}s · Confirmed: {state.answered}</p>
                    {state.current_item&&<fieldset disabled={busy||!!pending||state.remaining_seconds===0} className="space-y-3">
                        <legend className="mb-4 whitespace-pre-wrap text-lg">{state.current_item.stem}</legend>
                        {state.current_item.options.map(o=><label className="flex gap-3 rounded border p-3" key={o.id}>
                            <input type={state.current_item!.type==='multiple_choice'?'checkbox':'radio'} name="answer" checked={selected.includes(o.id)} onChange={()=>{
                                const next=state.current_item!.type==='multiple_choice'?(selected.includes(o.id)?selected.filter(x=>x!==o.id):[...selected,o.id]):[o.id];
                                dirty.current=true;localStorage.setItem(prefix+'.draft.'+token+'.'+state.current_item!.id,JSON.stringify(next));setSelected(next);
                            }}/><span>{o.label}. {o.text}</span>
                        </label>)}
                        <button type="button" className="mr-3 rounded border px-4 py-2" onClick={()=>command('draft')}>Save draft</button>
                        <button type="button" className="rounded bg-green-700 px-4 py-2 text-white" onClick={()=>command('commit')}>Confirm and continue</button>
                    </fieldset>}
                    <button disabled={busy||!!pending} onClick={()=>{if(confirm('Submit this level now? Unanswered items earn no marks.'))command('submit');}}>Submit level</button>
                </>}
                {state.status==='between_levels'&&<><p>Level completed. A recovery level is available when the cooldown ends.</p>
                    <button disabled={busy||!!pending||(state.recovery_at??0)>Date.now()} onClick={()=>command('next-level')}>Start recovery level</button></>}
                {state.status==='closed'&&<p>The progression is complete ({state.stop_reason}). Your supervisor will synchronize it for portal verification. No official grade or certificate is issued here.</p>}
                <button disabled={busy} className="block underline" onClick={()=>void load()}>Refresh server state</button>
            </section>}
        </>}
    </main>;
}
