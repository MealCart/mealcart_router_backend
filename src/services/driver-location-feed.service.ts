import {pool} from '../db/pool.js';
import {TRACKING_CHANNEL,oneDriverLocation,latestDriverLocations,publishPublicDriverLocation} from './driver-location.service.js';
type Handle={client:import('pg').PoolClient;closing:boolean;released:boolean;release:(destroy?:boolean)=>void};
let listening:Promise<void>|null=null,current:Handle|null=null,retry:ReturnType<typeof setTimeout>|null=null,users=0;
async function connect(){
 if(listening)return listening;
 listening=(async()=>{
  const client=await pool.connect();const handle:Handle={client,closing:false,released:false,release(destroy=false){if(handle.released)return;handle.released=true;client.release(destroy);}};current=handle;
  const lost=()=>{if(handle.released)return;handle.release(true);if(handle.closing)return;if(current===handle){current=null;listening=null;}if(users&&!retry){retry=setTimeout(()=>{retry=null;if(users)void connect().catch(()=>{});},5000);retry.unref?.();}};
  client.on('error',lost);client.on('end',lost);
  client.on('notification',message=>{if(!users||handle.closing||message.channel!==TRACKING_CHANNEL)return;try{const id=JSON.parse(message.payload??'{}').driverId;if(typeof id==='string'&&id.length<=40)void oneDriverLocation(id).then(value=>{if(value)publishPublicDriverLocation(value);}).catch(()=>{});}catch{/* ignore malformed notification */}});
  try{await client.query(`LISTEN ${TRACKING_CHANNEL}`);for(const value of await latestDriverLocations())publishPublicDriverLocation(value);}catch(e){lost();throw e;}
 })();
 try{await listening;}catch(e){listening=null;throw e;}
}
export async function joinTrackingFeed(){
 users++;try{await connect();}catch(e){users--;if(!users&&retry){clearTimeout(retry);retry=null;}throw e;}
 let left=false;return()=>{
  if(left)return;left=true;users--;if(users)return;
  if(retry){clearTimeout(retry);retry=null;}
  const handle=current;current=null;listening=null;
  if(handle){handle.closing=true;handle.client.removeAllListeners('notification');void handle.client.query(`UNLISTEN ${TRACKING_CHANNEL}`).then(()=>handle.release(),()=>handle.release(true));}
 };
}
