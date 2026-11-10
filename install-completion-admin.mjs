import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const p='src/pages/AssignedRoutes.tsx';if(!existsSync(p))throw new Error('Run from the ADMIN FRONTEND root.');let s=readFileSync(p,'utf8');
if(!s.includes('// Refresh proof details while the modal is open.')){
 const start=s.indexOf('  useEffect(() => {\n    setExpandedSeq(null); setDetails(null); setDetailError("");');const end=s.indexOf('  const stopById',start);
 if(start<0||end<0)throw new Error('Unknown AssignedRoutes version; no files changed. Send src/pages/AssignedRoutes.tsx.');
 s=s.slice(0,start)+`  // Refresh proof details while the modal is open.
  useEffect(() => {
    setExpandedSeq(null);setDetails(null);setDetailError('');
    if(!viewPlanId){setDetailBusy(false);return;}
    let active=true,inflight=false;
    const refresh=async()=>{
      if(inflight||document.hidden)return;inflight=true;setDetailBusy(true);
      try{const data=await fetchAssignedRouteDetails(viewPlanId);if(!active)return;
        setDetails({planId:data.id,stops:data.stops});setDetailError('');
        const version=(data as {version?:number}).version;
        setPlans(previous=>previous.map(plan=>plan.id!==data.id?plan:{...plan,...(version==null?{}:{version}),stopArrivals:plan.stopArrivals.map(arrival=>{const stop=data.stops.find(d=>d.stopId===arrival.stopId&&d.seq===arrival.seq);return stop?{...arrival,status:stop.status as typeof arrival.status}:arrival;})}));
      }catch(error){if(active)setDetailError(error instanceof Error?error.message:'Could not refresh delivery proof.');}
      finally{inflight=false;if(active)setDetailBusy(false);}
    };
    void refresh();const timer=window.setInterval(()=>void refresh(),15000);
    return()=>{active=false;window.clearInterval(timer);};
  },[viewPlanId,detailRetry]);
`+s.slice(end);
 const anchor='<Button size="sm" variant="outline" onClick={()=>openDriverChange(viewingPlan)}>';
 if(!s.includes(anchor))throw new Error('Refresh button anchor missing; no files changed.');
 s=s.replace(anchor,'<Button size="sm" variant="outline" disabled={detailBusy} onClick={()=>setDetailRetry(n=>n+1)}>{detailBusy?"Refreshing…":"Refresh delivery status"}</Button>\n                  '+anchor);
}
writeFileSync(p,s);console.log('Installed live admin completion refresh. Build/restart the admin frontend after deploying the backend.');
