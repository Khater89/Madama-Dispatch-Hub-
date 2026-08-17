// MDAMA v11.7 — sync Company ALL TECHS MAP into public.company_techs ONLY.
// Compatible with Supabase sb_publishable_* keys; function must be deployed with verify_jwt=false.
// This Edge Function never reads from or writes to public.technicians.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.0";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const DEFAULT_MAP_ID = "13V9ZiPf-sBsClFRtgmcZ9BFmlr3GsJU";
const DEFAULT_LAYER_ID = "J9LesZjvxpM";
const MAP_ID = Deno.env.get("COMPANY_MAP_ID") || DEFAULT_MAP_ID;
const LAYER_ID = Deno.env.get("COMPANY_MAP_LAYER_ID") || DEFAULT_LAYER_ID;
const DEFAULT_KML_URL = `https://www.google.com/maps/d/u/0/kml?forcekml=1&mid=${encodeURIComponent(MAP_ID)}${LAYER_ID ? `&lid=${encodeURIComponent(LAYER_ID)}` : ""}`;
const VIEW_URL = `https://www.google.com/maps/d/u/0/viewer?mid=${encodeURIComponent(MAP_ID)}`;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

function jsonKeyValues(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return Object.values(value).map(String).filter(Boolean);
  } catch { /* legacy/non-JSON env */ }
  return [raw].filter(Boolean);
}
function requestIsAuthorized(req: Request): boolean {
  const supplied = (req.headers.get("apikey") || "").trim();
  if (!supplied) return false;
  const allowed = new Set<string>();
  jsonKeyValues(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || undefined).forEach(k => allowed.add(k));
  const legacyAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyAnon) allowed.add(legacyAnon);
  return allowed.has(supplied);
}
function adminKey(): string | null {
  const modern = jsonKeyValues(Deno.env.get("SUPABASE_SECRET_KEYS") || undefined);
  return modern[0] || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || null;
}
const arr = <T>(v: T | T[] | undefined | null): T[] => v == null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return String(o["#text"]);
    if (typeof o["#cdata"] === "string") return String(o["#cdata"]);
  }
  return String(v).trim();
};
function htmlToText(v: unknown): string {
  return text(v).replace(/<br\s*\/?>/gi," | ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
}
function normPhone(v: string): string {
  let d=(v||"").replace(/\D/g,"");
  if(d.length===11&&d.startsWith("1"))d=d.slice(1);
  return d.length===10?d:"";
}
function findPhone(blob: string): string {
  const m=blob.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m?normPhone(m[0]):"";
}
function findEmail(blob:string):string{return blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||"";}
const STATE_RE=/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;
function tradeValue(v:string):string|null{
  const key=(v||"").toLowerCase();
  if(/hvac|heating|cooling|air condition/.test(key))return "HVAC";
  if(/plumb|drain|sewer/.test(key))return "Plumber";
  if(/electric|electrical/.test(key))return "Electrical";
  if(/appliance/.test(key))return "Appliance Repair";
  if(/locksmith|lock /.test(key))return "Locksmith";
  if(/glass|glazier/.test(key))return "Glass Repair";
  if(/power\s*wash|pressure\s*wash/.test(key))return "Power Washing";
  if(/landscap|lawn/.test(key))return "Landscaping";
  if(/snow|plow/.test(key))return "Snow Removal";
  if(/junk|hauling/.test(key))return "Junk Removal";
  if(/handyman|general\s*maintenance|general repair/.test(key))return "Handyman";
  return null;
}
function extendedData(pm:Record<string,unknown>):Record<string,string>{
  const out:Record<string,string>={};
  const ext=(pm.ExtendedData||{}) as Record<string,unknown>;
  for(const d of arr(ext.Data as Record<string,unknown>|Record<string,unknown>[])){
    if(!d||typeof d!=="object")continue;
    const name=text((d as Record<string,unknown>)["@_name"]),value=htmlToText((d as Record<string,unknown>).value);
    if(name&&value)out[name.toLowerCase()]=value;
  }
  const schema=ext.SchemaData as Record<string,unknown>|undefined;
  for(const sd of arr(schema?.SimpleData as Record<string,unknown>|Record<string,unknown>[])){
    if(!sd||typeof sd!=="object")continue;
    const name=text((sd as Record<string,unknown>)["@_name"]),value=htmlToText(sd);
    if(name&&value)out[name.toLowerCase()]=value;
  }
  return out;
}
function field(data:Record<string,string>,names:string[]):string{for(const n of names)if(data[n.toLowerCase()])return data[n.toLowerCase()];return "";}
function parseLocation(address:string,blob:string){
  const source=`${address} ${blob}`,state=source.match(STATE_RE)?.[1]?.toUpperCase()||"",zip=source.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]||"";
  let city="";
  if(address){const parts=address.split(",").map(s=>s.trim()).filter(Boolean);if(parts.length>=3)city=parts[parts.length-2].replace(STATE_RE,"").trim();}
  return {city,state,zip};
}
async function sha(v:string){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");}
async function kmlTextFromResponse(response:Response):Promise<string>{
  const bytes=new Uint8Array(await response.arrayBuffer()),type=(response.headers.get("content-type")||"").toLowerCase();
  if((bytes[0]===0x50&&bytes[1]===0x4b)||type.includes("zip")||type.includes("kmz")){
    const files=unzipSync(bytes),kmlName=Object.keys(files).find(n=>n.toLowerCase().endsWith(".kml"));
    if(!kmlName)throw new Error("KMZ did not contain a KML file");
    return new TextDecoder().decode(files[kmlName]);
  }
  return new TextDecoder().decode(bytes);
}
type Row=Record<string,unknown>&{map_key:string};
type ParsedKml={rows:Row[];networkLinks:string[]};

function absoluteKmlUrl(href:string,baseUrl:string):string{
  const raw=String(href||'').trim();
  if(!raw)return '';
  try{return new URL(raw,baseUrl).toString();}catch{return raw;}
}
function mapExportCandidates(configuredUrl:string):string[]{
  const out:string[]=[];
  const add=(u:string)=>{const x=String(u||'').trim();if(x&&!out.includes(x))out.push(x);};
  add(configuredUrl);
  // Google My Maps can expose either a direct KML/KMZ export or a small KML
  // NetworkLink wrapper. Try both common export URL shapes so sync does not
  // depend on which form Google returns for a particular map/account.
  if(LAYER_ID){
    add(`https://www.google.com/maps/d/kml?forcekml=1&mid=${encodeURIComponent(MAP_ID)}&lid=${encodeURIComponent(LAYER_ID)}`);
    add(`https://www.google.com/maps/d/u/0/kml?forcekml=1&mid=${encodeURIComponent(MAP_ID)}&lid=${encodeURIComponent(LAYER_ID)}`);
  }
  add(`https://www.google.com/maps/d/kml?mid=${encodeURIComponent(MAP_ID)}&forcekml=1`);
  add(`https://www.google.com/maps/d/u/0/kml?mid=${encodeURIComponent(MAP_ID)}&forcekml=1`);
  add(`https://www.google.com/maps/d/kml?mid=${encodeURIComponent(MAP_ID)}`);
  add(`https://www.google.com/maps/d/u/0/kml?mid=${encodeURIComponent(MAP_ID)}`);
  return out;
}
async function parseKml(xml:string):Promise<ParsedKml>{
  const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,trimValues:true,cdataPropName:'#cdata'});
  const doc=parser.parse(xml) as Record<string,unknown>;
  const root=((doc.kml||doc) as Record<string,unknown>).Document as Record<string,unknown>|undefined;
  if(!root)throw new Error('Google My Maps returned KML without a Document');
  const rows:Row[]=[];
  const networkLinks:string[]=[];
  const visit=async(node:Record<string,unknown>,layer='')=>{
    const currentLayer=text(node.name)||layer;
    for(const nl of arr(node.NetworkLink as Record<string,unknown>|Record<string,unknown>[])){
      if(!nl||typeof nl!=='object')continue;
      const link=((nl.Link||nl.Url||{}) as Record<string,unknown>);
      const href=htmlToText(link.href);
      if(href)networkLinks.push(href);
    }
    for(const pm of arr(node.Placemark as Record<string,unknown>|Record<string,unknown>[])){
      if(!pm||typeof pm!=='object')continue;
      const data=extendedData(pm),name=field(data,['name','technician','tech','contact','title'])||text(pm.name)||'Unnamed tech';
      const description=htmlToText(pm.description),address=field(data,['address','full address','location','service address'])||htmlToText(pm.address);
      const coords=text(((pm.Point||{}) as Record<string,unknown>).coordinates).split(',').map(Number);
      const longitude=Number.isFinite(coords[0])?coords[0]:null,latitude=Number.isFinite(coords[1])?coords[1]:null;
      const dataBlob=Object.entries(data).map(([k,v])=>`${k}: ${v}`).join(' | '),blob=`${currentLayer} | ${name} | ${description} | ${address} | ${dataBlob}`;
      const rawPhone=field(data,['phone','phone number','telephone','mobile','cell']),normalized=normPhone(rawPhone)||findPhone(blob);
      const loc=parseLocation(address,blob),ratingRaw=Number(field(data,['rating'])),reviewsRaw=Number(field(data,['reviews','reviews count','review count']));
      const keyBase=[MAP_ID,currentLayer,name,longitude??'',latitude??'',address].join('|').toLowerCase();
      rows.push({
        map_key:await sha(keyBase),map_id:MAP_ID,map_layer:currentLayer||null,name,
        phone:rawPhone||normalized||null,normalized_phone:normalized||null,email:field(data,['email','e-mail'])||findEmail(blob)||null,
        primary_trade:tradeValue(field(data,['trade','primary trade','specialty','service','category'])||currentLayer||blob),
        city:field(data,['city'])||loc.city||null,state:(field(data,['state'])||loc.state||'').toUpperCase()||null,
        zip_code:field(data,['zip','zipcode','zip code','postal code'])||loc.zip||null,latitude,longitude,
        rating:Number.isFinite(ratingRaw)&&ratingRaw>=0&&ratingRaw<=5?ratingRaw:null,reviews_count:Number.isFinite(reviewsRaw)&&reviewsRaw>=0?Math.trunc(reviewsRaw):null,
        map_address:address||null,source_url:field(data,['source url','url','website','facebook','facebook url'])||VIEW_URL,
        notes:[description,dataBlob?`Map fields: ${dataBlob}`:''].filter(Boolean).join(' | ').slice(0,12000),active:true,
      });
    }
    for(const folder of arr(node.Folder as Record<string,unknown>|Record<string,unknown>[]))if(folder&&typeof folder==='object')await visit(folder,currentLayer);
    for(const child of arr(node.Document as Record<string,unknown>|Record<string,unknown>[]))if(child&&typeof child==='object')await visit(child,currentLayer);
  };
  await visit(root,text(root.name));
  const unique=new Map<string,Row>();for(const r of rows)unique.set(r.map_key,r);
  return {rows:[...unique.values()],networkLinks:[...new Set(networkLinks)]};
}

