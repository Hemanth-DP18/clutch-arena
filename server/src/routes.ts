import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';

type MatchSlot = { id:string; match:number; group:string; startsAt:string; label:string; status:'Scheduled'|'Delayed'|'Cancelled'|'Completed'; delayReason?:string; updatedAt?:string };
type Squad = { id:string; name:string; roster:{name:string;uid:string;playerId?:string;caid?:string}[]; createdAt:string; accessHash:string; codeHash:string };
type Team = { id:string; lobbySquadNumbers?:Record<string,number>; squadId?:string; eventId:string; name:string; captain:string; roster:{name:string;uid:string;playerId?:string;caid?:string}[]; slot:number; group?:string; createdAt:string; results:{placement:number;kills:number;confirmed:boolean}[]; accessHash:string };
type Event = { id:string; scoringMode?:'ffws'|'custom'; eliminationPointsPerKill?:number; placementPoints?:number[]; name:string; game:string; type:'Tournament'|'Scrim'; format?:'Solo'|'Squad'; mode:string; matches:number; groups:number; teamLimit:number; status:string; stage:string; createdAt:string; completedAt?:string; organizerHash:string; organizerPlayerId?:string; roomReleaseMinutes?:number; roomId?:string; roomPassword?:string; registrationOpensAt?:string; registrationClosesAt?:string; autoScheduleStartAt?:string; matchIntervalMinutes?:number; groupRooms?:Record<string,{roomId:string;roomPassword:string}>; matchSchedule?:MatchSlot[] };
const router = Router();
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const makePasswordHash=(password:string,salt:string)=>scryptSync(password,salt,64).toString('hex');
const validPlayerUid=(uid:unknown)=>typeof uid==='string'&&/^\d{5,20}$/.test(uid.trim());
const playerFromToken=async(token:unknown)=>{
  if(typeof token!=='string'||token.length<32)return undefined;
  const result=await pool.query('SELECT id,username,profile FROM ca_players WHERE token_hash=$1',[digest(token)]);
  const row=result.rows[0];if(!row)return undefined;
  const profile={...(row.profile||{})};
  if(!profile.caid){
    for(let attempt=0;attempt<8;attempt++){
      const candidate='CAID-'+randomBytes(4).toString('hex').toUpperCase();
      const exists=await pool.query("SELECT 1 FROM ca_players WHERE upper(profile->>'caid')=$1 LIMIT 1",[candidate]);
      if(!exists.rowCount){
        profile.caid=candidate;
        await pool.query('UPDATE ca_players SET profile=$2::jsonb,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(profile)]);
        break;
      }
    }
  }
  return {id:row.id,username:row.username,...profile};
};
const bad = (res:Response,message:string,status=400) => res.status(status).json({error:message});
const safeEvent = (event:Event) => { const {organizerHash,roomId,roomPassword,groupRooms,...visible}=event; return visible; };
const getSquad = async (id:string):Promise<Squad|undefined> => {
  const result=await pool.query('SELECT id,data,code_hash FROM ca_squads WHERE id=$1',[id]);
  return result.rows[0] ? {id:result.rows[0].id,...result.rows[0].data,codeHash:result.rows[0].code_hash} as Squad : undefined;
};
const requireSquad = (squad:Squad|undefined,token:unknown) => Boolean(squad && typeof token==='string' && token.length>0 && digest(token)===squad.accessHash);
const validRoster = (value:unknown):value is {name:string;uid:string}[] => Array.isArray(value) && value.length>=4 && value.length<=5 && value.every((p:any)=>typeof p?.name==='string'&&p.name.trim().length>=2&&p.name.trim().length<=30&&typeof p?.uid==='string'&&/^\d{5,20}$/.test(p.uid.trim())) && new Set(value.map((p:any)=>p.uid.trim())).size===value.length;
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
  const interval=(event.type==='Tournament'?Math.max(5,Math.min(240,Math.floor(Number(event.matchIntervalMinutes)||5))):Math.max(1,Math.min(2,Math.floor(Number(event.matchIntervalMinutes)||2))))*60000;
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
    const points=event.placementPoints||[12,9,8,7,6,5,4,3,2,1,0,0];
    const eliminationPoints=event.eliminationPointsPerKill??1;
    const history={teamId:team.id,teamName:team.name,captain:team.captain,eventId:event.id,eventName:event.name,game:event.game,type:event.type,group:team.group,slot:team.slot,teamCreatedAt:team.createdAt,completedAt,results:team.results||[],kills:completed.reduce((n,r)=>n+Math.max(0,r.kills||0),0),booyahs:completed.filter(r=>r.placement===1).length,totalPoints:completed.reduce((n,r)=>n+(points[r.placement-1]??0)+Math.max(0,r.kills||0)*eliminationPoints,0)};
    const id=`h_${event.id.replace(/[^a-zA-Z0-9_-]/g,'_')}_${team.id.replace(/[^a-zA-Z0-9_-]/g,'_')}`.slice(0,180);
    await pool.query('INSERT INTO ca_team_history(id,event_id,team_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',[id,event.id,team.id,JSON.stringify(history)]);
  }
};
export async function cleanupCompletedEvents() {
  const result=await pool.query("SELECT id,data FROM ca_events WHERE data->>'status'='Completed' AND data->>'completedAt' IS NOT NULL AND (data->>'completedAt')::timestamptz <= now()-interval '10 days'");
  let removed=0;
  for(const row of result.rows) {
    const event={id:row.id,...row.data} as Event;
    const teams=await getTeams(event.id);
    await archiveEvent(event,teams);
    const points=event.placementPoints||[12,9,8,7,6,5,4,3,2,1,0,0];
    const eliminationPoints=event.eliminationPointsPerKill??1;
    const standings=teams.map(team=>{
      const confirmed=(team.results||[]).filter(r=>r.confirmed);
      const kills=confirmed.reduce((n,r)=>n+Math.max(0,r.kills||0),0);
      const totalPoints=confirmed.reduce((n,r)=>n+(points[r.placement-1]??0)+Math.max(0,r.kills||0)*eliminationPoints,0);
      return {teamName:team.name,captain:team.captain,slot:team.slot,group:team.group||'',kills,booyahs:confirmed.filter(r=>r.placement===1).length,totalPoints};
    }).sort((a,b)=>b.totalPoints-a.totalPoints||b.kills-a.kills);
    if(event.organizerPlayerId) {
      await pool.query("INSERT INTO ca_notifications(id,player_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING",
        [randomUUID(),event.organizerPlayerId,JSON.stringify({type:'event_report',eventId:event.id,eventName:event.name,completedAt:event.completedAt,createdAt:new Date().toISOString(),message:'Your event has been archived. Download its final points table.',standings})]);
    }
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
export async function cleanupInactiveSquads() {
  const result=await pool.query("DELETE FROM ca_squads s WHERE s.updated_at <= now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM ca_teams t JOIN ca_events e ON e.id=t.event_id WHERE t.data->>'squadId'=s.id AND e.data->>'status' <> 'Completed') RETURNING id");
  return result.rowCount||0;
}

const requireOrganizer = (event:Event|undefined,token:unknown) => Boolean(event && typeof token==='string' && token.length>0 && digest(token)===event.organizerHash);
const requireTeam = (team:Team|undefined,eventId:string,token:unknown) => Boolean(team && team.eventId===eventId && typeof token==='string' && token.length>0 && digest(token)===team.accessHash);


router.post('/players/register',async(req,res)=>{
  const input=req.body||{};const username=String(input.username||'').trim().toLowerCase();const displayName=String(input.displayName||'').trim();const password=String(input.password||'');const uid=String(input.uid||'').trim();
  if(!/^[a-z0-9_]{4,20}$/.test(username)||displayName.length<2||displayName.length>30||password.length<10||password.length>128||(uid&&!validPlayerUid(uid)))return bad(res,'Use a 4–20 character username, display name, and password of at least 10 characters. Game UID is optional.');
  const salt=randomBytes(16).toString('hex');const passwordHash=makePasswordHash(password,salt);const token=randomBytes(32).toString('hex');const id=randomUUID();
  let caid='';
  for(let attempt=0;attempt<8;attempt++){
    caid='CAID-'+randomBytes(4).toString('hex').toUpperCase();
    try{
      await pool.query('INSERT INTO ca_players(id,username,password_salt,password_hash,token_hash,profile) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[id,username,salt,passwordHash,digest(token),JSON.stringify({displayName,uid,caid,createdAt:new Date().toISOString()})]);
      break;
    }catch(error:any){
      if(error?.code==='23505' && String(error?.constraint||'').includes('username'))return bad(res,'That username is already taken. Choose another.',409);
      if(error?.code!=='23505'||attempt===7)throw error;
    }
  }
  res.status(201).json({token,profile:{id,username,displayName,uid:uid||'',caid}});
});
router.post('/players/login',async(req,res)=>{
  const username=String(req.body?.username||'').trim().toLowerCase();const password=String(req.body?.password||'');
  const result=await pool.query('SELECT id,username,password_salt,password_hash,profile FROM ca_players WHERE username=$1',[username]);const row=result.rows[0];
  if(!row||password.length>128)return bad(res,'Username or password is incorrect.',401);
  const supplied=Buffer.from(makePasswordHash(password,row.password_salt),'hex');const expected=Buffer.from(row.password_hash,'hex');
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return bad(res,'Username or password is incorrect.',401);
  const token=randomBytes(32).toString('hex');
  const profile={...row.profile};
  if(!profile.caid){
    for(let attempt=0;attempt<8;attempt++){
      const candidate='CAID-'+randomBytes(4).toString('hex').toUpperCase();
      const exists=await pool.query("SELECT 1 FROM ca_players WHERE upper(profile->>'caid')=$1 LIMIT 1",[candidate]);
      if(!exists.rowCount){profile.caid=candidate;break;}
    }
    if(!profile.caid)return bad(res,'Could not assign a Clutch Arena ID. Please try again.',503);
  }
  await pool.query('UPDATE ca_players SET token_hash=$2,profile=$3::jsonb,updated_at=now() WHERE id=$1',[row.id,digest(token),JSON.stringify(profile)]);
  res.json({token,profile:{id:row.id,username:row.username,...profile}});
});
router.get('/players/me',async(req,res)=>{const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!player)return bad(res,'Please sign in again.',401);res.json({profile:player});});
router.get('/players/notifications',async(req,res)=>{const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!player)return bad(res,'Sign in to view reports.',401);const rows=await pool.query('SELECT id,data FROM ca_notifications WHERE player_id=$1 ORDER BY created_at DESC LIMIT 50',[player.id]);res.json({notifications:rows.rows.map(row=>({id:row.id,...row.data}))});});
router.post('/events/:id/players/register',async(req,res)=>{
  const event=await getEvent(req.params.id);if(!event)return bad(res,'Event not found',404);if(event.format!=='Solo')return bad(res,'This event is for squads. Use team registration instead.',409);
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!player)return bad(res,'Sign in to your individual profile before registering.',401);
  const playerUid=validPlayerUid(player.uid)?player.uid:'';
  if(!player.caid)return bad(res,'Your player profile is missing its CAID. Please sign in again.',409);
  const entrants=await getTeams(event.id);const current=statusFor(event,entrants.length);if(current!=='Registration open')return bad(res,current==='Registration scheduled'?'Registration has not opened yet':'Registration is closed',409);
  if(entrants.some(t=>t.roster?.some(p=>p.playerId===player.id || (playerUid && p.uid===playerUid))))return bad(res,'This player is already registered for this event.',409);
  if(event.teamLimit>0&&entrants.length>=event.teamLimit)return bad(res,'This event has reached its player limit.',409);
  const slot=entrants.length+1;const accessToken=randomBytes(32).toString('hex');const displayName=String(player.displayName).slice(0,30);
  const entrant:Team={id:randomUUID(),eventId:event.id,name:displayName,captain:displayName,roster:[{name:displayName,uid:playerUid,playerId:player.id,caid:player.caid}],slot,group:event.type==='Tournament'?'Group '+String.fromCharCode(65+Math.floor(entrants.length/12)):undefined,createdAt:new Date().toISOString(),results:Array.from({length:event.matches},()=>({placement:0,kills:0,confirmed:false})),accessHash:digest(accessToken)};
  await pool.query('INSERT INTO ca_teams(id,event_id,data) VALUES($1,$2,$3::jsonb)',[entrant.id,event.id,JSON.stringify(entrant)]);
  res.status(201).json({entrant:{id:entrant.id,eventId:event.id,name:entrant.name,slot:entrant.slot,group:entrant.group},accessToken});
});

