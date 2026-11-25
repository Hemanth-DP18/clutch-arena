import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import { Activity, ArrowRight, Award, BarChart3, CalendarDays, Check, ChevronRight, Copy, Crown, Download, Gamepad2, Plus, RefreshCw, ShieldCheck, Swords, Trophy, Users, X } from 'lucide-react';

type Game = 'Free Fire India' | 'Free Fire MAX';
type MatchSlot = { id:string; match:number; group:string; startsAt:string; label:string; status:'Scheduled'|'Delayed'|'Cancelled'|'Completed'; delayReason?:string; updatedAt?:string };
type RoomAccess = {roomId:string;roomPassword:string;schedule:MatchSlot[]};
type EventItem = { id: string; completedAt?:string; roomPublished?: boolean; roomReleaseMinutes?: number; name: string; game: Game; type: 'Tournament' | 'Scrim'; mode: string; matches: number; status: string; stage: string; createdAt: string; groups?: number; teamLimit?: number; registrationOpensAt?: string; registrationClosesAt?: string; autoScheduleStartAt?:string; matchIntervalMinutes?:number; matchSchedule?: MatchSlot[]; roomId?: string; roomPassword?: string };
type Player = { name: string; uid: string };
type Team = { id: string; eventId: string; name: string; captain: string; roster: Player[]; slot: number; group?: string; createdAt?:string; results: { placement: number; kills: number; confirmed: boolean }[]; accessToken?: string };
type TeamHistory = { id:string; teamId:string; teamName:string; captain:string; eventId:string; eventName:string; game:string; type:string; group?:string; slot:number; teamCreatedAt?:string; completedAt:string; results:{placement:number;kills:number;confirmed:boolean}[]; kills:number; booyahs:number; totalPoints:number };
const points = [12,9,8,7,6,5,4,3,2,1,0,0];
const score = (r: {placement:number;kills:number}) => (points[r.placement-1] || 0) + Math.max(0,r.kills || 0);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
const saved = (key:string) => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
const toLocalInput = (value?:string) => { if (!value) return ''; const d=new Date(value); if(Number.isNaN(d.getTime())) return ''; const pad=(n:number)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const localToIso = (value:string) => value ? new Date(value).toISOString() : '';

export default function App() {
  const [events,setEvents] = useState<EventItem[]>([]);
  const [teams,setTeams] = useState<Team[]>([]);
  const [teamHistory,setTeamHistory] = useState<TeamHistory[]>([]);
  const [activeId,setActiveId] = useState('');
  const [selectedSquadId,setSelectedSquadId] = useState('');
  const refreshSequence = useRef(0);
  const [tab,setTab] = useState('Discover');
  const [loading,setLoading] = useState(true);
  const [notice,setNotice] = useState('');
  const [search,setSearch] = useState('');
  const [showCreate,setShowCreate] = useState(false);
  const [showJoin,setShowJoin] = useState(false);
  const [name,setName] = useState('');
  const [game,setGame] = useState<Game>('Free Fire MAX');
  const [type,setType] = useState<'Tournament'|'Scrim'>('Scrim');
  const [mode,setMode] = useState('Battle Royale');
  const [matches,setMatches] = useState(6);
  const [groups,setGroups] = useState(4);
  const [teamLimit,setTeamLimit] = useState(0);
  const [registrationOpensAt,setRegistrationOpensAt] = useState('');
  const [registrationClosesAt,setRegistrationClosesAt] = useState('');
  const [scheduleMatch,setScheduleMatch] = useState(1);
  const [scheduleGroup,setScheduleGroup] = useState('All groups');
  const [scheduleAt,setScheduleAt] = useState('');
  const [scheduleLabel,setScheduleLabel] = useState('');
  const [manageGroups,setManageGroups] = useState(4);
  const [manageTeamLimit,setManageTeamLimit] = useState(0);
  const [autoScheduleStartAt,setAutoScheduleStartAt] = useState('');
  const [matchIntervalMinutes,setMatchIntervalMinutes] = useState(30);
  const [selectedScheduleId,setSelectedScheduleId] = useState('');
  const [rescheduleAt,setRescheduleAt] = useState('');
  const [installPrompt,setInstallPrompt] = useState<any>(null);
  const [teamName,setTeamName] = useState('');
  const [teamCreateEventId,setTeamCreateEventId] = useState('');
  const [roster,setRoster] = useState('');
  const [organizerTokens,setOrganizerTokens] = useState<Record<string,string>>(() => saved('ca-organizer-links'));
  const [teamTokens,setTeamTokens] = useState<Record<string,string>>(() => saved('ca-team-access'));
  const [room,setRoom] = useState<RoomAccess|null>(null);
  const [roomReleaseMinutes,setRoomReleaseMinutes] = useState(0);
  const [teamPortalEvent,setTeamPortalEvent] = useState('');
  const [roomId,setRoomId] = useState('');
  const [roomPassword,setRoomPassword] = useState('');
  const [slotDraft,setSlotDraft] = useState<Record<string,number>>({});
  const [resultDraft,setResultDraft] = useState<Record<string,{placement:number;kills:number}>>({});
  const [selectedMatch,setSelectedMatch] = useState(0);

  const accessParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const roleMode = accessParams.has('manage') ? 'manager' : accessParams.has('team') ? 'team' : accessParams.has('watch') ? 'watch' : 'public';
  const active = events.find(e => e.id === activeId);
  const activeTeams = teams.filter(t => t.eventId === active?.id);
  const refresh = async (selected?:string, linkedTeamId?:string) => {
    const requestId = ++refreshSequence.current;
    setLoading(true);
    try {
      const response = await api.get('/api/events');
      if (requestId !== refreshSequence.current) return;
      const list = (response.data.events || []) as EventItem[];
      const publicTeams = (response.data.teams || []) as Team[];
      const publicHistory = (response.data.history || []) as TeamHistory[];
      const linkedIds = new Set([...Object.keys(teamTokens),...(linkedTeamId?[linkedTeamId]:[])]);
      const linkedNames = new Set(publicTeams.filter(team=>linkedIds.has(team.id)).map(team=>team.name.trim().toLowerCase()));
      const linkedEventId = linkedTeamId ? publicTeams.find(team=>team.id===linkedTeamId)?.eventId : '';
      const requestedId = selected || linkedEventId || activeId;
      const id = list.some(item=>item.id===requestedId) ? requestedId : list[0]?.id || '';
      setTeams(publicTeams);
      setTeamHistory(publicHistory);
      setActiveId(id);
      const relatedEventIds=publicTeams.filter(team=>linkedNames.has(team.name.trim().toLowerCase())).map(team=>team.eventId);
      const detailIds = Array.from(new Set([id,...publicTeams.map(team=>team.eventId),...relatedEventIds].filter(eventId=>list.some(item=>item.id===eventId))));
      const details = await Promise.all(detailIds.map(async eventId => {
        const detail = await api.get('/api/events/' + encodeURIComponent(eventId));
        return [eventId,detail.data.event] as const;
      }));
      if (requestId !== refreshSequence.current) return;
      const detailMap = new Map(details);
      setEvents(list.map(item=>detailMap.get(item.id)||item));
      setRoom(null);
    } catch {
      if (requestId === refreshSequence.current) setNotice('Could not load shared events and team names. Please refresh in a moment.');
    } finally {
      if (requestId === refreshSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const organizerId = params.get('manage');
    const teamId = params.get('team');
    const watchId = params.get('watch');
    const accessKey = params.get('key');
    if (organizerId && accessKey) {
      setOrganizerTokens(current=>({...current,[organizerId]:accessKey}));
      setActiveId(organizerId);
      setTab('Manage');
      void (async()=>{
        await refresh(organizerId);
        try {
          const savedRoom=await api.post('/api/events/'+encodeURIComponent(organizerId)+'/organizer-room',{organizerToken:accessKey});
          setRoomId(savedRoom.data.roomId||'');
          setRoomPassword(savedRoom.data.roomPassword||'');
        } catch {
          setRoomId('');
          setRoomPassword('');
        }
      })();
      return;
    }
    if (teamId && accessKey) {
      setTeamTokens(current=>({...current,[teamId]:accessKey}));
      setTab('Team');
      void refresh(undefined,teamId);
      return;
    }
    if (watchId) {
      setTab('Standings');
      void refresh(watchId);
      return;
    }
    void refresh();
  }, []);
  useEffect(() => { localStorage.setItem('ca-organizer-links',JSON.stringify(organizerTokens)); },[organizerTokens]);
  useEffect(() => { localStorage.setItem('ca-team-access',JSON.stringify(teamTokens)); },[teamTokens]);
  useEffect(() => { const timer=window.setInterval(()=>{ if(activeId) void refresh(activeId); },60000); return ()=>window.clearInterval(timer); },[activeId]);
  useEffect(() => { if (!active) return; setRegistrationOpensAt(toLocalInput(active.registrationOpensAt)); setRegistrationClosesAt(toLocalInput(active.registrationClosesAt)); setManageGroups(active.groups||1); setManageTeamLimit(active.teamLimit||0); setAutoScheduleStartAt(toLocalInput(active.autoScheduleStartAt)); setMatchIntervalMinutes(active.matchIntervalMinutes||30); setSelectedScheduleId(active.matchSchedule?.[0]?.id||''); },[active?.id]);
  useEffect(() => {
    const onInstallPrompt = (event:Event) => { event.preventDefault(); setInstallPrompt(event as any); };
    const onInstalled = () => { setInstallPrompt(null); flash('ClutchArena is installed on your home screen.'); };
    window.addEventListener('beforeinstallprompt',onInstallPrompt);
    window.addEventListener('appinstalled',onInstalled);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
    return () => { window.removeEventListener('beforeinstallprompt',onInstallPrompt); window.removeEventListener('appinstalled',onInstalled); };
  },[]);
  const flash = (s:string) => { setNotice(s); window.setTimeout(()=>setNotice(''),4000); };
  const createEvent = async () => {
    if (!name.trim()) return flash('Enter an event name first.');
    const organizerToken = token();
    try {
      const r = await api.post('/api/events',{name:name.trim(),game,type,mode,matches,groups,teamLimit,organizerToken});
      const id = r.data.event.id as string;
      setOrganizerTokens(v=>({...v,[id]:organizerToken}));
      setName(''); setShowCreate(false); location.hash = `manage=${id}&key=${organizerToken}`; setTab('Manage'); await refresh(id);
      flash('Event published! Save your private organizer link before closing this device.');
      const link = location.origin + location.pathname + '#manage=' + id + '&key=' + organizerToken;
      await navigator.clipboard?.writeText(link).catch(()=>{});
    } catch(e:any) { flash(e?.response?.data?.error || 'Event could not be created.'); }
  };
  const registerTeam = async () => {
    if (!active) return flash('Choose an event first.');
    const players = roster.split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean).map(line=>{const i=line.indexOf(':');return {name:i<0?'':line.slice(0,i).trim(),uid:i<0?'':line.slice(i+1).trim()};});
    if (!teamName.trim() || players.length !== 4 || players.some(p=>!p.name||!p.uid)) return flash('Enter a team name and four players as Name:UID.');
    const accessToken = token();
    try {
      const r = await api.post('/api/events/'+encodeURIComponent(active.id)+'/teams',{name:teamName.trim(),players,accessToken});
      setTeamTokens(v=>({...v,[r.data.team.id]:accessToken}));
      setTeamName('');setRoster('');setShowJoin(false);await refresh(active.id);
      location.hash = `team=${r.data.team.id}&key=${accessToken}`;
      setTab('Team');setTeamPortalEvent(active.id);
      const teamLink=location.origin+location.pathname+'#team='+r.data.team.id+'&key='+accessToken;
      await navigator.clipboard?.writeText(teamLink).catch(()=>{});
      flash('Team registered! Your private team access link was copied. Save it to open the team portal on another device.');
    } catch(e:any) { flash(e?.response?.data?.error || 'Registration failed.'); }
  };
  const saveRegistrationSettings = async () => {
    if (!active) return;
    const open=localToIso(registrationOpensAt), close=localToIso(registrationClosesAt);
    if(open && close && new Date(close)<=new Date(open)) return flash('Registration closing time must be after opening time.');
    const groupsValue=active.type==='Tournament'?manageGroups:0;
    const cap=active.type==='Tournament'?groupsValue*12:manageTeamLimit;    if(cap>0 && activeTeams.length>cap) return flash('The new limit cannot be lower than the number of teams already registered.');    await manage({groups:groupsValue,teamLimit:cap,registrationOpensAt:open,registrationClosesAt:close});
  };
  const updateTeamSlot = async (team:Team) => {
    if (!active) return;
    const slot=Number(slotDraft[team.id] ?? team.slot);
    const maximum=active.type==='Tournament'?(active.groups||1)*12:(active.teamLimit||10000);
    if (!Number.isInteger(slot)||slot<1||slot>maximum) return flash('Choose a valid slot within this event capacity.');
    const key=organizerTokens[active.id];
    if (!key) return flash('Organizer access is required.');
    try {
      await api.put('/api/events/'+encodeURIComponent(active.id)+'/teams/'+encodeURIComponent(team.id),{organizerToken:key,slot});
      await refresh(active.id);
      flash(`${team.name} assigned to Slot ${slot}.`);
    } catch(e:any) { flash(e?.response?.data?.error||'Team slot could not be updated.'); }
  };
  const exportOverallStandings = async () => {
    if (!active) return flash('Choose an event before exporting standings.');
    const rows=sorted;
    const width=1400, headerHeight=190, rowHeight=62, footerHeight=74;
    const height=headerHeight+Math.max(1,rows.length)*rowHeight+footerHeight;
    const canvas=document.createElement('canvas');
    canvas.width=width; canvas.height=height;
    const ctx=canvas.getContext('2d');
    if(!ctx) return flash('Could not generate the standings image in this browser.');
    ctx.fillStyle='#090b16'; ctx.fillRect(0,0,width,height);
    const gradient=ctx.createLinearGradient(0,0,width,headerHeight); gradient.addColorStop(0,'#21183e'); gradient.addColorStop(1,'#101626');
    ctx.fillStyle=gradient; ctx.fillRect(0,0,width,headerHeight);
    ctx.fillStyle='#a993ff'; ctx.font='700 22px Arial'; ctx.fillText('FOREVER GAMING  /  CLUTCHARENA',54,48);
    ctx.fillStyle='#ffffff'; ctx.font='800 46px Arial'; ctx.fillText('OVERALL STANDINGS',54,108);
    ctx.fillStyle='#c6bddf'; ctx.font='22px Arial'; ctx.fillText(`${active.name}  •  ${active.game}  •  ${active.type}`,54,150);
    ctx.fillStyle='#a993ff'; ctx.font='700 18px Arial';
    const columns=[{label:'RANK',x:54},{label:'TEAM / SQUAD',x:180},{label:'GROUP / SLOT',x:690},{label:'BOOYAHS',x:900},{label:'KILLS',x:1080},{label:'TOTAL POINTS',x:1200}];
    columns.forEach(c=>ctx.fillText(c.label,c.x,headerHeight+36));
    rows.forEach((team,index)=>{
      const y=headerHeight+rowHeight*(index+1);
      ctx.fillStyle=index%2===0?'#151b2b':'#101625'; ctx.fillRect(36,y-8,width-72,rowHeight);
      ctx.fillStyle=index===0?'#f2d38c':'#e8e9f5'; ctx.font='700 24px Arial'; ctx.fillText(String(index+1),54,y+30);
      ctx.fillStyle='#ffffff'; ctx.font='700 22px Arial'; ctx.fillText(String(team.name).slice(0,28),180,y+30);
      ctx.fillStyle='#aeb7cc'; ctx.font='20px Arial'; ctx.fillText(`${team.group||'Open'}  /  ${team.slot}`,690,y+30);
      ctx.fillText(String(team.booyahs),900,y+30); ctx.fillText(String(team.kills),1080,y+30);
      ctx.fillStyle='#c6b4ff'; ctx.font='800 24px Arial'; ctx.fillText(String(team.total),1200,y+30);
    });
    ctx.fillStyle='#7f8aa5'; ctx.font='16px Arial'; ctx.fillText(`Generated ${new Date().toLocaleString()}  •  ClutchArena overall points table`,54,height-28);
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob) return flash('Standings image could not be created.');
    const url=URL.createObjectURL(blob); const link=document.createElement('a');
    link.href=url; link.download=`${active.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-overall-standings.png`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    flash('Overall standings photo generated and downloaded as PNG.');
  };
  const markEventCompleted = async () => {
    if(!active) return;
    const key=organizerTokens[active.id];
    if(!key) return flash('Organizer access is required.');
    try {
      await api.put('/api/events/'+encodeURIComponent(active.id),{organizerToken:key,status:'Completed'});
      await exportOverallStandings();
      await refresh(active.id);
      flash('Event completed. Standings photo downloaded; this event will be automatically deleted after 24 hours.');
    } catch(e:any) { flash(e?.response?.data?.error||'Could not complete this event.'); }
  };
  const deleteEvent = async () => {
    if(!active) return;
    const key=organizerTokens[active.id];
    if(!key) return flash('Organizer access is required.');
    if(!window.confirm(`Permanently delete “${active.name}” and all its registered teams? This cannot be undone. Download the standings photo first if you need it.`)) return;
    try {
      await api.delete('/api/events/'+encodeURIComponent(active.id),{organizerToken:key});
      setOrganizerTokens(current=>{const next={...current};delete next[active.id];return next;});
      setTeamTokens(current=>{const next={...current};teams.filter(team=>team.eventId===active.id).forEach(team=>delete next[team.id]);return next;});
      setActiveId(''); await refresh(''); setTab('Discover');
      flash('Event and its registered teams were deleted.');
    } catch(e:any) { flash(e?.response?.data?.error||'Event could not be deleted.'); }
  };
  const deleteHostedEvent = async (event:EventItem) => {
    const key=organizerTokens[event.id];
    if(!key) return flash('Organizer access is required.');
    if(!window.confirm(`Permanently delete “${event.name}” and all its registered teams? This cannot be undone.`)) return;
    try {
      await api.delete('/api/events/'+encodeURIComponent(event.id),{organizerToken:key});
      setOrganizerTokens(current=>{const next={...current};delete next[event.id];return next;});
      setTeamTokens(current=>{const next={...current};teams.filter(team=>team.eventId===event.id).forEach(team=>delete next[team.id]);return next;});
      if(activeId===event.id) setActiveId('');
      await refresh('');
      flash('Event and its registered teams were deleted.');
    } catch(e:any) { flash(e?.response?.data?.error||'Event could not be deleted.'); }
  };
  const saveAutoScheduleSettings = async () => {
    if (!active) return;
    if (autoScheduleStartAt && Number.isNaN(new Date(autoScheduleStartAt).getTime())) return flash('Choose a valid first match time.');
    await manage({autoScheduleStartAt:localToIso(autoScheduleStartAt),matchIntervalMinutes:Math.max(15,Math.min(240,matchIntervalMinutes))});
  };
  const updateScheduleStatus = async (status:'Delayed'|'Cancelled'|'Completed') => {
    if (!active || !selectedScheduleId) return flash('Select a group match first.');
    const targetId=selectedScheduleId || active.matchSchedule?.[0]?.id;
    if (!targetId) return flash('No scheduled match is available.');
    const schedule=(active.matchSchedule||[]).map(slot=>slot.id===targetId?{...slot,status,updatedAt:new Date().toISOString(),delayReason:status==='Delayed'?'Awaiting manager reschedule':undefined}:slot);
    await manage({matchSchedule:schedule});
  };
  const rescheduleSelectedMatch = async () => {
    const targetId=selectedScheduleId || active?.matchSchedule?.[0]?.id;    if (!active || !targetId || !rescheduleAt) return flash('Select a match and its new date/time.');
    const slot=(active.matchSchedule||[]).find(item=>item.id===targetId);
    if (!slot) return flash('That match slot is no longer available. Refresh the event.');
    const schedule=(active.matchSchedule||[]).map(item=>item.id===targetId?{...item,startsAt:localToIso(rescheduleAt),status:'Scheduled' as const,delayReason:undefined,updatedAt:new Date().toISOString()}:item);
    await manage({matchSchedule:schedule}); setRescheduleAt('');
    flash('Match rescheduled. Its teams remain in the same group and available for the new time.');
  };
  const installApp = async () => {
    if (!installPrompt) return flash('To install: open your browser menu and choose Add to Home screen or Install app.');
    try { await installPrompt.prompt(); const result=await installPrompt.userChoice; setInstallPrompt(null); flash(result?.outcome==='accepted'?'ClutchArena installation started.':'You can install ClutchArena later from your browser menu.'); }
    catch { flash('Use your browser menu and choose Add to Home screen.'); }
  };
  const manage = async (patch:Record<string,unknown>) => {
    if (!active) return;
    const key = organizerTokens[active.id];
    if (!key) return flash('Open your private organizer link on this device to manage this event.');
    try {
      if ('roomId' in patch || 'roomPassword' in patch) {
        const releaseMinutes=patch.roomReleaseMinutes===undefined?0:Math.max(0,Math.min(120,Number(patch.roomReleaseMinutes)||0));
        const savedRoom = await api.put('/api/events/'+encodeURIComponent(active.id)+'/room',{organizerToken:key,roomId:String(patch.roomId || ''),roomPassword:String(patch.roomPassword || ''),roomReleaseMinutes:releaseMinutes});
        setRoomId(savedRoom.data.roomId || '');
        setRoomPassword(savedRoom.data.roomPassword || '');
        setRoomReleaseMinutes(savedRoom.data.roomReleaseMinutes??0);
        await refresh(active.id);
        flash('Room details saved. Registered teams can open them at match start or '+releaseMinutes+' minutes before match time.');
      } else {
        await api.put('/api/events/'+encodeURIComponent(active.id),{organizerToken:key,...patch});
        await refresh(active.id);
        flash('Event updated for everyone.');
      }
    } catch(e:any) { flash(e?.response?.data?.error || 'Update failed. Check your private organizer link.'); }
  };
  const confirmResult = async (team:Team) => {
    if (!active) return;
    const draft = resultDraft[team.id+'-'+selectedMatch] || {placement:1,kills:0};
    if (!Number.isInteger(draft.placement) || draft.placement<1 || draft.placement>activeTeams.length || !Number.isInteger(draft.kills) || draft.kills<0 || draft.kills>999) return flash('Enter a placement between 1 and the registered team count, plus a kill count from 0 to 999.');
    const key = organizerTokens[active.id];
    if (!key) return flash('Organizer access is required to confirm results.');
    const results = [...(team.results || [])];
    results[selectedMatch] = {...draft,confirmed:true};
    try { await api.put('/api/events/'+encodeURIComponent(active.id)+'/teams/'+encodeURIComponent(team.id),{organizerToken:key,results}); await refresh(active.id); flash('Confirmed result saved and standings recalculated.'); }
    catch(e:any) { flash(e?.response?.data?.error || 'Result could not be saved.'); }
  };
  const openRoom = async (team:Team) => {
    const accessToken = teamTokens[team.id];
    if (!accessToken) return flash('Import this team’s private access link to view its match room.');
    try { const r=await api.post('/api/events/'+encodeURIComponent(active!.id)+'/room',{teamId:team.id,accessToken});setRoom(r.data.room); }
    catch(e:any) { flash(e?.response?.data?.error || 'Room details are not available yet.'); }
  };
  const importTeamLink = () => { const raw=prompt('Paste the private team access link:');if(!raw)return;try{const u=new URL(raw);const id=u.hash.match(/team=([^&]+)/)?.[1];const key=u.hash.match(/key=([^&]+)/)?.[1];if(!id||!key)throw new Error();const decoded=decodeURIComponent(id);location.hash=`team=${decoded}&key=${key}`;setTeamTokens(v=>({...v,[decoded]:key}));setTab('Team');void refresh(undefined,decoded);flash('Team workspace opened.');}catch{flash('That team access link is not valid or its event was deleted.');} };
  const sorted = useMemo(()=>activeTeams.map(t=>{const done=(t.results||[]).filter(r=>r.confirmed);return {...t,kills:done.reduce((n,r)=>n+r.kills,0),booyahs:done.filter(r=>r.placement===1).length,total:done.reduce((n,r)=>n+score(r),0),match:done[0]};}).sort((a,b)=>b.total-a.total||b.booyahs-a.booyahs||b.kills-a.kills),[activeTeams]);
  const matchSorted = useMemo(()=>activeTeams.map(t=>{const r=t.results?.[selectedMatch]||{placement:0,kills:0,confirmed:false};return {...t,result:r,matchPoints:r.confirmed?score(r):0};}).sort((a,b)=>(a.result.placement||999)-(b.result.placement||999)||b.matchPoints-a.matchPoints),[activeTeams,selectedMatch]);
  const filtered = events.filter(e=>(e.name+' '+e.game+' '+e.type).toLowerCase().includes(search.toLowerCase()));
  const linkedSquads = useMemo(()=>{
    // The public Team directory lists every squad actually created through event registration.
    // Private access links are still required for room credentials and team-only actions.
    const ownedTeamIds=new Set(Object.keys(teamTokens));
    const linked=teams.filter(team=>ownedTeamIds.has(team.id) && !!team.name?.trim() && Array.isArray(team.roster) && team.roster.length>0);
    const unique=new Map<string,Team>();
    linked.forEach(team=>{const key=team.name.trim().toLowerCase();if(!unique.has(key))unique.set(key,team);});
    return Array.from(unique.values()).map(team=>{
      const key=team.name.trim().toLowerCase();
      const eventTeams=teams.filter(item=>item.name.trim().toLowerCase()===key);
      const eventIds=new Set(eventTeams.map(item=>item.eventId));
      const activeEvents=events.filter(event=>eventIds.has(event.id)&&event.status!=='Completed').map(event=>({event,team:eventTeams.find(item=>item.eventId===event.id)!}));
      const completedEvents=events.filter(event=>eventIds.has(event.id)&&event.status==='Completed').map(event=>({event,team:eventTeams.find(item=>item.eventId===event.id)!}));
      const archived=teamHistory.filter(item=>item.teamName.trim().toLowerCase()===key);
      const kills=eventTeams.reduce((sum,item)=>sum+item.results.filter(result=>result.confirmed).reduce((n,result)=>n+result.kills,0),0)+archived.reduce((sum,item)=>sum+item.kills,0);
      const pointsTotal=eventTeams.reduce((sum,item)=>sum+item.results.filter(result=>result.confirmed).reduce((n,result)=>n+score(result),0),0)+archived.reduce((sum,item)=>sum+item.totalPoints,0);
      const booyahs=eventTeams.reduce((sum,item)=>sum+item.results.filter(result=>result.confirmed&&result.placement===1).length,0)+archived.reduce((sum,item)=>sum+item.booyahs,0);
      return {team,activeEvents,completedEvents,archived,kills,pointsTotal,booyahs};
    });
  },[teamTokens,teams,events,teamHistory]);
  useEffect(() => {
    if (!linkedSquads.length) { setSelectedSquadId(''); return; }
    if (!linkedSquads.some(squad=>squad.team.id===selectedSquadId)) setSelectedSquadId(linkedSquads[0].team.id);
  },[linkedSquads,selectedSquadId]);
  const visibleSquads = selectedSquadId ? linkedSquads.filter(squad=>squad.team.id===selectedSquadId) : linkedSquads.slice(0,1);
  const leaveTeamDashboard = () => {
    history.pushState({clutchTab:'Discover'},'',location.pathname+location.search);
    setRoom(null); setTab('Discover');
    document.getElementById('events')?.scrollIntoView({behavior:'smooth',block:'start'});
  };
  const startTeamCreation = () => {
    const openEvents=events.filter(event=>event.status==='Registration open');
    const target=openEvents.find(event=>event.id===teamCreateEventId)||openEvents.find(event=>event.id===activeId)||openEvents[0];
    if(!target){setTab('Discover');flash('No event is accepting team registrations right now. Explore events and try again when registration opens.');return;}
    setTeamCreateEventId(target.id);setActiveId(target.id);setTeamName('');setRoster('');setShowJoin(true);
  };
  const isOrganizer = !!active && !!organizerTokens[active.id];
  const navigateTab = (next:string) => { history.pushState({clutchTab:next},'',location.pathname+location.search); setTab(next); };
  useEffect(() => {
    const onPopState = (event:PopStateEvent) => {
      const hash = new URLSearchParams(location.hash.replace(/^#/,''));
      if (hash.has('manage')) setTab('Manage');
      else if (hash.has('team')) setTab('Team');
      else if (hash.has('watch')) setTab('Standings');
      else setTab(event.state?.clutchTab || 'Discover');
    };
    window.addEventListener('popstate',onPopState);
    return () => window.removeEventListener('popstate',onPopState);
  },[]);
  const copyViewerLink = () => { if(!active) return; copy(location.origin+location.pathname+'#watch='+active.id); };
  const copy = async (value:string) => { try { await navigator.clipboard.writeText(value); flash('Copied to clipboard.'); } catch { flash('Copy is unavailable in this browser.'); } };
  const importOrganizerLink = () => { const raw=prompt('Paste your private organizer link:'); if(!raw)return;try{const u=new URL(raw);const id=u.hash.match(/manage=([^&]+)/)?.[1];const key=u.hash.match(/key=([^&]+)/)?.[1];if(!id||!key)throw new Error();const decoded=decodeURIComponent(id);location.hash=`manage=${decoded}&key=${key}`;setOrganizerTokens(v=>({...v,[decoded]:key}));setActiveId(decoded);setTab('Manage');void (async()=>{await refresh(decoded);try{const savedRoom=await api.post('/api/events/'+encodeURIComponent(decoded)+'/organizer-room',{organizerToken:key});setRoomId(savedRoom.data.roomId||'');setRoomPassword(savedRoom.data.roomPassword||'');}catch{setRoomId('');setRoomPassword('');}})();flash('Manager workspace opened.');}catch{flash('That organizer link is not valid or the event was deleted.');} };

  return <div className={'shell role-'+roleMode+' tab-'+tab.toLowerCase().replace(' ','-')}>
    <header className="top"><a className="brand" href="#"><span className="brand-mark">C</span><span>CLUTCH<strong>ARENA</strong><small>INDIA ESPORTS HUB</small></span></a><nav><button className={tab==='Discover'?'on':''} onClick={()=>navigateTab('Discover')}>Discover</button><button className={tab==='Standings'?'on':''} onClick={()=>navigateTab('Standings')}>Standings</button>{Object.keys(organizerTokens).length>0&&<button className={tab==='Manage'?'on':''} onClick={()=>navigateTab('Manage')}>Manager</button>}{Object.keys(organizerTokens).length>0&&<button className={tab==='My events'?'on':''} onClick={()=>{navigateTab('My events');void refresh('');}}>My events</button>}<button className={tab==='Team'?'on':''} onClick={()=>{navigateTab('Team');void refresh(activeId);}}>My team</button></nav><div className="top-actions"><button className="outline" onClick={installApp}><Download size={14}/> Install app</button><button className="outline" onClick={importOrganizerLink}>Organizer access</button><button className="outline" onClick={importTeamLink}>Team access</button><button className="primary" onClick={()=>setShowCreate(true)}><Plus size={16}/> Host event</button></div></header>
    <main>
      <section className="hero"><div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> THE COMMUNITY SCRIM & TOURNAMENT PLATFORM</div><h1>Build your squad.<br/><em>Own the arena.</em></h1><p>Discover Free Fire India and Free Fire MAX scrims, register your squad, host tournaments and follow every point on one competitive platform.</p><div className="hero-buttons"><button className="primary big" onClick={()=>{setTab('Discover');document.getElementById('events')?.scrollIntoView({behavior:'smooth'});}}>Find an event <ArrowRight size={17}/></button><button className="outline big" onClick={()=>setShowCreate(true)}>Create your tournament</button></div><div className="trust"><span><ShieldCheck size={15}/> Open community platform</span><span><Users size={15}/> Unlimited team slots</span><span><Activity size={15}/> Shared online standings</span></div></div><div className="hero-art"><div className="ring ring-one"/><div className="ring ring-two"/><div className="hero-cup"><Trophy size={74}/></div><div className="float-card card-a"><Swords size={17}/><span>SCRIMS<strong>OPEN NOW</strong></span></div><div className="float-card card-b"><Award size={17}/><span>CHAMPIONS<strong>START HERE</strong></span></div></div></section>
      <section className="stats"><div><small>LIVE EVENTS</small><b>{events.filter(e=>e.status!=='Completed').length}</b></div><div><small>REGISTERED SQUADS</small><b>{teams.length}</b></div><div><small>GAMES SUPPORTED</small><b>02</b></div><div><small>COMMUNITY ACCESS</small><b>OPEN</b></div></section>
      <section className="app-about" id="about"><div className="about-copy"><div className="eyebrow">THE CLUTCHARENA APP</div><h2>Your esports hub.<br/><em>Ready on your phone.</em></h2><p>ClutchArena brings community scrims and tournaments into one place. Discover events, register a four-player squad, follow group schedules, check room details and track live standings.</p><button className="primary big" onClick={installApp}>Install ClutchArena <ArrowRight size={16}/></button><small>Install from your browser. No app-store account required for the web app.</small></div><div className="feature-grid"><div><Trophy/><b>Tournaments</b><span>Groups, team limits and automatic match schedules.</span></div><div><CalendarDays/><b>Match planner</b><span>Published times with delay and reschedule controls.</span></div><div><Users/><b>Team registration</b><span>Squad slots and group allocation in one place.</span></div><div><BarChart3/><b>Points tables</b><span>Match-wise and overall standings.</span></div><div><ShieldCheck/><b>Private room info</b><span>Room credentials restricted to registered teams.</span></div><div><Gamepad2/><b>FFI & FFM</b><span>Community events for Free Fire India and MAX.</span></div></div></section>
      <section id="events" className="content">
        <div className="section-head"><div><div className="eyebrow">PLAY • COMPETE • HOST</div><h2>{tab==='Standings'?'Community standings':tab==='Manage'?'Event control room':tab==='My events'?'My hosted events':'Find your next match'}</h2><p>{tab==='My events'?'View and manage every tournament and scrim linked to your organizer access.':'Browse open competitions or create an event for your own community.'}</p></div><div className="head-actions"><button className="outline" onClick={()=>void refresh(activeId)}><RefreshCw size={15}/> Refresh</button><button className="primary" onClick={()=>setShowCreate(true)}><Plus size={15}/> Host event</button></div></div>
        {notice&&<div className="notice" role="status">{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}
        <>{(tab==='Manage'||tab==='Standings')&&<section className="panel workspace-event-picker"><div className="panel-head"><h3>{tab==='Manage'?<><ShieldCheck size={17}/> Your hosted events</>:<><BarChart3 size={17}/> Choose an event to view standings</>}</h3><span>{(tab==='Manage'?events.filter(e=>!!organizerTokens[e.id]):events.filter(e=>e.status!=='Completed')).length} EVENTS</span></div>{(tab==='Manage'?events.filter(e=>!!organizerTokens[e.id]):events.filter(e=>e.status!=='Completed')).length===0?<div className="empty"><Trophy size={28}/><b>{tab==='Manage'?'No hosted events on this device':'No active events available'}</b><p>{tab==='Manage'?'Host an event or import your private organizer link to manage it.':'When an event is published, it will appear here.'}</p>{tab==='Manage'&&<button className="primary" onClick={()=>setShowCreate(true)}>Host an event</button>}</div>:<div className="event-list">{(tab==='Manage'?events.filter(e=>!!organizerTokens[e.id]):events.filter(e=>e.status!=='Completed')).map(e=><button className={'event-row '+(active?.id===e.id?'selected':'')} key={e.id} onClick={()=>{setActiveId(e.id);if(tab==='Manage'){setTab('Manage');}void refresh(e.id);}}><span className="game-icon">{e.type==='Tournament'?'🏆':'⚔️'}</span><span className="event-info"><b>{e.name}</b><small>{e.type} · {e.game} · {teams.filter(t=>t.eventId===e.id).length} teams</small><small>{e.status}</small></span><ChevronRight size={15}/></button>)}</div>}</section>}{tab==='My events'&&<section className="panel my-hosted-events"><div className="panel-head"><h3><Trophy size={17}/> Events you manage</h3><span>{events.filter(e=>!!organizerTokens[e.id]).length} YOUR EVENTS</span></div>{events.filter(e=>!!organizerTokens[e.id]).length===0?<div className="empty"><CalendarDays size={28}/><b>No hosted events found</b><p>Import your organizer access link or host a new tournament or scrim.</p><button className="primary" onClick={()=>setShowCreate(true)}>Host an event</button></div>:<div className="event-list">{events.filter(e=>!!organizerTokens[e.id]).map(e=><article className="event-row hosted-event-row" key={e.id}><span className="game-icon">{e.type==='Tournament'?'🏆':'⚔️'}</span><span className="event-info"><b>{e.name}</b><small>{e.type} · {e.game} · {e.mode}</small><small>{teams.filter(t=>t.eventId===e.id).length} teams registered · {e.status}</small></span><button className="outline tiny" onClick={()=>{setActiveId(e.id);setTab('Manage');void refresh(e.id);}}>Manage</button><button className="outline tiny danger-action" onClick={()=>void deleteHostedEvent(e)}>Delete</button></article>)}</div>}</section>}</><div className={'layout '+(tab==='Team'?'team-hidden':'')+(tab==='My events'?' my-events-hidden':'')+(tab==='Standings'?' standings-mode':'')+(tab==='Manage'?' manage-mode':'')}>
          <section className="panel events-panel"><div className="panel-head"><h3><Gamepad2 size={17}/> Open events</h3><span>{filtered.length} LISTED</span></div><input className="search" placeholder="Search events or game..." value={search} onChange={e=>setSearch(e.target.value)}/>{loading?<div className="empty">Loading community events…</div>:filtered.length===0?<div className="empty"><Trophy size={28}/><b>No events yet</b><p>Be the first organizer. Create a scrim or tournament and invite teams.</p><button className="primary" onClick={()=>setShowCreate(true)}>Create first event</button></div>:<div className="event-list">{filtered.map(e=><button className={'event-row '+(active?.id===e.id?'selected':'')} key={e.id} onClick={()=>{setActiveId(e.id);void refresh(e.id);}}><span className="game-icon">{e.game==='Free Fire India'?'FFI':'FFM'}</span><span className="event-info"><b>{e.name}</b><small>{e.game} · {e.mode} · {e.matches} matches</small><small>{e.type} · {e.stage} · Free entry</small></span><span className={'status '+(e.status==='Completed'?'done':'')}>{e.status}</span><ChevronRight size={15}/></button>)}</div>}</section>
          <section className="panel detail-panel">{active&&(tab!=='Manage'||isOrganizer)?<><div className="panel-head"><h3><CalendarDays size={17}/> Event details</h3><span>{active.id}</span></div><div className="event-title"><span className="eyebrow">{active.type.toUpperCase()} / {active.game.toUpperCase()}</span><h2>{active.name}</h2><p>{active.mode} · {active.matches} matches · {active.stage} · {active.type==='Tournament'?`${active.groups||1} groups × 12 teams (${active.teamLimit||((active.groups||1)*12)} slots)`:(active.teamLimit?`${active.teamLimit} team limit`:'Open team registration')} · Free entry · {active.registrationOpensAt?`Opens ${new Date(active.registrationOpensAt).toLocaleString()}`:''} {active.registrationClosesAt?`Closes ${new Date(active.registrationClosesAt).toLocaleString()}`:''}</p></div><div className="event-actions"><button className="primary" onClick={()=>setShowJoin(true)} disabled={active.status!=='Registration open'}><Users size={15}/> Register your team</button><button className="outline" onClick={()=>setTab('Standings')}><BarChart3 size={15}/> View standings</button><button className="outline" onClick={copyViewerLink}>Copy public match-view link</button>{isOrganizer&&<button className="outline danger-action" onClick={()=>void deleteEvent()}>Delete {active.type}</button>}</div><div className="detail-stats"><div><small>REGISTERED / CAP</small><b>{activeTeams.length} / {active.teamLimit||'∞'}</b></div><div><small>MATCHES</small><b>{active.matches}</b></div><div><small>STATUS</small><b>{active.status==='Registration open'?'OPEN':active.status.toUpperCase()}</b></div></div>{isOrganizer&&<div className="organizer-box"><div><b><ShieldCheck size={16}/> Organizer controls unlocked</b><small>Your private organizer access is active on this device.</small></div><button className="outline small" onClick={()=>copy(location.origin+location.pathname+'#manage='+active.id+'&key='+organizerTokens[active.id])}><Copy size={13}/> Copy link</button></div>}{tab==='Manage'&&isOrganizer&&<div className="manage-box"><h3>Manage this event</h3><section className="manager-section room-manager"><h4><ShieldCheck size={16}/> Custom Room ID & Password</h4><p className="muted">Enter the custom room credentials after creating the room in Free Fire. Save them here so registered teams can access them at the scheduled release time.</p><label>Room ID<input value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="Enter custom room ID" autoComplete="off"/></label><label>Room Password<input value={roomPassword} onChange={e=>setRoomPassword(e.target.value)} placeholder="Enter custom room password" autoComplete="off"/></label><label>Release credentials (minutes before match; 0 = at match start)<input type="number" min="0" max="120" value={roomReleaseMinutes} onChange={e=>setRoomReleaseMinutes(Math.max(0,Math.min(120,Number(e.target.value))))}/></label><button className="primary" onClick={()=>void manage({roomId,roomPassword,roomReleaseMinutes})}>Save & publish room details</button><small className="muted">{active.roomPublished?'Room details are saved and will unlock for registered teams during the release window.':'Room details are not published yet.'}</small></section><section className="manager-section"><h4>Team slot allotment</h4><p className="muted">Assign or change each registered squad’s lobby slot. The assigned slot is shown in the team dashboard and standings.</p>{activeTeams.length===0?<div className="schedule-empty">Registered teams will appear here.</div>:activeTeams.map(team=><div className="payment-row slot-row" key={team.id}><span><b>{team.name}</b><small>{team.group||'All teams'} · Current Slot {team.slot}</small></span><label>Slot number<input aria-label={'Slot for '+team.name} type="number" min="1" max={active.type==='Tournament'?(active.groups||1)*12:(active.teamLimit||10000)} value={slotDraft[team.id]??team.slot} onChange={e=>setSlotDraft(current=>({...current,[team.id]:Number(e.target.value)}))}/></label><button className="outline tiny" onClick={()=>void updateTeamSlot(team)}>Save slot</button></div>)}</section><section className="manager-section"><h4>Registration control</h4>{active.type==='Tournament'?<label>Number of groups (12 teams each)<input type="number" min="1" max="26" value={manageGroups} onChange={e=>setManageGroups(Math.max(1,Math.min(26,Number(e.target.value))))}/><small className="muted">Registration capacity: {manageGroups*12} teams</small></label>:<label>Maximum teams (0 = unlimited)<input type="number" min="0" max="10000" value={manageTeamLimit} onChange={e=>setManageTeamLimit(Math.max(0,Math.min(10000,Number(e.target.value))))}/></label>}<label>Registration opens<input type="datetime-local" value={registrationOpensAt} onChange={e=>setRegistrationOpensAt(e.target.value)}/></label><label>Registration closes<input type="datetime-local" value={registrationClosesAt} onChange={e=>setRegistrationClosesAt(e.target.value)}/></label><small className="muted">Times use this device's local timezone. Leave a date blank for no scheduled time boundary.</small><button className="primary" onClick={()=>void saveRegistrationSettings()}>Save registration settings</button><div className="manager-actions"><button className="outline" onClick={()=>void manage({status:'Registration open'})}>Open registration</button><button className="outline" onClick={()=>void manage({status:'Registration closed'})}>Close registration now</button></div></section><section className="manager-section"><h4>Automatic group match schedule</h4><p className="muted">After registration closes, ClutchArena creates every match slot for every active group. Groups play each round in parallel. The manager can change a delayed match without removing its teams.</p><label>First round starts<input type="datetime-local" value={autoScheduleStartAt} onChange={e=>setAutoScheduleStartAt(e.target.value)}/></label><label>Minutes between rounds<input type="number" min="15" max="240" value={matchIntervalMinutes} onChange={e=>setMatchIntervalMinutes(Math.max(15,Math.min(240,Number(e.target.value))))}/></label><button className="primary" onClick={()=>void saveAutoScheduleSettings()}>Save automatic schedule settings</button>{(active.matchSchedule||[]).length===0?<div className="schedule-empty">The group timetable will be generated automatically when registration closes and at least one team is registered.</div>:<><div className="published-schedule manager-schedule">{[...(active.matchSchedule||[])].sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime()).map(slot=><div key={slot.id}><b>{slot.label}</b><small>{slot.group} · Match {slot.match} · {new Date(slot.startsAt).toLocaleString()}</small><span className={'schedule-status '+slot.status.toLowerCase()}>{slot.status}</span></div>)}</div><label>Select match to update<select value={selectedScheduleId || active.matchSchedule?.[0]?.id || ''} onChange={e=>setSelectedScheduleId(e.target.value)}>{(active.matchSchedule||[]).map(slot=><option key={slot.id} value={slot.id}>{slot.group} · Match {slot.match} · {slot.status}</option>)}</select></label><label>New match date and time<input type="datetime-local" value={rescheduleAt} onChange={e=>setRescheduleAt(e.target.value)}/></label><div className="manager-actions"><button className="outline" onClick={()=>void updateScheduleStatus('Delayed')}>Mark delayed</button><button className="outline" onClick={()=>void updateScheduleStatus('Cancelled')}>Mark cancelled</button><button className="outline" onClick={()=>void updateScheduleStatus('Completed')}>Mark completed</button></div><button className="primary" onClick={()=>void rescheduleSelectedMatch()}>Reschedule match</button><small className="muted">Delayed or cancelled slots can be rescheduled. Their teams stay registered in the same group and remain eligible.</small></>}</section><div className="manage-results"><h4>Confirm match results</h4><label>Match<select value={selectedMatch} onChange={e=>setSelectedMatch(Number(e.target.value))}>{Array.from({length:active.matches},(_,i)=><option value={i} key={i}>Match {i+1}</option>)}</select></label>{activeTeams.map(t=><div className="result-line" key={t.id}><b>{t.name}</b><input aria-label="Placement" type="number" min="1" max={activeTeams.length} placeholder="Place" value={resultDraft[t.id+'-'+selectedMatch]?.placement??''} onChange={e=>setResultDraft(v=>({...v,[t.id+'-'+selectedMatch]:{placement:Number(e.target.value),kills:v[t.id+'-'+selectedMatch]?.kills||0}}))}/><input aria-label="Kills" type="number" min="0" placeholder="Kills" value={resultDraft[t.id+'-'+selectedMatch]?.kills??''} onChange={e=>setResultDraft(v=>({...v,[t.id+'-'+selectedMatch]:{placement:v[t.id+'-'+selectedMatch]?.placement||1,kills:Number(e.target.value)}}))}/><button className="primary small" onClick={()=>void confirmResult(t)}>Confirm</button></div>)}</div><button className="outline" onClick={()=>void manage({status:'In progress'})}>Start event</button><button className="primary" disabled={active.status==='Completed'} onClick={()=>void markEventCompleted()}>Complete event & download standings photo</button><section className="manager-section cleanup-notice"><h4>Event cleanup</h4><p className="muted">Completed events are automatically deleted after 24 hours. Scrims are also removed within 24 hours of completion. Download the overall standings PNG before the cleanup time.</p><button className="outline danger-action" onClick={()=>void deleteEvent()}>Delete this event now</button></section></div>}</>:<div className="empty"><Trophy size={28}/><b>Select an event</b><p>Choose an event or create a new competition.</p><button className="primary" onClick={()=>setShowCreate(true)}>Host an event</button></div>}</section>
        </div>
        {tab==='Team'&&<section className="team-dashboard">
          <div className="team-portal-head"><div><div className="eyebrow">SQUAD COMMAND CENTRE</div><h2>My Team</h2><p>Create your squad, manage player details and view every event you have registered for.</p></div><div className="team-dashboard-actions"><button className="outline" onClick={()=>void refresh(activeId)}><RefreshCw size={14}/> Refresh</button><button className="outline" onClick={leaveTeamDashboard}>← Back to events</button></div></div>
          <section className="dream-team-banner">
            <div className="dream-team-copy"><span className="dream-team-kicker"><Swords size={14}/> YOUR SQUAD. YOUR LEGACY.</span><h2>CREATE THE <em>DREAM TEAM</em></h2><p>Build your four-player squad and register it for the competitions you want to play.</p><label className="team-event-picker">Choose an event to join<select value={teamCreateEventId} onChange={e=>setTeamCreateEventId(e.target.value)}><option value="">Choose an open event…</option>{events.filter(event=>event.status==='Registration open').map(event=><option key={event.id} value={event.id}>{event.name} · {event.game} · {event.type}</option>)}</select></label><button className="primary dream-team-button" onClick={startTeamCreation}><Users size={16}/> Create your team <ArrowRight size={16}/></button><small>Your team will be registered for the selected event.</small></div>
            <div className="dream-team-art" aria-hidden="true"><div className="dream-orbit orbit-a"/><div className="dream-orbit orbit-b"/><div className="dream-emblem"><Trophy size={54}/></div><span className="dream-art-label">BUILT TO COMPETE</span></div>
          </section>
          {linkedSquads.length>1&&<div className="panel squad-switcher"><label htmlFor="squad-switch">Select your team</label><select id="squad-switch" value={selectedSquadId} onChange={e=>setSelectedSquadId(e.target.value)}>{linkedSquads.map(squad=><option key={squad.team.id} value={squad.team.id}>{squad.team.name}</option>)}</select></div>}
          {loading?<div className="panel team-empty">Loading your team details…</div>:linkedSquads.length===0?<div className="panel team-empty"><Users size={28}/><h3>No team created yet</h3><p>Create your team and register it for an event. Your team and player names will appear here.</p><button className="primary" onClick={startTeamCreation}>Create your team</button></div>:visibleSquads.map(squad=>{
            const registrations=[...squad.activeEvents.map(item=>({...item,completed:false})),...squad.completedEvents.map(item=>({...item,completed:true}))];
            return <article className="panel team-dashboard-card" key={squad.team.id}>
              <div className="team-dashboard-title"><div><div className="eyebrow">YOUR TEAM</div><h3>{squad.team.name}</h3><p>Captain: {squad.team.captain}</p></div><span className="status">TEAM CREATED</span></div>
              <div className="team-roster team-roster-simple">{squad.team.roster.map((player,i)=><div className="team-player-row" key={i}><span className="player-number">{i+1}</span><div><b>{player.name}</b><small>{i===0?'CAPTAIN':'PLAYER '+(i+1)}</small></div></div>)}</div>
              <div className="team-history-section registered-events-section"><div className="team-schedule-head"><h4><CalendarDays size={16}/> Registered Events</h4><span>{registrations.length} REGISTERED</span></div>
                {registrations.length===0?<div className="schedule-empty">This team has not registered for an event yet.</div>:registrations.map(({event,team,completed})=><div className="registered-event-card" key={event.id}>
                  <div className="registered-event-info"><div><b>{event.name}</b><small>{event.game} · {event.type} · {event.mode}</small><small>{team.group||'Open group'} · Slot {team.slot} · {event.status}</small>{event.matchSchedule?.[0]&&<small>First match: {new Date(event.matchSchedule[0].startsAt).toLocaleString()}</small>}</div><span className={'status '+(completed?'done':'')}>{completed?'COMPLETED':'REGISTERED'}</span></div>
                  {!completed&&<div className="registered-room-access">
                    <div><b><ShieldCheck size={15}/> Custom Room ID & Password</b><small>{!event.roomPublished?'Waiting for the organiser to publish the room credentials.':event.matchSchedule?.length?('Room credentials unlock '+(event.roomReleaseMinutes??0)+' minutes before your scheduled match. First match: '+new Date(event.matchSchedule[0].startsAt).toLocaleString()+'.'):'Room credentials are published. Your match schedule is being prepared.'}</small></div>
                    <button className="primary tiny" disabled={!event.roomPublished||!teamTokens[team.id]} onClick={()=>{setActiveId(event.id);setTeamPortalEvent(event.id);void api.post('/api/events/'+encodeURIComponent(event.id)+'/room',{teamId:team.id,accessToken:teamTokens[team.id]}).then(r=>{setRoom(r.data.room);flash('Your event room details are ready.');}).catch((e:any)=>flash(e?.response?.data?.error||'Room details are not available yet.'));}}>{!teamTokens[team.id]?'Private access needed':event.roomPublished?'Check room access':'Waiting for room details'}</button>
                  </div>}
                </div>)}
              </div>
            </article>;
          })}
        </section>}
        {false&&tab==='Team'&&<section className="team-portal"><div className="team-portal-head"><div><div className="eyebrow">PLAYER AREA</div><h2>My team dashboard</h2><p>Your registered events, match schedule and private room access in one place.</p></div><button className="outline" onClick={importTeamLink}>Import team link</button></div>{Object.keys(teamTokens).length===0?<div className="panel team-empty"><Trophy/><b>No team linked on this device</b><p>Register a squad or import the private team access link saved after registration.</p><button className="primary" onClick={()=>setTab('Discover')}>Find an event</button></div>:Object.entries(teamTokens).map(([teamId,accessToken])=>{const team=teams.find(t=>t.id===teamId);const event=events.find(e=>e.id===team?.eventId);const slots=(event?.matchSchedule||[]).filter(slot=>slot.group===(team?.group||'All teams')).sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime());return <article className="panel team-card" key={teamId}><div className="team-card-top"><span className="game-icon">{event?.game==='Free Fire India'?'FFI':'FFM'}</span><div><div className="eyebrow">{event?.type||'REGISTERED EVENT'} · {event?.game||''}</div><h3>{team?.name||'Team access linked'}</h3><p>{event?.name||'Open this event to refresh your team details'} {team?.group?'· '+team.group:''} {team?'· Lobby Slot '+team.slot:''}</p></div><span className="status">{team?'REGISTERED':'LINKED'}</span></div>{team&&<><div className="team-performance"><div><small>MATCHES PLAYED</small><b>{team.results.filter(result=>result.confirmed).length}/{event?.matches||0}</b></div><div><small>ELIMINATIONS</small><b>{team.results.filter(result=>result.confirmed).reduce((sum,result)=>sum+result.kills,0)}</b></div><div><small>TOTAL POINTS</small><b>{team.results.filter(result=>result.confirmed).reduce((sum,result)=>sum+score(result),0)}</b></div><div><small>BOOYAHS</small><b>{team.results.filter(result=>result.confirmed&&result.placement===1).length}</b></div></div><div className="team-roster">{team.roster.map((p,i)=><span key={i}>{p.name}<small>{i===0?'CAPTAIN':'PLAYER '+(i+1)}</small></span>)}</div><div className="team-schedule-head"><h4><CalendarDays size={16}/> Your match schedule</h4><span>{slots.length} MATCHES</span></div>{slots.length?slots.map(slot=><div className="team-match" key={slot.id}><div><b>Match {slot.match} · {slot.group}</b><small>{new Date(slot.startsAt).toLocaleString()}</small></div><span className={'schedule-status '+slot.status.toLowerCase()}>{slot.status}</span></div>):<div className="schedule-empty">Your manager has not published the match timetable yet. It will appear here after registration closes and the schedule is generated.</div>}<div className="team-room-area"><div><b><ShieldCheck size={16}/> Match room access</b><small>{event?.roomPublished?`Room ID and password unlock ${event.roomReleaseMinutes??10} minutes before the next match.`:'The manager has not published room details yet. Your match schedule remains available above.'}</small></div><button className="primary" disabled={!event?.roomPublished} onClick={()=>{setActiveId(team.eventId);setTeamPortalEvent(team.eventId);void api.post('/api/events/'+encodeURIComponent(team.eventId)+'/room',{teamId,accessToken}).then(r=>setRoom(r.data.room)).catch((e:any)=>flash(e?.response?.data?.error||'Room details are not available yet.'));}}>Open room details</button></div></>}</article>})}</section>}{tab!=='Standings'&&tab!=='Manage'&&active&&(active.matchSchedule||[]).length>0&&<section className="panel schedule-public"><div className="panel-head"><h3><CalendarDays size={17}/> Group match schedule</h3><span>{active.matchSchedule!.length} MATCH SLOTS</span></div><div className="published-schedule">{[...active.matchSchedule!].sort((a,b)=>new Date(a.startsAt).getTime()-new Date(b.startsAt).getTime()).map(slot=><div key={slot.id}><b>{slot.label}</b><small>{slot.group} · {new Date(slot.startsAt).toLocaleString()}</small><span className={'schedule-status '+slot.status.toLowerCase()}>{slot.status}</span>{slot.status==='Delayed'||slot.status==='Cancelled'?<small>Teams remain registered. Check the updated time after the manager reschedules.</small>:null}</div>)}</div></section>}
        {tab==='Standings'&&active&&<section className="panel standings-panel"><div className="panel-head"><h3><BarChart3 size={17}/> Match-wise points table</h3><span>{activeTeams.length} TEAMS</span></div><label className="match-picker">Select match <select value={selectedMatch} onChange={e=>setSelectedMatch(Number(e.target.value))}>{Array.from({length:active.matches},(_,i)=><option value={i} key={i}>Match {i+1}</option>)}</select></label><div className="table-scroll"><table><thead><tr><th>RANK</th><th>TEAM / SQUAD</th><th>PLACEMENT</th><th>KILLS</th><th>MATCH POINTS</th></tr></thead><tbody>{matchSorted.map((t,i)=><tr key={t.id}><td><span className={'rank r'+i}>{i+1}</span></td><td><b>{t.name}</b><small>Slot {t.slot}{t.group?` · ${t.group}`:''} · {t.captain}</small></td><td>{t.result.confirmed?t.result.placement:'Pending'}</td><td>{t.result.confirmed?t.result.kills:'—'}</td><td className="points">{t.result.confirmed?t.matchPoints:'—'}</td></tr>)}</tbody></table>{matchSorted.length===0&&<div className="empty">No teams registered yet.</div>}</div><div className="panel-head overall-head"><h3><Trophy size={17}/> Overall points table</h3><button className="outline tiny" onClick={()=>void exportOverallStandings()}><Download size={13}/> Download standings photo</button></div><div className="table-scroll"><table><thead><tr><th>RANK</th><th>TEAM / SQUAD</th><th>BOOYAHS</th><th>KILLS</th><th>TOTAL POINTS</th><th>TEAM ACCESS</th></tr></thead><tbody>{sorted.map((t,i)=><tr key={t.id}><td><span className={'rank r'+i}>{i+1}</span></td><td><b>{t.name}</b><small>Slot {t.slot}{t.group?` · ${t.group}`:''} · {t.captain}</small></td><td>{t.booyahs}</td><td>{t.kills}</td><td className="points">{t.total}</td><td>{teamTokens[t.id]?<button className="outline tiny" onClick={()=>void openRoom(t)}>Room info</button>:<span className="muted">Registered</span>}</td></tr>)}</tbody></table></div><p className="fine">Placement points preset: 12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0; one point per elimination. This is a configurable starting preset, not a claim of universal official FFI/FFM scoring. Organizers should verify the current rules for their event.</p></section>}
        {room&&<div className="room-card"><b><ShieldCheck size={16}/> Your match room details</b>{room.schedule.map(slot=><span key={slot.id}>Match {slot.match} · {new Date(slot.startsAt).toLocaleString()}</span>)}<span>Room ID: {room.roomId}</span><span>Password: {room.roomPassword}</span><button className="outline tiny" onClick={()=>setRoom(null)}>Close</button></div>}
      </section>
      <section className="promo"><div><div className="eyebrow">YOUR COMMUNITY. YOUR COMPETITION.</div><h2>Ready to host the next big scrim?</h2><p>Create an event page, open team registrations and publish the results for your whole community.</p></div><button className="primary big" onClick={()=>setShowCreate(true)}>Start hosting <ArrowRight size={17}/></button></section>
      
    </main>
    <footer><span>CLUTCHARENA</span><span>Independent community platform · Not affiliated with Garena</span><span>Play fair. Compete hard.</span></footer>
    {showCreate&&<div className="modal-bg" onClick={()=>setShowCreate(false)}><div className="modal" onClick={e=>e.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">CREATE A COMPETITION</div><h2>Host your event</h2></div><button className="close" onClick={()=>setShowCreate(false)}><X/></button></div><label>Event name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Friday Night Pro Scrims"/></label><label>Game<select value={game} onChange={e=>setGame(e.target.value as Game)}><option>Free Fire India</option><option>Free Fire MAX</option></select></label><label>Event type<div className="choice"><button className={type==='Scrim'?'chosen':''} onClick={()=>setType('Scrim')}><Swords/> Scrim</button><button className={type==='Tournament'?'chosen':''} onClick={()=>setType('Tournament')}><Trophy/> Tournament</button></div></label><div className="modal-note"><ShieldCheck size={16}/> All ClutchArena tournaments and scrims are free to join. No entry fees or cash-prize tracking.</div><label>Mode<select value={mode} onChange={e=>setMode(e.target.value)}><option>Battle Royale</option><option>Clash Squad</option></select></label><label>Number of matches<input type="number" min="1" max="30" value={matches} onChange={e=>setMatches(Math.max(1,Math.min(30,Number(e.target.value))))}/></label>{type==='Tournament'?<label>Number of groups (12 teams per group)<input type="number" min="1" max="26" value={groups} onChange={e=>setGroups(Math.max(1,Math.min(26,Number(e.target.value))))}/><small className="muted">Maximum registrations: {groups*12} teams. Group assignment is automatic.</small></label>:<label>Team registration limit<input type="number" min="0" max="10000" value={teamLimit} onChange={e=>setTeamLimit(Math.max(0,Math.min(10000,Number(e.target.value))))}/><small className="muted">Enter 0 for no team limit.</small></label>}<div className="modal-note"><ShieldCheck size={16}/> A private organizer link will be generated. Save it securely; no email account or manager PIN is needed.</div><button className="primary full" onClick={()=>void createEvent()}>Publish event <ArrowRight size={16}/></button></div></div>}
    {showJoin&&<div className="modal-bg" onClick={()=>setShowJoin(false)}><div className="modal" onClick={e=>e.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">TEAM REGISTRATION</div><h2>Register your squad</h2></div><button className="close" onClick={()=>setShowJoin(false)}><X/></button></div><p className="muted">Joining: {active?.name}</p><label>Team name<input value={teamName} onChange={e=>setTeamName(e.target.value)} placeholder="Your squad name"/></label><label>Four players (one per line)<textarea rows={6} value={roster} onChange={e=>setRoster(e.target.value)} placeholder={'Captain:UID123\nPlayer 2:UID456\nPlayer 3:UID789\nPlayer 4:UID012'}/></label><div className="modal-note"><ShieldCheck size={16}/> {active?.type==='Tournament'?`Group capacity: ${active?.groups||1} groups × 12 = ${active?.teamLimit||((active?.groups||1)*12)} teams.`:'Registration is subject to the event team limit.'} Your team access is saved on this device for private room details.</div><button className="primary full" onClick={()=>void registerTeam()}>Submit team registration <ArrowRight size={16}/></button></div></div>}
  </div>;
}
