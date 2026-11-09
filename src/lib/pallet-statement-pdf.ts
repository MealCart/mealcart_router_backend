/** A standalone, paginated A4 statement using PDF standard fonts; no native/pdf dependency. */
import type {palletStatement} from '../services/pallet.service.js';
type Statement=Awaited<ReturnType<typeof palletStatement>>;
const clean=(value:unknown)=>String(value??'').replace(/[\r\n\t]/g,' ').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[\u2013\u2014]/g,'-').replace(/[^\x20-\xFF]/g,'?');
const escape=(v:unknown)=>clean(v).replace(/([\\()])/g,'\\$1');
function lines(value:unknown,width:number){const text=clean(value);const out:string[]=[];let row='';for(const word of text.split(/\s+/)){if((row+' '+word).trim().length>width&&row){out.push(row);row='';}if(word.length>width){if(row){out.push(row);row='';}for(let i=0;i<word.length;i+=width)out.push(word.slice(i,i+width));}else row+=(row?' ':'')+word;}if(row)out.push(row);return out;}
export function palletStatementPdf(s:Statement){
 const pages:string[][]=[];let commands:string[]=[],y=0;const title=`Pallet statement - ${s.client.name}`;
 const text=(x:number,at:number,v:unknown,size=9,bold=false)=>commands.push(`BT /${bold?'F2':'F1'} ${size} Tf 0.08 0.16 0.23 rg 1 0 0 1 ${x} ${842-at} Tm (${escape(v)}) Tj ET`);
 const rule=(at:number)=>commands.push(`0.84 0.88 0.92 RG 40 ${842-at} m 555 ${842-at} l S`);
 const newPage=()=>{if(commands.length)pages.push(commands);commands=[];text(40,45,'MEALCART / PALLET REGISTER',11,true);const heading=lines(title,64);heading.forEach((line,i)=>text(40,72+i*17,line,13,true));const top=72+heading.length*17;text(40,top+4,`Client #${s.client.id} | ${s.from??'Beginning'} to ${s.to??'Current date'} | Australia/Melbourne`,9);text(40,top+22,'Positive balance: Mealcart owes client. Negative balance: client owes Mealcart.',8);rule(top+34);y=top+57;};
 const ensure=(height:number)=>{if(y+height>790)newPage();};
 newPage();text(40,y,'Type',10,true);text(180,y,'Opening',10,true);text(300,y,'Closing',10,true);text(400,y,'Position at period end',10,true);y+=23;
 for(const type of ['CHEP','LOSCAM','PLAIN']){const balance=s.closing[type];text(40,y,type,10,true);text(180,y,s.opening[type]);text(300,y,balance);text(400,y,balance>0?`Mealcart owes ${balance}`:balance<0?`Client owes ${-balance}`:'Settled');y+=21;}
 y+=14;rule(y);y+=24;
 if(!s.movements.length){text(40,y,'No pallet movements in this period.');y+=22;}
 for(const m of s.movements){
  const note=lines(m.notes,94),who=lines(`Client: ${m.clientName} | Driver: ${m.driverName} | Recorded by: ${m.actorName}`,94);
  const ref=lines(`Receipt: ${m.id}${m.reversesId?' | Reversal of: '+m.reversesId:''}`,94);
  const h=42+(note.length+who.length+ref.length)*13;ensure(h);
  const date=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(m.occurredAt));
  text(40,y,date,9,true);text(190,y,m.palletType,9,true);text(265,y,m.kind,9,true);text(360,y,`Qty ${m.quantity}`);text(425,y,`Change ${m.delta>0?'+':''}${m.delta}`);text(505,y,`Bal ${m.runningBalance}`);y+=17;
  for(const row of [...who,...ref,...note.map(t=>'Note: '+t)]){ensure(16);text(40,y,row,8);y+=13;}
  rule(y+4);y+=22;
 }
 if(commands.length)pages.push(commands);
 const objects:string[]=[];const add=(v:string)=>{objects.push(v);return objects.length;};
 const catalog=add(''),pageTree=add(''),regular=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),bold=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
 const ids:number[]=[];
 pages.forEach((cmd,index)=>{cmd.push(`BT /F1 8 Tf 0.35 0.4 0.45 rg 1 0 0 1 40 25 Tm (Mealcart | Page ${index+1} of ${pages.length} | Generated ${escape(s.generatedAt)}) Tj ET`);const content=cmd.join('\n');const stream=add(`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}\nendstream`);ids.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`));});
 objects[catalog-1]=`<< /Type /Catalog /Pages ${pageTree} 0 R >>`;objects[pageTree-1]=`<< /Type /Pages /Kids [${ids.map(id=>id+' 0 R').join(' ')}] /Count ${ids.length} >>`;
 const header=Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1'),parts:Buffer[]=[header],offsets=[0];let length=header.length;
 objects.forEach((obj,index)=>{offsets.push(length);const chunk=Buffer.from(`${index+1} 0 obj\n${obj}\nendobj\n`,'latin1');parts.push(chunk);length+=chunk.length;});
 const xref=length;const trailer=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
 parts.push(Buffer.from(trailer,'latin1'));return Buffer.concat(parts);
}