router.get('/events',async(req,res)=>{
  const viewer=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  const [events,teams,history]=await Promise.all([
    pool.query('SELECT id,data FROM ca_events ORDER BY created_at DESC'),
    pool.query('SELECT id,event_id,data FROM ca_teams ORDER BY created_at'),
    pool.query('SELECT data FROM ca_team_history ORDER BY created_at DESC')
  ]);
  const teamCounts=new Map<string,number>();
  const publicTeams=teams.rows.map(row=>{teamCounts.set(row.event_id,(teamCounts.get(row.event_id)||0)+1);const {accessHash,...data}=row.data;return {id:row.id,...data,roster:(data.roster||[]).map((p:any)=>({name:p.name}))};});
  res.json({events:events.rows.map(row=>{const event={id:row.id,...row.data} as Event;return {...safeEvent(event),roomPublished:Boolean(event.type==='Tournament'?Object.keys(event.groupRooms||{}).length:event.roomId&&event.roomPassword),status:statusFor(event,teamCounts.get(row.id)||0)};}),teams:publicTeams,history:history.rows.map(row=>row.data)});
});

router.post('/events',async(req,res)=>{
  const input=req.body||{};
  if(typeof input.name!=='string'||!input.name.trim()||typeof input.organizerToken!=='string'||!input.organizerToken||!['Free Fire India','Free Fire MAX'].includes(input.game)||!['Scrim','Tournament'].includes(input.type)||!['Solo','Squad'].includes(input.format||'Squad')) return bad(res,'Valid event details are required');
  const matches=Math.max(1,Math.min(30,Number(input.matches)||1));
  const groups=input.type==='Tournament'?Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1))):0;
  const format=input.format==='Solo'?'Solo':'Squad';
  const host=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!host)return bad(res,'Sign in before creating an event.',401);
  const event:Event={id:randomUUID(),organizerPlayerId:host.id,scoringMode:input.scoringMode==='custom'?'custom':'ffws',eliminationPointsPerKill:input.scoringMode==='custom'?Math.max(0,Math.min(10,Math.floor(Number(input.eliminationPointsPerKill)||0))):1,placementPoints:[12,9,8,7,6,5,4,3,2,1,0,0],name:input.name.trim().slice(0,100),game:input.game,type:input.type,format,mode:input.mode==='Clash Squad'?'Clash Squad':'Battle Royale',matches,groups,teamLimit:input.type==='Tournament'?groups*12:Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0))),status:'Registration open',stage:input.type==='Tournament'?'Group Stage':'Practice Scrim',createdAt:new Date().toISOString(),organizerHash:digest(input.organizerToken),roomReleaseMinutes:10,matchIntervalMinutes:input.type==='Tournament'?5:2};
  await pool.query('INSERT INTO ca_events(id,data) VALUES($1,$2::jsonb)',[event.id,JSON.stringify(event)]);
  res.status(201).json({event:safeEvent(event)});
});