async function fetchKmlTree(startUrl:string,maxDepth=5):Promise<{rows:Row[];fetchedUrls:string[];networkLinksFollowed:number}>{
  const queue:{url:string;depth:number}[]=[{url:startUrl,depth:0}];
  const seen=new Set<string>();
  const merged=new Map<string,Row>();
  const fetchedUrls:string[]=[];
  let networkLinksFollowed=0;
  while(queue.length){
    const item=queue.shift()!;
    if(item.depth>maxDepth||seen.has(item.url))continue;
    seen.add(item.url);
    let response:Response;
    try{response=await fetch(item.url,{redirect:'follow',headers:{'User-Agent':'MDAMA-Dispatch/11.3'}});}catch(e){
      if(item.depth===0)throw new Error(`Could not fetch Tech Map: ${e instanceof Error?e.message:String(e)}`);
      continue;
    }
    if(!response.ok){if(item.depth===0)throw new Error(`Tech Map returned HTTP ${response.status}`);continue;}
    const effectiveUrl=response.url||item.url;
    fetchedUrls.push(effectiveUrl);
    const xml=await kmlTextFromResponse(response);
    const parsed=await parseKml(xml);
    parsed.rows.forEach(r=>merged.set(r.map_key,r));
    if(item.depth<maxDepth){
      for(const href of parsed.networkLinks){
        const next=absoluteKmlUrl(href,effectiveUrl);
        if(next&&!seen.has(next)){queue.push({url:next,depth:item.depth+1});networkLinksFollowed++;}
      }
    }
  }
  return {rows:[...merged.values()],fetchedUrls:[...new Set(fetchedUrls)],networkLinksFollowed};
}

