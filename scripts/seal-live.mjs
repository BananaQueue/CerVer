import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { decode } from '../src/sealcode/decode.js';

const B='http://localhost:3100', IIS='R1-2026-010734', PW=595.28, PH=841.89;
const doc=await PDFDocument.create();
const f=await doc.embedFont(StandardFonts.Helvetica), fb=await doc.embedFont(StandardFonts.HelveticaBold);
const p=doc.addPage([PW,PH]);
['SPECIAL ORDER No. 25-506','Series of 2025','','SUBJECT: Designation of Inspection Team for','ARO-O RESORT, Bauang, La Union.','',
 'In the interest of the service, the following personnel','are hereby designated to conduct inspection:','',
 '   1. Juan Dela Cruz   — Team Leader','   2. Maria Santos     — Member','','Travel period: 15–17 October 2025.']
 .forEach((t,i)=>p.drawText(t,{x:64,y:768-i*21,size:i===0?13:11,font:i===0?fb:f,color:rgb(.06,.06,.06)}));

const fd=new FormData();
fd.append('iisNo',IIS); fd.append('mark','sealcode');
fd.append('file',new Blob([await doc.save()],{type:'application/pdf'}),'SO.pdf');
const r=await fetch(B+'/api/seal',{method:'POST',body:fd});
const sealed=new Uint8Array(await r.arrayBuffer());
await fs.writeFile('scripts/sealed-sc.pdf',sealed);
console.log('SEALED  mark=',r.headers.get('x-sealed-mark'),' pages=',r.headers.get('x-sealed-pages'),' ',sealed.length.toLocaleString(),'bytes');

// render the page and decode the mark straight off it
const b=await chromium.launch({channel:'chrome',headless:true});
const pg=await b.newPage({viewport:{width:1190,height:1684},deviceScaleFactor:2});
await pg.goto('file:///D:/CerVer/scripts/sealed-sc.pdf#zoom=page-fit&toolbar=0',{waitUntil:'load'});
await pg.waitForTimeout(3200);
await pg.screenshot({path:'scripts/sealed-sc.png'});
const shot=await fs.readFile('scripts/sealed-sc.png');
const p2=await b.newPage();
const out=await p2.evaluate(async({durl,PW,PH})=>{
  const im=new Image(); im.src=durl; await im.decode();
  const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
  const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(im,0,0);
  const d=cx.getImageData(0,0,im.width,im.height).data;
  let mnX=1e9,mnY=1e9,mxX=-1,mxY=-1;
  for(let y=0;y<im.height;y+=2)for(let x=0;x<im.width;x+=2){const o=(y*im.width+x)*4;
    if(d[o]>240&&d[o+1]>240&&d[o+2]>240){if(x<mnX)mnX=x;if(x>mxX)mxX=x;if(y<mnY)mnY=y;if(y>mxY)mxY=y;}}
  const s=(mxX-mnX)/PW;                       // px per pt
  const mm=22, size=mm/25.4*72;
  const cxp=mnX+(PW-26-size/2)*s, cyp=mnY+(PH-(34+size/2))*s, half=size*0.72*s, px=900;
  const oc=document.createElement('canvas'); oc.width=px; oc.height=px;
  const o2=oc.getContext('2d',{willReadFrequently:true});
  o2.fillStyle='#fff'; o2.fillRect(0,0,px,px);
  o2.drawImage(im,cxp-half,cyp-half,half*2,half*2,0,0,px,px);
  const id=o2.getImageData(0,0,px,px);
  return {s,width:id.width,height:id.height,data:Array.from(id.data)};
},{durl:'data:image/png;base64,'+shot.toString('base64'),PW,PH});
await b.close();
console.log('page rendered at', out.s.toFixed(2), 'px/pt  (~'+Math.round(out.s*72)+' dpi)');
const got=decode({width:out.width,height:out.height,data:new Uint8ClampedArray(out.data)});
console.log('DECODED OFF THE PAGE ->', got ?? 'null');
console.log('MATCH ->', got===`CVR|${IIS}|1|`+got?.split('|')[3] ? 'YES' : (got?'?':'NO'));