router.get('/events/:id',async(req,res)=>{
  const viewer=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  const event=await getEvent(req.params.id);
  if(!event) return bad(res,'Event not found',404);
  const teams=await getTeams(event.id);
  const updated=await makeSchedule(event,teams);
  res.json({event:{...safeEvent(updated),roomPublished:Boolean(updated.type==='Tournament'?Object.keys(updated.groupRooms||{}).length:updated.roomId&&updated.roomPassword),status:statusFor(updated,teams.length)},teams:teams.map(({accessHash,...t})=>({...t,roster:t.roster.map(p=>({name:p.name}))}))});
});

router.post('/events/:id/teams',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!player)return bad(res,'Sign in before registering for an event.',401);
  const event=await getEvent(req.params.id); const input=req.body||{};
  if(!event) return bad(res,'Event not found',404);
  const teams=await getTeams(event.id);
  const current=statusFor(event,teams.length);
  if(current!=='Registration open') return bad(res,current==='Registration scheduled'?'Registration has not opened yet':'Registration is closed',409);
  const roster=Array.isArray(input.players)?input.players:[];
  if(event.format==='Solo') return bad(res,'This is a solo event. Register with an individual player profile.',409);
  const validPlayers=roster.length>=4&&roster.length<=5&&roster.every((p:any)=>typeof p?.name==='string'&&p.name.trim().length>=2&&p.name.trim().length<=30&&validPlayerUid(typeof p?.uid==='string'?p.uid.trim():null));
  const playerUids=roster.map((p:any)=>String(p.uid).trim());
  if(typeof input.name!=='string'||input.name.trim().length<2||input.name.trim().length>40||!validPlayers||new Set(playerUids).size!==playerUids.length||typeof input.accessToken!=='string'||input.accessToken.length<32) return bad(res,'Enter a team name and 4–5 players with unique numeric UIDs (5–20 digits).');
  if(event.teamLimit>0&&teams.length>=event.teamLimit) return bad(res,'This event has reached its team registration limit',409);
  if(teams.some(t=>t.name.toLowerCase()===input.name.trim().toLowerCase())) return bad(res,'That team name is already registered',409);
  const uidSet=new Set(playerUids);
  if(teams.some(t=>(t.roster||[]).some(p=>uidSet.has(p.uid)))) return bad(res,'One or more players are already registered with another team in this event.',409);
  const slot=teams.length+1;
  const team:Team={id:randomUUID(),eventId:event.id,name:input.name.trim().slice(0,60),captain:String(roster[0].name).trim(),roster:roster.map((p:any)=>({name:String(p.name).trim(),uid:String(p.uid).trim()})),slot,group:event.type==='Tournament'?`Group ${String.fromCharCode(65+Math.floor(teams.length/12))}`:undefined,createdAt:new Date().toISOString(),results:Array.from({length:event.matches},()=>({placement:0,kills:0,confirmed:false})),accessHash:digest(input.accessToken)};
  await pool.query('INSERT INTO ca_teams(id,event_id,data) VALUES($1,$2,$3::jsonb)',[team.id,event.id,JSON.stringify(team)]);
  res.status(201).json({team:{id:team.id}});
});