async function loadMapRows(configuredUrl:string):Promise<{rows:Row[];fetchedUrls:string[];networkLinksFollowed:number;usedStartUrl:string}>{
  let lastError='';
  for(const candidate of mapExportCandidates(configuredUrl)){
    try{
      const result=await fetchKmlTree(candidate);
      if(result.rows.length)return {...result,usedStartUrl:candidate};
      lastError=`No Placemark technicians found from ${candidate}`;
    }catch(e){lastError=e instanceof Error?e.message:String(e);}
  }
  throw new Error(lastError||'Tech Map contained no Placemark technicians');
}



function parseCsvRowsLoose(csv:string):string[][] {
  const rows:string[][]=[]; let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];
    if(quoted){
      if(ch==='"'&&csv[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"')quoted=false; else cell+=ch;
    }else{
      if(ch==='"')quoted=true;
      else if(ch===','){row.push(cell);cell='';}
      else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
      else cell+=ch;
    }
  }
  if(cell.length||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows.filter(r=>r.some(v=>String(v||'').trim()));
}
function mapCsvPhoneIndex(r:string[]):number{
  for(let i=1;i<Math.min(r.length-4,9);i++)if(normPhone(String(r[i]||'')))return i;
  return Math.min(2,Math.max(1,r.length-1));
}
const MAP_CSV_TEAMS=new Set(['JAYCO','HAWKS','HAWKS EM','SIMPLY','PIPE AND WIRES','NEW HIRE','MJN','KYIV SERVICES','NBA PLUMBERS']);
function mapCsvTeamIndex(r:string[],stateIdx:number):number{
  for(let i=stateIdx+1;i<Math.min(r.length-4,stateIdx+14);i++)if(MAP_CSV_TEAMS.has(String(r[i]||'').trim().toUpperCase()))return i;
  for(let i=stateIdx+1;i<Math.min(r.length-6,stateIdx+14);i++){
    const ans=String(r[i+1]||'').trim().toLowerCase();
    const tr=String(r[i+2]||'').trim();
    if(['yes','no','y','n',''].includes(ans)&&tr)return i;
  }
  return Math.min(stateIdx+2,Math.max(stateIdx+1,r.length-5));
}
function mapCsvTrade(raw:string):string|null{
  const value=String(raw||'').trim();
  if(!value)return null;
  if(/all\s*trades?/i.test(value))return 'All Trades';
  return tradeValue(value)||value;
}
async function rowsFromAllStatesTechCsv(rawRows:string[][]):Promise<Row[]> {
  const out:Row[]=[];
  for(const r of rawRows.slice(1)){
    if(r.length<8)continue;
    const phoneIdx=mapCsvPhoneIndex(r);
    const rawPhone=String(r[phoneIdx]||'').trim();
    const normalized=normPhone(rawPhone)||findPhone(r.join(' | '));
    const name=r.slice(1,phoneIdx).map(x=>String(x||'').trim()).filter(Boolean).join(', ')||'Unnamed tech';
    const stateIdx=phoneIdx+1;
    const stateCell=String(r[stateIdx]||'').trim().toUpperCase();
    const teamIdx=mapCsvTeamIndex(r,stateIdx);
    const cityList=r.slice(stateIdx+1,teamIdx).map(x=>String(x||'').trim()).filter(Boolean).join(', ');
    const team=String(r[teamIdx]||'').trim();
    const answered=String(r[teamIdx+1]||'').trim();
    const tradeRaw=String(r[teamIdx+2]||'').trim();
    const tailCity=String(r[r.length-4]||'').trim();
    const tailStateZip=String(r[r.length-3]||'').trim();
    const tailState=tailStateZip.match(STATE_RE)?.[1]?.toUpperCase()||'';
    const state=/^[A-Z]{2}$/.test(stateCell)?stateCell:tailState;
    const zipTail=tailStateZip.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]||'';
    let zip=zipTail;
    if(!zip){for(let i=r.length-5;i>teamIdx+2;i--){const v=String(r[i]||'').trim();if(/^\d{5}$/.test(v)){zip=v;break;}}}
    const wkt=String(r[0]||'');
    const wktMatch=wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
    const latRaw=Number(String(r[r.length-2]||'').trim()),lonRaw=Number(String(r[r.length-1]||'').trim());
    const longitude=Number.isFinite(lonRaw)?lonRaw:(wktMatch?Number(wktMatch[1]):null);
    const latitude=Number.isFinite(latRaw)?latRaw:(wktMatch?Number(wktMatch[2]):null);
    const city=tailCity||cityList.split(',')[0]?.trim()||null;
    const address=[tailCity,tailStateZip].filter(Boolean).join(', ');
    const middle=r.slice(teamIdx+3,r.length-4).map(x=>String(x||'').trim()).filter(Boolean);
    const notes=[team?`Team: ${team}`:'',answered?`Answered: ${answered}`:'',cityList?`Cities: ${cityList}`:'',middle.length?`Original details: ${middle.join(' | ')}`:''].filter(Boolean).join(' | ');
    const keyBase=['all-states-techs',name,normalized,longitude??'',latitude??'',state,zip].join('|').toLowerCase();
    out.push({
      map_key:await sha(keyBase),map_id:MAP_ID,map_layer:'All States Techs',name,
      phone:rawPhone||normalized||null,normalized_phone:normalized||null,email:findEmail(r.join(' | '))||null,
      primary_trade:mapCsvTrade(tradeRaw),city,state:state||null,zip_code:zip.slice(0,5)||null,
      latitude,longitude,rating:null,reviews_count:null,map_address:address||null,source_url:null,notes:notes.slice(0,12000),active:true,
    });
  }
  const unique=new Map<string,Row>();for(const r of out)unique.set(r.map_key,r);return [...unique.values()];
}
function parseCsvRecords(csv:string):Record<string,string>[] {
  const rows:string[][]=[]; let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];
    if(quoted){
      if(ch==='"'&&csv[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"')quoted=false; else cell+=ch;
    }else{
      if(ch==='"')quoted=true;
      else if(ch===','){row.push(cell);cell='';}
      else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
      else cell+=ch;
    }
  }
  if(cell.length||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  const clean=rows.filter(r=>r.some(v=>String(v||'').trim())); if(!clean.length)return [];
  const headers=clean[0].map(h=>String(h||'').trim().toLowerCase().replace(/^\ufeff/,''));
  return clean.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,String(r[i]??'').trim()])));
}
function csvPick(r:Record<string,string>,names:string[]):string{
  for(const n of names){const key=n.toLowerCase();for(const [k,v] of Object.entries(r)){if(k===key||k.replace(/[ _-]+/g,'')===key.replace(/[ _-]+/g,'')||k.includes(key))if(v)return v;}}
  return '';
}
async function rowsFromCsv(csv:string):Promise<Row[]> {
  const rawRows=parseCsvRowsLoose(csv);
  const header=(rawRows[0]||[]).map(x=>String(x||'').trim().toLowerCase().replace(/^\ufeff/,''));
  if(header.includes('wkt')&&header.includes('phone number')&&header.includes('latlong'))return await rowsFromAllStatesTechCsv(rawRows);
  const records=parseCsvRecords(csv),out:Row[]=[];
  for(const r of records){
    const name=csvPick(r,['name','technician','tech name','business name','title'])||'Unnamed tech';
    const phoneRaw=csvPick(r,['phone','phone number','telephone','mobile','cell']);
    const address=csvPick(r,['address','full address','street address','location','map address']);
    const state=(csvPick(r,['state'])||address.match(STATE_RE)?.[1]||'').toUpperCase();
    const zip=csvPick(r,['zip','zipcode','zip code','postal code'])||address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]||'';
    const city=csvPick(r,['city']);
    const layer=csvPick(r,['layer','map layer','category']);
    const trade=tradeValue(csvPick(r,['trade','primary trade','specialty','service','category'])||layer||name+' '+address);
    const latRaw=Number(csvPick(r,['latitude','lat'])),lonRaw=Number(csvPick(r,['longitude','lng','lon','long']));
    const ratingRaw=Number(csvPick(r,['rating'])),reviewsRaw=Number(csvPick(r,['reviews','reviews count','review count']));
    const normalized=normPhone(phoneRaw)||findPhone(Object.values(r).join(' | '));
    const source=csvPick(r,['source url','url','website','facebook url','google maps url'])||VIEW_URL;
    const keyBase=[MAP_ID,layer,name,Number.isFinite(lonRaw)?lonRaw:'',Number.isFinite(latRaw)?latRaw:'',address,normalized].join('|').toLowerCase();
    out.push({map_key:await sha(keyBase),map_id:MAP_ID,map_layer:layer||null,name,phone:phoneRaw||normalized||null,normalized_phone:normalized||null,
      email:csvPick(r,['email','e-mail'])||findEmail(Object.values(r).join(' | '))||null,primary_trade:trade,city:city||null,state:state||null,zip_code:zip.slice(0,5)||null,
      latitude:Number.isFinite(latRaw)?latRaw:null,longitude:Number.isFinite(lonRaw)?lonRaw:null,rating:Number.isFinite(ratingRaw)&&ratingRaw>=0&&ratingRaw<=5?ratingRaw:null,
      reviews_count:Number.isFinite(reviewsRaw)&&reviewsRaw>=0?Math.trunc(reviewsRaw):null,map_address:address||null,source_url:source,notes:Object.entries(r).map(([k,v])=>v?`${k}: ${v}`:'').filter(Boolean).join(' | ').slice(0,12000),active:true});
  }
  const unique=new Map<string,Row>();for(const r of out)unique.set(r.map_key,r);return [...unique.values()];
}
function decodeBase64Bytes(value:string):Uint8Array{
  const bin=atob(value),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;
}
async function rowsFromUploadedFile(name:string,b64:string):Promise<Row[]> {
  const ext=(String(name||'').split('.').pop()||'').toLowerCase(),bytes=decodeBase64Bytes(b64);
  if(ext==='kmz'){
    const files=unzipSync(bytes),kmlName=Object.keys(files).find(n=>n.toLowerCase().endsWith('.kml'));
    if(!kmlName)throw new Error('KMZ did not contain a KML file');
    const parsed=await parseKml(new TextDecoder().decode(files[kmlName]));
    if(!parsed.rows.length&&parsed.networkLinks.length)throw new Error('NetworkLink-only KML/KMZ');
    return parsed.rows;
  }
  const textValue=new TextDecoder().decode(bytes);
  if(ext==='csv')return await rowsFromCsv(textValue);
  if(ext==='kml'){
    const parsed=await parseKml(textValue);
    if(!parsed.rows.length&&parsed.networkLinks.length)throw new Error('NetworkLink-only KML/KMZ');
    return parsed.rows;
  }
  throw new Error('Only KML, KMZ, and CSV are supported');
}
async function upsertMapRows(supabase:any,rows:Row[],replaceSnapshot=false){
  if(!rows.length)throw new Error('No technician rows were found in the uploaded file');
  const seenAt=new Date().toISOString();
  const {data:existing,error:readErr}=await supabase.from('company_techs').select('id,map_key,map_id');
  if(readErr)throw new Error(`company_techs is not ready: ${readErr.message}`);
  const byKey=new Map((existing||[]).map((x:any)=>[String(x.map_key),x]));
  const currentKeys=new Set(rows.map(r=>r.map_key));let inserted=0,updated=0;
  for(const row of rows){const payload={...row,last_seen_at:seenAt,updated_at:seenAt,active:true};
    if(byKey.has(row.map_key)){const {error}=await supabase.from('company_techs').update(payload).eq('map_key',row.map_key);if(error)throw new Error(error.message);updated++;}
    else{const {error}=await supabase.from('company_techs').insert({...payload,first_seen_at:seenAt});if(error)throw new Error(error.message);inserted++;}}
  let deactivated=0;
  if(replaceSnapshot){const stale=(existing||[]).filter((x:any)=>String(x.map_id||'')===MAP_ID&&!currentKeys.has(String(x.map_key))).map((x:any)=>String(x.id));
    for(let i=0;i<stale.length;i+=100){const {error}=await supabase.from('company_techs').update({active:false,updated_at:seenAt}).in('id',stale.slice(i,i+100));if(error)throw new Error(error.message);}deactivated=stale.length;}
  return {active_count:rows.length,inserted,updated,deactivated};
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  if(req.method!=="POST")return json({error:"POST only"},405);
  if(!requestIsAuthorized(req))return json({error:"Unauthorized Company Map sync request"},401);
  const serviceKey=adminKey(),url=Deno.env.get("SUPABASE_URL");
  if(!serviceKey||!url)return json({error:"Supabase server credentials are not configured"},500);
  const supabase=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  let body:any={}; try{body=await req.json();}catch{/* sync without body */}
  if(body?.mode==='import_file') {
    try{
      const rows=await rowsFromUploadedFile(String(body.file_name||''),String(body.file_base64||''));
      const result=await upsertMapRows(supabase,rows,Boolean(body.replace_snapshot));
      return json({ok:true,mode:'import_file',file_name:String(body.file_name||''),map_id:MAP_ID,table:'company_techs',...result});
    }catch(e){return json({error:`Could not import Tech Map file: ${e instanceof Error?e.message:String(e)}`},422);}
  }
  const kmlUrl=Deno.env.get('COMPANY_MAP_KML_URL')||DEFAULT_KML_URL;
  let loaded:{rows:Row[];fetchedUrls:string[];networkLinksFollowed:number;usedStartUrl:string};
  try{loaded=await loadMapRows(kmlUrl);}catch(e){return json({error:`Could not sync Tech Map: ${e instanceof Error?e.message:String(e)}`},422);}
  const rows=loaded.rows;
  if(!rows.length)return json({error:'Tech Map contained no Placemark technicians after following NetworkLinks'},422);
  const seenAt=new Date().toISOString();
  const {data:existing,error:readErr}=await supabase.from("company_techs").select("id,map_key,map_id");
  if(readErr)return json({error:`company_techs is not ready: ${readErr.message}`},500);
  const byKey=new Map((existing||[]).map(x=>[String(x.map_key),x]));
  const currentKeys=new Set(rows.map(r=>r.map_key));let inserted=0,updated=0;
  for(const row of rows){
    const payload={...row,last_seen_at:seenAt,updated_at:seenAt,active:true};
    if(byKey.has(row.map_key)){
      const {error}=await supabase.from("company_techs").update(payload).eq("map_key",row.map_key);if(error)return json({error:error.message},500);updated++;
    }else{
      const {error}=await supabase.from("company_techs").insert({...payload,first_seen_at:seenAt});if(error)return json({error:error.message},500);inserted++;
    }
  }
  const stale=(existing||[]).filter(x=>String(x.map_id||"")===MAP_ID&&!currentKeys.has(String(x.map_key))).map(x=>String(x.id));
  for(let i=0;i<stale.length;i+=100){const {error}=await supabase.from("company_techs").update({active:false,updated_at:seenAt}).in("id",stale.slice(i,i+100));if(error)return json({error:error.message},500);}
  return json({ok:true,map_id:MAP_ID,layer_id:LAYER_ID||null,fetched_from:loaded.usedStartUrl,fetched_urls:loaded.fetchedUrls,network_links_followed:loaded.networkLinksFollowed,active_count:rows.length,inserted,updated,deactivated:stale.length,table:"company_techs",technicians_table_writes:0});
});
