import { AppError } from '../domain/errors.js';

const invalid=()=>new AppError('INVALID_ARTIFACT','Android 결과물의 manifest를 읽을 수 없습니다. 완성된 APK 또는 AAB를 선택해 주세요.');
type Field={id:number;value:Buffer|number};
function fields(data:Buffer):Field[] {
  let offset=0;const result:Field[]=[];
  const varint=()=>{let value=0;let shift=0;for(let i=0;i<10;i++){if(offset>=data.length)throw invalid();const byte=data[offset++];value+=(byte&127)*2**shift;if(!(byte&128)){if(!Number.isSafeInteger(value))throw invalid();return value;}shift+=7;}throw invalid();};
  while(offset<data.length){if(result.length>100_000)throw invalid();const tag=varint(),id=Math.floor(tag/8),wire=tag%8;if(!id)throw invalid();
    if(wire===0)result.push({id,value:varint()});
    else if(wire===2){const length=varint();if(offset+length>data.length)throw invalid();result.push({id,value:data.subarray(offset,offset+length)});offset+=length;}
    else if(wire===1||wire===5){offset+=wire===1?8:4;if(offset>data.length)throw invalid();}
    else throw invalid();
  }return result;
}
const bytes=(rows:Field[],id:number)=>{const value=rows.find(row=>row.id===id)?.value;return Buffer.isBuffer(value)?value:Buffer.alloc(0);};
const string=(rows:Field[],id:number)=>bytes(rows,id).toString('utf8');
const android='http://schemas.android.com/apk/res/android';

/** AAPT2 Resources.proto XmlNode/XmlElement/XmlAttribute, without loading resources or executing SDK tools. */
function bundleAttributes(data:Buffer):Record<string,string> {
  const root=fields(bytes(fields(data),1));if(string(root,3)!=='manifest')throw invalid();
  const result:Record<string,string>={};
  for(const row of root.filter(row=>row.id===4)) {
    if(!Buffer.isBuffer(row.value))throw invalid();const attr=fields(row.value),name=string(attr,2),ns=string(attr,1);
    if(!((name==='package'&&!ns)||(['versionCode','versionName'].includes(name)&&ns===android)))continue;
    let value=string(attr,3);
    if(!value){const item=fields(bytes(attr,6));value=string(fields(bytes(item,2)),1)||string(fields(bytes(item,3)),1);const primitive=fields(bytes(item,7));const number=primitive.find(f=>[6,7].includes(f.id))?.value;if(typeof number==='number')value=String(number);}
    if(name in result)throw invalid();result[name]=value;
  }return result;
}

/** Android ResXMLTree and ResStringPool from androidfw/ResourceTypes.h. Bounds are checked before every chunk. */
function apkAttributes(data:Buffer):Record<string,string> {
  if(data.length<8||data.readUInt16LE(0)!==3||data.readUInt32LE(4)!==data.length)throw invalid();
  let strings:string[]=[];
  const lookup=(id:number)=>{if(id===0xffffffff)return '';if(id>=strings.length)throw invalid();return strings[id];};
  for(let offset=data.readUInt16LE(2);offset<data.length;){
    if(offset<8||offset+8>data.length)throw invalid();const type=data.readUInt16LE(offset),header=data.readUInt16LE(offset+2),size=data.readUInt32LE(offset+4);
    if(header<8||size<header||offset+size>data.length)throw invalid();const chunk=data.subarray(offset,offset+size);
    if(type===1){
      if(header<28)throw invalid();const count=chunk.readUInt32LE(8),utf8=!!(chunk.readUInt32LE(16)&256),start=chunk.readUInt32LE(20);
      if(count>100_000||header+count*4>size||start<header+count*4||start>size)throw invalid();strings=[];
      for(let i=0;i<count;i++){
        let cursor=start+chunk.readUInt32LE(header+i*4);
        const length=()=>{if(cursor+(utf8?1:2)>size)throw invalid();let n=utf8?chunk[cursor++]:chunk.readUInt16LE(cursor);if(!utf8)cursor+=2;
          if(n&(utf8?128:32768)){if(cursor+(utf8?1:2)>size)throw invalid();n=(n&(utf8?127:32767))*(utf8?256:65536)+(utf8?chunk[cursor++]:chunk.readUInt16LE(cursor));if(!utf8)cursor+=2;}return n;};
        if(utf8)length();const byteLength=length()*(utf8?1:2);if(cursor+byteLength+(utf8?1:2)>size)throw invalid();strings.push(chunk.subarray(cursor,cursor+byteLength).toString(utf8?'utf8':'utf16le'));
      }
    } else if(type===0x102){
      if(header<16||header+20>size||lookup(chunk.readUInt32LE(header+4))!=='manifest')throw invalid();
      const start=header+chunk.readUInt16LE(header+8),stride=chunk.readUInt16LE(header+10),count=chunk.readUInt16LE(header+12);
      if(stride<20||start<header+20||start+stride*count>size)throw invalid();const result:Record<string,string>={};
      for(let i=0;i<count;i++){
        const at=start+i*stride,ns=lookup(chunk.readUInt32LE(at)),name=lookup(chunk.readUInt32LE(at+4));
        if(!((name==='package'&&!ns)||(['versionCode','versionName'].includes(name)&&ns===android)))continue;
        const raw=chunk.readUInt32LE(at+8),type=chunk[at+15],value=chunk.readUInt32LE(at+16);
        if(name in result)throw invalid();result[name]=raw!==0xffffffff?lookup(raw):type===3?lookup(value):[0x10,0x11].includes(type)?String(value):'';
      }return result;
    }
    offset+=size;
  }throw invalid();
}
export function androidArtifactMetadata(data:Buffer,bundle:boolean):{appIdentifier:string;version:string;buildVersion:string} {
  try{const attrs=bundle?bundleAttributes(data):apkAttributes(data);
    if(!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(attrs.package??'')||!/^\d{1,10}$/.test(attrs.versionCode??'')||Number(attrs.versionCode)<1||Number(attrs.versionCode)>2100000000)throw invalid();
    return {appIdentifier:attrs.package,version:attrs.versionName||attrs.versionCode,buildVersion:attrs.versionCode};
  }catch(error){if(error instanceof AppError)throw error;throw invalid();}
}
