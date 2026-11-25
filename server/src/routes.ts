import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';

type MatchSlot = { id:string; match:number; group:string; startsAt:string; label:string; status:'Scheduled'|'Delayed'|'Cancelled'|'Completed'; delayReason?:string; updatedAt?:string };
type Team = { id:string; eventId:string; name:string; captain:string; roster:{name:string;uid:string}[]; slot:number; group?:string; createdAt:string; results:{placement:number;kills:number;confirmed:boolean}[]; accessHash:string };
type Event = { id:string; name:string; game:string; type:'Tournament'|'Scrim'; mode:string; matches:number; groups:number; teamLimit:number; status:string; stage:string; createdAt:string; completedAt?:string; organizerHash:string; roomReleaseMinutes?:number; roomId?:string; roomPassword?:string; registrationOpensAt?:string; registrationClosesAt?:string; autoScheduleStartAt?:string; matchIntervalMinutes?:number; matchSchedule?:MatchSlot[] };
const router = Router();
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const bad = (res:Response,message:string,status=400) => res.status(status).json({error:message});
const safeEvent = (event:Event) => { const {organizerHash,roomId,roomPassword,...visible}=event; return visible; };
const getEvent = async (id:string):Promise<Event|undefined> => {
  const result=await pool.query('SELECT id,data FROM ca_events WHERE id=$1',[id]);
  return result.rows[0] ? {id:result.rows[0].id,...result.rows[0].data} as Event : undefined;
};
const getTeams = async (eventId:string):Promise<Team[]> => {
  const result=await pool.query('SELECT id,data FROM ca_teams WHERE event_id=$1 ORDER BY (data->>\'slot\')::int,id',[eventId]);
  return result.rows.map(row=>({id:row.id,...row.data}) as Team);
};
const saveEvent = async (event:Event) => pool.query('UPDATE ca_events SET data=$2::jsonb,updated_at=now() WHERE id=$1',[event.id,JSON.stringify(event)]);
const saveTeam = async (team:Team) => pool.query('UPDATE ca_teams SET data=$2::jsonb,updated_at=now() WHERE id=$1',[team.id,JSON.stringify(team)]);
const statusFor = (event:Event,count:number) => {
  if(['Registration closed','In progress','Completed'].includes(event.status)) return event.status;
  const now=Date.now();
  if(event.registrationOpensAt && new Date(event.registrationOpensAt).getTime()>now) return 'Registration scheduled';
  if(event.registrationClosesAt && new Date(event.registrationClosesAt).getTime()<=now) return 'Registration closed';
  if(event.teamLimit>0 && count>=event.teamLimit) return 'Registration closed';
  return 'Registration open';
};
const makeSchedule = async (event:Event,teams:Team[]) => {
  if(event.matchSchedule?.length || !teams.length || !['Registration closed','In progress'].includes(statusFor(event,teams.length))) return event;
  const groups=event.type==='Tournament' ? [...new Set(teams.map(t=>t.group).filter(Boolean))].sort() as string[] : ['All teams'];
  if(!groups.length) return event;
  const configured=event.autoScheduleStartAt ? new Date(event.autoScheduleStartAt).getTime() : 0;
  const first=Math.max(Number.isFinite(configured)?configured:0,Date.now()+30*60*1000);
  const interval=Math.max(15,Math.min(240,Math.floor(Number(event.matchIntervalMinutes)||30)))*60000;
  const schedule:MatchSlot[]=[];
  for(let match=1;match<=event.matches;match++) for(const group of groups) {
    const safe=group.toLowerCase().replace(/[^a-z0-9]+/g,'-');
    schedule.push({id:`m${match}-${safe}`,match,group,startsAt:new Date(first+(match-1)*interval).toISOString(),label:`${group} · Match ${match}`,status:'Scheduled'});
  }
  event.matchSchedule=schedule;
  await saveEvent(event);
  return event;
};
const archiveEvent = async (event:Event,teams:Team[]) => {
  const completedAt=event.completedAt||new Date().toISOString();
  for(const team of teams) {
    if(!(team.results||[]).some(r=>r.confirmed) && event.status!=='Completed') continue;
    const completed=(team.results||[]).filter(r=>r.confirmed);
    const points=[12,9,8,7,6,5,4,3,2,1,0,0];
    const history={teamId:team.id,teamName:team.name,captain:team.captain,eventId:event.id,eventName:event.name,game:event.game,type:event.type,group:team.group,slot:team.slot,teamCreatedAt:team.createdAt,completedAt,results:team.results||[],kills:completed.reduce((n,r)=>n+Math.max(0,r.kills||0),0),booyahs:completed.filter(r=>r.placement===1).length,totalPoints:completed.reduce((n,r)=>n+(points[r.placement-1]||0)+Math.max(0,r.kills||0),0)};
    const id=`h_${event.id.replace(/[^a-zA-Z0-9_-]/g,'_')}_${team.id.replace(/[^a-zA-Z0-9_-]/g,'_')}`.slice(0,180);
    await pool.query('INSERT INTO ca_team_history(id,event_id,team_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[id,event.id,team.id,JSON.stringify(history)]);
  }
};
export async function cleanupCompletedEvents() {
  const result=await pool.query("SELECT id,data FROM ca_events WHERE data->>'status'='Completed'");
  let removed=0;
  for(const row of result.rows) {
    const event={id:row.id,...row.data} as Event;
    if(!event.completedAt || Date.now()-new Date(event.completedAt).getTime()<24*60*60*1000) continue;
    const teams=await getTeams(event.id);
    await archiveEvent(event,teams);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM ca_teams WHERE event_id=$1',[event.id]);
      await client.query('DELETE FROM ca_events WHERE id=$1',[event.id]);
      await client.query('COMMIT');
      removed++;
    } catch(error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return removed;
}

const requireOrganizer = (event:Event|undefined,token:unknown) => Boolean(event && typeof token==='string' && token.length>0 && digest(token)===event.organizerHash);
const requireTeam = (team:Team|undefined,eventId:string,token:unknown) => Boolean(team && team.eventId===eventId && typeof token==='string' && token.length>0 && digest(token)===team.accessHash);

router.get('/events',async(_req,res)=>{
  const [events,teams,history]=await Promise.all([
    pool.query('SELECT id,data FROM ca_events ORDER BY created_at DESC'),
    pool.query('SELECT id,event_id,data FROM ca_teams ORDER BY created_at'),
    pool.query('SELECT data FROM ca_team_history ORDER BY created_at DESC')
  ]);
  const teamCounts=new Map<string,number>();
  const publicTeams=teams.rows.map(row=>{teamCounts.set(row.event_id,(teamCounts.get(row.event_id)||0)+1);const {accessHash,...data}=row.data;return {id:row.id,...data};});
  res.json({events:events.rows.map(row=>{const event={id:row.id,...row.data} as Event;return {...safeEvent(event),roomPublished:Boolean(event.roomId&&event.roomPassword),status:statusFor(event,teamCounts.get(row.id)||0)};}),teams:publicTeams,history:history.rows.map(row=>row.data)});
});

router.post('/events',async(req,res)=>{
  const input=req.body||{};
  if(typeof input.name!=='string'||!input.name.trim()||typeof input.organizerToken!=='string'||!input.organizerToken||!['Free Fire India','Free Fire MAX'].includes(input.game)||!['Scrim','Tournament'].includes(input.type)) return bad(res,'Valid event details are required');
  const matches=Math.max(1,Math.min(30,Number(input.matches)||1));
  const groups=input.type==='Tournament'?Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1))):0;
  const event:Event={id:randomUUID(),name:input.name.trim().slice(0,100),game:input.game,type:input.type,mode:input.mode==='Clash Squad'?'Clash Squad':'Battle Royale',matches,groups,teamLimit:input.type==='Tournament'?groups*12:Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0))),status:'Registration open',stage:'Open Qualifier',createdAt:new Date().toISOString(),organizerHash:digest(input.organizerToken)};
  await pool.query('INSERT INTO ca_events(id,data) VALUES($1,$2::jsonb)',[event.id,JSON.stringify(event)]);
  res.status(201).json({event:safeEvent(event)});
});