// A squad is created independently of any event. Its invite code is only returned once.
// Player-owned permanent squads. The captain creates the squad from their signed-in profile.
router.get('/players/teams',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in to view your teams.',401);
  const result=await pool.query("SELECT id,data FROM ca_squads WHERE data->>'ownerId'=$1 OR data @> $2::jsonb ORDER BY created_at DESC",[player.id,JSON.stringify({roster:[{playerId:player.id}]})]);
  res.json({squads:result.rows.map(row=>({id:row.id,name:row.data.name,logo:row.data.logo||'',roster:row.data.roster,createdAt:row.data.createdAt,role:row.data.ownerId===player.id?'Captain':'Player',inviteCode:row.data.ownerId===player.id?row.data.inviteCode||'':undefined}))});
});
router.post('/teams',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in before creating a team.',401);
  const name=String(req.body?.name||'').trim();
  const uid=String(req.body?.uid||'').trim();
  const logo=String(req.body?.logo||'');
  if(name.length<2||name.length>40)return bad(res,'Team name must be 2–40 characters.');
  if(!validPlayerUid(uid))return bad(res,'A valid game UID (5–20 digits) is required to create a team.');
  if(logo && (!/^data:image\/(png|jpeg|webp);base64,/.test(logo)||logo.length>240000))return bad(res,'Team logo must be a PNG, JPG or WEBP image under 180 KB.');
  const id=randomUUID(),code='CA-'+randomBytes(4).toString('hex').toUpperCase();
  const roster=[{playerId:player.id,name:player.displayName,uid,caid:player.caid}];
  const data={name,logo,ownerId:player.id,roster,createdAt:new Date().toISOString(),inviteHash:digest(code),inviteCode:code};
  await pool.query('INSERT INTO ca_squads(id,code_hash,data) VALUES($1,$2,$3::jsonb)',[id,digest(code),JSON.stringify(data)]);
  res.status(201).json({squad:{id,name,logo,roster,createdAt:data.createdAt,role:'Captain',inviteCode:code}});
});
router.delete('/teams/:id/leave',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in before leaving a team.',401);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query('SELECT id,data FROM ca_squads WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!found.rows[0]){await client.query('ROLLBACK');return bad(res,'Team not found.',404);}
    const data=found.rows[0].data;
    if(data.ownerId===player.id){await client.query('ROLLBACK');return bad(res,'The captain cannot leave their own team. Delete the team if you no longer want it.',409);}
    const before=(data.roster||[]).length;
    data.roster=(data.roster||[]).filter((member:any)=>member.playerId!==player.id);
    if(data.roster.length===before){await client.query('ROLLBACK');return bad(res,'You are not a member of this team.',404);}
    await client.query('UPDATE ca_squads SET data=$2::jsonb,updated_at=now() WHERE id=$1',[req.params.id,JSON.stringify(data)]);
    const registrations=await client.query("SELECT id,data FROM ca_teams WHERE data->>'squadId'=$1",[req.params.id]);
    for(const registration of registrations.rows){
      const team=registration.data;
      team.roster=(team.roster||[]).filter((member:any)=>member.playerId!==player.id);
      await client.query('UPDATE ca_teams SET data=$2::jsonb,updated_at=now() WHERE id=$1',[registration.id,JSON.stringify(team)]);
    }
    await client.query('COMMIT');
    res.json({ok:true,teamId:req.params.id});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});

