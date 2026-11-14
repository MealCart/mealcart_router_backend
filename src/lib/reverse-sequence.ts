export type ReversibleRoute={jobIds:string[];legs:{durationSeconds:number;distanceMeters:number}[];encodedPolyline:string;distanceMeters:number;durationSeconds:number;viaPoints?:{id:string;beforeJobId:string|null;position:{lat:number;lng:number}}[]};
// Reverse existing geometry rather than requesting a new optimized route.
export function reversePolyline(encoded:string){
 let i=0,lat=0,lng=0;const points:number[][]=[];
 const read=()=>{let result=0,shift=0,byte=0;do{if(i>=encoded.length||shift>30)throw new Error('Invalid calculated route geometry.');byte=encoded.charCodeAt(i++)-63;if(byte<0||byte>63)throw new Error('Invalid calculated route geometry.');result|=(byte&31)<<shift;shift+=5;}while(byte>=32);return result&1?~(result>>1):result>>1;};
 while(i<encoded.length){lat+=read();lng+=read();points.push([lat,lng]);}
 if(points.length<2)throw new Error('Calculate the route before reversing it.');
 const encode=(value:number)=>{let number=value<0?~(value<<1):value<<1,out='';while(number>=32){out+=String.fromCharCode((32|(number&31))+63);number>>>=5;}return out+String.fromCharCode(number+63);};
 lat=0;lng=0;let output='';for(const point of points.reverse()){output+=encode(point[0]-lat)+encode(point[1]-lng);lat=point[0];lng=point[1];}return output;
}
export function reverseCalculatedRoute<T extends ReversibleRoute>(route:T):T{
 if(route.jobIds.length<2)throw new Error('At least two stops are needed to reverse a sequence.');
 if(new Set(route.jobIds).size!==route.jobIds.length||route.legs.length!==route.jobIds.length+1||route.legs.some(l=>!Number.isFinite(l.durationSeconds)||l.durationSeconds<0||!Number.isFinite(l.distanceMeters)||l.distanceMeters<0))throw new Error('The saved route is incomplete. Calculate it again before reversing.');
 const destinations=[...route.jobIds,null],vias=route.viaPoints??[];
 if(vias.some(v=>!destinations.includes(v.beforeJobId)))throw new Error('A road via is not on this route. Save or discard road edits first.');
 const reversedVias=destinations.flatMap(destination=>vias.filter(v=>v.beforeJobId===destination)).reverse().map(v=>{
  const index=v.beforeJobId===null?route.jobIds.length:route.jobIds.indexOf(v.beforeJobId);
  return {...v,position:{...v.position},beforeJobId:index===0?null:route.jobIds[index-1]};
 });
 return {...route,jobIds:[...route.jobIds].reverse(),legs:route.legs.map(l=>({...l})).reverse(),encodedPolyline:reversePolyline(route.encodedPolyline),viaPoints:reversedVias};
}
export function reverseSavedArrivals(original:ReversibleRoute,arrivals:any[],reversed:ReversibleRoute){
 const stops=arrivals.filter(s=>s.stopId!=='__DEPOT__').sort((a,b)=>a.seq-b.seq),depot=arrivals.filter(s=>s.stopId==='__DEPOT__');
 if(stops.length!==original.jobIds.length||depot.length!==1||JSON.stringify(stops.map(s=>s.stopId))!==JSON.stringify(original.jobIds)||arrivals.some(s=>s.status!=='Pending'))throw new Error('Only a complete pending route can be reversed.');
 const ordered=[...stops,depot[0]];const dwell=new Map<string,number>();
 for(let i=0;i<stops.length;i++){const seconds=ordered[i+1].arrivalSecondsFromMidnight-stops[i].arrivalSecondsFromMidnight-original.legs[i+1].durationSeconds;if(!Number.isFinite(seconds)||seconds< -1)throw new Error('The route has invalid saved arrival estimates. Recalculate it first.');dwell.set(stops[i].stopId,Math.max(0,seconds));}
 let time=stops[0].arrivalSecondsFromMidnight-original.legs[0].durationSeconds,distance=0,duration=0;
 if(!Number.isFinite(time)||time<0)throw new Error('The route start time is invalid. Recalculate it first.');
 const result=[...reversed.jobIds,'__DEPOT__'].map((id,index)=>{const leg=reversed.legs[index];time+=leg.durationSeconds;distance+=leg.distanceMeters;duration+=leg.durationSeconds;const source=ordered.find(s=>s.stopId===id);const arrival={...source,seq:index+1,arrivalSecondsFromMidnight:Math.round(time),liveEtaSeconds:Math.round(time),travelSecondsFromPrev:leg.durationSeconds,distanceMetersFromPrev:leg.distanceMeters,cumulativeDistanceMeters:distance,cumulativeDurationSeconds:duration};time+=dwell.get(id)??0;return arrival;});
 return result;
}
