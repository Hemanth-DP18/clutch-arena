import { json, router, db, error } from '@appdeploy/sdk';

type MatchSlotRecord = { id:string; match:number; group:string; startsAt:string; label:string; status:'Scheduled'|'Delayed'|'Cancelled'|'Completed'; delayReason?:string; updatedAt?:string };
type PrizeAwardRecord = { teamId:string; teamName:string; rank:number; share:number; amount:number; status:'Pending'|'Paid'; paidAt?:string };
type EventRecord = { name:string; game:string; type:string; mode:string; matches:number; groups:number; teamLimit:number; status:string; stage:string; createdAt:string; completedAt?:string; organizerHash:string; roomReleaseMinutes?:number; entryFeeMode?:'Free'|'Paid'; entryFee?:number; prizePool?:number; prizeShares?:number[]; prizeDistribution?:PrizeAwardRecord[]; prizePublishedAt?:string; roomId?:string; roomPassword?:string; registrationOpensAt?:string; registrationClosesAt?:string; autoScheduleStartAt?:string; matchIntervalMinutes?:number; matchSchedule?:MatchSlotRecord[] };
type TeamRecord = { id?:string; eventId:string; name:string; captain:string; roster:{name:string;uid:string}[]; slot:number; group?:string; createdAt?:string; paymentStatus?:'Pending'|'Verified'|'Not required'; results:{placement:number;kills:number;confirmed:boolean}[]; accessHash:string };
type TeamHistoryRecord = { teamId:string; teamName:string; captain:string; eventId:string; eventName:string; game:string; type:string; group?:string; slot:number; teamCreatedAt?:string; completedAt:string; results:{placement:number;kills:number;confirmed:boolean}[]; kills:number; booyahs:number; totalPoints:number };
const archiveEventHistory = async (eventId:string,event:EventRecord,teams:TeamRecord[]) => {
  const finishedAt=event.completedAt||new Date().toISOString();
  const records=teams.filter(team=>team.eventId===eventId && ((team.results||[]).some(result=>result.confirmed)||event.status==='Completed')).map(team=>{
    const completed=(team.results||[]).filter(result=>result.confirmed);
    const safe=(value:string)=>value.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48);
    return {id:`h_${safe(eventId)}_${safe(team.id)}`,teamId:team.id,teamName:team.name,captain:team.captain,eventId,eventName:event.name,game:event.game,type:event.type,group:team.group,slot:team.slot,teamCreatedAt:team.createdAt,completedAt:finishedAt,results:team.results||[],kills:completed.reduce((sum,result)=>sum+Math.max(0,result.kills||0),0),booyahs:completed.filter(result=>result.placement===1).length,totalPoints:completed.reduce((sum,result)=>sum+( [12,9,8,7,6,5,4,3,2,1,0,0][result.placement-1]||0 )+Math.max(0,result.kills||0),0)};
  });
  for(let i=0;i<records.length;i+=500) await db.tx.add('ca_team_history',records.slice(i,i+500));
};
const hash = async (value:string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
};
const cleanEvent = (event:any) => { const {organizerHash,roomId,roomPassword,...publicEvent}=event; return publicEvent; };
const listTeams = async (eventId:string) => {
  const page = await db.list<TeamRecord>('ca_teams',{limit:1000});
  return page.items.filter(team=>team.eventId===eventId).map(({accessHash,...team})=>team);
};
const effectiveStatus = (event:any, teamCount:number) => {
  if (['Registration closed','In progress','Completed'].includes(event.status)) return event.status;
  const now=Date.now();
  if(event.registrationOpensAt && new Date(event.registrationOpensAt).getTime()>now) return 'Registration scheduled';
  if(event.registrationClosesAt && new Date(event.registrationClosesAt).getTime()<=now) return 'Registration closed';
  if(Number(event.teamLimit)>0 && teamCount>=Number(event.teamLimit)) return 'Registration closed';
  return 'Registration open';
};
const ensureAutomaticSchedule = async (eventId:string,event:EventRecord,teams:TeamRecord[]) => {
  if (event.matchSchedule?.length || !teams.length || !['Registration closed','In progress'].includes(effectiveStatus(event,teams.length))) return event;
  const groups=event.type==='Tournament'
    ? Array.from(new Set(teams.map(team=>team.group).filter((group):group is string=>!!group))).sort()
    : ['All teams'];
  if (!groups.length) return event;
  const configured=event.autoScheduleStartAt ? new Date(event.autoScheduleStartAt).getTime() : 0;
  const firstStart=Math.max(Number.isFinite(configured)?configured:0,Date.now()+30*60*1000);
  const interval=Math.max(15,Math.min(240,Math.floor(Number(event.matchIntervalMinutes)||30)))*60*1000;
  const schedule:MatchSlotRecord[]=[];
  for (let match=1;match<=event.matches;match++) {
    for (const group of groups) {
      const safeGroup=group.toLowerCase().replace(/[^a-z0-9]+/g,'-');
      schedule.push({id:`m${match}-${safeGroup}`,match,group,startsAt:new Date(firstStart+(match-1)*interval).toISOString(),label:`${group} · Match ${match}`,status:'Scheduled'});
    }
  }
  const updated={...event,matchSchedule:schedule};
  const [ok]=await db.update('ca_events',[{id:eventId,record:updated as any}]);
  if (!ok) throw new Error('Automatic group schedule could not be saved');
  return updated;
};
const getEvent = async (id:string) => {
  const [event] = await db.get<EventRecord>('ca_events',[id],{consistent:true});
  return event;
};
export const cleanupCompletedEvents = async (_event: { type:'cron'; name:string; scheduledTime:string; invokedTime:string }) => {
  const eventsPage=await db.list<EventRecord>('ca_events',{limit:1000});
  const teamsPage=await db.list<TeamRecord>('ca_teams',{limit:1000});
  const now=Date.now();
  const expired=eventsPage.items.filter(event=>event.status==='Completed' && event.completedAt && now-new Date(event.completedAt).getTime()>=24*60*60*1000);
  for(const event of expired){
    const eventTeams=teamsPage.items.filter(team=>team.eventId===event.id);
    await archiveEventHistory(event.id,event,eventTeams);
    const teamIds=eventTeams.map(team=>team.id);
    for(let i=0;i<teamIds.length;i+=500) await db.delete('ca_teams',teamIds.slice(i,i+500));
    await db.delete('ca_events',[event.id]);
  }
  return {statusCode:200};
};