router.get('/events/:id',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!event) return bad(res,'Event not found',404);
  const teams=await getTeams(event.id);
  const updated=await makeSchedule(event,teams);
  res.json({event:{...safeEvent(updated),roomPublished:Boolean(updated.roomId&&updated.roomPassword),status:statusFor(updated,teams.length)},teams:teams.map(({accessHash,...t})=>t)});
});

router.post('/events/:id/teams',async(req,res)=>{
  const event=await getEvent(req.params.id); const input=req.body||{};
  if(!event) return bad(res,'Event not found',404);
  const teams=await getTeams(event.id);
  const current=statusFor(event,teams.length);
  if(current!=='Registration open') return bad(res,current==='Registration scheduled'?'Registration has not opened yet':'Registration is closed',409);
  const roster=Array.isArray(input.players)?input.players:[];
  if(typeof input.name!=='string'||!input.name.trim()||roster.length!==4||roster.some((p:any)=>!p.name?.trim()||!p.uid?.trim())||typeof input.accessToken!=='string'||!input.accessToken) return bad(res,'A team name and four valid players are required');
  if(event.teamLimit>0&&teams.length>=event.teamLimit) return bad(res,'This event has reached its team registration limit',409);
  if(teams.some(t=>t.name.toLowerCase()===input.name.trim().toLowerCase())) return bad(res,'That team name is already registered',409);
  const slot=teams.length+1;
  const team:Team={id:randomUUID(),eventId:event.id,name:input.name.trim().slice(0,60),captain:String(roster[0].name).trim(),roster:roster.map((p:any)=>({name:String(p.name).trim(),uid:String(p.uid).trim()})),slot,group:event.type==='Tournament'?`Group ${String.fromCharCode(65+Math.floor(teams.length/12))}`:undefined,createdAt:new Date().toISOString(),results:Array.from({length:event.matches},()=>({placement:0,kills:0,confirmed:false})),accessHash:digest(input.accessToken)};
  await pool.query('INSERT INTO ca_teams(id,event_id,data) VALUES($1,$2,$3::jsonb)',[team.id,event.id,JSON.stringify(team)]);
  res.status(201).json({team:{id:team.id}});
});

