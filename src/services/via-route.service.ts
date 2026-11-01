import { ApiError } from "../types/api.types.js";
import type { RouteJob, RoutePoint, RouteViaPoint, RoadRoute, RoadRouteLeg } from "../types/route.types.js";
import { computeViaSegment } from "./google-routes.service.js";
import { stitchPolylines } from "../lib/route-geometry.js";

type Node = {position:RoutePoint;via:boolean;jobId:string|null};
/** Split only at delivery stops, never at a via point. Google permits 25 intermediates. */
export function viaSegments(depot:RoutePoint,jobs:RouteJob[],vias:RouteViaPoint[]) {
 const ids=new Set(jobs.map(j=>j.id));
 if(vias.length>10 || vias.some(v=>v.beforeJobId!==null&&!ids.has(v.beforeJobId))) throw new ApiError(400,"INVALID_VIA","A route-via point references a missing delivery stop.");
 const nodes:Node[]=[];
 for(const job of jobs){for(const v of vias.filter(v=>v.beforeJobId===job.id))nodes.push({position:v.position,via:true,jobId:null});nodes.push({position:job.position,via:false,jobId:job.id});}
 for(const v of vias.filter(v=>v.beforeJobId===null))nodes.push({position:v.position,via:true,jobId:null});
 nodes.push({position:depot,via:false,jobId:null});
 const segments:{origin:RoutePoint;destination:Node;intermediates:Node[]}[]=[];
 let remaining=nodes,origin=depot;
 while(remaining.length){
  let end=remaining.length-1;
  if(end>25){end=25;while(end>=0&&(remaining[end].via||remaining[end].jobId===null))end--;}
  if(end<0)throw new ApiError(400,"TOO_MANY_VIAS","Too many points between delivery stops.");
  const destination=remaining[end];segments.push({origin,destination,intermediates:remaining.slice(0,end)});
  origin=destination.position;remaining=remaining.slice(end+1);
 }
 return segments;
}
export async function planViaRoute(depot:RoutePoint,jobs:RouteJob[],viaPoints:RouteViaPoint[]):Promise<RoadRoute> {
 const allLegs:RoadRouteLeg[]=[],parts:string[]=[];
 for(const segment of viaSegments(depot,jobs,viaPoints)){
  const data=await computeViaSegment(segment.origin,segment.destination.position,segment.intermediates);
  const route=(data as any)?.routes?.[0];
  if(!route)throw new ApiError(422,"NO_VIA_ROUTE","Google could not find a driving route through these points. Move or remove the point and try again.");
  const expected=segment.intermediates.filter(n=>!n.via).length+1;
  if(!Array.isArray(route.legs)||route.legs.length!==expected)throw new ApiError(502,"BAD_VIA_LEGS","Google returned incomplete route legs.");
  const duration=(v:unknown)=>{if(typeof v!=="string"||!/^\d+(\.\d+)?s$/.test(v))throw new ApiError(502,"BAD_DURATION","Missing driving time.");const n=Number(v.slice(0,-1));if(!Number.isFinite(n))throw new ApiError(502,"BAD_DURATION","Invalid driving time.");return n;};
  const distance=(v:unknown)=>{if(v===undefined)return 0;if(typeof v!=="number"||!Number.isFinite(v)||v<0)throw new ApiError(502,"BAD_DISTANCE","Invalid driving distance.");return v;};
  allLegs.push(...route.legs.map((leg:any)=>({durationSeconds:duration(leg.duration),distanceMeters:distance(leg.distanceMeters)})));
  if(typeof route.polyline?.encodedPolyline!=="string")throw new ApiError(502,"NO_GEOMETRY","Google returned no route geometry.");
  parts.push(route.polyline.encodedPolyline);
 }
 if(allLegs.length!==jobs.length+1)throw new ApiError(502,"BAD_VIA_LEGS","Edited route does not match delivery stops.");
 return {jobIds:jobs.map(j=>j.id),legs:allLegs,distanceMeters:allLegs.reduce((a,l)=>a+l.distanceMeters,0),durationSeconds:allLegs.reduce((a,l)=>a+l.durationSeconds,0),encodedPolyline:stitchPolylines(parts),viaPoints};
}