export const handler = router({
  'GET /api/_healthcheck': [async () => json({message:'Success'})],
  'GET /api/events': [async () => {
    const page = await db.list<EventRecord>('ca_events',{limit:1000});
    const teamPage=await db.list<TeamRecord>('ca_teams',{limit:1000});
    const historyPage=await db.list<TeamHistoryRecord>('ca_team_history',{limit:1000});
    const counts=new Map<string,number>();
    for (const team of teamPage.items) counts.set(team.eventId,(counts.get(team.eventId)||0)+1);
    const publicTeams=teamPage.items.map(({accessHash,...team})=>team);
    return json({
      events:page.items.map(item=>({
        id:item.id,
        ...cleanEvent(item),
        roomPublished:Boolean(item.roomId&&item.roomPassword),
        status:effectiveStatus(item,counts.get(item.id)||0)
      })),
      teams:publicTeams,
      history:historyPage.items
    });
  }],
  'POST /api/events': [async ({body}) => {
    const input = body as any;
    if (!input?.name?.trim() || !input.organizerToken || !['Free Fire India','Free Fire MAX'].includes(input.game) || !['Scrim','Tournament'].includes(input.type)) return error('Valid event details are required',400);
    const matches = Math.max(1,Math.min(30,Number(input.matches)||1));
    const groups = input.type==='Tournament' ? Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1))) : 0;
    const teamLimit = input.type==='Tournament' ? groups*12 : Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0)));
    const entryFeeMode=input.entryFeeMode==='Paid'?'Paid':'Free';
    const entryFee=entryFeeMode==='Paid'?Math.max(1,Math.min(100000,Math.floor(Number(input.entryFee)||0))):0;
    if(entryFeeMode==='Paid' && entryFee<1) return error('A paid event needs a valid entry fee',400);
    const prizePool=Math.max(0,Math.min(100000000,Math.floor(Number(input.prizePool)||0)));
    const prizeShares=Array.isArray(input.prizeShares)?input.prizeShares.slice(0,3).map((value:any)=>Math.max(0,Math.min(100,Math.floor(Number(value)||0)))):[50,30,20];
    if(prizeShares.length!==3 || prizeShares.reduce((sum:number,value:number)=>sum+value,0)!==100) return error('Prize shares must add up to 100 percent',400);
    const record:EventRecord={name:String(input.name).trim().slice(0,100),game:input.game,type:input.type,mode:input.mode==='Clash Squad'?'Clash Squad':'Battle Royale',matches,groups,teamLimit,status:'Registration open',stage:'Open Qualifier',createdAt:new Date().toISOString(),entryFeeMode,entryFee,prizePool,prizeShares,organizerHash:await hash(input.organizerToken)};
    const [id] = await db.add('ca_events',[record as any]);
    if (!id) return error('Could not save event',500);
    return json({event:{id,...cleanEvent(record)}},201);
  }],
  'GET /api/events/:id': [async ({params}) => {
    const event=await getEvent(params.id);
    if (!event) return error('Event not found',404);
    const teams=await listTeams(params.id);
    const scheduledEvent=await ensureAutomaticSchedule(params.id,event,teams);
    return json({event:{id:params.id,...cleanEvent(scheduledEvent),roomPublished:Boolean(scheduledEvent.roomId&&scheduledEvent.roomPassword),status:effectiveStatus(scheduledEvent,teams.length)},teams});
  }],
  'POST /api/events/:id/teams': [async ({params,body}) => {
    const event=await getEvent(params.id);
    const input=body as any;
    if (!event) return error('Event not found',404);
    const currentTeams=await listTeams(params.id);
    const currentStatus=effectiveStatus(event,currentTeams.length);
    if (currentStatus!=='Registration open') return error(currentStatus==='Registration scheduled'?'Registration has not opened yet':'Registration is closed',409);
    const roster=Array.isArray(input?.players)?input.players: [];
    if (!input?.name?.trim() || roster.length!==4 || roster.some((p:any)=>!p.name?.trim()||!p.uid?.trim()) || !input.accessToken) return error('A team name and four valid players are required',400);
    const existing=currentTeams;
    const teamLimit = Math.max(0,Number(event.teamLimit)||0);
    if (teamLimit>0 && existing.length>=teamLimit) return error('This event has reached its team registration limit',409);
    if (existing.some((t:any)=>t.name.toLowerCase()===String(input.name).trim().toLowerCase())) return error('That team name is already registered',409);
    const slot=existing.length+1;
    const group=event.type==='Tournament' ? `Group ${String.fromCharCode(65+Math.floor(existing.length/12))}` : undefined;
    const [id] = await db.add('ca_teams',[{eventId:params.id,name:String(input.name).trim().slice(0,60),captain:String(roster[0].name).trim(),roster:roster.map((p:any)=>({name:String(p.name).trim(),uid:String(p.uid).trim()})),slot,group,paymentStatus:event.entryFeeMode==='Paid'?'Pending':'Not required',results:Array.from({length:event.matches},()=>({placement:0,kills:0,confirmed:false})),createdAt:new Date().toISOString(),accessHash:await hash(input.accessToken)} as any]);
    if (!id) return error('Could not register team',500);
    return json({team:{id}},201);
  }],
  'POST /api/events/:id/organizer-room': [async ({params,body}) => {
    const input=body as any;
    const event=await getEvent(params.id);
    if (!event || !input?.organizerToken || await hash(input.organizerToken)!==event.organizerHash) return error('Organizer access denied',403);
    return json({roomId:event.roomId||'',roomPassword:event.roomPassword||''});
  }],
  'PUT /api/events/:id/room': [async ({params,body}) => {
    const input=body as any;
    const event=await getEvent(params.id);
    if (!event || !input?.organizerToken || await hash(input.organizerToken)!==event.organizerHash) return error('Organizer access denied',403);
    const roomId=String(input.roomId||'').trim().slice(0,80);
    const roomPassword=String(input.roomPassword||'').trim().slice(0,80);
    const roomReleaseMinutes=Math.max(0,Math.min(120,Math.floor(Number(input.roomReleaseMinutes)||0)));
    if (!roomId || !roomPassword) return error('Enter both the room ID and room password',400);
    const updated={...event,roomId,roomPassword,roomReleaseMinutes};
    const [ok]=await db.update('ca_events',[{id:params.id,record:updated as any}]);
    if (!ok) return error('Room details could not be saved',500);
    return json({ok:true,roomId,roomPassword,roomReleaseMinutes});
  }],
  'DELETE /api/events/:id': [async ({params,body}) => {
    const input=body as any;
    const event=await getEvent(params.id);
    if (!event || !input?.organizerToken || await hash(input.organizerToken)!==event.organizerHash) return error('Organizer access denied',403);
    const page=await db.list<TeamRecord>('ca_teams',{limit:1000});
    const eventTeams=page.items.filter(team=>team.eventId===params.id);
    await archiveEventHistory(params.id,event,eventTeams);
    const teamIds=eventTeams.map(team=>team.id);
    for(let i=0;i<teamIds.length;i+=500) await db.delete('ca_teams',teamIds.slice(i,i+500));
    const [deleted]=await db.delete('ca_events',[params.id]);
    if(!deleted) return error('Event could not be deleted',500);
    return json({ok:true,deletedTeams:teamIds.length});
  }],
  'PUT /api/events/:id': [async ({params,body}) => {
    const input=body as any;
    const event=await getEvent(params.id);
    if (!event) return error('Event not found',404);
    if (!input?.organizerToken || await hash(input.organizerToken)!==event.organizerHash) return error('Organizer access denied',403);
    const updated={...event};
    if (typeof input.status==='string' && ['Registration open','Registration closed','In progress','Completed'].includes(input.status)) {
      updated.status=input.status;
      if(input.status==='Completed' && !event.completedAt) updated.completedAt=new Date().toISOString();
      if(input.status!=='Completed') updated.completedAt=undefined;
    }
    if (event.type==='Tournament' && input.groups!==undefined) {
      const groups=Math.max(1,Math.min(26,Math.floor(Number(input.groups)||1)));
      if ((await listTeams(params.id)).length>groups*12) return error('Cannot reduce groups below the number needed for registered teams',409);
      updated.groups=groups; updated.teamLimit=groups*12;
      const allTeams=await db.list<TeamRecord>('ca_teams',{limit:1000});
      const changes=allTeams.items.filter(t=>t.eventId===params.id).map(t=>({...t,group:`Group ${String.fromCharCode(65+Math.floor((t.slot-1)/12))}`}));
      if(changes.length) await db.update('ca_teams',changes.map(t=>({id:t.id,record:t as any})));
    } else if(event.type==='Scrim' && input.teamLimit!==undefined) {
      const cap=Math.max(0,Math.min(10000,Math.floor(Number(input.teamLimit)||0)));
      if(cap>0 && (await listTeams(params.id)).length>cap) return error('Cannot set a limit below the number of registered teams',409);
      updated.teamLimit=cap;
    }
    if(input.entryFeeMode!==undefined) { updated.entryFeeMode=input.entryFeeMode==='Paid'?'Paid':'Free'; if(updated.entryFeeMode==='Free') updated.entryFee=0; }
    if(input.entryFee!==undefined) updated.entryFee=updated.entryFeeMode==='Paid'?Math.max(1,Math.min(100000,Math.floor(Number(input.entryFee)||0))):0;
    if(updated.entryFeeMode==='Paid' && !(Number(updated.entryFee)>0)) return error('A paid event needs a valid entry fee',400);
    if(input.prizePool!==undefined) updated.prizePool=Math.max(0,Math.min(100000000,Math.floor(Number(input.prizePool)||0)));
    if(input.prizeShares!==undefined) {
      if(!Array.isArray(input.prizeShares)||input.prizeShares.length!==3) return error('Prize distribution must have three places',400);
      const shares=input.prizeShares.map((value:any)=>Math.max(0,Math.min(100,Math.floor(Number(value)||0))));
      if(shares.reduce((sum:number,value:number)=>sum+value,0)!==100) return error('Prize shares must add up to 100 percent',400);
      updated.prizeShares=shares;
    }
    if(input.prizeDistribution!==undefined) {
      if(!Array.isArray(input.prizeDistribution)) return error('Prize distribution must be a list',400);
      const awards=input.prizeDistribution.map((award:any)=>({teamId:String(award.teamId||'').slice(0,100),teamName:String(award.teamName||'').slice(0,60),rank:Math.max(1,Math.min(3,Math.floor(Number(award.rank)||1))),share:Math.max(0,Math.min(100,Math.floor(Number(award.share)||0))),amount:Math.max(0,Math.floor(Number(award.amount)||0)),status:award.status==='Paid'?'Paid':'Pending',paidAt:award.paidAt?String(award.paidAt):undefined}));
      if(awards.some((award:any)=>!award.teamId||!award.teamName)) return error('Every prize award must identify a team',400);
      const registered=await listTeams(params.id);
      if(awards.some((award:any)=>!registered.some((team:any)=>team.id===award.teamId&&team.name===award.teamName))) return error('Prize awards must match registered teams',400);
      updated.prizeDistribution=awards;
      if(input.prizePublishedAt!==undefined) updated.prizePublishedAt=input.prizePublishedAt||undefined;
    }
    if(input.registrationOpensAt!==undefined) updated.registrationOpensAt=input.registrationOpensAt||undefined;
    if(input.registrationClosesAt!==undefined) updated.registrationClosesAt=input.registrationClosesAt||undefined;
    if(input.autoScheduleStartAt!==undefined) updated.autoScheduleStartAt=input.autoScheduleStartAt||undefined;
    if(input.matchIntervalMinutes!==undefined) updated.matchIntervalMinutes=Math.max(15,Math.min(240,Math.floor(Number(input.matchIntervalMinutes)||30)));
    if(updated.autoScheduleStartAt && Number.isNaN(new Date(updated.autoScheduleStartAt).getTime())) return error('Invalid automatic schedule start time',400);
    if(updated.registrationOpensAt && Number.isNaN(new Date(updated.registrationOpensAt).getTime())) return error('Invalid registration opening date',400);
    if(updated.registrationClosesAt && Number.isNaN(new Date(updated.registrationClosesAt).getTime())) return error('Invalid registration closing date',400);
    if(updated.registrationOpensAt && updated.registrationClosesAt && new Date(updated.registrationClosesAt)<=new Date(updated.registrationOpensAt)) return error('Registration closing time must be after opening time',400);
    if(input.matchSchedule!==undefined) {
      const registrationState=effectiveStatus(event,(await listTeams(params.id)).length);
      if(!['Registration closed','In progress'].includes(registrationState)) return error('Close registration or reach the registration limit before scheduling matches',409);
      if(!Array.isArray(input.matchSchedule)) return error('Match schedule must be a list',400);
      const schedule=input.matchSchedule.map((s:any)=>({id:String(s.id||'').slice(0,80),match:Math.max(1,Math.min(event.matches,Math.floor(Number(s.match)||1))),group:String(s.group||'All teams').slice(0,30),startsAt:String(s.startsAt||''),label:String(s.label||'').slice(0,80),status:['Scheduled','Delayed','Cancelled','Completed'].includes(s.status)?s.status:'Scheduled',delayReason:s.delayReason?String(s.delayReason).slice(0,120):undefined,updatedAt:s.updatedAt?String(s.updatedAt):undefined}));
      if(schedule.some((s:any)=>!s.id || Number.isNaN(new Date(s.startsAt).getTime()))) return error('Every match needs a valid ID and date/time',400);
      if(new Set(schedule.map((s:any)=>s.id)).size!==schedule.length) return error('Match slot IDs must be unique',400);
      const completedSlots=new Map((event.matchSchedule||[]).filter(slot=>slot.status==='Completed').map(slot=>[slot.id,slot]));
      if(schedule.some((slot:any)=>{const previous=completedSlots.get(slot.id);return previous && (slot.status!=='Completed'||slot.startsAt!==previous.startsAt);})) return error('A completed match cannot be rescheduled',409);
      updated.matchSchedule=schedule;
      if(schedule.length>0 && schedule.every((slot:any)=>slot.status==='Completed')) {
        updated.status='Completed';
        if(!event.completedAt) updated.completedAt=new Date().toISOString();
      }
    }
    if (typeof input.roomId==='string') updated.roomId=input.roomId.slice(0,80);
    if (typeof input.roomPassword==='string') updated.roomPassword=input.roomPassword.slice(0,80);
    const [ok]=await db.update('ca_events',[{id:params.id,record:updated as any}]);
    if (!ok) return error('Event update failed',500);
    return json({ok:true});
  }],
  'PUT /api/events/:id/teams/:teamId': [async ({params,body}) => {
    const input=body as any;
    const event=await getEvent(params.id);
    if (!event || !input?.organizerToken || await hash(input.organizerToken)!==event.organizerHash) return error('Organizer access denied',403);
    const [team]=await db.get<TeamRecord>('ca_teams',[params.teamId],{consistent:true});
    if (!team || team.eventId!==params.id) return error('Team not found',404);
    const hasResults=Array.isArray(input.results);
    const results=hasResults?input.results.slice(0,event.matches):[];    const resultTeams=hasResults?await listTeams(params.id):[];
    const maxPlacement=event.type==='Tournament'
      ? resultTeams.filter(item=>item.group===team.group).length
      : resultTeams.length;
    if (input.paymentStatus!==undefined && !['Pending','Verified'].includes(input.paymentStatus)) return error('Invalid entry payment status',400);
    if (input.slot!==undefined) {
      const requestedSlot=Number(input.slot);
      const capacity=event.type==='Tournament'?Math.max(1,event.groups*12):(Number(event.teamLimit)||10000);
      if (!Number.isInteger(requestedSlot)||requestedSlot<1||requestedSlot>capacity) return error('Choose a slot within the event capacity',400);
      const otherTeams=await listTeams(params.id);
      if (otherTeams.some(item=>item.id!==params.teamId&&item.slot===requestedSlot)) return error('That slot is already assigned to another team',409);
    }
    if (!hasResults && input.paymentStatus===undefined && input.slot===undefined) return error('No team update was supplied',400);
    if (hasResults && (!results.length || results.some((r:any)=>r?.confirmed && (!Number.isInteger(Number(r.placement))||Number(r.placement)<1||Number(r.placement)>Math.max(1,maxPlacement)||!Number.isInteger(Number(r.kills))||Number(r.kills)<0||Number(r.kills)>999)))) return error('Confirmed match results need a valid placement within the registered team count and a kill count from 0 to 999',400);
    const updated={...team};
    if (input.paymentStatus!==undefined) updated.paymentStatus=input.paymentStatus;
    if (input.slot!==undefined) {
      updated.slot=Number(input.slot);
      updated.group=event.type==='Tournament'?`Group ${String.fromCharCode(65+Math.floor((updated.slot-1)/12))}`:undefined;
    }
    if (hasResults) updated.results=team.results.map((r:any,i:number)=>results[i]?.confirmed?{placement:Number(results[i].placement),kills:Number(results[i].kills),confirmed:true}:r);
    const [ok]=await db.update('ca_teams',[{id:params.teamId,record:updated as any}]);
    if (!ok) return error('Team update failed',500);
    if (!hasResults) return json({ok:true,paymentStatus:updated.paymentStatus,slot:updated.slot,group:updated.group});
    const matchTeams=await listTeams(params.id);
    const changedMatch=results.findIndex((result:any,index:number)=>result?.confirmed && (!team.results?.[index]?.confirmed || team.results[index].placement!==Number(result.placement) || team.results[index].kills!==Number(result.kills)));
    const eventTeams=matchTeams.filter((item:any)=>event.type!=='Tournament'||item.group===team.group);
    const completed=changedMatch>=0 && eventTeams.length>0 && eventTeams.every((item:any)=>item.results?.[changedMatch]?.confirmed);
    if (completed && event.matchSchedule?.length) {
      const schedule=event.matchSchedule.map(slot=>slot.match===changedMatch+1 && (event.type!=='Tournament'||slot.group===team.group)?{...slot,status:'Completed' as const,updatedAt:new Date().toISOString()}:slot);
      const allSlotsCompleted=schedule.length>0 && schedule.every(slot=>slot.status==='Completed');
      await db.update('ca_events',[{id:params.id,record:{...event,matchSchedule:schedule,status:allSlotsCompleted?'Completed':event.status,completedAt:allSlotsCompleted?(event.completedAt||new Date().toISOString()):event.completedAt} as any}]);
    }
    return json({ok:true,matchCompleted:completed});
  }],
  'POST /api/events/:id/room': [async ({params,body}) => {
    const event=await getEvent(params.id);
    const input=body as any;
    if (!event || !input?.teamId || !input?.accessToken) return error('Team access is required',403);
    const [team]=await db.get<TeamRecord>('ca_teams',[input.teamId],{consistent:true});
    if (!team || team.eventId!==params.id || await hash(input.accessToken)!==team.accessHash) return error('Team access denied',403);
    if (event.entryFeeMode==='Paid' && team.paymentStatus!=='Verified') return error('Your team entry payment has not been verified by the organizer yet',403);
    if (!event.roomId || !event.roomPassword) return error('The manager has not published room details yet',404);
    const eligible=(event.matchSchedule||[]).filter((slot:any)=>slot.group===(team.group||'All teams') && ['Scheduled','Delayed'].includes(slot.status)).sort((a:any,b:any)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());
    if (!eligible.length) return error('Your match schedule is not available yet',404);
    const now=Date.now();
    const releaseMinutes=Math.max(0,Math.min(120,Number(event.roomReleaseMinutes)||0));
    const next=eligible.find((slot:any)=>now>=new Date(slot.startsAt).getTime()-releaseMinutes*60000);
    if (!next) {
      const unlockAt=new Date(new Date(eligible[0].startsAt).getTime()-releaseMinutes*60000);
      return error(`Room ID and password unlock at ${unlockAt.toLocaleString()}`,403);
    }
    return json({room:{roomId:event.roomId,roomPassword:event.roomPassword,schedule:eligible.filter((slot:any)=>slot.id===next.id)}});
  }]
});