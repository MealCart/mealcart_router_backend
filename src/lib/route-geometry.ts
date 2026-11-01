import { decodeRoutePolyline } from "./road-route.js";
import type { RoutePoint } from "../types/route.types.js";
export function encodePolyline(points: RoutePoint[]) {
 let lat=0,lng=0,out="";
 const write=(delta:number)=>{let n=delta<0?~(delta<<1):delta<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};
 for(const p of points){const a=Math.round(p.lat*1e5),b=Math.round(p.lng*1e5);write(a-lat);write(b-lng);lat=a;lng=b;}
 return out;
}
export function stitchPolylines(parts: string[]) {
 const points:RoutePoint[]=[];
 for(const part of parts){const path=decodeRoutePolyline(part);const last=points.at(-1);const first=path[0];if(last&&last.lat===first.lat&&last.lng===first.lng)path.shift();points.push(...path);}
 return encodePolyline(points);
}
