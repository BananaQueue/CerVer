import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { decode } from '../src/leafcode/decode.js';

const B='http://localhost:3100', IIS='R1-2026-010734';
const hr=()=>console.log('─'.repeat(70));

const doc=await PDFDocument.create();
const f=await doc.embedFont(StandardFonts.Helvetica), fb=await doc.embedFont(StandardFonts.HelveticaBold);
for(const ls of [['SPECIAL ORDER No. 25-506','Series of 2025','','SUBJECT: Inspection Team, ARO-O RESORT','Bauang, La Union.'],
                 ['Page 2 — TEAM','','1. Juan Dela Cruz — Team Leader','2. Maria Santos — Member','','Budget: MOOE 2025.']]){
  const p=doc.addPage([595.28,841.89]);
  ls.forEach((t,i)=>p.drawText(t,{x:60,y:770-i*22,size:i===0?13:11,font:i===0?fb:f,color:rgb(.05,.05,.05)}));
}
const fd=new FormData();
fd.append('iisNo',IIS); fd.append('mark','leafcode');
fd.append('file',new Blob([await doc.save()],{type:'application/pdf'}),'SO.pdf');
const r=await fetch(B+'/api/seal',{method:'POST',body:fd});
const sealed=new Uint8Array(await r.arrayBuffer());
await fs.writeFile('scripts/leafdoc.pdf',sealed);
hr(); console.log(`SEALED  mark=${r.headers.get('x-sealed-mark')}  pages=${r.headers.get('x-sealed-pages')}`);

// Render page 1 to a big PNG at a known page width, then crop the leaf area precisely.
const PW=595.28, PH=841.89, SCALE=4;           // 4 px per pt ~= 288 dpi
const b=await chromium.launch({channel:'chrome',headless:true});
const pg=await b.newPage({viewport:{width:Math.round(PW*SCALE/2),height:Math.round(PH*SCALE/2)},deviceScaleFactor:2});
await pg.goto('file:///D:/CerVer/scripts/leafdoc.pdf#page=1&zoom=page-fit&toolbar=0',{waitUntil:'load'});
await pg.waitForTimeout(3500);
await pg.screenshot({path:'scripts/leafdoc-page.png',fullPage:false});
await b.close();

// Decode: locate the page rect in the screenshot by finding the white page area,
// then crop the leaf's known placement box (generously, to allow for rotation).
const png=await fs.readFile('scripts/leafdoc-page.png');
const b2=await chromium.launch({channel:'chrome',headless:true});
const p2=await b2.newPage();
const out=await p2.evaluate(async ({durl,PW,PH})=>{
  const im=new Image(); im.src=durl; await im.decode();
  const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
  const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(im,0,0);
  const d=cx.getImageData(0,0,im.width,im.height).data;
  // find white page bounds
  let minX=1e9,minY=1e9,maxX=-1,maxY=-1;
  for(let y=0;y<im.height;y+=2)for(let x=0;x<im.width;x+=2){
    const o=(y*im.width+x)*4;
    if(d[o]>240&&d[o+1]>240&&d[o+2]>240){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
  }
  const pw=maxX-minX, ph=maxY-minY, s=pw/PW;
  // leaf placed centre: x = PW-26-55, y(from bottom)=46+55 ; box 110pt +/- rotation slack
  const ccx=minX+(PW-26-55)*s, ccy=minY+(PH-(46+55))*s, half=80*s;
  const px=1000;
  const oc=document.createElement('canvas'); oc.width=px; oc.height=px;
  const octx=oc.getContext('2d',{willReadFrequently:true});
  octx.fillStyle='#fff'; octx.fillRect(0,0,px,px);
  octx.drawImage(im, ccx-half, ccy-half, half*2, half*2, 0,0,px,px);
  const id=octx.getImageData(0,0,px,px);
  return {pageW:pw,pageH:ph,scale:s,width:id.width,height:id.height,data:Array.from(id.data)};
},{durl:'data:image/png;base64,'+png.toString('base64'),PW,PH});
await b2.close();

console.log(`  page found in screenshot: ${out.pageW}x${out.pageH}px  (${out.scale.toFixed(2)} px/pt)`);
const got=decode({width:out.width,height:out.height,data:new Uint8ClampedArray(out.data)});
hr();
console.log('  DECODED FROM THE PRINTED PAGE ->', got ?? 'null');
console.log('  page-1 payload match ->', got && got.startsWith(`CVR|${IIS}|1|`) ? 'YES ✔' : 'NO ✘');
hr();