router.delete('/teams/:id',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in before deleting a team.',401);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query('SELECT id,data FROM ca_squads WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!found.rows[0]){await client.query('ROLLBACK');return bad(res,'Team not found.',404);}
    if(found.rows[0].data.ownerId!==player.id){await client.query('ROLLBACK');return bad(res,'Only the team captain can delete this team.',403);}
    const removed=await client.query("DELETE FROM ca_teams WHERE data->>'squadId'=$1 RETURNING id",[req.params.id]);
    await client.query('DELETE FROM ca_squads WHERE id=$1',[req.params.id]);
    await client.query('COMMIT');
    res.json({ok:true,deletedTeamIds:removed.rows.map(row=>row.id),deletedRegistrations:removed.rowCount||0});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});

router.post('/teams/:id/invite',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in first.',401);
  const result=await pool.query('SELECT id,data FROM ca_squads WHERE id=$1',[req.params.id]);
  if(!result.rows[0])return bad(res,'Team not found.',404);
  const data=result.rows[0].data;
  if(data.ownerId!==player.id)return bad(res,'Only the captain can create an invite.',403);
  if(data.roster.length>=5)return bad(res,'Your team already has five players.',409);
  const code='CA-'+randomBytes(4).toString('hex').toUpperCase();
  data.inviteHash=digest(code);data.inviteCode=code;
  await pool.query('UPDATE ca_squads SET code_hash=$2,data=$3::jsonb,updated_at=now() WHERE id=$1',[req.params.id,digest(code),JSON.stringify(data)]);
  res.json({inviteCode:code});
});
router.post('/teams/join-by-caid',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in before joining a team.',401);
  const caid=String(req.body?.captainCaid||'').trim().toUpperCase();
  const uid=String(req.body?.uid||'').trim();
  if(!validPlayerUid(uid))return bad(res,'A valid game UID (5–20 digits) is required to join a team.');
  if(!/^CAID-[A-F0-9]{8}$/.test(caid))return bad(res,'Enter the captain’s valid CAID.');
  const captainResult=await pool.query("SELECT id,profile FROM ca_players WHERE upper(profile->>'caid')=$1",[caid]);
  if(!captainResult.rows[0])return bad(res,'No player account was found for that CAID.',404);
  const captainId=captainResult.rows[0].id;
  if(captainId===player.id)return bad(res,'You are already the captain of your own account.',409);
  const squadResult=await pool.query("SELECT id,data FROM ca_squads WHERE data->>'ownerId'=$1 ORDER BY created_at DESC LIMIT 1",[captainId]);
  if(!squadResult.rows[0])return bad(res,'That player has not created a team yet.',404);
  const data=squadResult.rows[0].data;
  if((data.roster||[]).some((p:any)=>p.playerId===player.id))return bad(res,'You are already on this team.',409);
  if((data.roster||[]).some((p:any)=>p.uid===uid))return bad(res,'This game UID is already used by a teammate.',409);
  if((data.roster||[]).length>=5)return bad(res,'This team already has five players.',409);
  data.roster.push({playerId:player.id,name:player.displayName,uid,caid:player.caid});
  await pool.query('UPDATE ca_squads SET data=$2::jsonb,updated_at=now() WHERE id=$1',[squadResult.rows[0].id,JSON.stringify(data)]);
  res.status(201).json({squad:{id:squadResult.rows[0].id,name:data.name,logo:data.logo||'',roster:data.roster,createdAt:data.createdAt,role:'Player'}});
});