router.post('/events/:id/organizer-room',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!requireOrganizer(event,req.body?.organizerToken)) return bad(res,'Organizer access denied',403);
  res.json({roomId:event!.roomId||'',roomPassword:event!.roomPassword||''});
});

router.put('/events/:id/room',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!requireOrganizer(event,req.body?.organizerToken)) return bad(res,'Organizer access denied',403);
  const roomId=String(req.body.roomId||'').trim().slice(0,80),roomPassword=String(req.body.roomPassword||'').trim().slice(0,80);
  if(!roomId||!roomPassword) return bad(res,'Enter both the room ID and room password');
  event!.roomId=roomId;event!.roomPassword=roomPassword;event!.roomReleaseMinutes=Math.max(0,Math.min(120,Math.floor(Number(req.body.roomReleaseMinutes)||0)));
  await saveEvent(event!);
  res.json({ok:true,roomId,roomPassword,roomReleaseMinutes:event!.roomReleaseMinutes});
});

router.delete('/events/:id',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!requireOrganizer(event,req.body?.organizerToken)) return bad(res,'Organizer access denied',403);
  const teams=await getTeams(event!.id);
  await archiveEvent(event!,teams);
  const client=await pool.connect();
  try { await client.query('BEGIN'); await client.query('DELETE FROM ca_teams WHERE event_id=$1',[event!.id]); const deleted=await client.query('DELETE FROM ca_events WHERE id=$1',[event!.id]); await client.query('COMMIT'); if(!deleted.rowCount) return bad(res,'Event could not be deleted',500); }
  catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  res.json({ok:true,deletedTeams:teams.length});
});

