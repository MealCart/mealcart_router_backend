import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { ApiError } from "../types/api.types.js";
import { bcryptHash } from "./auth-policy.js";
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const dummy=bcrypt.hash(randomBytes(32).toString('hex'),12);
export interface MobileDriver {id:string;name:string;username:string;depotId:string|null;}
const publicDriver=(d:any):MobileDriver=>({id:d.public_id,name:d.name,username:d.username,depotId:d.depot_id});
export async function driverLogin(username:string,password:string){
 const rows=(await pool.query("SELECT public_id,name,username,depot_id,status,password_hash FROM drivers WHERE lower(username)=lower($1) LIMIT 2",[username])).rows;
 const d=rows.length===1?rows[0]:null;
 const stored=d?.password_hash?bcryptHash(d.password_hash):null;
 const matches=await bcrypt.compare(password,stored??await dummy);
 if(!d||!stored||!matches||d.status!=='Active')throw new ApiError(401,'INVALID_DRIVER_LOGIN','Invalid username or password, or the driver account is inactive.');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const current=(await c.query('SELECT * FROM drivers WHERE public_id=$1 FOR SHARE',[d.public_id])).rows[0];
  if(!current||current.status!=='Active'||current.password_hash!==d.password_hash)throw new ApiError(401,'INVALID_DRIVER_LOGIN','Account changed. Please sign in again.');
  const token=randomBytes(32).toString('hex');
  const expiresAt=new Date(Date.now()+30*24*3600*1000);
  await c.query('DELETE FROM mealcart_driver_sessions WHERE driver_id=$1 AND expires_at<=NOW()',[d.public_id]);
  await c.query('INSERT INTO mealcart_driver_sessions(token_hash,driver_id,password_fingerprint,expires_at) VALUES($1,$2,$3,$4)',[hash(token),d.public_id,hash(d.password_hash),expiresAt]);
  await c.query('COMMIT');return{token,expiresAt:expiresAt.toISOString(),driver:publicDriver(current)};
 }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
export async function mobileSession(token:string):Promise<MobileDriver|null>{
 if(!/^[a-f0-9]{64}$/.test(token))return null;
 const d=(await pool.query(`SELECT d.*,s.password_fingerprint FROM mealcart_driver_sessions s JOIN drivers d ON d.public_id=s.driver_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[hash(token)])).rows[0];
 if(!d||d.status!=='Active'||!d.password_hash||hash(d.password_hash)!==d.password_fingerprint)return null;
 return publicDriver(d);
}
export async function driverLogout(token:string){await pool.query('DELETE FROM mealcart_driver_sessions WHERE token_hash=$1',[hash(token)]);}