router.post('/teams/join',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));
  if(!player)return bad(res,'Sign in before joining a team.',401);
  const code=String(req.body?.inviteCode||'').trim().toUpperCase().replace(/\\s+/g,'');
  const uid=String(req.body?.uid||'').trim();
  if(!validPlayerUid(uid))return bad(res,'A valid game UID (5–20 digits) is required to join a team.');
  if(!/^CA-[A-F0-9]{8}$/.test(code))return bad(res,'Enter a valid team invite code.');
  const result=await pool.query('SELECT id,data FROM ca_squads WHERE code_hash=$1',[digest(code)]);
  if(!result.rows[0])return bad(res,'Invite code not found or expired.',404);
  const data=result.rows[0].data;
  if(data.roster.some((p:any)=>p.playerId===player.id))return bad(res,'You are already on this team.',409);
  if(data.roster.some((p:any)=>p.uid===uid))return bad(res,'This game UID is already used by a teammate.',409);
  if(data.roster.length>=5)return bad(res,'This team is full.',409);
  data.roster.push({playerId:player.id,name:player.displayName,uid,caid:player.caid});
  data.inviteHash=null;data.inviteCode='';
  await pool.query('UPDATE ca_squads SET code_hash=$2,data=$3::jsonb,updated_at=now() WHERE id=$1',[result.rows[0].id,digest(randomBytes(32).toString('hex')),JSON.stringify(data)]);
  res.status(201).json({squad:{id:result.rows[0].id,name:data.name,logo:data.logo||'',roster:data.roster,createdAt:data.createdAt,role:'Player'}});
});

router.post('/teams',async(req,res)=>{
  const input=req.body||{};
  if(typeof input.name!=='string'||input.name.trim().length<2||input.name.trim().length>40||!validRoster(input.players)||typeof input.accessToken!=='string'||input.accessToken.length<32) return bad(res,'Enter a team name and 4–5 players with unique numeric player UIDs (5–20 digits).');
  const accessHash=digest(input.accessToken);
  const id=randomUUID();
  const code='CA-'+randomBytes(4).toString('hex').toUpperCase();
  const codeHash=digest(code);
  const squad:Squad={id,name:input.name.trim(),roster:input.players.map((p:{name:string;uid:string})=>({name:p.name.trim(),uid:p.uid.trim()})),createdAt:new Date().toISOString(),accessHash,codeHash};
  try {
    await pool.query('INSERT INTO ca_squads(id,code_hash,data) VALUES($1,$2,$3::jsonb)',[id,codeHash,JSON.stringify({name:squad.name,roster:squad.roster,createdAt:squad.createdAt,accessHash})]);
  } catch(error:any) {
    if(error?.code==='23505') return bad(res,'Please generate your team again; the invite code collided.',409);
    throw error;
  }
  res.status(201).json({squad:{id,name:squad.name,roster:squad.roster,createdAt:squad.createdAt},teamCode:code});
});

router.get('/teams/:id',async(req,res)=>{
  const squad=await getSquad(req.params.id);
  if(!requireSquad(squad,req.header('x-team-access'))) return bad(res,'Team access denied',403);
  const registrations=await pool.query("SELECT id,event_id,data FROM ca_teams WHERE data->>'squadId'=$1 ORDER BY created_at DESC",[squad!.id]);
  res.json({squad:{id:squad!.id,name:squad!.name,roster:squad!.roster,createdAt:squad!.createdAt},registrations:registrations.rows.map(row=>({id:row.id,eventId:row.event_id,name:row.data.name,slot:row.data.slot,group:row.data.group}))});
});

router.post('/events/:id/teams/register-code',async(req,res)=>{
  const player=await playerFromToken(req.header('authorization')?.replace(/^Bearer\s+/i,''));if(!player)return bad(res,'Sign in before registering for an event.',401);
  const event=await getEvent(req.params.id);const input=req.body||{};
  if(!event) return bad(res,'Event not found',404);
  const code=typeof input.teamCode==='string'?input.teamCode.trim().toUpperCase().replace(/\s+/g,''):'';
  const captainUid=typeof input.captainUid==='string'?input.captainUid.trim():'';
  if(event.format==='Solo') return bad(res,'This is a solo event. Register with an individual player profile.',409);
  if(!/^CA-[A-F0-9]{8}$/.test(code)||!/^\d{5,20}$/.test(captainUid)) return bad(res,'Enter a valid team code and captain UID.');
  const found=await pool.query('SELECT id,data,code_hash FROM ca_squads WHERE code_hash=$1',[digest(code)]);
  if(!found.rows[0]) return bad(res,'Team code not found. Check the code and try again.',404);
  const squad={id:found.rows[0].id,...found.rows[0].data,codeHash:found.rows[0].code_hash} as Squad;
  if(squad.roster[0]?.uid!==captainUid) return bad(res,'Captain UID verification failed. Only the registered captain UID can confirm this squad.',403);
  if(!validRoster(squad.roster)) return bad(res,'This squad roster needs to be corrected before registration.');
  const teams=await getTeams(event.id);
  const current=statusFor(event,teams.length);
  if(current!=='Registration open') return bad(res,current==='Registration scheduled'?'Registration has not opened yet':'Registration is closed',409);
  if(event.teamLimit>0&&teams.length>=event.teamLimit) return bad(res,'This event has reached its team registration limit',409);
  if(teams.some(t=>t.squadId===squad.id)) return bad(res,'This squad is already registered for this event.',409);
  if(teams.some(t=>t.name.toLowerCase()===squad.name.toLowerCase())) return bad(res,'A team with this name is already registered for this event.',409);
  const playerUids=new Set(squad.roster.map(p=>p.uid));
  if(teams.some(t=>t.roster.some(p=>playerUids.has(p.uid)))) return bad(res,'One or more players are already registered with another team in this event.',409);
  const slot=teams.length+1;
  const accessToken=randomBytes(32).toString('hex');
  const team:Team={id:randomUUID(),squadId:squad.id,eventId:event.id,name:squad.name,captain:squad.roster[0].name,roster:squad.roster,slot,group:event.type==='Tournament'?'Group '+String.fromCharCode(65+Math.floor(teams.length/12)):undefined,createdAt:new Date().toISOString(),results:Array.from({length:event.matches},()=>({placement:0,kills:0,confirmed:false})),accessHash:digest(accessToken)};
  await pool.query('INSERT INTO ca_teams(id,event_id,data) VALUES($1,$2,$3::jsonb)',[team.id,event.id,JSON.stringify(team)]);
  await pool.query('UPDATE ca_squads SET updated_at=now() WHERE id=$1',[squad.id]);
  res.status(201).json({team:{id:team.id,squadId:squad.id,name:team.name,eventId:event.id},accessToken});
});