router.put('/events/:id',async(req,res)=>{
  const event=await getEvent(req.params.id); const input=req.body||{};
  if(!requireOrganizer(event,input.organizerToken)) return bad(res,'Organizer access denied',403);
  const updated={...event!};
  if(typeof input.status==='string'&&['Registration open','Registration closed','In progress','Completed'].includes(input.status)){updated.status=input.status;if(input.status==='Completed'&&!event!.completedAt)updated.completedAt=new Date().toISOString();if(input.status!=='Completed')updated.completedAt=undefined;}
  const teams=await getTeams(updated.id);
  if(updated.type==='Tournament'&&input.groups!==undefined){const groups=Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1)));if(teams.length>groups*12)return bad(res,'Cannot reduce groups below the number needed for registered teams',409);updated.groups=groups;updated.teamLimit=groups*12;for(const team of teams){team.group=`Group ${String.fromCharCode(65+Math.floor((team.slot-1)/12))}`;await saveTeam(team);}}
  else if(updated.type==='Scrim'&&input.teamLimit!==undefined){const cap=Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0)));if(cap>0&&teams.length>cap)return bad(res,'Cannot set a limit below the number of registered teams',409);updated.teamLimit=cap;}
  for(const key of ['registrationOpensAt','registrationClosesAt','autoScheduleStartAt'] as const) if(input[key]!==undefined) (updated as any)[key]=input[key]||undefined;
  if(input.matchIntervalMinutes!==undefined)updated.matchIntervalMinutes=Math.max(15,Math.min(240,Math.floor(Number(input.matchIntervalMinutes)||30)));
  for(const key of ['registrationOpensAt','registrationClosesAt','autoScheduleStartAt'] as const)if(updated[key]&&Number.isNaN(new Date(updated[key]!).getTime()))return bad(res,'Invalid date/time value');
  if(updated.registrationOpensAt&&updated.registrationClosesAt&&new Date(updated.registrationClosesAt)<=new Date(updated.registrationOpensAt))return bad(res,'Registration closing time must be after opening time');
  if(input.matchSchedule!==undefined){
    if(!['Registration closed','In progress'].includes(statusFor(event!,teams.length)))return bad(res,'Close registration or reach the registration limit before scheduling matches',409);
    if(!Array.isArray(input.matchSchedule))return bad(res,'Match schedule must be a list');
    const schedule:MatchSlot[]=input.matchSchedule.map((s:any)=>({id:String(s.id||'').slice(0,80),match:Math.max(1,Math.min(updated.matches,Math.floor(Number(s.match)||1))),group:String(s.group||'All teams').slice(0,30),startsAt:String(s.startsAt||''),label:String(s.label||'').slice(0,80),status:['Scheduled','Delayed','Cancelled','Completed'].includes(s.status)?s.status:'Scheduled',delayReason:s.delayReason?String(s.delayReason).slice(0,120):undefined,updatedAt:s.updatedAt?String(s.updatedAt):undefined}));
    if(schedule.some(s=>!s.id||Number.isNaN(new Date(s.startsAt).getTime()))||new Set(schedule.map(s=>s.id)).size!==schedule.length)return bad(res,'Every match needs a unique ID and valid date/time');
    const completed=new Map((event!.matchSchedule||[]).filter(s=>s.status==='Completed').map(s=>[s.id,s]));
    if(schedule.some(s=>{const old=completed.get(s.id);return old&&(s.status!=='Completed'||s.startsAt!==old.startsAt);}))return bad(res,'A completed match cannot be rescheduled',409);
    updated.matchSchedule=schedule;
    if(schedule.length&&schedule.every(s=>s.status==='Completed')){updated.status='Completed';updated.completedAt=updated.completedAt||new Date().toISOString();}
  }
  if(typeof input.roomId==='string')updated.roomId=input.roomId.slice(0,80);
  if(typeof input.roomPassword==='string')updated.roomPassword=input.roomPassword.slice(0,80);
  await saveEvent(updated);res.json({ok:true});
});

