import {pool} from '../db/pool.js';
/** A route reference is resolved to one exact jobs.do_number. Never use recipient contacts from users. */
export async function jobByDoNumber(doNumber:string){
 const rows=(await pool.query('SELECT id,do_number FROM jobs WHERE do_number=$1 ORDER BY id LIMIT 2',[doNumber])).rows;
 if(rows.length!==1)throw new Error(rows.length?'Duplicate jobs.do_number: delivery reference is ambiguous':'No job matches the route delivery reference');return rows[0];
}
export async function routeJob(stop:any){
 const references=[stop.do_number,stop.doNumber,stop.orderRef].filter(v=>v!=null).map(v=>String(v).trim()).filter(Boolean);
 if(new Set(references).size>1)throw new Error('Route stop has conflicting delivery references');
 if(references.length)return jobByDoNumber(references[0]);
 const reference=String(stop.stopId??'').trim();if(reference==='__DEPOT__'||/^STP-C/.test(reference))return null;
 const literal=(await pool.query('SELECT id,do_number FROM jobs WHERE do_number=$1 ORDER BY id LIMIT 2',[reference])).rows;
 if(literal.length>1)throw new Error('Duplicate jobs.do_number: delivery reference is ambiguous');
 // Preserve older internal IDs only if they do not conflict with a literal delivery reference.
 const m=/^STP-J([1-9]\d*)$/.exec(reference);
 if(m){const source=(await pool.query('SELECT do_number FROM jobs WHERE id::text=$1 ORDER BY do_number LIMIT 2',[m[1]])).rows;
  if(source.length===1&&source[0].do_number){const canonical=await jobByDoNumber(String(source[0].do_number));if(literal.length&&literal[0].id!==canonical.id)throw new Error('Route reference conflicts with its legacy internal ID; add an explicit do_number to the stop');return canonical;}
 }
 if(literal.length===1)return literal[0];
 throw new Error('Route stop has no unique jobs.do_number match');
}
export async function plannedJobs(date:string){
 const plans=(await pool.query(`SELECT public_id,stop_arrivals FROM route_plans WHERE plan_date=$1 AND status='Planned'`,[date])).rows;
 const result=new Map<number,{id:number;doNumber:string;planId:string;stop:any}>();const ambiguous=new Set<number>();const issues:string[]=[];
 for(const p of plans)for(const stop of p.stop_arrivals){try{const j=await routeJob(stop);if(!j)continue;if(result.has(j.id)){ambiguous.add(j.id);issues.push(`${j.do_number}: appears more than once on planned routes`);}else result.set(j.id,{id:j.id,doNumber:j.do_number,planId:p.public_id,stop});}catch(e){issues.push(`${p.public_id} / ${stop.stopId}: ${(e as Error).message}`);}}
 for(const id of ambiguous)result.delete(id);
 return{jobs:[...result.values()],issues};
}
