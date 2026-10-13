const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '../src/itmo-calendar.gs'),'utf8');
const props = new Map();
const events = [];
class Event {
  constructor(title,start,end,o) { Object.assign(this,{title,start,end,location:o.location,description:o.description,tags:{}}); }
  getTitle(){return this.title;} getStartTime(){return this.start;} getEndTime(){return this.end;}
  getLocation(){return this.location;} getDescription(){return this.description;}
  getTag(k){return this.tags[k]||'';} setTag(k,v){this.tags[k]=v;return this;} deleteTag(k){delete this.tags[k];return this;}
  setTitle(v){this.title=v;return this;} setTime(a,b){this.start=a;this.end=b;return this;}
  setLocation(v){this.location=v;return this;} setDescription(v){this.description=v;return this;}
  setColor(){return this;} removeAllReminders(){return this;}
}
const cal = {getId:()=> 'owned-test',isOwnedByMe:()=>true,getDescription:()=> 'Managed by private ITMO sync v1',
  getEvents:(a,b)=>events.filter(e=>e.start<b&&e.end>a),createEvent:(...args)=>{const e=new Event(...args);events.push(e);return e;}};
const c = vm.createContext({console,Utilities:{DigestAlgorithm:{SHA_256:'sha256'},
  computeDigest:(a,s)=>[...crypto.createHash(a).update(s).digest()],base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url')},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
  CalendarApp:{createCalendar:()=>cal,getCalendarById:()=>cal,EventColor:{BLUE:'blue',GRAY:'gray'}}});
vm.runInContext(source,c);
const start=new Date(); start.setUTCHours(0,0,0,0); start.setUTCDate(start.getUTCDate()+1);
const w={start,end:new Date(+start+28*86400000)};
const day=start.toISOString().slice(0,10);
const raw=[{date:day,lessons:[{subject:'Web',type:'Лекции',time_start:'11:30',time_end:'13:00',room:'1404'},
  {subject:'Теннис',type:'Занятия спортом',time_start:'13:30',time_end:'15:00',room:'4403'}]}];
let items=c.normalize_(raw,w);
c.window_=()=>w;c.readItmo_=()=>items;
c.syncItmo(); assert.equal(events.length,2);
c.syncItmo(); assert.equal(events.length,2,'Repeat must not duplicate');
raw[0].lessons[0].room='1405';items=c.normalize_(raw,w);c.syncItmo();assert.equal(events[0].location,'1405');
raw[0].lessons[0].time_start='10:00';items=c.normalize_(raw,w);c.syncItmo();assert.equal(events.length,3);
assert.ok(!events[0].title.startsWith('[Отменено]'),'Do not cancel on one missing observation');
events[0].tags.itmo_missing_at=String(Date.now()-31*60000);c.syncItmo();assert.ok(events[0].title.startsWith('[Отменено]'));
raw[0].lessons[0].time_start='11:30';items=c.normalize_(raw,w);c.syncItmo();assert.equal(events[0].title,'Web','Restore reappearing lesson');
const snapshot=JSON.stringify(events);
c.readItmo_=()=>{throw new Error('Server unavailable');};assert.throws(()=>c.syncItmo());assert.equal(JSON.stringify(events),snapshot);
assert.throws(()=>c.normalize_([],w));
assert.throws(()=>c.normalize_([{date:day,lessons:[{subject:'Bad',time_start:'25:90',time_end:'27:00'}]}],w));
assert.throws(()=>c.normalize_([{date:day,lessons:[{subject:'Bad'}]}],w));
const duplicate=JSON.parse(JSON.stringify(raw)); duplicate[0].lessons.push({...duplicate[0].lessons[0],room:'different'});
assert.throws(()=>c.normalize_(duplicate,w));
console.log('PASS: creation, repeat, room change, move, delayed cancellation, restoration, failed fetch, empty data, malformed data, ambiguous duplicates.');
props.set('ITMO_USERNAME','test');props.set('ITMO_PASSWORD','test-secret');
c.Utilities.getUuid=()=> '12345678-abcd-1234-abcd-123456789012';
const state='12345678-abcd-1234-abcd-123456789012';
const requests=[];
const reply=(status,body,headers={})=>({getResponseCode:()=>status,getContentText:()=>body,getAllHeaders:()=>headers});
c.UrlFetchApp={fetch:(url,opts)=>{
  requests.push({url,opts});
  if(url.includes('/openid-connect/auth?')) return reply(200,JSON.stringify({loginAction:'https://id.itmo.ru/auth/realms/itmo/login-actions/authenticate?session=1&x=2'}),{'Set-Cookie':['a=b; Secure','c=d; Secure']});
  if(url.includes('/login-actions/')) {assert.equal(opts.payload.password,'test-secret');assert.equal(opts.headers.Cookie,'a=b; c=d');return reply(302,'',{'Location':'https://my.itmo.ru/login/callback?code=test-code&state='+state});}
  if(url.endsWith('/openid-connect/token')) return reply(200,JSON.stringify({access_token:'dummy-token'}));
  throw new Error('Unexpected host');
}};
assert.equal(c.loginItmo_(),'dummy-token');
assert.ok(requests.every(r=>r.url.startsWith('https://id.itmo.ru/')));
c.UrlFetchApp.fetch=()=>reply(200,'<form action="https://evil.example/login">');
assert.throws(()=>c.loginItmo_(),/Неожиданный адрес/);
console.log('PASS: authentication exchange, cookie preservation, credential destination restricted to ITMO.');

