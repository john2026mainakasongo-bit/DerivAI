import fs from 'node:fs';
import path from 'node:path';
export class Store {
 constructor(directory){fs.mkdirSync(directory,{recursive:true});this.file=path.join(directory,'scanner.json');}
 load(){
  if(!fs.existsSync(this.file))return [];
  const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
  if(data.version!==1 || !Array.isArray(data.signals))throw Error('Invalid scanner store; restore backup before starting');
  return data.signals;
 }
 save(signals){
  const temp=this.file+'.tmp',body=JSON.stringify({version:1,savedAt:Date.now(),signals});
  const fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,this.file);
 }
}