router.put('/events/:id/teams/:teamId',async(req,res)=>{
  const event=await getEvent(req.params.id);const input=req.body||{};
  if(!requireOrganizer(event,input.organizerToken))return bad(res,'Organizer access denied',403);
  const teams=await getTeams(req.params.id);const team=teams.find(t=>t.id===req.params.teamId);
  if(!team)return bad(res,'Team not found',404);
  const hasResults=Array.isArray(input.results);const results=hasResults?input.results.slice(0,event!.matches):[];
  const maxPlacement=event!.type==='Tournament'?teams.filter(t=>t.group===team.group).length:teams.length;
  if(input.slot!==undefined){const slot=Number(input.slot),capacity=event!.type==='Tournament'?Math.max(1,event!.groups*12):(Number(event!.teamLimit)||10000);if(!Number.isInteger(slot)||slot<1||slot>capacity)return bad(res,'Choose a slot within the event capacity');if(teams.some(t=>t.id!==team.id&&t.slot===slot))return bad(res,'That slot is already assigned',409);team.slot=slot;team.group=event!.type==='Tournament'?`Group ${String.fromCharCode(65+Math.floor((slot-1)/12))}`:undefined;}
  if(!hasResults&&input.slot===undefined)return bad(res,'No team update was supplied');
  if(hasResults&&(!results.length||results.some((r:any)=>r?.confirmed&&(!Number.isInteger(Number(r.placement))||Number(r.placement)<1||Number(r.placement)>Math.max(1,maxPlacement)||!Number.isInteger(Number(r.kills))||Number(r.kills)<0||Number(r.kills)>999))))return bad(res,'Confirmed match results need a valid placement and kills value');
  const previousResults=team.results.map(r=>({...r}));
  if(hasResults)team.results=team.results.map((old,i)=>results[i]?.confirmed?{placement:Number(results[i].placement),kills:Number(results[i].kills),confirmed:true}:old);
  await saveTeam(team);
  if(!hasResults)return res.json({ok:true,slot:team.slot,group:team.group});
  const changed=results.findIndex((r:any,i:number)=>r?.confirmed&&(!previousResults[i]?.confirmed||previousResults[i].placement!==Number(r.placement)||previousResults[i].kills!==Number(r.kills)));
  const matchTeams=await getTeams(event!.id);const groupTeams=matchTeams.filter(t=>event!.type!=='Tournament'||t.group===team.group);
  const complete=changed>=0&&groupTeams.length>0&&groupTeams.every(t=>t.results?.[changed]?.confirmed);
  if(complete&&event!.matchSchedule?.length){event!.matchSchedule=event!.matchSchedule.map(slot=>slot.match===changed+1&&(event!.type!=='Tournament'||slot.group===team.group)?{...slot,status:'Completed',updatedAt:new Date().toISOString()}:slot);if(event!.matchSchedule.every(slot=>slot.status==='Completed')){event!.status='Completed';event!.completedAt=event!.completedAt||new Date().toISOString();}await saveEvent(event!);}
  res.json({ok:true,matchCompleted:complete});
});

router.post('/events/:id/room',async(req,res)=>{
  const event=await getEvent(req.params.id);const input=req.body||{};
  if(!event||!input.teamId||!input.accessToken)return bad(res,'Team access is required',403);
  const teams=await getTeams(event.id);const team=teams.find(t=>t.id===input.teamId);
  if(!requireTeam(team,event.id,input.accessToken))return bad(res,'Team access denied',403);
  if(!event.roomId||!event.roomPassword)return bad(res,'The manager has not published room details yet',404);
  const eligible=(event.matchSchedule||[]).filter(s=>s.group===(team!.group||'All teams')&&['Scheduled','Delayed'].includes(s.status)).sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());
  if(!eligible.length)return bad(res,'Your match schedule is not available yet',404);
  const release=Math.max(0,Math.min(120,Number(event.roomReleaseMinutes)||0));const now=Date.now();
  const next=eligible.find(s=>now>=new Date(s.startsAt).getTime()-release*60000);
  if(!next){const unlock=new Date(new Date(eligible[0].startsAt).getTime()-release*60000);return bad(res,`Room ID and password unlock at ${unlock.toLocaleString()}`,403);}
  res.json({room:{roomId:event.roomId,roomPassword:event.roomPassword,schedule:eligible.filter(s=>s.id===next.id)}});
});

export default router;