router.post('/events/:id/organizer-room',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!requireOrganizer(event,req.body?.organizerToken)) return bad(res,'Organizer access denied',403);
  res.json({roomId:event!.roomId||'',roomPassword:event!.roomPassword||'',groupRooms:event!.groupRooms||{},roomReleaseMinutes:10});
});

router.put('/events/:id/room',async(req,res)=>{
  const event=await getEvent(req.params.id);
  if(!requireOrganizer(event,req.body?.organizerToken)) return bad(res,'Organizer access denied',403);
  if(event!.type==='Tournament'){const rooms=req.body.groupRooms&&typeof req.body.groupRooms==='object'?req.body.groupRooms:{};const clean:Record<string,{roomId:string;roomPassword:string}>={};for(const [group,value] of Object.entries(rooms) as [string,any][]){const id=String(value?.roomId||'').trim().slice(0,80),pw=String(value?.roomPassword||'').trim().slice(0,80);if((id&&!pw)||(!id&&pw))return bad(res,'Enter both room credentials for '+group+'.');if(id&&pw)clean[group.slice(0,30)]={roomId:id,roomPassword:pw};}if(!Object.keys(clean).length)return bad(res,'Add room credentials for at least one group.');event!.groupRooms=clean;event!.roomId=undefined;event!.roomPassword=undefined;}else{const id=String(req.body.roomId||'').trim().slice(0,80),pw=String(req.body.roomPassword||'').trim().slice(0,80);if(!id||!pw)return bad(res,'Enter both the room ID and room password');event!.roomId=id;event!.roomPassword=pw;}event!.roomReleaseMinutes=10;await saveEvent(event!);res.json({ok:true,roomReleaseMinutes:event!.roomReleaseMinutes});
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
  const scoringRequested=input.scoringMode!==undefined||input.eliminationPointsPerKill!==undefined||input.placementPoints!==undefined;
  if(scoringRequested&&teams.some(team=>(team.results||[]).some(result=>result.confirmed)))return bad(res,'Scoring rules are locked after the first match result is confirmed.',409);
  if(input.scoringMode!==undefined){if(!['ffws','custom'].includes(input.scoringMode))return bad(res,'Choose a valid scoring mode.');updated.scoringMode=input.scoringMode;}
  if(input.eliminationPointsPerKill!==undefined){const value=Number(input.eliminationPointsPerKill);if(!Number.isInteger(value)||value<0||value>10)return bad(res,'Elimination points must be a whole number from 0 to 10.');updated.eliminationPointsPerKill=updated.scoringMode==='ffws'?1:value;}
  if(input.placementPoints!==undefined){const table=input.placementPoints;if(!Array.isArray(table)||table.length!==12||table.some((v:any)=>!Number.isInteger(v)||v<0||v>100))return bad(res,'Placement scoring must contain exactly 12 non-negative whole-number values.');updated.placementPoints=table;}
  if(updated.scoringMode==='ffws')updated.eliminationPointsPerKill=1;
  if(typeof input.status==='string'&&['Registration open','Registration closed','In progress','Completed'].includes(input.status)){updated.status=input.status;if(input.status==='Completed'&&!event!.completedAt)updated.completedAt=new Date().toISOString();if(input.status!=='Completed')updated.completedAt=undefined;}
  const teams=await getTeams(updated.id);
  if(updated.type==='Tournament'&&input.groups!==undefined){const groups=Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1)));if(teams.length>groups*12)return bad(res,'Cannot reduce groups below the number needed for registered teams',409);updated.groups=groups;updated.teamLimit=groups*12;for(const team of teams){team.group=`Group ${String.fromCharCode(65+Math.floor((team.slot-1)/12))}`;await saveTeam(team);}}
  else if(updated.type==='Scrim'&&input.teamLimit!==undefined){const cap=Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0)));if(cap>0&&teams.length>cap)return bad(res,'Cannot set a limit below the number of registered teams',409);updated.teamLimit=cap;}
  for(const key of ['registrationOpensAt','registrationClosesAt','autoScheduleStartAt'] as const) if(input[key]!==undefined) (updated as any)[key]=input[key]||undefined;
  if(input.matchIntervalMinutes!==undefined)updated.matchIntervalMinutes=updated.type==='Tournament'?Math.max(5,Math.min(240,Math.floor(Number(input.matchIntervalMinutes)||5))):Math.max(1,Math.min(2,Math.floor(Number(input.matchIntervalMinutes)||2)));
  for(const key of ['registrationOpensAt','registrationClosesAt','autoScheduleStartAt'] as const)if(updated[key]&&Number.isNaN(new Date(updated[key]!).getTime()))return bad(res,'Invalid date/time value');
  if(updated.registrationOpensAt&&updated.registrationClosesAt&&new Date(updated.registrationClosesAt)<=new Date(updated.registrationOpensAt))return bad(res,'Registration closing time must be after opening time');
  if(input.matchSchedule!==undefined){
    if(!['Registration closed','In progress'].includes(statusFor(event!,teams.length)))return bad(res,'Close registration or reach the registration limit before scheduling matches',409);
    if(!Array.isArray(input.matchSchedule))return bad(res,'Match schedule must be a list');
    const schedule:MatchSlot[]=input.matchSchedule.map((s:any)=>({id:String(s.id||'').slice(0,80),match:Math.max(1,Math.min(updated.matches,Math.floor(Number(s.match)||1))),group:String(s.group||'All teams').slice(0,30),startsAt:String(s.startsAt||''),label:String(s.label||'').slice(0,80),status:['Scheduled','Delayed','Cancelled','Completed'].includes(s.status)?s.status:'Scheduled',delayReason:s.delayReason?String(s.delayReason).slice(0,120):undefined,updatedAt:s.updatedAt?String(s.updatedAt):undefined}));
    if(schedule.some(s=>!s.id||Number.isNaN(new Date(s.startsAt).getTime()))||new Set(schedule.map(s=>s.id)).size!==schedule.length)return bad(res,'Every match needs a unique ID and valid date/time');
    const minGap=updated.type==='Tournament'?5:1;const byGroup=new Map<string,MatchSlot[]>();for(const slot of schedule){const list=byGroup.get(slot.group)||[];list.push(slot);byGroup.set(slot.group,list);}for(const list of byGroup.values()){list.sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());for(let i=1;i<list.length;i++){const gap=(new Date(list[i].startsAt).getTime()-new Date(list[i-1].startsAt).getTime())/60000;if(gap<minGap)return bad(res,'Matches in the same group must be at least '+minGap+' minute(s) apart.',409);if(updated.type==='Scrim'&&gap>2)return bad(res,'Scrim matches in the same group must stay within a 1–2 minute turnaround.',409);}}
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
  if(input.lobbySquadNumber!==undefined){const matchNumber=Number(input.matchNumber);const squadNumber=Number(input.lobbySquadNumber);if(!Number.isInteger(matchNumber)||matchNumber<1||matchNumber>event!.matches||!Number.isInteger(squadNumber)||squadNumber<1||squadNumber>12)return bad(res,'Choose a match and an in-game squad number from 1 to 12.');const key=String(matchNumber);const duplicate=teams.find(t=>t.id!==team.id&&(event!.type!=='Tournament'||t.group===team.group)&&Number(t.lobbySquadNumbers?.[key])===squadNumber);if(duplicate)return bad(res,'That in-game squad number is already mapped to '+duplicate.name+' for this match.',409);team.lobbySquadNumbers={...(team.lobbySquadNumbers||{}),[key]:squadNumber};}
  if(!hasResults&&input.slot===undefined&&input.lobbySquadNumber===undefined)return bad(res,'No team update was supplied');
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
  const group=team!.group||'All teams';const credentials=event.type==='Tournament'?(event.groupRooms||{})[group]:{roomId:event.roomId,roomPassword:event.roomPassword};if(!credentials?.roomId||!credentials?.roomPassword)return bad(res,'The manager has not published room details for your group yet',404);
  const eligible=(event.matchSchedule||[]).filter(s=>s.group===(team!.group||'All teams')&&['Scheduled','Delayed'].includes(s.status)).sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());
  if(!eligible.length)return bad(res,'Your match schedule is not available yet',404);
  const release=10;const now=Date.now();
  const next=eligible.find(s=>now>=new Date(s.startsAt).getTime()-release*60000);
  if(!next){const unlock=new Date(new Date(eligible[0].startsAt).getTime()-release*60000);return bad(res,`Room ID and password unlock exactly 10 minutes before your match at ${unlock.toLocaleString()}`,403);}
  res.json({room:{roomId:credentials.roomId,roomPassword:credentials.roomPassword,schedule:eligible.filter(s=>s.id===next.id)}});
});

export default router;
